use std::fs;
use std::path::PathBuf;
use uuid::Uuid;

fn session_dir(session_id: &str) -> PathBuf {
    std::env::temp_dir().join("ocr-bookmarker").join(session_id)
}

#[tauri::command]
pub fn create_session() -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    let dir = session_dir(&id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub fn cleanup_session(session_id: String) -> Result<(), String> {
    let dir = session_dir(&session_id);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn get_session_path(session_id: &str, filename: &str) -> PathBuf {
    session_dir(session_id).join(filename)
}
