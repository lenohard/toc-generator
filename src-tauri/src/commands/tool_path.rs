use std::process::Command;

pub fn tool_search_path() -> String {
    let mut paths = Vec::new();
    if let Ok(prefix) = std::env::var("HOMEBREW_PREFIX") {
        paths.push(format!("{prefix}/bin"));
    }
    if let Ok(home) = std::env::var("HOME") {
        paths.push(format!("{home}/homebrew/bin"));
    }
    paths.extend([
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
        "/usr/bin".to_string(),
        "/bin".to_string(),
    ]);
    paths.join(":")
}

pub fn find_tool(name: &str) -> Option<String> {
    let path_env = tool_search_path();
    let result = Command::new("which")
        .arg(name)
        .env("PATH", &path_env)
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

pub fn resolve_tool(name: &str) -> String {
    find_tool(name).unwrap_or_else(|| name.to_string())
}
