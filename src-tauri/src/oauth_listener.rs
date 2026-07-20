use serde::Serialize;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
pub struct OAuthCallbackPayload {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
}

struct ListenerState {
    port: u16,
    active: AtomicBool,
}

fn state() -> &'static Mutex<Option<ListenerState>> {
    static STATE: OnceLock<Mutex<Option<ListenerState>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(None))
}

/// Survives emit races: FE polls this until the browser callback arrives.
fn pending_result() -> &'static Mutex<Option<OAuthCallbackPayload>> {
    static PENDING: OnceLock<Mutex<Option<OAuthCallbackPayload>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(None))
}

fn publish_outcome(app: &AppHandle, outcome: OAuthCallbackPayload) {
    if let Ok(mut slot) = pending_result().lock() {
        *slot = Some(outcome.clone());
    }
    // Best-effort notify; FE must not depend on this alone.
    let _ = app.emit("oauth-callback", &outcome);
}

fn publish_outcome_without_app(outcome: OAuthCallbackPayload) {
    if let Ok(mut slot) = pending_result().lock() {
        *slot = Some(outcome);
    }
}

fn parse_oauth_callback(request_line: &str) -> OAuthCallbackPayload {
    let path = request_line.split_whitespace().nth(1).unwrap_or("/");
    let query = path.split('?').nth(1).unwrap_or("");
    let mut code: Option<String> = None;
    let mut oauth_state: Option<String> = None;
    let mut error: Option<String> = None;
    for part in query.split('&') {
        if part.is_empty() {
            continue;
        }
        let mut kv = part.splitn(2, '=');
        let k = kv.next().unwrap_or("");
        let v = urlencoding_decode(kv.next().unwrap_or(""));
        match k {
            "code" => code = Some(v),
            "state" => oauth_state = Some(v),
            "error" => error = Some(v),
            _ => {}
        }
    }
    OAuthCallbackPayload {
        code,
        state: oauth_state,
        error,
    }
}

fn urlencoding_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hex = &input[i + 1..i + 3];
                if let Ok(v) = u8::from_str_radix(hex, 16) {
                    out.push(v);
                    i += 3;
                } else {
                    out.push(bytes[i]);
                    i += 1;
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn html_ok() -> Vec<u8> {
    let body = r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Signed in — Parascene</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: "IBM Plex Sans", "Segoe UI", system-ui, sans-serif;
      background: #121214;
      color: #ececf0;
    }
    .card {
      width: min(420px, calc(100% - 2rem));
      padding: 1.75rem;
      border: 1px solid #2e2e34;
      border-radius: 12px;
      background: #1c1c20;
      text-align: center;
    }
    .mark { font-weight: 700; font-size: 1.25rem; letter-spacing: 0.02em; }
    p { color: #9a9aa3; line-height: 1.45; }
    .hint { font-size: 0.9rem; margin-top: 0.25rem; }
    a.btn {
      display: inline-block;
      margin-top: 0.5rem;
      padding: 0.7rem 1.1rem;
      border-radius: 8px;
      border: 1px solid #7c6cf0;
      background: rgba(124, 108, 240, 0.22);
      color: #ececf0;
      text-decoration: none;
      font-weight: 600;
      cursor: pointer;
    }
    a.btn:hover { filter: brightness(1.08); }
  </style>
</head>
<body>
  <div class="card">
    <div class="mark">Parascene</div>
    <p>You're signed in. Return to the desktop app to continue.</p>
    <a class="btn" id="open" href="parascene://auth/complete">Open Parascene Desktop</a>
    <p class="hint" id="hint">This page will close automatically…</p>
  </div>
  <script>
    (function () {
      var done = false;
      var CLOSE_MS = 2500;

      function focusApp() {
        try { window.location.href = "parascene://auth/complete"; } catch (e) {}
      }

      function tryClose() {
        try { window.close(); } catch (e) {}
        try {
          window.open("", "_self");
          window.close();
        } catch (e) {}
        var hint = document.getElementById("hint");
        if (hint) hint.textContent = "You can close this tab now.";
      }

      function finish(fromClick) {
        if (done) return;
        done = true;
        focusApp();
        var delay = fromClick ? 150 : 0;
        setTimeout(tryClose, delay);
      }

      var open = document.getElementById("open");
      if (open) {
        open.addEventListener("click", function (e) {
          e.preventDefault();
          finish(true);
        });
      }

      setTimeout(function () { finish(false); }, CLOSE_MS);
    })();
  </script>
</body>
</html>"#;
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
        body.len(),
        body
    )
    .into_bytes()
}

fn html_err(msg: &str) -> Vec<u8> {
    let safe = msg
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    let body = format!(
        r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sign-in failed — Parascene</title>
  <style>
    :root {{ color-scheme: dark; }}
    body {{
      margin: 0; min-height: 100vh; display: grid; place-items: center;
      font-family: "IBM Plex Sans", "Segoe UI", system-ui, sans-serif;
      background: #121214; color: #ececf0;
    }}
    .card {{
      width: min(420px, calc(100% - 2rem)); padding: 1.75rem;
      border: 1px solid #5c2a2a; border-radius: 12px; background: #1c1c20;
      text-align: center;
    }}
    .mark {{ font-weight: 700; margin-bottom: 0.75rem; }}
    .err {{ color: #ffb4b4; }}
    a.btn {{
      display: inline-block; margin-top: 0.5rem; padding: 0.7rem 1.1rem;
      border-radius: 8px; border: 1px solid #7c6cf0;
      background: rgba(124, 108, 240, 0.22); color: #ececf0;
      text-decoration: none; font-weight: 600; cursor: pointer;
    }}
    .hint {{ color: #9a9aa3; font-size: 0.9rem; }}
  </style>
</head>
<body>
  <div class="card">
    <div class="mark">Parascene</div>
    <p class="err">Sign-in failed: {safe}</p>
    <a class="btn" id="open" href="parascene://auth/complete">Back to Parascene Desktop</a>
    <p class="hint" id="hint">This page will close automatically…</p>
  </div>
  <script>
    (function () {{
      var done = false;
      function focusApp() {{
        try {{ window.location.href = "parascene://auth/complete"; }} catch (e) {{}}
      }}
      function tryClose() {{
        try {{ window.close(); }} catch (e) {{}}
        try {{ window.open("", "_self"); window.close(); }} catch (e) {{}}
        var hint = document.getElementById("hint");
        if (hint) hint.textContent = "You can close this tab now.";
      }}
      function finish(fromClick) {{
        if (done) return;
        done = true;
        focusApp();
        setTimeout(tryClose, fromClick ? 150 : 0);
      }}
      var open = document.getElementById("open");
      if (open) {{
        open.addEventListener("click", function (e) {{
          e.preventDefault();
          finish(true);
        }});
      }}
      setTimeout(function () {{ finish(false); }}, 4000);
    }})();
  </script>
</body>
</html>"#
    );
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
        body.len(),
        body
    )
    .into_bytes()
}

/// Bind loopback redirect and accept in a background thread.
#[tauri::command]
pub fn start_oauth_listener(app: AppHandle, port: u16) -> Result<u16, String> {
    // Drop any leftover callback from a prior attempt.
    if let Ok(mut slot) = pending_result().lock() {
        *slot = None;
    }

    let mut guard = state().lock().map_err(|e| e.to_string())?;
    if let Some(existing) = guard.as_ref() {
        if existing.active.load(Ordering::SeqCst) {
            drop(guard);
            let _ = cancel_oauth_listener();
            thread::sleep(std::time::Duration::from_millis(120));
            guard = state().lock().map_err(|e| e.to_string())?;
            if let Some(still) = guard.as_ref() {
                if still.active.load(Ordering::SeqCst) {
                    return Err("oauth_listener_already_active".into());
                }
            }
        }
    }

    let listener = TcpListener::bind(("127.0.0.1", port)).map_err(|e| {
        format!(
            "Could not bind OAuth callback on 127.0.0.1:{port}: {e}. Is another copy of the app running?"
        )
    })?;

    *guard = Some(ListenerState {
        port,
        active: AtomicBool::new(true),
    });
    drop(guard);

    thread::spawn(move || {
        let outcome = loop {
            let active = state()
                .lock()
                .ok()
                .and_then(|g| g.as_ref().map(|s| s.active.load(Ordering::SeqCst)))
                .unwrap_or(false);
            if !active {
                break OAuthCallbackPayload {
                    code: None,
                    state: None,
                    error: Some("cancelled".into()),
                };
            }

            match listener.accept() {
                Ok((mut stream, _)) => {
                    let mut buf = [0u8; 8192];
                    let n = stream.read(&mut buf).unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]);
                    let first_line = req.lines().next().unwrap_or("");
                    let payload = parse_oauth_callback(first_line);
                    let has_oauth = payload.code.is_some() || payload.error.is_some();
                    if !has_oauth {
                        let body = b"Not Found";
                        let header = format!(
                            "HTTP/1.1 404 Not Found\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        );
                        let _ = stream.write_all(header.as_bytes());
                        let _ = stream.write_all(body);
                        let _ = stream.flush();
                        continue;
                    }
                    let response = if payload.error.is_some() && payload.code.is_none() {
                        html_err(payload.error.as_deref().unwrap_or("error"))
                    } else if payload.code.is_some() {
                        html_ok()
                    } else {
                        html_err("missing_code")
                    };
                    let _ = stream.write_all(&response);
                    let _ = stream.flush();
                    break payload;
                }
                Err(e) => {
                    break OAuthCallbackPayload {
                        code: None,
                        state: None,
                        error: Some(format!("accept_failed: {e}")),
                    };
                }
            }
        };

        if let Ok(mut g) = state().lock() {
            if let Some(st) = g.as_ref() {
                st.active.store(false, Ordering::SeqCst);
            }
            *g = None;
        }

        eprintln!(
            "[oauth] callback received (code={}, error={:?})",
            outcome.code.is_some(),
            outcome.error
        );
        publish_outcome(&app, outcome);
    });

    Ok(port)
}

/// FE polls this — reliable even when Tauri events are missed.
#[tauri::command]
pub fn oauth_take_callback() -> Option<OAuthCallbackPayload> {
    pending_result().lock().ok().and_then(|mut slot| slot.take())
}

/// Unblock a waiting listener (e.g. user cancelled login).
#[tauri::command]
pub fn cancel_oauth_listener() -> Result<(), String> {
    let port = {
        let guard = state().lock().map_err(|e| e.to_string())?;
        let Some(st) = guard.as_ref() else {
            publish_outcome_without_app(OAuthCallbackPayload {
                code: None,
                state: None,
                error: Some("cancelled".into()),
            });
            return Ok(());
        };
        if !st.active.load(Ordering::SeqCst) {
            return Ok(());
        }
        st.port
    };

    let _ = std::net::TcpStream::connect(("127.0.0.1", port)).and_then(|mut stream| {
        stream.write_all(
            b"GET /oauth/callback?error=cancelled HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
        )
    });
    Ok(())
}
