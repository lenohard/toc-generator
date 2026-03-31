use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const HISTORY_FILE: &str = "task_history.json";

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TaskHistoryRecord {
    pub id: String,
    pub at: String,
    pub file_type: String,
    pub input_file: String,
    pub output_file: String,
    pub selected_pages: Vec<u32>,
    pub offset: i32,
    pub if_cover: String,
    pub model: Option<String>,
    pub prompt_tokens: Option<i64>,
    pub completion_tokens: Option<i64>,
    pub total_tokens: Option<i64>,
    pub cost_usd: Option<f64>,
    pub toc_count: usize,
    #[serde(default)]
    pub toc_entries: Option<Vec<serde_json::Value>>,
    pub duration_ms: u64,
    pub success: bool,
    pub error: Option<String>,
    pub logs: Vec<String>,
}

fn history_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create app data dir: {}", e))?;
    Ok(dir.join(HISTORY_FILE))
}

fn read_all(path: &PathBuf) -> Result<Vec<TaskHistoryRecord>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let txt = fs::read_to_string(path).map_err(|e| format!("Failed to read history: {}", e))?;
    if txt.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str::<Vec<TaskHistoryRecord>>(&txt)
        .map_err(|e| format!("Failed to parse history JSON: {}", e))
}

fn write_all(path: &PathBuf, rows: &[TaskHistoryRecord]) -> Result<(), String> {
    let txt = serde_json::to_string_pretty(rows)
        .map_err(|e| format!("Failed to serialize history JSON: {}", e))?;
    fs::write(path, txt).map_err(|e| format!("Failed to write history: {}", e))
}

#[tauri::command]
pub fn append_task_history(app: AppHandle, record: TaskHistoryRecord) -> Result<(), String> {
    let path = history_path(&app)?;
    let mut rows = read_all(&path)?;
    rows.insert(0, record);
    if rows.len() > 500 {
        rows.truncate(500);
    }
    write_all(&path, &rows)
}

#[tauri::command]
pub fn list_task_history(app: AppHandle, limit: Option<usize>) -> Result<Vec<TaskHistoryRecord>, String> {
    let path = history_path(&app)?;
    let mut rows = read_all(&path)?;
    if let Some(n) = limit {
        if rows.len() > n {
            rows.truncate(n);
        }
    }
    Ok(rows)
}

#[tauri::command]
pub fn clear_task_history(app: AppHandle) -> Result<(), String> {
    let path = history_path(&app)?;
    write_all(&path, &[])
}
