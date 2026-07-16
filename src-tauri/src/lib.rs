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

/// Holds the per-launch resolve-endpoint auth token (ADR-001:
/// resolve-endpoint-trust-boundary). Generated once in `run()`, before the
/// packaged/dev split, and never mutated afterward — plain `String`, no
/// `Mutex` needed. Read by `get_resolve_token()` (packaged builds) and by the
/// packaged-only sidecar-spawn code below, which writes it to the sidecar's
/// stdin. Dev builds never read this field (see `get_resolve_token`'s
/// `cfg!(debug_assertions)` branch) since dev mode's token instead comes from
/// `PI_DESKTOP_RESOLVE_TOKEN`, set by the `npm run dev` orchestration.
struct ResolveTokenState(String);

/// Returns the per-launch resolve-endpoint auth token, reachable only via
/// Tauri's `invoke()` IPC bridge (registered below in `invoke_handler!`) —
/// never over HTTP, a file, or an env var the frontend process or anything
/// spawned from it could leak. See ADR-001 for why this channel specifically
/// (stdin + Tauri IPC) was chosen over env vars/argv/an HTTP endpoint: all of
/// those are readable by the agent's own unrestricted `bash` tool via
/// `printenv`/`ps`/`curl localhost`, defeating the point of the token.
///
/// Dev-mode fallback (ADR-001 §"Dev mode fallback"): in dev,
/// `cfg!(debug_assertions)` is true and this Rust process never spawns the
/// sidecar at all (`npm run dev`'s `concurrently` step does, outside Rust) —
/// so there is no stdin handoff to originate here. Dev mode's reduced threat
/// model (the developer running `npm run dev` themselves is the trusted
/// operator) uses a simpler, explicitly weaker fallback instead: the token
/// travels via the `PI_DESKTOP_RESOLVE_TOKEN` env var that the same
/// `concurrently` parent process exports to both `vite` and the Bun server.
/// This function mirrors that here so the frontend's `invoke("get_resolve_token")`
/// call has the same shape in both dev and packaged builds. If the env var is
/// unset (e.g. someone runs `tauri dev` outside the `npm run dev` wrapper),
/// this returns an empty-string sentinel — the resolve-auth check on the
/// server side (a different task) simply won't have a token to compare
/// against in that case.
#[tauri::command]
fn get_resolve_token(state: tauri::State<ResolveTokenState>) -> String {
    if cfg!(debug_assertions) {
        std::env::var("PI_DESKTOP_RESOLVE_TOKEN").unwrap_or_default()
    } else {
        state.0.clone()
    }
}

/// The window is frameless (`decorations: false` in tauri.conf.json) — these
/// three commands are what `TitleBar.tsx`'s custom traffic-light dots actually
/// call, replacing the real OS window-chrome buttons they visually stand in
/// for (rather than being a non-functional copy of them, which is what this
/// app shipped with before).
///
/// `Window::close()` (not `.destroy()`) emits a real `WindowEvent::CloseRequested`
/// first, exactly like a user clicking a native close button — so the red dot
/// reaches the same `on_window_event` handler below that already intercepts
/// that event and hides to tray instead of quitting, with no hide-to-tray
/// logic duplicated here.
#[tauri::command]
fn window_close(window: tauri::Window) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

#[tauri::command]
fn window_minimize(window: tauri::Window) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

/// Green dot: maximize/restore toggle — not fullscreen. Simpler and more
/// predictable than macOS's usual "green = fullscreen" convention for this
/// app's small utility-window footprint.
#[tauri::command]
fn window_toggle_maximize(window: tauri::Window) -> Result<(), String> {
    let is_maximized = window.is_maximized().map_err(|e| e.to_string())?;
    if is_maximized {
        window.unmaximize().map_err(|e| e.to_string())
    } else {
        window.maximize().map_err(|e| e.to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 256-bit-ish randomness, generated once per app launch, held only in
    // Rust process memory (ADR-001 point 1). Managed as app state below so
    // both `get_resolve_token()` and the packaged-only sidecar-spawn code can
    // reach it.
    let resolve_token = uuid::Uuid::new_v4().to_string();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .manage(SidecarState(Mutex::new(None)))
        .manage(ResolveTokenState(resolve_token))
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
                let (mut rx, mut child) = sidecar
                    .spawn()
                    .expect("failed to spawn pi-desktop-server sidecar");

                // ADR-001: hand the resolve token to the sidecar over its own
                // stdin, immediately after spawn and before anything else
                // touches the child process (before it's stored in
                // `SidecarState`, before the stdout/stderr reader task below
                // is even spawned). The server reads and consumes this one
                // line at startup, before serving any HTTP request — by the
                // time a `bash` tool call could run (which requires the
                // server to already be fully up), the bytes are already gone
                // from the pipe. Deliberately NOT an env var or argv: both
                // are readable by the agent's own unrestricted `bash` tool
                // (`printenv`/`ps`/`/proc/self/environ`), which would defeat
                // the whole point of the token.
                let resolve_token = app.state::<ResolveTokenState>().0.clone();
                child
                    .write(format!("{resolve_token}\n").as_bytes())
                    .expect("failed to write resolve token to sidecar stdin");

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
        .invoke_handler(tauri::generate_handler![
            web_fetch::render_url_headless,
            get_resolve_token,
            window_close,
            window_minimize,
            window_toggle_maximize
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
