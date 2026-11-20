use super::session::get_session_path;
use super::tool_path::{resolve_tool, tool_search_path};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::process::Command;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PageThumbnail {
    pub page: u32,
    pub data: String,  // base64-encoded image
    pub mime: String,  // "image/png"
}

/// Get the total page count of a PDF or DjVu file
#[tauri::command]
pub fn get_page_count(file_path: String, file_type: String) -> Result<u32, String> {
    match file_type.as_str() {
        "pdf" => {
            let pdfinfo = resolve_tool("pdfinfo");
            let output = Command::new(&pdfinfo)
                .arg(&file_path)
                .env("PATH", &tool_search_path())
                .output()
                .map_err(|e| format!("pdfinfo failed: {}", e))?;
            let out = String::from_utf8_lossy(&output.stdout);
            for line in out.lines() {
                if line.starts_with("Pages:") {
                    let n = line.split(':').nth(1).unwrap_or("").trim().parse::<u32>();
                    return n.map_err(|e| e.to_string());
                }
            }
            Err("Could not parse page count from pdfinfo".to_string())
        }
        "djvu" => {
            let djvused = resolve_tool("djvused");
            let output = Command::new(&djvused)
                .args([file_path.as_str(), "-e", "n"])
                .env("PATH", &tool_search_path())
                .output()
                .map_err(|e| format!("djvused failed: {}", e))?;
            let out = String::from_utf8_lossy(&output.stdout).trim().to_string();
            out.parse::<u32>().map_err(|e| e.to_string())
        }
        _ => Err(format!("Unsupported file type: {}", file_type)),
    }
}

/// Render specific pages as base64-encoded PNG thumbnails
#[tauri::command]
pub async fn render_page_thumbnails(
    session_id: String,
    file_path: String,
    file_type: String,
    pages: Vec<u32>,
) -> Result<Vec<PageThumbnail>, String> {
    let work_dir = std::env::temp_dir()
        .join("ocr-bookmarker")
        .join(&session_id)
        .join("thumbs");
    fs::create_dir_all(&work_dir).map_err(|e| e.to_string())?;

    let mut results = Vec::new();

    match file_type.as_str() {
        "pdf" => {
            let pdftoppm = resolve_tool("pdftoppm");
            for &page in &pages {
                let out_prefix = work_dir.join(format!("thumb{:04}", page));
                let _ = Command::new(&pdftoppm)
                    .args([
                        "-png",
                        "-r", "72",
                        "-f", &page.to_string(),
                        "-l", &page.to_string(),
                        "-scale-to", "400",
                        file_path.as_str(),
                        out_prefix.to_str().unwrap(),
                    ])
                    .env("PATH", &tool_search_path())
                    .output();

                // pdftoppm appends -1.png or -01.png etc.
                let png_path = find_generated_png(&work_dir, page);
                if let Some(path) = png_path {
                    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
                    let b64 = base64_encode(&bytes);
                    results.push(PageThumbnail { page, data: b64, mime: "image/png".to_string() });
                }
            }
        }
        "djvu" => {
            for &page in &pages {
                let prefix = work_dir.join(format!("thumb{:04}", page));
                results.push(render_djvu_page(&file_path, page, "400x600", &prefix)?);
            }
        }
        _ => return Err(format!("Unsupported file type: {}", file_type)),
    }

    Ok(results)
}

fn render_djvu_page(file_path: &str, page: u32, size: &str, prefix: &Path) -> Result<PageThumbnail, String> {
    let ppm_path = prefix.with_extension("ppm");
    // Do not reuse a PPM left by an earlier rendering attempt.
    if ppm_path.exists() {
        fs::remove_file(&ppm_path).map_err(|e| e.to_string())?;
    }
    let output = Command::new(resolve_tool("ddjvu"))
        .args(["--format=ppm", &format!("-page={}", page), &format!("-size={}", size), file_path])
        .arg(&ppm_path)
        .env("PATH", tool_search_path())
        .output()
        .map_err(|e| format!("ddjvu failed for page {}: {}", page, e))?;
    if !output.status.success() || fs::metadata(&ppm_path).map(|m| m.len()).unwrap_or(0) == 0 {
        return Err(format!("ddjvu failed for page {}: {}", page, String::from_utf8_lossy(&output.stderr)));
    }

    #[cfg(target_os = "macos")]
    let bytes = {
        let png_path = prefix.with_extension("png");
        // Never accept a PNG left by an earlier rendering attempt.
        if png_path.exists() {
            fs::remove_file(&png_path).map_err(|e| e.to_string())?;
        }
        let output = Command::new("sips")
            .args(["-s", "format", "png"])
            .arg(&ppm_path)
            .arg("--out")
            .arg(&png_path)
            .output()
            .map_err(|e| format!("sips failed for page {}: {}", page, e))?;
        if !output.status.success() {
            return Err(format!("sips failed for page {}: {}", page, String::from_utf8_lossy(&output.stderr)));
        }
        fs::read(&png_path).map_err(|e| format!("Could not read PNG for page {}: {}", page, e))?
    };
    #[cfg(not(target_os = "macos"))]
    let bytes = {
        let output = Command::new(resolve_tool("pnmtopng"))
            .arg(&ppm_path)
            .env("PATH", tool_search_path())
            .output()
            .map_err(|e| format!("pnmtopng failed for page {} (install netpbm): {}", page, e))?;
        if !output.status.success() {
            return Err(format!("pnmtopng failed for page {}: {}", page, String::from_utf8_lossy(&output.stderr)));
        }
        output.stdout
    };
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err(format!("PNG conversion produced invalid output for page {}", page));
    }
    Ok(PageThumbnail { page, data: base64_encode(&bytes), mime: "image/png".to_string() })
}

fn find_generated_png(dir: &Path, page: u32) -> Option<std::path::PathBuf> {
    // pdftoppm generates files like thumb0001-1.png or thumb0001-01.png
    let prefix = format!("thumb{:04}", page);
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(&prefix) && name.ends_with(".png") {
                return Some(entry.path());
            }
        }
    }
    None
}

fn base64_encode(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = if chunk.len() > 1 { chunk[1] as usize } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as usize } else { 0 };
        result.push(CHARS[(b0 >> 2) & 0x3F] as char);
        result.push(CHARS[((b0 << 4) | (b1 >> 4)) & 0x3F] as char);
        if chunk.len() > 1 {
            result.push(CHARS[((b1 << 2) | (b2 >> 6)) & 0x3F] as char);
        } else {
            result.push('=');
        }
        if chunk.len() > 2 {
            result.push(CHARS[b2 & 0x3F] as char);
        } else {
            result.push('=');
        }
    }
    result
}

/// Render specific pages as FULL resolution base64-encoded PNG (for AI vision)
#[tauri::command]
pub async fn render_pages_for_ai(
    session_id: String,
    file_path: String,
    file_type: String,
    pages: Vec<u32>,
) -> Result<Vec<PageThumbnail>, String> {
    let work_dir = std::env::temp_dir()
        .join("ocr-bookmarker")
        .join(&session_id)
        .join("ai_pages");
    fs::create_dir_all(&work_dir).map_err(|e| e.to_string())?;

    let mut results = Vec::new();

    match file_type.as_str() {
        "pdf" => {
            let pdftoppm = resolve_tool("pdftoppm");
            for &page in &pages {
                let out_prefix = work_dir.join(format!("aipage{:04}", page));
                let _ = Command::new(&pdftoppm)
                    .args([
                        "-png",
                        "-r", "150",
                        "-f", &page.to_string(),
                        "-l", &page.to_string(),
                        "-scale-to", "1200",
                        file_path.as_str(),
                        out_prefix.to_str().unwrap(),
                    ])
                    .env("PATH", &tool_search_path())
                    .output();

                let prefix = format!("aipage{:04}", page);
                if let Ok(entries) = fs::read_dir(&work_dir) {
                    for entry in entries.flatten() {
                        let name = entry.file_name().to_string_lossy().to_string();
                        if name.starts_with(&prefix) && name.ends_with(".png") {
                            let bytes = fs::read(entry.path()).map_err(|e| e.to_string())?;
                            let b64 = base64_encode(&bytes);
                            results.push(PageThumbnail { page, data: b64, mime: "image/png".to_string() });
                            break;
                        }
                    }
                }
            }
        }
        "djvu" => {
            for &page in &pages {
                let prefix = work_dir.join(format!("aipage{:04}", page));
                results.push(render_djvu_page(&file_path, page, "1200x1800", &prefix)?);
            }
        }
        _ => return Err(format!("Unsupported file type: {}", file_type)),
    }

    Ok(results)
}

/// Save AI-produced TOC entries to session (replaces regex-based rules path)
#[tauri::command]
pub fn save_ai_toc(session_id: String, entries_json: String) -> Result<(), String> {
    let path = get_session_path(&session_id, "ai_toc.json");
    fs::write(&path, &entries_json).map_err(|e| e.to_string())
}
