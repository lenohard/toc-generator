use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Serialize, Deserialize, Debug)]
pub struct DepStatus {
    pub name: String,
    pub found: bool,
    pub path: Option<String>,
    pub required_for: String,
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
            let result = Command::new("which").arg(name).output();
            match result {
                Ok(output) if output.status.success() => {
                    let path = String::from_utf8_lossy(&output.stdout)
                        .trim()
                        .to_string();
                    DepStatus {
                        name: name.to_string(),
                        found: true,
                        path: Some(path),
                        required_for: required_for.to_string(),
                    }
                }
                _ => DepStatus {
                    name: name.to_string(),
                    found: false,
                    path: None,
                    required_for: required_for.to_string(),
                },
            }
        })
        .collect()
}
