// EDEN//0 — desktop shell.
//
// V0 keeps the entire simulation in a Web Worker (TypeScript). This shell exists
// to provide a native macOS window, and to establish the boundary that a future
// migration will use: heavy numerical kernels (neural updates, genetic
// operations, spatial queries) can be moved behind Tauri commands like the one
// below without the UI changing at all.

use serde::Serialize;

#[derive(Serialize)]
pub struct BackendInfo {
    /// Where the simulation currently runs.
    pub simulation_backend: &'static str,
    /// Where it is intended to run after the Rust migration.
    pub planned_backend: &'static str,
    pub engine_version: &'static str,
    pub platform: &'static str,
    pub arch: &'static str,
}

/// Report which simulation backend is active.
///
/// The frontend calls this only for display; it never depends on it, which is
/// what keeps the migration path open.
#[tauri::command]
fn sim_backend_info() -> BackendInfo {
    BackendInfo {
        simulation_backend: "web-worker (TypeScript)",
        planned_backend: "tauri (Rust)",
        engine_version: env!("CARGO_PKG_VERSION"),
        platform: std::env::consts::OS,
        arch: std::env::consts::ARCH,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![sim_backend_info])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
