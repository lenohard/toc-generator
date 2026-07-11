use serde::{Deserialize, Serialize};

use super::tool_path::find_tool;

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
