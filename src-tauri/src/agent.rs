//! Debug-only localhost agent API. Never started in release builds.
//!
//! External clients read `~/Movies/Parascene/agent.json` for origin + token.

use crate::library::paths::machine_root;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{mpsc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, LogicalSize, Manager};

const TOKEN_HEADER: &str = "authorization";
const LOG_CAP: usize = 200;
const UI_TIMEOUT: Duration = Duration::from_secs(90);
const DEFAULT_WINDOW_WIDTH: f64 = 1280.0;
const DEFAULT_WINDOW_HEIGHT: f64 = 900.0;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentManifest {
    pub origin: String,
    pub token: String,
    pub pid: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAction {
    pub id: String,
    pub scope: String,
    pub status: String,
    pub summary: String,
}

fn ui_state() -> &'static Mutex<Value> {
    static STATE: OnceLock<Mutex<Value>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(json!({})))
}

fn logs() -> &'static Mutex<VecDeque<Value>> {
    static LOGS: OnceLock<Mutex<VecDeque<Value>>> = OnceLock::new();
    LOGS.get_or_init(|| Mutex::new(VecDeque::new()))
}

fn errors() -> &'static Mutex<VecDeque<Value>> {
    static ERRORS: OnceLock<Mutex<VecDeque<Value>>> = OnceLock::new();
    ERRORS.get_or_init(|| Mutex::new(VecDeque::new()))
}

fn pending() -> &'static Mutex<HashMap<String, mpsc::Sender<Result<Value, String>>>> {
    static PENDING: OnceLock<Mutex<HashMap<String, mpsc::Sender<Result<Value, String>>>>> =
        OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn push_capped(slot: &Mutex<VecDeque<Value>>, row: Value) {
    if let Ok(mut guard) = slot.lock() {
        guard.push_back(row);
        while guard.len() > LOG_CAP {
            guard.pop_front();
        }
    }
}

pub fn set_ui_state(state: Value) {
    if let Ok(mut guard) = ui_state().lock() {
        *guard = state;
    }
}

#[tauri::command]
pub fn agent_report_ui_state(state: Value) -> Result<(), String> {
    set_ui_state(state);
    Ok(())
}

#[tauri::command]
pub fn agent_complete(id: String, ok: bool, result: Option<Value>, error: Option<String>) {
    let tx = pending()
        .lock()
        .ok()
        .and_then(|mut map| map.remove(&id));
    if let Some(tx) = tx {
        let payload = if ok {
            Ok(result.unwrap_or(json!({ "ok": true })))
        } else {
            Err(error.unwrap_or_else(|| "Agent action failed".into()))
        };
        let _ = tx.send(payload);
    }
}

fn actions() -> Vec<AgentAction> {
    vec![
        AgentAction {
            id: "project.create".into(),
            scope: "project".into(),
            status: "wired".into(),
            summary: "Create a local project and open it".into(),
        },
        AgentAction {
            id: "project.open".into(),
            scope: "project".into(),
            status: "wired".into(),
            summary: "Open an existing local project".into(),
        },
        AgentAction {
            id: "project.close".into(),
            scope: "project".into(),
            status: "wired".into(),
            summary: "Close the open project".into(),
        },
        AgentAction {
            id: "project.delete".into(),
            scope: "project".into(),
            status: "wired".into(),
            summary: "Delete a local project (folder may remain as regular)".into(),
        },
        AgentAction {
            id: "folder.create".into(),
            scope: "library".into(),
            status: "wired".into(),
            summary: "Create a Library folder".into(),
        },
        AgentAction {
            id: "folder.delete".into(),
            scope: "library".into(),
            status: "wired".into(),
            summary: "Delete an empty regular Library folder".into(),
        },
        AgentAction {
            id: "sync.start".into(),
            scope: "sync".into(),
            status: "wired".into(),
            summary: "Start Sync Newest (not a full library hammer)".into(),
        },
        AgentAction {
            id: "library.clearLocal".into(),
            scope: "library".into(),
            status: "wired".into(),
            summary: "Drop cloud-backed local catalog + files (not cloud)".into(),
        },
        AgentAction {
            id: "sync.folders".into(),
            scope: "sync".into(),
            status: "wired".into(),
            summary: "Pull cloud folder membership into local Library folders".into(),
        },
        AgentAction {
            id: "sync.thumbs".into(),
            scope: "sync".into(),
            status: "wired".into(),
            summary: "Cache missing local previews".into(),
        },
        AgentAction {
            id: "sync.media".into(),
            scope: "sync".into(),
            status: "wired".into(),
            summary: "Cache missing full local media".into(),
        },
        AgentAction {
            id: "cloud.delete".into(),
            scope: "cloud".into(),
            status: "wired".into(),
            summary: "Unfile, ungroup, soft-delete, then drop local rows. Fails if rows remain.".into(),
        },
        AgentAction {
            id: "library.lookup".into(),
            scope: "library".into(),
            status: "wired".into(),
            summary: "Return which of the given creation ids still exist locally".into(),
        },
        AgentAction {
            id: "generation.start".into(),
            scope: "generation".into(),
            status: "wired".into(),
            summary: "Generate a still via Parascene product text2image".into(),
        },
        AgentAction {
            id: "window.setSize".into(),
            scope: "window".into(),
            status: "wired".into(),
            summary: "Unmaximize and set the main window size (default 1280x900)".into(),
        },
        AgentAction {
            id: "shell.show".into(),
            scope: "shell".into(),
            status: "wired".into(),
            summary: "Show a page (Library, Sync, Project chooser, Director, Editor) without mutating data".into(),
        },
        AgentAction {
            id: "help.open".into(),
            scope: "help".into(),
            status: "wired".into(),
            summary: "Open the Help window, optionally a topic page".into(),
        },
    ]
}

fn arg_f64(args: &Value, key: &str) -> Option<f64> {
    args.get(key).and_then(|v| {
        v.as_f64()
            .or_else(|| v.as_i64().map(|n| n as f64))
            .or_else(|| v.as_u64().map(|n| n as f64))
    })
}

fn window_snapshot(app: &AppHandle) -> Value {
    let Some(window) = app.get_webview_window("main") else {
        return json!(null);
    };
    let maximized = window.is_maximized().ok();
    let (width, height) = match (window.inner_size(), window.scale_factor()) {
        (Ok(size), Ok(scale)) if scale > 0.0 => (
            (f64::from(size.width) / scale).round() as i64,
            (f64::from(size.height) / scale).round() as i64,
        ),
        _ => {
            return json!({ "maximized": maximized });
        }
    };
    json!({ "width": width, "height": height, "maximized": maximized })
}

fn set_window_size(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let width = arg_f64(args, "width").unwrap_or(DEFAULT_WINDOW_WIDTH);
    let height = arg_f64(args, "height").unwrap_or(DEFAULT_WINDOW_HEIGHT);
    if !(width.is_finite() && height.is_finite()) || width < 400.0 || height < 400.0 {
        return Err("Window size must be at least 400x400".into());
    }
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;
    let _ = window.unmaximize();
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|e| format!("Could not set window size: {e}"))?;
    // macOS reports maximized for a beat after unmaximize.
    thread::sleep(Duration::from_millis(40));
    let mut out = window_snapshot(app);
    if out.is_null() {
        out = json!({
            "width": width.round() as i64,
            "height": height.round() as i64,
            "maximized": false,
        });
    }
    Ok(out)
}

fn require_signed_in() -> Result<Value, String> {
    let raw = ui_state().lock().map_err(|_| "UI state lock poisoned".to_string())?;
    let status = raw
        .get("auth")
        .and_then(|a| a.get("status"))
        .and_then(|s| s.as_str())
        .unwrap_or("signed_out");
    if status != "connected" {
        return Err("Not signed in — agent actions need a live session".into());
    }
    Ok(raw.clone())
}

fn ui_timeout_for(action: &str) -> Duration {
    match action {
        "sync.thumbs" => Duration::from_secs(6 * 60),
        "sync.media" => Duration::from_secs(15 * 60),
        "generation.start" => Duration::from_secs(12 * 60),
        _ => UI_TIMEOUT,
    }
}

fn wait_ui(app: &AppHandle, action: &str, args: Value) -> Result<Value, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::channel();
    pending()
        .lock()
        .map_err(|_| "Pending invoke lock poisoned".to_string())?
        .insert(id.clone(), tx);
    app.emit(
        "parascene:agent-request",
        json!({ "id": id, "action": action, "args": args }),
    )
    .map_err(|e| format!("Could not reach the UI: {e}"))?;
    match rx.recv_timeout(ui_timeout_for(action)) {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(err)) => {
            push_capped(errors(), json!({ "action": action, "error": err }));
            Err(err)
        }
        Err(_) => {
            if let Ok(mut map) = pending().lock() {
                map.remove(&id);
            }
            let err = format!("Timed out waiting for UI to handle {action}");
            push_capped(errors(), json!({ "action": action, "error": err }));
            Err(err)
        }
    }
}

fn get_state(app: &AppHandle, scope: Option<&str>) -> Result<Value, String> {
    let ui = ui_state()
        .lock()
        .map_err(|_| "UI state lock poisoned".to_string())?
        .clone();
    let library = match crate::library::paths::account_root() {
        Ok(_) => {
            let mut lib = json!({
                "bound": true,
                "accountRoot": crate::library::paths::account_root().ok().map(|p| p.display().to_string()),
                "needsSync": true,
            });
            if let Ok(status) = crate::library::current_sync_status() {
                if let Ok(serde_json::Value::Object(map)) = serde_json::to_value(&status) {
                    for (key, value) in map {
                        lib[key] = value;
                    }
                }
                lib["needsSync"] = json!(status.last_sync_at.is_none());
            }
            let folders = crate::library::current_folder_snapshot().unwrap_or_default();
            lib["folderCount"] = json!(folders.len());
            lib["folders"] = json!(folders);
            lib
        }
        Err(_) => json!({ "bound": false }),
    };
    let all = json!({
        "auth": ui.get("auth").cloned().unwrap_or(json!({ "status": "unknown" })),
        "shell": ui.get("shell").cloned().unwrap_or(json!(null)),
        "projects": ui.get("projects").cloned().unwrap_or(json!([])),
        "library": library,
        "window": window_snapshot(app),
    });
    Ok(match scope.unwrap_or("").trim() {
        "" | "all" => all,
        key => all.get(key).cloned().unwrap_or(json!(null)),
    })
}

fn invoke_action(app: &AppHandle, action: &str, args: Value) -> Result<Value, String> {
    push_capped(logs(), json!({ "action": action, "args": args }));
    match action {
        "project.create"
        | "project.open"
        | "project.close"
        | "project.delete"
        | "folder.create"
        | "folder.delete"
        | "cloud.delete"
        | "generation.start"
        | "sync.start"
        | "sync.folders"
        | "sync.thumbs"
        | "sync.media"
        | "library.clearLocal"
        | "library.lookup"
        | "shell.show" => {
            let _ = require_signed_in()?;
            wait_ui(app, action, args)
        }
        "help.open" => crate::help_window::show_help(
            app,
            args.get("topicId").and_then(|v| v.as_str()),
        ),
        "window.setSize" => set_window_size(app, &args),
        other => Err(format!("Unknown action: {other}")),
    }
}

fn reset(app: &AppHandle) -> Result<Value, String> {
    if let Ok(mut guard) = errors().lock() {
        guard.clear();
    }
    if let Ok(mut guard) = logs().lock() {
        guard.clear();
    }
    if require_signed_in().is_ok() {
        let _ = wait_ui(app, "project.close", json!({}));
    }
    Ok(json!({ "ok": true }))
}

struct ParsedRequest {
    method: String,
    path: String,
    query: HashMap<String, String>,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn parse_query(raw: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for part in raw.split('&') {
        if part.is_empty() {
            continue;
        }
        let mut kv = part.splitn(2, '=');
        let k = kv.next().unwrap_or("").to_string();
        let v = kv.next().unwrap_or("").to_string();
        out.insert(k, v);
    }
    out
}

fn parse_http(raw: &[u8]) -> Result<ParsedRequest, String> {
    let text = String::from_utf8_lossy(raw);
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((text.as_ref(), ""));
    let mut lines = head.lines();
    let request_line = lines.next().ok_or("Empty request")?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("/").to_string();
    let (path, query_raw) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (target, String::new()),
    };
    let mut headers = HashMap::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }
    Ok(ParsedRequest {
        method,
        path,
        query: parse_query(&query_raw),
        headers,
        body: body.as_bytes().to_vec(),
    })
}

fn json_response(status: u16, body: &Value) -> Vec<u8> {
    let raw = serde_json::to_vec(body).unwrap_or_else(|_| b"{}".to_vec());
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        _ => "Error",
    };
    format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\n\r\n",
        raw.len()
    )
    .into_bytes()
    .into_iter()
    .chain(raw)
    .collect()
}

fn authorized(req: &ParsedRequest, token: &str) -> bool {
    req.headers
        .get(TOKEN_HEADER)
        .map(|v| {
            let v = v.trim();
            v == token || v.strip_prefix("Bearer ").unwrap_or(v) == token
        })
        .unwrap_or(false)
}

fn handle(app: &AppHandle, token: &str, req: ParsedRequest) -> Vec<u8> {
    if req.method == "OPTIONS" {
        return b"HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: Authorization, Content-Type\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec();
    }
    if !authorized(&req, token) {
        return json_response(401, &json!({ "error": "Unauthorized" }));
    }
    let body_json: Value = serde_json::from_slice(&req.body).unwrap_or(json!({}));
    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/agent/v1/health") => json_response(200, &json!({ "ok": true, "service": "parascene-agent" })),
        ("GET", "/agent/v1/state") => match get_state(app, req.query.get("scope").map(String::as_str)) {
            Ok(v) => json_response(200, &v),
            Err(e) => json_response(400, &json!({ "error": e })),
        },
        ("GET", "/agent/v1/actions") => {
            let scope = req.query.get("scope").map(String::as_str).unwrap_or("");
            let list: Vec<AgentAction> = actions()
                .into_iter()
                .filter(|a| scope.is_empty() || a.scope == scope)
                .collect();
            json_response(200, &json!({ "actions": list }))
        }
        ("GET", "/agent/v1/errors") => {
            let rows = errors().lock().map(|g| g.iter().cloned().collect::<Vec<_>>()).unwrap_or_default();
            json_response(200, &json!({ "errors": rows }))
        }
        ("GET", "/agent/v1/logs") => {
            let rows = logs().lock().map(|g| g.iter().cloned().collect::<Vec<_>>()).unwrap_or_default();
            json_response(200, &json!({ "logs": rows }))
        }
        ("POST", "/agent/v1/invoke") => {
            let action = body_json
                .get("action")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let args = body_json.get("args").cloned().unwrap_or(json!({}));
            match invoke_action(app, action, args) {
                Ok(v) => json_response(200, &json!({ "ok": true, "result": v })),
                Err(e) => json_response(400, &json!({ "ok": false, "error": e })),
            }
        }
        ("POST", "/agent/v1/reset") => match reset(app) {
            Ok(v) => json_response(200, &v),
            Err(e) => json_response(400, &json!({ "ok": false, "error": e })),
        },
        _ => json_response(404, &json!({ "error": "Not found" })),
    }
}

fn write_manifest(origin: &str, token: &str) -> Result<(), String> {
    let machine = machine_root()?;
    std::fs::create_dir_all(&machine).map_err(|e| e.to_string())?;
    let path = machine.join("agent.json");
    let body = serde_json::to_string_pretty(&AgentManifest {
        origin: origin.to_string(),
        token: token.to_string(),
        pid: std::process::id(),
    })
    .map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

pub fn start(app: AppHandle) {
    thread::spawn(move || {
        let listener = match TcpListener::bind("127.0.0.1:0") {
            Ok(l) => l,
            Err(err) => {
                eprintln!("agent API bind failed: {err}");
                return;
            }
        };
        let port = match listener.local_addr() {
            Ok(addr) => addr.port(),
            Err(err) => {
                eprintln!("agent API addr failed: {err}");
                return;
            }
        };
        let token = uuid::Uuid::new_v4().to_string();
        let origin = format!("http://127.0.0.1:{port}");
        if let Err(err) = write_manifest(&origin, &token) {
            eprintln!("agent API manifest failed: {err}");
            return;
        }
        eprintln!("agent API listening on {origin}");
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let app = app.clone();
            let token = token.clone();
            thread::spawn(move || {
                let mut stream = stream;
                let mut buf = vec![0u8; 64 * 1024];
                let n = match stream.read(&mut buf) {
                    Ok(0) | Err(_) => return,
                    Ok(n) => n,
                };
                let req = match parse_http(&buf[..n]) {
                    Ok(req) => req,
                    Err(err) => {
                        let _ = stream.write_all(&json_response(400, &json!({ "error": err })));
                        return;
                    }
                };
                let response = handle(&app, &token, req);
                let _ = stream.write_all(&response);
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_get_with_scope() {
        let raw = b"GET /agent/v1/state?scope=auth HTTP/1.1\r\nAuthorization: Bearer abc\r\n\r\n";
        let req = parse_http(raw).unwrap();
        assert_eq!(req.method, "GET");
        assert_eq!(req.path, "/agent/v1/state");
        assert_eq!(req.query.get("scope").unwrap(), "auth");
        assert!(authorized(&req, "abc"));
        assert!(!authorized(&req, "nope"));
    }

    #[test]
    fn actions_include_planned_cloud_delete() {
        assert!(actions().iter().any(|a| a.id == "cloud.delete" && a.status == "wired"));
        assert!(actions().iter().any(|a| a.id == "generation.start" && a.status == "wired"));
        assert!(actions().iter().any(|a| a.id == "project.create" && a.status == "wired"));
        assert!(actions().iter().any(|a| a.id == "library.clearLocal" && a.status == "wired"));
        assert!(actions().iter().any(|a| a.id == "sync.folders" && a.status == "wired"));
        assert!(actions().iter().any(|a| a.id == "sync.thumbs" && a.status == "wired"));
        assert!(actions().iter().any(|a| a.id == "sync.media" && a.status == "wired"));
    }
}
