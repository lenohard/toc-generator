use serde_json::Value;
use std::process::Command;

#[tauri::command]
pub async fn fetch_models(base_url: String, api_key: Option<String>) -> Result<Vec<String>, String> {
    let url = format!("{}/v1/models", base_url);

    let mut cmd = Command::new("curl");
    cmd.arg("-s").arg("-f").arg(&url);

    if let Some(key) = api_key {
        if !key.is_empty() {
            cmd.arg("-H").arg(format!("Authorization: Bearer {}", key));
        }
    }

    let output = cmd.output().map_err(|e| format!("curl failed: {}", e))?;

    if !output.status.success() {
        return Err(format!("HTTP request failed (exit {})", output.status));
    }

    let body =
        String::from_utf8(output.stdout).map_err(|e| format!("Invalid UTF-8: {}", e))?;

    let json: Value =
        serde_json::from_str(&body).map_err(|e| format!("Invalid JSON: {}", e))?;

    let mut models: Vec<String> = json["data"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .filter_map(|m| m["id"].as_str().map(String::from))
        .collect();

    models.sort();
    Ok(models)
}
