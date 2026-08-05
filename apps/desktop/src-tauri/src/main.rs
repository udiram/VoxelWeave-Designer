#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    voxelweave_designer_lib::run()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .run(tauri::generate_context!())
        .expect("error while running VoxelWeave Designer");
}
