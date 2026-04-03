use super::regex_tools::{Rule, SessionMetadata};
use super::session::get_session_path;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::process::Command;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TocEntry {
    pub title: String,
    pub page: i32, // actual PDF page (after offset applied)
    pub raw_page: String,
    pub level: u32,
    pub source_line: usize,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct MergeOptions {
    pub session_id: String,
    pub input_file: String,
    pub output_file: String,
    pub merge_original: bool,
}

#[derive(Serialize, Clone)]
struct MergeLog {
    session_id: String,
    line: String,
    done: bool,
    success: bool,
}

fn emit(app: &AppHandle, session_id: &str, line: &str, done: bool, success: bool) {
    let _ = app.emit(
        "merge-log",
        MergeLog {
            session_id: session_id.to_string(),
            line: line.to_string(),
            done,
            success,
        },
    );
}

/// Build TOC entries: AI path (ai_toc.json) takes priority over regex/rules path
pub fn build_toc(session_id: &str) -> Result<Vec<TocEntry>, String> {
    // If AI-produced TOC exists, apply offset and return
    let ai_toc_path = get_session_path(session_id, "ai_toc.json");
    if ai_toc_path.exists() {
        let json = fs::read_to_string(&ai_toc_path).map_err(|e| e.to_string())?;
        let mut entries: Vec<TocEntry> = serde_json::from_str(&json).map_err(|e| e.to_string())?;

        // Apply page offset from metadata
        let meta_path = get_session_path(session_id, "metadata.json");
        let meta: SessionMetadata = if meta_path.exists() {
            let mjson = fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
            serde_json::from_str(&mjson).unwrap_or_default()
        } else {
            SessionMetadata::default()
        };
        let offset = meta.offset;
        let if_cover: i32 = meta.if_cover.parse().unwrap_or(0);

        for entry in &mut entries {
            if let Ok(raw) = entry.raw_page.parse::<i32>() {
                let auto_page = if if_cover > 0 && raw > 0 {
                    raw + offset + if_cover - 1
                } else {
                    raw + offset
                };

                // If frontend manually changed PDF page for a numeric printed page,
                // keep that manual final page. Otherwise use metadata-derived page.
                if entry.page > 0 && entry.page != raw {
                    entry.page = entry.page.max(0);
                } else {
                    entry.page = auto_page;
                }
            } else {
                // Non-numeric printed page (e.g. roman numeral): frontend-resolved page is already
                // the final PDF page index and must not have offset/cover applied again.
                entry.page = entry.page.max(0);
            }
        }

        return Ok(entries);
    }

    let result_path = get_session_path(session_id, "result.txt");
    let rules_path = get_session_path(session_id, "rules.json");
    let meta_path = get_session_path(session_id, "metadata.json");

    if !result_path.exists() {
        return Err("No TOC data found. Please use AI extraction in Step 2.".to_string());
    }

    let content = fs::read_to_string(&result_path).map_err(|e| e.to_string())?;

    let rules: Vec<Rule> = if rules_path.exists() {
        let json = fs::read_to_string(&rules_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&json).map_err(|e| e.to_string())?
    } else {
        return Err("No rules defined".to_string());
    };

    let meta: SessionMetadata = if meta_path.exists() {
        let json = fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&json).unwrap_or_default()
    } else {
        SessionMetadata::default()
    };

    if rules.is_empty() {
        return Err("No rules defined — go back to Step 2".to_string());
    }

    // Compile regexes sorted by rank
    let compiled: Vec<(Regex, &Rule)> = rules
        .iter()
        .map(|rule| {
            let re = Regex::new(&rule.pattern)
                .map_err(|e| format!("Invalid regex in rule '{}': {}", rule.pattern, e))?;
            Ok((re, rule))
        })
        .collect::<Result<Vec<_>, String>>()?;

    let offset = meta.offset;

    // Parse ifCover: 0 = no cover, N = cover page is real page N
    let if_cover: i32 = meta.if_cover.parse().unwrap_or(0);

    let mut entries: Vec<TocEntry> = Vec::new();
    // Track which lines were forced-continue (:::1 suffix)
    for (line_idx, line) in content.lines().enumerate() {
        let raw_line = line;
        // Check for force-continue marker
        let force_continue = raw_line.trim_end().ends_with(":::1");
        let clean_line = if force_continue {
            raw_line.trim_end_matches(":::1").trim()
        } else {
            raw_line.trim()
        };

        if clean_line.is_empty() {
            continue;
        }

        // Try each rule in rank order — first match wins
        for (re, rule) in &compiled {
            if let Some(caps) = re.captures(clean_line) {
                let title = caps.get(1).map_or("", |m| m.as_str()).trim().to_string();
                let raw_page = caps.get(2).map_or("", |m| m.as_str()).trim().to_string();
                let raw_page_num: i32 = raw_page.parse().unwrap_or(0);

                // Compute actual PDF page number
                let actual_page = if if_cover > 0 && raw_page_num > 0 {
                    raw_page_num + offset + if_cover - 1
                } else {
                    raw_page_num + offset
                };

                // Determine hierarchy level from rank (rank 1 = top level, rank 2 = sublevel, etc.)
                let level = rule.rank;

                entries.push(TocEntry {
                    title: title.clone(),
                    page: actual_page,
                    raw_page: raw_page.clone(),
                    level,
                    source_line: line_idx + 1,
                });
                break;
            }
        }
    }

    Ok(entries)
}

/// Generate pdftk bookmark format from TOC entries
fn entries_to_pdftk_bookmarks(entries: &[TocEntry]) -> String {
    let mut out = String::new();
    for entry in entries {
        out.push_str("BookmarkBegin\n");
        out.push_str(&format!("BookmarkTitle: {}\n", entry.title));
        out.push_str(&format!("BookmarkLevel: {}\n", entry.level));
        out.push_str(&format!("BookmarkPageNumber: {}\n", entry.page));
    }
    out
}

/// Generate djvused outline format from TOC entries
fn entries_to_djvu_outline(entries: &[TocEntry]) -> String {
    fn escape_djvu(s: &str) -> String {
        s.replace('"', "\\\"")
    }

    let mut lines: Vec<String> = Vec::new();
    lines.push("(bookmarks".to_string());

    let mut stack: Vec<u32> = Vec::new();

    for entry in entries {
        let level = entry.level as usize;

        // Close deeper levels
        while stack.len() >= level {
            lines.push(")".to_string());
            stack.pop();
        }

        lines.push(format!(
            "(\"{}\" \"#{}\"",
            escape_djvu(&entry.title),
            entry.page
        ));
        stack.push(entry.level);
    }

    // Close remaining
    for _ in &stack {
        lines.push(")".to_string());
    }
    lines.push(")".to_string());

    lines.join("\n")
}

fn resolve_tool(name: &str) -> String {
    let output = Command::new("which")
        .arg(name)
        .env("PATH", "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")
        .output();
    match output {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        _ => name.to_string(),
    }
}

#[tauri::command]
pub async fn run_merge(app: AppHandle, opts: MergeOptions) -> Result<String, String> {
    let session_id = opts.session_id.clone();
    let work_dir_path = get_session_path(&session_id, "");
    let work_dir = work_dir_path.parent().unwrap().join(&session_id);

    emit(&app, &session_id, "Building TOC from rules...", false, false);

    let entries = build_toc(&session_id)?;

    if entries.is_empty() {
        return Err("No TOC entries matched — check your rules and regex patterns".to_string());
    }

    emit(
        &app,
        &session_id,
        &format!("Found {} TOC entries", entries.len()),
        false,
        false,
    );

    let input_path = Path::new(&opts.input_file);
    let is_djvu = {
        let ext = input_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        ext == "djvu" || ext == "djv"
    };

    if is_djvu {
        merge_djvu(&app, &opts, &entries, &work_dir)
    } else {
        merge_pdf(&app, &opts, &entries, &work_dir)
    }
}

fn merge_pdf(
    app: &AppHandle,
    opts: &MergeOptions,
    entries: &[TocEntry],
    work_dir: &Path,
) -> Result<String, String> {
    let pdftk = resolve_tool("pdftk");
    let session_id = &opts.session_id;

    // Dump existing metadata
    let info_path = work_dir.join("book.info");
    emit(app, session_id, "Dumping PDF metadata...", false, false);

    let dump_output = Command::new(&pdftk)
        .args([
            opts.input_file.as_str(),
            "dump_data",
            "output",
            info_path.to_str().unwrap(),
        ])
        .env("PATH", "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")
        .output()
        .map_err(|e| format!("pdftk dump_data failed: {}", e))?;

    if !dump_output.status.success() {
        return Err(format!(
            "pdftk dump_data error: {}",
            String::from_utf8_lossy(&dump_output.stderr)
        ));
    }

    let info_content = fs::read_to_string(&info_path).map_err(|e| e.to_string())?;

    // Strip existing bookmarks
    let stripped: String = info_content
        .lines()
        .filter(|line| !line.starts_with("Bookmark"))
        .collect::<Vec<_>>()
        .join("\n");

    // Optionally prepend original bookmarks
    let bookmark_block = if opts.merge_original {
        let original_bm: String = info_content
            .lines()
            .filter(|line| line.starts_with("Bookmark"))
            .collect::<Vec<_>>()
            .join("\n");
        format!("{}\n{}", original_bm, entries_to_pdftk_bookmarks(entries))
    } else {
        entries_to_pdftk_bookmarks(entries)
    };

    // Build new info: inject bookmark block after NumberOfPages line
    let mut new_info = String::new();
    let mut inserted = false;
    for line in stripped.lines() {
        new_info.push_str(line);
        new_info.push('\n');
        if !inserted && line.starts_with("NumberOf") {
            new_info.push_str(&bookmark_block);
            new_info.push('\n');
            inserted = true;
        }
    }
    if !inserted {
        new_info.push_str(&bookmark_block);
    }

    let new_info_path = work_dir.join("book_new.info");
    fs::write(&new_info_path, &new_info).map_err(|e| e.to_string())?;

    emit(
        app,
        session_id,
        &format!("Writing {} bookmarks to PDF...", entries.len()),
        false,
        false,
    );

    let update_output = Command::new(&pdftk)
        .args([
            opts.input_file.as_str(),
            "update_info",
            new_info_path.to_str().unwrap(),
            "output",
            opts.output_file.as_str(),
        ])
        .env("PATH", "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")
        .output()
        .map_err(|e| format!("pdftk update_info failed: {}", e))?;

    if !update_output.status.success() {
        return Err(format!(
            "pdftk update_info error: {}",
            String::from_utf8_lossy(&update_output.stderr)
        ));
    }

    emit(
        app,
        session_id,
        &format!("✓ Done! Output: {}", opts.output_file),
        true,
        true,
    );

    Ok(opts.output_file.clone())
}

fn merge_djvu(
    app: &AppHandle,
    opts: &MergeOptions,
    entries: &[TocEntry],
    work_dir: &Path,
) -> Result<String, String> {
    let djvused = resolve_tool("djvused");
    let session_id = &opts.session_id;

    let outline = entries_to_djvu_outline(entries);
    let outline_path = work_dir.join("outline.txt");
    fs::write(&outline_path, &outline).map_err(|e| e.to_string())?;

    // Copy input to output first
    emit(app, session_id, "Copying DjVu file...", false, false);
    fs::copy(&opts.input_file, &opts.output_file)
        .map_err(|e| format!("Copy failed: {}", e))?;

    emit(
        app,
        session_id,
        &format!("Writing {} bookmarks to DjVu...", entries.len()),
        false,
        false,
    );

    let set_outline = format!(
        "set-outline \"{}\"",
        outline_path.to_str().unwrap()
    );
    let djvu_output = Command::new(&djvused)
        .args([
            opts.output_file.as_str(),
            "-e",
            &set_outline,
            "-s",
        ])
        .env("PATH", "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")
        .output()
        .map_err(|e| format!("djvused failed: {}", e))?;

    if !djvu_output.status.success() {
        return Err(format!(
            "djvused error: {}",
            String::from_utf8_lossy(&djvu_output.stderr)
        ));
    }

    emit(
        app,
        session_id,
        &format!("✓ Done! Output: {}", opts.output_file),
        true,
        true,
    );

    Ok(opts.output_file.clone())
}

/// Called from frontend to preview the TOC without running the full merge
#[tauri::command]
pub fn preview_toc(session_id: String) -> Result<Vec<TocEntry>, String> {
    build_toc(&session_id)
}
