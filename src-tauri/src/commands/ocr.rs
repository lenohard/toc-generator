use super::session::get_session_path;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct OcrOptions {
    pub session_id: String,
    pub file_path: String,
    pub first_page: u32,
    pub last_page: u32,
    pub use_textcleaner: bool,
    pub language: String, // "eng" or "chi_sim"
}

#[derive(Serialize, Clone)]
struct LogEvent {
    session_id: String,
    line: String,
    done: bool,
    success: bool,
}

fn emit_log(app: &AppHandle, session_id: &str, line: &str, done: bool, success: bool) {
    let _ = app.emit(
        "ocr-log",
        LogEvent {
            session_id: session_id.to_string(),
            line: line.to_string(),
            done,
            success,
        },
    );
}

fn resolve_tool(name: &str) -> String {
    // Ensure homebrew bin is in PATH
    let output = Command::new("which")
        .arg(name)
        .env("PATH", "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")
        .output();
    match output {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        _ => name.to_string(),
    }
}

fn run_cmd_log(
    app: &AppHandle,
    session_id: &str,
    program: &str,
    args: &[&str],
    cwd: &Path,
) -> Result<(), String> {
    let display = format!("$ {} {}", program, args.join(" "));
    emit_log(app, session_id, &display, false, false);

    let mut child = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .env("PATH", "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to run {}: {}", program, e))?;

    if let Some(stderr) = child.stderr.take() {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            emit_log(app, session_id, &line, false, false);
        }
    }

    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!("{} exited with status {}", program, status));
    }
    Ok(())
}

#[tauri::command]
pub async fn run_ocr(app: AppHandle, opts: OcrOptions) -> Result<(), String> {
    let session_id = opts.session_id.clone();
    let work_dir = get_session_path(&session_id, "");
    let work_dir = work_dir.parent().unwrap_or(Path::new("/tmp")).join(&session_id);

    std::fs::create_dir_all(&work_dir).map_err(|e| e.to_string())?;

    let file_path = Path::new(&opts.file_path);
    let file_type = detect_file_type(file_path)?;

    emit_log(
        &app,
        &session_id,
        &format!("Detected file type: {}", file_type),
        false,
        false,
    );

    // Clean previous images/results
    for entry in fs::read_dir(&work_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with("image") || name_str.starts_with("tmp") || name_str == "result.txt"
        {
            let _ = fs::remove_file(entry.path());
        }
    }

    match file_type.as_str() {
        "djvu" => extract_djvu_pages(&app, &opts, &work_dir)?,
        "pdf" => extract_pdf_pages(&app, &opts, &work_dir)?,
        _ => return Err(format!("Unsupported file type: {}", file_type)),
    }

    // Find all image files and run tesseract on each
    let mut image_files: Vec<_> = fs::read_dir(&work_dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| {
            let name = e.file_name();
            let n = name.to_string_lossy();
            (n.starts_with("image") || n.starts_with("page"))
                && (n.ends_with(".png") || n.ends_with(".ppm") || n.ends_with(".tiff"))
        })
        .collect();
    image_files.sort_by_key(|e| e.file_name());

    if image_files.is_empty() {
        return Err("No image files were generated".to_string());
    }

    let tesseract = resolve_tool("tesseract");

    for entry in &image_files {
        let img_path = entry.path();
        let img_name = img_path.file_name().unwrap().to_string_lossy().to_string();

        // Extract page number for output filename
        let page_num = extract_page_number(&img_name);
        let out_stem = format!("tmp{}", page_num);

        emit_log(
            &app,
            &session_id,
            &format!("OCR: {} → {}.txt", img_name, out_stem),
            false,
            false,
        );

        let mut tc_path = img_path.clone();

        if opts.use_textcleaner {
            let tiff_path = work_dir.join(format!("tc{}.tiff", page_num));
            let textcleaner = resolve_tool("textcleaner");
            let _ = run_cmd_log(
                &app,
                &session_id,
                &textcleaner,
                &[
                    "-g",
                    "-e",
                    "stretch",
                    "-t",
                    "30",
                    "-s",
                    "2",
                    "-u",
                    "-T",
                    img_path.to_str().unwrap(),
                    tiff_path.to_str().unwrap(),
                ],
                &work_dir,
            );
            if tiff_path.exists() {
                tc_path = tiff_path;
            }
        }

        let out_stem_path = work_dir.join(&out_stem);
        let tesseract_args = vec![
            tc_path.to_str().unwrap().to_string(),
            out_stem_path.to_str().unwrap().to_string(),
            "-l".to_string(),
            opts.language.clone(),
            "--oem".to_string(),
            "3".to_string(),
            "--psm".to_string(),
            "6".to_string(),
        ];

        let args_refs: Vec<&str> = tesseract_args.iter().map(|s| s.as_str()).collect();
        run_cmd_log(&app, &session_id, &tesseract, &args_refs, &work_dir)?;
    }

    // Concatenate all tmp*.txt → result.txt
    let result_path = work_dir.join("result.txt");
    let mut result_content = String::new();

    // For PDF: also include pdftotext output if it exists
    let pdf_text_path = work_dir.join("pdftext.txt");
    if pdf_text_path.exists() {
        result_content.push_str(&fs::read_to_string(&pdf_text_path).unwrap_or_default());
        result_content.push('\n');
    }

    let mut tmp_files: Vec<_> = fs::read_dir(&work_dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| {
            let name = e.file_name();
            let n = name.to_string_lossy();
            n.starts_with("tmp") && n.ends_with(".txt")
        })
        .collect();
    tmp_files.sort_by_key(|e| e.file_name());

    for entry in &tmp_files {
        let content = fs::read_to_string(entry.path()).unwrap_or_default();
        result_content.push_str(&content);
    }

    fs::write(&result_path, &result_content).map_err(|e| e.to_string())?;

    let line_count = result_content.lines().count();
    emit_log(
        &app,
        &session_id,
        &format!("✓ OCR complete. {} lines in result.txt", line_count),
        true,
        true,
    );

    Ok(())
}

fn detect_file_type(path: &Path) -> Result<String, String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "djvu" | "djv" => Ok("djvu".to_string()),
        "pdf" => Ok("pdf".to_string()),
        _ => {
            // Try `file` command
            let output = Command::new("file")
                .arg(path)
                .output()
                .map_err(|e| e.to_string())?;
            let out = String::from_utf8_lossy(&output.stdout).to_lowercase();
            if out.contains("djvu") {
                Ok("djvu".to_string())
            } else if out.contains("pdf") {
                Ok("pdf".to_string())
            } else {
                Err(format!("Unknown file type: {}", out))
            }
        }
    }
}

fn extract_page_number(filename: &str) -> String {
    // image-001.png → 001, image001.png → 001, page-001.ppm → 001
    let re = regex::Regex::new(r"(?:image|page)-?(\d+)").unwrap();
    if let Some(cap) = re.captures(filename) {
        cap[1].to_string()
    } else {
        filename.to_string()
    }
}

fn extract_pdf_pages(app: &AppHandle, opts: &OcrOptions, work_dir: &Path) -> Result<(), String> {
    let pdftoppm = resolve_tool("pdftoppm");
    let pdftotext = resolve_tool("pdftotext");

    // Convert pages to PNG images
    let prefix = work_dir.join("image").to_string_lossy().to_string();
    run_cmd_log(
        app,
        &opts.session_id,
        &pdftoppm,
        &[
            opts.file_path.as_str(),
            "-png",
            "-f",
            &opts.first_page.to_string(),
            "-l",
            &opts.last_page.to_string(),
            &prefix,
        ],
        work_dir,
    )?;

    // Also dump native text (may be garbage for scanned PDFs but useful sometimes)
    let pdf_text_path = work_dir.join("pdftext.txt");
    let _ = Command::new(&pdftotext)
        .args([
            "-layout",
            "-f",
            &opts.first_page.to_string(),
            "-l",
            &opts.last_page.to_string(),
            opts.file_path.as_str(),
            pdf_text_path.to_str().unwrap(),
        ])
        .env("PATH", "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")
        .current_dir(work_dir)
        .output();

    Ok(())
}

fn extract_djvu_pages(app: &AppHandle, opts: &OcrOptions, work_dir: &Path) -> Result<(), String> {
    let ddjvu = resolve_tool("ddjvu");

    for i in opts.first_page..=opts.last_page {
        let out_file = work_dir.join(format!("image{:04}.ppm", i));
        run_cmd_log(
            app,
            &opts.session_id,
            &ddjvu,
            &[
                "--format=ppm",
                &format!("-page={}", i),
                "-size=2000x2000",
                opts.file_path.as_str(),
                out_file.to_str().unwrap(),
            ],
            work_dir,
        )?;
    }

    Ok(())
}

#[tauri::command]
pub fn get_ocr_result(session_id: String) -> Result<String, String> {
    let result_path = get_session_path(&session_id, "result.txt");
    if !result_path.exists() {
        return Err("result.txt not found — run OCR first".to_string());
    }
    fs::read_to_string(&result_path).map_err(|e| e.to_string())
}
