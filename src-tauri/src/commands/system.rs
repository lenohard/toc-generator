use std::path::Path;
use std::process::Command;

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
