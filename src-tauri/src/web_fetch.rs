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

    // Captured before `parsed` is moved into `WebviewUrl::External` below, so
    // `on_navigation` can compare every later navigation's host against the
    // one already gated by the approval flow before this command ever ran.
    let original_host = parsed.host_str().map(str::to_owned);

    let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed))
        .visible(false) // must never flash on screen
        .initialization_script(&build_init_script(&event_name))
        // REVIEW.md finding #7: contain the hidden webview to the originally
        // requested host. Without this, a server-side redirect or
        // client-side JS navigation inside the rendered page could freely
        // reach a private/internal address *after* `classifyTarget()` (on
        // the TypeScript side, in server/src/web-fetch/safety.ts) already
        // approved only the original URL — the same class of gap as the
        // plain-fetch redirect bypass, just via a real browser engine
        // instead of `fetch()`.
        //
        // This is a deliberately narrow same-host check, not a second
        // implementation of `classifyTarget()`'s IP-range classification
        // logic in Rust: duplicating that logic across two languages would
        // just be a second place for the two to drift out of sync, and the
        // render fallback never had a legitimate reason to hop to an
        // unrelated host mid-render anyway. The original URL's own
        // public/private classification already happened on the TypeScript
        // side before this command was ever invoked; this handler's only job
        // is making sure the webview stays on that same host once inside.
        .on_navigation(move |dest| is_same_host(original_host.as_deref(), dest.host_str()))
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

/// Pure host-comparison logic backing `render_url_headless`'s
/// `on_navigation` handler (REVIEW.md finding #7). Extracted so it's
/// testable without a real webview/`MockRuntime`, unlike the window-lifecycle
/// behavior this file otherwise documents as untestable (AC-9.2).
///
/// `None` for `original_host` (which shouldn't happen in practice — the
/// scheme check above guarantees an absolute `http`/`https` URL, which always
/// has a host) is treated as "reject everything," not "allow everything" —
/// fail closed rather than fail open.
fn is_same_host(original_host: Option<&str>, dest_host: Option<&str>) -> bool {
    original_host.is_some() && original_host == dest_host
}

#[cfg(test)]
mod tests {
    use super::is_same_host;

    #[test]
    fn allows_the_initial_navigation_to_the_original_host() {
        assert!(is_same_host(Some("example.com"), Some("example.com")));
    }

    #[test]
    fn rejects_navigation_to_a_different_host() {
        assert!(!is_same_host(Some("example.com"), Some("attacker.example")));
    }

    #[test]
    fn rejects_navigation_to_a_different_subdomain() {
        // Same-host, not same-site: a subdomain is a plain string mismatch
        // here, deliberately, matching this function's "no IP/domain
        // classification, just a literal comparison" design.
        assert!(!is_same_host(Some("example.com"), Some("evil.example.com")));
    }

    #[test]
    fn rejects_when_the_destination_has_no_host() {
        assert!(!is_same_host(Some("example.com"), None));
    }

    #[test]
    fn fails_closed_when_the_original_host_is_missing() {
        // Should not happen in practice (see doc comment), but must not
        // silently allow every navigation if it ever does.
        assert!(!is_same_host(None, Some("example.com")));
        assert!(!is_same_host(None, None));
    }

    #[test]
    fn is_case_sensitive_matching_url_host_str_normalization() {
        // `url::Url::host_str()` already lowercases hostnames during
        // parsing, so both sides of this comparison are pre-normalized by
        // the time they reach this function — this test documents that
        // assumption rather than re-implementing normalization here.
        assert!(is_same_host(Some("example.com"), Some("example.com")));
        assert!(!is_same_host(Some("Example.com"), Some("example.com")));
    }
}
