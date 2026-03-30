mod commands;

use commands::{deps, history, merge, ocr, pages, regex_tools, session, system};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            deps::check_deps,
            session::create_session,
            session::cleanup_session,
            ocr::run_ocr,
            ocr::get_ocr_result,
            regex_tools::test_regex,
            regex_tools::get_regex_library,
            regex_tools::save_rule,
            regex_tools::get_rules,
            regex_tools::delete_rule,
            regex_tools::set_metadata,
            regex_tools::get_metadata,
            merge::run_merge,
            merge::preview_toc,
            pages::get_page_count,
            pages::render_page_thumbnails,
            pages::render_pages_for_ai,
            pages::save_ai_toc,
            system::open_output_file,
            system::reveal_output_file,
            history::append_task_history,
            history::list_task_history,
            history::clear_task_history,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
