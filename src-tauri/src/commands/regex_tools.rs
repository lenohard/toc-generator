use super::session::get_session_path;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct RegexMatch {
    pub line_number: usize,
    pub raw_line: String,
    pub title: String,
    pub page: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct RegexLibraryEntry {
    pub label: String,
    pub pattern: String,
    pub rank_hint: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Rule {
    pub id: String,
    pub pattern: String,
    pub rank: u32,
    pub label: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct SessionMetadata {
    pub offset: i32,
    pub if_cover: String, // "0" or number string
}

fn rules_path(session_id: &str) -> PathBuf {
    get_session_path(session_id, "rules.json")
}

fn metadata_path(session_id: &str) -> PathBuf {
    get_session_path(session_id, "metadata.json")
}

#[tauri::command]
pub fn test_regex(session_id: String, pattern: String) -> Result<Vec<RegexMatch>, String> {
    let result_path = get_session_path(&session_id, "result.txt");
    if !result_path.exists() {
        return Err("result.txt not found — run OCR first".to_string());
    }

    let content = fs::read_to_string(&result_path).map_err(|e| e.to_string())?;

    let re = Regex::new(&pattern).map_err(|e| format!("Invalid regex: {}", e))?;

    let mut matches = Vec::new();
    for (i, line) in content.lines().enumerate() {
        if let Some(caps) = re.captures(line) {
            let title = caps.get(1).map_or("", |m| m.as_str()).trim().to_string();
            let page = caps.get(2).map_or("", |m| m.as_str()).trim().to_string();
            matches.push(RegexMatch {
                line_number: i + 1,
                raw_line: line.to_string(),
                title,
                page,
            });
        }
    }

    Ok(matches)
}

#[tauri::command]
pub fn get_regex_library() -> Vec<RegexLibraryEntry> {
    let regexps_path = dirs_path();

    let mut entries = Vec::new();

    if let Ok(content) = fs::read_to_string(&regexps_path) {
        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            // Format: "label   :::pattern###rank_hint"
            if let Some(sep_pos) = line.find(":::") {
                let label = line[..sep_pos].trim().to_string();
                let rest = &line[sep_pos + 3..];
                let (pattern, rank_hint) = if let Some(hash_pos) = rest.find("###") {
                    let pat = rest[..hash_pos].trim().to_string();
                    let rank = rest[hash_pos + 3..].trim().to_string();
                    (pat, Some(rank))
                } else {
                    (rest.trim().to_string(), None)
                };
                entries.push(RegexLibraryEntry {
                    label,
                    pattern,
                    rank_hint,
                });
            }
        }
    }

    // Also add common patterns from readme if library is empty
    if entries.is_empty() {
        entries = default_patterns();
    }

    entries
}

fn dirs_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(home).join(".dotfiles/kit/ocr/regexps")
}

fn default_patterns() -> Vec<RegexLibraryEntry> {
    vec![
        RegexLibraryEntry {
            label: "number.decimal + title + page".to_string(),
            pattern: r"^ *([0-9]+\.[0-9]+ *[-+?a-zA-Z —]+)[. ]*([0-9]+)$".to_string(),
            rank_hint: None,
        },
        RegexLibraryEntry {
            label: "optional number + title + page".to_string(),
            pattern: r"^ *([0-9]* *[-+a-zA-Z —]+) *([0-9]+)$".to_string(),
            rank_hint: None,
        },
        RegexLibraryEntry {
            label: "Part ... + page".to_string(),
            pattern: r"^(Part.*) +(-?[0-9]+)$".to_string(),
            rank_hint: None,
        },
        RegexLibraryEntry {
            label: "alpha title + dots + page".to_string(),
            pattern: r"^ *([a-zA-Z'' —]+)[. ]*([-0-9]+)$".to_string(),
            rank_hint: None,
        },
        RegexLibraryEntry {
            label: "alphanumeric title + dots + page".to_string(),
            pattern: r"^ *([0-9a-zA-Z,?'' —]+[^0-9-])[. ]*([-0-9]+)$".to_string(),
            rank_hint: None,
        },
        RegexLibraryEntry {
            label: "Roman numeral sections".to_string(),
            pattern: r"^(V?I+\.[0-9]+.+[^0-9-])[. ]*([-0-9]+)$".to_string(),
            rank_hint: None,
        },
        RegexLibraryEntry {
            label: "ALL CAPS title + page".to_string(),
            pattern: r"^([A-Z].*)[ ]+([-0-9]+)$".to_string(),
            rank_hint: None,
        },
        RegexLibraryEntry {
            label: "number. start + title + page".to_string(),
            pattern: r"^([0-9].*)[ ]+([-0-9]+)$".to_string(),
            rank_hint: None,
        },
    ]
}

#[tauri::command]
pub fn save_rule(session_id: String, rule: Rule) -> Result<Vec<Rule>, String> {
    let mut rules = load_rules(&session_id);
    // Replace if same id, else push
    if let Some(existing) = rules.iter_mut().find(|r| r.id == rule.id) {
        *existing = rule;
    } else {
        rules.push(rule);
    }
    rules.sort_by_key(|r| r.rank);
    write_rules(&session_id, &rules)?;
    Ok(rules)
}

#[tauri::command]
pub fn get_rules(session_id: String) -> Vec<Rule> {
    load_rules(&session_id)
}

#[tauri::command]
pub fn delete_rule(session_id: String, rule_id: String) -> Result<Vec<Rule>, String> {
    let mut rules = load_rules(&session_id);
    rules.retain(|r| r.id != rule_id);
    write_rules(&session_id, &rules)?;
    Ok(rules)
}

#[tauri::command]
pub fn set_metadata(session_id: String, meta: SessionMetadata) -> Result<(), String> {
    let path = metadata_path(&session_id);
    let json = serde_json::to_string(&meta).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_metadata(session_id: String) -> SessionMetadata {
    let path = metadata_path(&session_id);
    if let Ok(content) = fs::read_to_string(&path) {
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        SessionMetadata::default()
    }
}

fn load_rules(session_id: &str) -> Vec<Rule> {
    let path = rules_path(session_id);
    if let Ok(content) = fs::read_to_string(&path) {
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        Vec::new()
    }
}

fn write_rules(session_id: &str, rules: &[Rule]) -> Result<(), String> {
    let path = rules_path(session_id);
    let json = serde_json::to_string_pretty(rules).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}
