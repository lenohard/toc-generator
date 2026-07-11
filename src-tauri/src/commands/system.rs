use std::fs;
use std::path::Path;
use std::process::Command;

use super::tool_path::{resolve_tool, tool_search_path};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ExistingTocEntry {
    pub title: String,
    pub page: i32,
    pub level: u32,
}

/// Read existing bookmarks/TOC from a PDF or DjVu file.
/// Returns empty vec if no bookmarks are present.
#[tauri::command]
pub fn read_existing_toc(file_path: String, file_type: String) -> Result<Vec<ExistingTocEntry>, String> {
    match file_type.as_str() {
        "pdf" => read_pdf_toc(&file_path),
        "djvu" => read_djvu_toc(&file_path),
        _ => Err(format!("Unsupported file type: {}", file_type)),
    }
}

/// Decode HTML entities that pdftk emits in bookmark titles (e.g. &#8217; → ').
fn decode_html_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while !rest.is_empty() {
        if let Some(amp) = rest.find('&') {
            out.push_str(&rest[..amp]);
            rest = &rest[amp..];
            if let Some(semi) = rest.find(';') {
                let entity = &rest[1..semi]; // between & and ;
                let decoded = if let Some(num_str) = entity.strip_prefix('#') {
                    let code = if let Some(hex) = num_str.strip_prefix('x').or_else(|| num_str.strip_prefix('X')) {
                        u32::from_str_radix(hex, 16).ok()
                    } else {
                        num_str.parse::<u32>().ok()
                    };
                    code.and_then(char::from_u32).map(|c| c.to_string())
                } else {
                    match entity {
                        "amp"  => Some("&".into()),
                        "lt"   => Some("<".into()),
                        "gt"   => Some(">".into()),
                        "quot" => Some("\"".into()),
                        "apos" => Some("'".into()),
                        "nbsp" => Some("\u{00A0}".into()),
                        _      => None,
                    }
                };
                if let Some(d) = decoded {
                    out.push_str(&d);
                    rest = &rest[semi + 1..];
                } else {
                    // Unknown entity — emit as-is
                    out.push('&');
                    rest = &rest[1..];
                }
            } else {
                out.push('&');
                rest = &rest[1..];
            }
        } else {
            out.push_str(rest);
            break;
        }
    }
    out
}

fn read_pdf_toc(file_path: &str) -> Result<Vec<ExistingTocEntry>, String> {
    let pdftk = resolve_tool("pdftk");
    let output = Command::new(&pdftk)
        .args([file_path, "dump_data", "output", "-"])
        .env("PATH", &tool_search_path())
        .output()
        .map_err(|e| format!("pdftk dump_data failed: {}", e))?;

    if !output.status.success() {
        // Not an error — just no bookmarks or unreadable
        return Ok(vec![]);
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let mut entries = Vec::new();
    let mut cur_title: Option<String> = None;
    let mut cur_level: u32 = 1;
    let mut cur_page: i32 = 1;

    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("BookmarkTitle: ") {
            // Save any previous complete entry
            if let Some(t) = cur_title.take() {
                entries.push(ExistingTocEntry { title: t, page: cur_page, level: cur_level });
            }
            cur_title = Some(decode_html_entities(rest.trim()));
            cur_level = 1;
            cur_page = 1;
        } else if let Some(rest) = line.strip_prefix("BookmarkLevel: ") {
            cur_level = rest.trim().parse().unwrap_or(1);
        } else if let Some(rest) = line.strip_prefix("BookmarkPageNumber: ") {
            cur_page = rest.trim().parse().unwrap_or(1);
        }
    }
    if let Some(t) = cur_title {
        entries.push(ExistingTocEntry { title: t, page: cur_page, level: cur_level });
    }

    Ok(entries)
}

fn read_djvu_toc(file_path: &str) -> Result<Vec<ExistingTocEntry>, String> {
    let djvused = resolve_tool("djvused");
    let output = Command::new(&djvused)
        .args([file_path, "-e", "print-outline"])
        .env("PATH", &tool_search_path())
        .output()
        .map_err(|e| format!("djvused print-outline failed: {}", e))?;

    let text = String::from_utf8_lossy(&output.stdout);
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed == "()" || trimmed == "(bookmarks)" {
        return Ok(vec![]);
    }

    // Parse djvu outline s-expression: (bookmarks ("Title" "#42" ...) ...)
    let mut entries = Vec::new();
    parse_djvu_outline(trimmed, 1, &mut entries);
    Ok(entries)
}

fn parse_djvu_outline(text: &str, level: u32, out: &mut Vec<ExistingTocEntry>) {
    // Simple recursive parser for djvu s-expression outline
    let mut depth: i32 = 0;
    let mut pos = 0;
    let chars: Vec<char> = text.chars().collect();
    let len = chars.len();

    // skip outer (bookmarks ...) wrapper
    while pos < len && chars[pos] != '(' { pos += 1; }
    if pos >= len { return; }
    pos += 1; // skip '('
    // skip keyword e.g. "bookmarks"
    while pos < len && chars[pos] != '(' && chars[pos] != ')' { pos += 1; }

    while pos < len {
        if chars[pos] == '(' {
            depth += 1;
            // Parse one entry: ("Title" "#N" children...)
            pos += 1;
            // read title string
            let title = read_djvu_string(&chars, &mut pos);
            // read page string
            let page_str = read_djvu_string(&chars, &mut pos);
            let page: i32 = page_str.trim_start_matches('#').parse().unwrap_or(1);

            if !title.is_empty() {
                out.push(ExistingTocEntry { title, page, level });
            }

            // parse children (nested entries)
            parse_djvu_children(&chars, &mut pos, level + 1, out);

            // skip to closing ')'
            while pos < len && chars[pos] != ')' { pos += 1; }
            pos += 1; // skip ')'
            depth -= 1;
        } else if chars[pos] == ')' {
            break;
        } else {
            pos += 1;
        }
    }
}

fn parse_djvu_children(chars: &[char], pos: &mut usize, level: u32, out: &mut Vec<ExistingTocEntry>) {
    let len = chars.len();
    // Skip whitespace
    while *pos < len && chars[*pos].is_whitespace() { *pos += 1; }
    // Process nested entries until we hit the closing ')' of the parent
    while *pos < len {
        while *pos < len && chars[*pos].is_whitespace() { *pos += 1; }
        if *pos >= len { break; }
        if chars[*pos] == ')' { break; } // end of parent entry
        if chars[*pos] == '(' {
            *pos += 1;
            let title = read_djvu_string(chars, pos);
            let page_str = read_djvu_string(chars, pos);
            let page: i32 = page_str.trim_start_matches('#').parse().unwrap_or(1);
            if !title.is_empty() {
                out.push(ExistingTocEntry { title, page, level });
            }
            parse_djvu_children(chars, pos, level + 1, out);
            while *pos < len && chars[*pos] != ')' { *pos += 1; }
            *pos += 1;
        } else {
            *pos += 1;
        }
    }
}

fn read_djvu_string(chars: &[char], pos: &mut usize) -> String {
    let len = chars.len();
    while *pos < len && chars[*pos].is_whitespace() { *pos += 1; }
    if *pos >= len || chars[*pos] != '"' { return String::new(); }
    *pos += 1; // skip opening quote
    let mut s = String::new();
    while *pos < len {
        if chars[*pos] == '\\' && *pos + 1 < len {
            *pos += 1;
            s.push(chars[*pos]);
        } else if chars[*pos] == '"' {
            *pos += 1;
            break;
        } else {
            s.push(chars[*pos]);
        }
        *pos += 1;
    }
    s
}

/// Delete a file. Used to remove the original after successful merge.
#[tauri::command]
pub fn delete_file(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Ok(()); // already gone
    }
    fs::remove_file(p).map_err(|e| format!("Failed to delete file: {}", e))
}

#[tauri::command]
pub fn open_output_file(path: String) -> Result<(), String> {
    let target = Path::new(&path);
    if !target.exists() {
        return Err(format!("File does not exist: {}", path));
    }

    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        c.arg(&path);
        c
    };

    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("cmd");
        c.args(["/C", "start", "", &path]);
        c
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        c.arg(&path);
        c
    };

    let status = cmd.status().map_err(|e| format!("Open failed: {}", e))?;
    if status.success() {
        Ok(())
    } else {
        Err("Failed to open file".to_string())
    }
}

#[tauri::command]
pub fn reveal_output_file(path: String) -> Result<(), String> {
    let target = Path::new(&path);
    if !target.exists() {
        return Err(format!("File does not exist: {}", path));
    }

    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        c.args(["-R", &path]);
        c
    };

    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("explorer");
        c.arg(format!("/select,{}", path));
        c
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        if let Some(parent) = target.parent() {
            c.arg(parent);
        } else {
            c.arg(&path);
        }
        c
    };

    let status = cmd.status().map_err(|e| format!("Reveal failed: {}", e))?;
    if status.success() {
        Ok(())
    } else {
        Err("Failed to reveal file".to_string())
    }
}
