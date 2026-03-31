use serde::{Deserialize, Serialize};
use std::process::Command;

const CHECK_PATH: &str = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";

#[derive(Serialize, Deserialize, Debug)]
pub struct DepStatus {
    pub name: String,
    pub found: bool,
    pub path: Option<String>,
    pub required_for: String,
}

fn find_tool(name: &str) -> Option<String> {
    let result = Command::new("which")
        .arg(name)
        .env("PATH", CHECK_PATH)
        .output()
        .ok()?;

    if !result.status.success() {
        return None;
    }

    let path = String::from_utf8_lossy(&result.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

#[tauri::command]
pub fn check_deps() -> Vec<DepStatus> {
    let tools: Vec<(&str, &str)> = vec![
        ("tesseract", "OCR text recognition"),
        ("pdftoppm", "PDF to image conversion"),
        ("pdftk", "PDF bookmark writing"),
        ("gawk", "Bookmark script generation"),
        ("ddjvu", "DjVu to image conversion"),
        ("djvused", "DjVu bookmark writing"),
    ];

    tools
        .into_iter()
        .map(|(name, required_for)| {
            let found_path = find_tool(name);
            DepStatus {
                name: name.to_string(),
                found: found_path.is_some(),
                path: found_path,
                required_for: required_for.to_string(),
            }
        })
        .collect()
}
