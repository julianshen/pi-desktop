//! Headless rendering primitive for the `web_fetch` feature's SPA/PWA
//! fallback (see `web-fetch/SPEC.md`'s "Headless render bridge" section).
//!
//! Renders a URL in a hidden, throwaway webview window and returns the
//! fully-rendered `document.documentElement.outerHTML`, for when a plain
//! HTTP fetch comes back looking like an empty JS-hydrated shell. This
//! module owns only the Rust-side rendering primitive; the frontend decides
//! when to call it and what to do with the result.

use std::{
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

use tauri::{Listener, WebviewUrl, WebviewWindowBuilder};

/// Extra time to let typical SPA framework hydration/rendering finish after
/// the raw `load` event fires, before snapshotting the DOM. A fixed,
/// reasonable default per SPEC.md — not user-configurable via this command.
const SETTLE_DELAY_MS: u64 = 400;

/// Monotonic counter mixed into each hidden window's label (and therefore
/// its completion event's name), so that two concurrent
/// `render_url_headless` calls can never observe each other's completion
/// event. Plain Tauri `emit()` (used by the injected script below) is a
/// broadcast to every registered listener regardless of the *listener's*
/// declared target, so name-uniqueness — not Tauri's window/webview target
/// scoping — is what actually prevents cross-talk here.
static RENDER_SEQ: AtomicU64 = AtomicU64::new(0);

/// Renders `url` in an invisible webview window and returns the
/// fully-rendered HTML once the page has loaded and settled, or `Err` if it
/// never signals completion within `timeout_ms`.
///
/// The hidden window is unconditionally destroyed before this function
/// returns — on the success path, the timeout path, and the
/// listener-dropped path alike — since cleanup happens once, after the
/// `tokio::time::timeout(...).await` has already resolved either way, not
/// inside any branch that could be skipped by an early return.
#[tauri::command]
pub async fn render_url_headless(
    app: tauri::AppHandle,
    url: String,
    timeout_ms: u64,
) -> Result<String, String> {
    let parsed = tauri::Url::parse(&url).map_err(|e| format!("invalid url: {e}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("invalid url: only http/https URLs are supported".to_string());
    }

    // The label is also the capability match target (see
    // capabilities/web-fetch-render.json's "windows" glob) and the event
    // name suffix — see RENDER_SEQ's doc comment for why uniqueness matters.
    let seq = RENDER_SEQ.fetch_add(1, Ordering::Relaxed);
    let label = format!("web-fetch-render-{}-{}", std::process::id(), seq);
    let event_name = format!("web-fetch:rendered:{label}");

    let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed))
        .visible(false) // must never flash on screen
        .initialization_script(&build_init_script(&event_name))
        .build()
        .map_err(|e| format!("failed to create hidden render window: {e}"))?;

    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let listener_id = window.once(event_name, move |event| {
        // The JS side hands us `document.documentElement.outerHTML` as an
        // arbitrary JS value; Tauri's event payload arrives on the Rust
        // side as its raw JSON encoding (a quoted, escaped JSON string),
        // not the bare HTML text, so it must be JSON-decoded back into a
        // plain String rather than used as-is.
        let html = serde_json::from_str::<String>(event.payload())
            .unwrap_or_else(|_| event.payload().to_string());
        // `once()` guarantees this closure runs at most once, so `tx.send`
        // consuming `tx` by move is always valid; a failed send just means
        // the timeout branch below already gave up and dropped `rx`.
        let _ = tx.send(html);
    });

    let outcome = tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await;

    // Unconditional cleanup: this runs after the race above has already
    // settled, for every outcome (success, timeout, or the sender being
    // dropped without sending), and before any `return` below — so there is
    // no path through this function that leaves the hidden window behind.
    // `.destroy()`, not `.close()`, is required here: `.close()` first
    // dispatches `WindowEvent::CloseRequested`, and this app's *global*
    // `on_window_event` handler (src-tauri/src/lib.rs) intercepts that
    // event on every window and turns it into a hide-to-tray instead of an
    // actual close — which would silently leak this hidden window forever
    // instead of destroying it. `.destroy()` force-closes without
    // dispatching that event, so it can't be intercepted that way.
    window.unlisten(listener_id);
    let _ = window.destroy();

    match outcome {
        Ok(Ok(html)) => Ok(html),
        Ok(Err(_)) => Err("render window closed before completion".to_string()),
        Err(_) => Err("render timed out".to_string()),
    }
}

/// Builds the script injected into the hidden window: wait for the page to
/// finish its initial load, wait a bit longer for SPA hydration to settle,
/// then hand the fully-rendered HTML back to Rust via a uniquely-named
/// Tauri event.
fn build_init_script(event_name: &str) -> String {
    // `event_name` is built entirely from our own process id and a counter
    // (see the caller) — never from the fetched URL or any page content —
    // so interpolating it directly into the script text here is safe.
    format!(
        r#"(function() {{
  function settleThenEmit() {{
    setTimeout(function() {{
      window.__TAURI_INTERNALS__.invoke('plugin:event|emit', {{
        event: {event_name:?},
        payload: document.documentElement.outerHTML
      }}).catch(function() {{
        // Best-effort: if this rejects (e.g. IPC not yet ready), the
        // Rust-side timeout still bounds how long the caller waits.
      }});
    }}, {settle_delay});
  }}
  if (document.readyState === "complete") {{
    settleThenEmit();
  }} else {{
    window.addEventListener("load", settleThenEmit, {{ once: true }});
  }}
}})();"#,
        event_name = event_name,
        settle_delay = SETTLE_DELAY_MS,
    )
}
