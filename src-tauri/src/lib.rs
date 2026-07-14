use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, WindowEvent,
};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

mod web_fetch;

struct SidecarState(Mutex<Option<CommandChild>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .manage(SidecarState(Mutex::new(None)))
        .setup(|app| {
            let show_item = MenuItem::with_id(app, "show", "Show pi desktop", true, None::<&str>)?;
            let hide_item = MenuItem::with_id(app, "hide", "Hide", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &hide_item, &quit_item])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "hide" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.hide();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            // In dev, `npm run dev` (tauri.conf.json beforeDevCommand) already starts the
            // pi-desktop server alongside Vite. In a packaged build there is no such dev
            // server, so spawn the bundled sidecar binary (see server/scripts and
            // bundle.externalBin in tauri.conf.json) ourselves.
            if !cfg!(debug_assertions) {
                // The sidecar binary is a copy of the `bun` runtime itself; the actual
                // server source + production node_modules ship as a bundled resource
                // (see server/scripts/build-sidecar.ts) and are passed as its entry-point
                // argument, since transformers.js's native/WASM assets don't survive
                // `bun build --compile`'s single-file embedding.
                let entry_point = app
                    .path()
                    .resolve("server/src/index.ts", tauri::path::BaseDirectory::Resource)?;
                let sidecar = app
                    .shell()
                    .sidecar("pi-desktop-server")?
                    .args([entry_point.to_string_lossy().to_string()]);
                let (mut rx, child) = sidecar
                    .spawn()
                    .expect("failed to spawn pi-desktop-server sidecar");
                *app.state::<SidecarState>().0.lock().unwrap() = Some(child);

                tauri::async_runtime::spawn(async move {
                    use tauri_plugin_shell::process::CommandEvent;
                    while let Some(event) = rx.recv().await {
                        match event {
                            CommandEvent::Stdout(line) => {
                                print!("[pi-desktop-server] {}", String::from_utf8_lossy(&line));
                            }
                            CommandEvent::Stderr(line) => {
                                eprint!("[pi-desktop-server] {}", String::from_utf8_lossy(&line));
                            }
                            _ => {}
                        }
                    }
                });
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // Keep the agent (and its sidecar server) alive in the tray when the
            // window is closed; only the tray's Quit item calls app.exit().
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![web_fetch::render_url_headless])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
