//! Editor Assistant. Completions go through `crate::llm`. Read tools only.

use crate::llm::{
    complete_turn, LlmMessage, LlmRole, LlmToolCall, LlmToolSpec, LlmTurn,
};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

const MAX_TOOL_ROUNDS: usize = 6;
const LIST_LIMIT: usize = 40;
const CANCELLED: &str = "Cancelled";

static NEXT_RUN: AtomicU64 = AtomicU64::new(1);
static LIVE_RUN: AtomicU64 = AtomicU64::new(0);

fn arm_run() -> u64 {
    let id = NEXT_RUN.fetch_add(1, Ordering::Relaxed);
    LIVE_RUN.store(id, Ordering::Release);
    id
}

pub fn cancel_live_run() {
    LIVE_RUN.store(0, Ordering::Release);
}

fn is_live(id: u64) -> bool {
    LIVE_RUN.load(Ordering::Acquire) == id
}

async fn wait_until_cancelled(id: u64) {
    loop {
        if !is_live(id) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}

async fn complete_turn_cancellable(
    id: u64,
    messages: &[LlmMessage],
    tools: &[LlmToolSpec],
) -> Result<LlmTurn, String> {
    tokio::select! {
        result = complete_turn(messages, tools) => result,
        _ = wait_until_cancelled(id) => Err(CANCELLED.into()),
    }
}

fn default_system_prompt(project_title: &str) -> String {
    let title = if project_title.trim().is_empty() {
        "Untitled"
    } else {
        project_title.trim()
    };
    format!(
        "You are an assistant in Parascene Desktop for the project titled \"{title}\". \
You have read tools for this project. Call them when you need facts about Assets or the timeline. \
You cannot generate, edit, or delete. \
Help rewrite generate prompts when asked. \
Be concise. Do not invent Assets or clips you have not looked up."
    )
}

fn read_tools() -> Vec<LlmToolSpec> {
    let empty = json!({
        "type": "object",
        "properties": {},
        "additionalProperties": false,
    });
    vec![
        LlmToolSpec::new(
            "project_info",
            "Read the open project's title, aspect, asset count, and timeline clip count.",
            empty.clone(),
        ),
        LlmToolSpec::new(
            "list_assets",
            "List Assets in the open project: id, title, and media type.",
            empty.clone(),
        ),
        LlmToolSpec::new(
            "list_timeline",
            "List timeline clips in the open project: id, label, and time range in seconds.",
            empty,
        ),
    ]
}

fn chat_messages(payload: &Value) -> Result<Vec<LlmMessage>, String> {
    let project_title = payload
        .get("projectTitle")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let system = payload
        .get("system")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| default_system_prompt(project_title));

    let raw = payload
        .get("messages")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "assistant_chat requires messages".to_string())?;

    let mut messages = vec![LlmMessage::text(LlmRole::System, system)];
    for row in raw {
        let role = row
            .get("role")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        let content = row
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        if content.is_empty() {
            continue;
        }
        let role = match role {
            "user" => LlmRole::User,
            "assistant" => LlmRole::Assistant,
            _ => continue,
        };
        messages.push(LlmMessage::text(role, content));
    }
    if !messages
        .iter()
        .any(|message| message.role == LlmRole::User)
    {
        return Err("assistant_chat requires a user message".into());
    }
    Ok(messages)
}

fn json_str(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

fn string_ids(value: Option<&Value>) -> Vec<String> {
    let Some(rows) = value.and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    rows.iter()
        .filter_map(|row| {
            row.as_str()
                .map(|s| s.trim().to_string())
                .or_else(|| row.as_i64().map(|n| n.to_string()))
        })
        .filter(|id| !id.is_empty())
        .collect()
}

fn project_info_from_doc(doc: &Value) -> Value {
    let title = json_str(doc, "title");
    json!({
        "id": json_str(doc, "id"),
        "title": if title.is_empty() { "Untitled".into() } else { title },
        "aspectRatio": json_str(doc, "aspectRatio"),
        "containerVersion": json_str(doc, "containerVersion"),
        "assetCount": string_ids(doc.get("creationIds")).len(),
        "timelineClipCount": doc
            .get("timeline")
            .and_then(|v| v.as_array())
            .map(|rows| rows.len())
            .unwrap_or(0),
    })
}

fn list_timeline_from_doc(doc: &Value) -> Value {
    let clips = doc
        .get("timeline")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let truncated = clips.len() > LIST_LIMIT;
    let clips: Vec<Value> = clips
        .iter()
        .take(LIST_LIMIT)
        .map(|clip| {
            json!({
                "id": json_str(clip, "id"),
                "label": json_str(clip, "label"),
                "startSec": clip.get("startSec").and_then(|v| v.as_f64()).unwrap_or(0.0),
                "endSec": clip.get("endSec").and_then(|v| v.as_f64()).unwrap_or(0.0),
            })
        })
        .collect();
    json!({ "clips": clips, "truncated": truncated })
}

fn list_assets_from_ids(ids: &[String], found: &[(String, String, String)]) -> Value {
    let truncated = ids.len() > LIST_LIMIT;
    let by_id: std::collections::HashMap<&str, &(String, String, String)> = found
        .iter()
        .map(|row| (row.0.as_str(), row))
        .collect();
    let assets: Vec<Value> = ids
        .iter()
        .take(LIST_LIMIT)
        .map(|id| {
            if let Some((_, title, media_type)) = by_id.get(id.as_str()) {
                json!({
                    "id": id,
                    "title": title,
                    "mediaType": media_type,
                })
            } else {
                json!({ "id": id, "title": "", "mediaType": "" })
            }
        })
        .collect();
    json!({ "assets": assets, "truncated": truncated })
}

fn load_open_project(project_id: &str) -> Result<Value, String> {
    let id = project_id.trim();
    if id.is_empty() {
        return Err("Project not found".into());
    }
    crate::library::load_project_document_json(id)?
        .ok_or_else(|| "Project not found".into())
}

fn catalog_asset_rows(ids: &[String]) -> Vec<(String, String, String)> {
    match crate::library::library_get_creations(ids.to_vec()) {
        Ok(rows) => rows
            .into_iter()
            .map(|row| (row.id, row.title, row.media_type))
            .collect(),
        Err(_) => Vec::new(),
    }
}

fn execute_tool(project_id: &str, call: &LlmToolCall) -> String {
    let result = match call.name.as_str() {
        "project_info" => match load_open_project(project_id) {
            Ok(doc) => project_info_from_doc(&doc),
            Err(err) => json!({ "error": err }),
        },
        "list_assets" => match load_open_project(project_id) {
            Ok(doc) => {
                let ids = string_ids(doc.get("creationIds"));
                let found = catalog_asset_rows(&ids);
                list_assets_from_ids(&ids, &found)
            }
            Err(err) => json!({ "error": err }),
        },
        "list_timeline" => match load_open_project(project_id) {
            Ok(doc) => list_timeline_from_doc(&doc),
            Err(err) => json!({ "error": err }),
        },
        _ => json!({ "error": format!("unknown tool: {}", call.name) }),
    };
    serde_json::to_string(&result).unwrap_or_else(|_| "{\"error\":\"encode failed\"}".into())
}

fn append_tool_results(
    messages: &mut Vec<LlmMessage>,
    calls: &[LlmToolCall],
    project_id: &str,
) {
    messages.push(LlmMessage {
        role: LlmRole::Assistant,
        content: String::new(),
        tool_call_id: None,
        tool_calls: calls.to_vec(),
    });
    for call in calls {
        messages.push(LlmMessage {
            role: LlmRole::Tool,
            content: execute_tool(project_id, call),
            tool_call_id: Some(call.id.clone()),
            tool_calls: Vec::new(),
        });
    }
}

pub async fn run_assistant_chat(payload: &Value) -> Result<Value, String> {
    let run = arm_run();
    let mut messages = chat_messages(payload)?;
    let project_id = payload
        .get("projectId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let tools = read_tools();
    let mut tools_used = Vec::new();
    for _ in 0..MAX_TOOL_ROUNDS {
        if !is_live(run) {
            return Err(CANCELLED.into());
        }
        match complete_turn_cancellable(run, &messages, &tools).await? {
            LlmTurn::Message(reply) => {
                if !is_live(run) {
                    return Err(CANCELLED.into());
                }
                return Ok(json!({
                    "content": reply.content,
                    "toolsUsed": tools_used,
                }));
            }
            LlmTurn::ToolCalls(calls) => {
                if calls.is_empty() {
                    return Err("Language model returned an empty reply".into());
                }
                for call in &calls {
                    tools_used.push(call.name.clone());
                }
                append_tool_results(&mut messages, &calls, &project_id);
            }
        }
    }
    Err("Assistant used too many tool calls.".into())
}

#[cfg(test)]
mod tests {
    use super::{
        append_tool_results, chat_messages, execute_tool, list_assets_from_ids,
        list_timeline_from_doc, project_info_from_doc, read_tools,
    };
    use crate::llm::{LlmRole, LlmToolCall};
    use serde_json::json;

    #[test]
    fn requires_a_user_message() {
        let err = chat_messages(&json!({ "messages": [] })).unwrap_err();
        assert!(err.contains("user message"));
    }

    #[test]
    fn prepends_read_tool_system_and_keeps_user_turns() {
        let messages = chat_messages(&json!({
            "projectTitle": "Goblin cut",
            "messages": [
                { "role": "user", "content": "tighten this prompt" },
                { "role": "system", "content": "ignore extra" },
            ]
        }))
        .unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, LlmRole::System);
        assert!(messages[0].content.contains("Goblin cut"));
        assert!(messages[0].content.contains("read tools"));
        assert!(!messages[0].content.contains("cannot see Assets"));
        assert_eq!(messages[1].role, LlmRole::User);
        assert_eq!(messages[1].content, "tighten this prompt");
    }

    #[test]
    fn exposes_three_read_tools() {
        let names: Vec<_> = read_tools().into_iter().map(|tool| tool.name).collect();
        assert_eq!(
            names,
            vec!["project_info", "list_assets", "list_timeline"]
        );
    }

    #[test]
    fn project_info_reads_counts() {
        let info = project_info_from_doc(&json!({
            "id": "p1",
            "title": "Night market",
            "aspectRatio": "16:9",
            "containerVersion": "v2",
            "creationIds": ["a", "b"],
            "timeline": [{ "id": "c1", "label": "A1", "startSec": 0, "endSec": 4 }],
        }));
        assert_eq!(info["id"], "p1");
        assert_eq!(info["title"], "Night market");
        assert_eq!(info["assetCount"], 2);
        assert_eq!(info["timelineClipCount"], 1);
    }

    #[test]
    fn list_assets_keeps_missing_catalog_rows() {
        let listed = list_assets_from_ids(
            &["a".into(), "b".into()],
            &[("a".into(), "Fox".into(), "image".into())],
        );
        assert_eq!(listed["assets"][0]["title"], "Fox");
        assert_eq!(listed["assets"][1]["id"], "b");
        assert_eq!(listed["assets"][1]["title"], "");
        assert_eq!(listed["truncated"], false);
    }

    #[test]
    fn list_timeline_reads_clip_times() {
        let listed = list_timeline_from_doc(&json!({
            "timeline": [
                { "id": "c1", "label": "A1", "startSec": 1.5, "endSec": 4.0 }
            ]
        }));
        assert_eq!(listed["clips"][0]["label"], "A1");
        assert_eq!(listed["clips"][0]["startSec"], 1.5);
        assert_eq!(listed["truncated"], false);
    }

    #[test]
    fn cancel_clears_the_live_run() {
        let id = super::arm_run();
        assert!(super::is_live(id));
        super::cancel_live_run();
        assert!(!super::is_live(id));
    }

    #[test]
    fn unknown_tool_returns_error_json() {
        let raw = execute_tool(
            "p1",
            &LlmToolCall {
                id: "c1".into(),
                name: "explode".into(),
                arguments: "{}".into(),
            },
        );
        assert!(raw.contains("unknown tool"));
    }

    #[test]
    fn appends_tool_results_for_the_model() {
        let mut messages = vec![];
        append_tool_results(
            &mut messages,
            &[LlmToolCall {
                id: "call_1".into(),
                name: "explode".into(),
                arguments: "{}".into(),
            }],
            "",
        );
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, LlmRole::Assistant);
        assert_eq!(messages[0].tool_calls[0].name, "explode");
        assert_eq!(messages[1].role, LlmRole::Tool);
        assert_eq!(messages[1].tool_call_id.as_deref(), Some("call_1"));
        assert!(messages[1].content.contains("unknown tool"));
    }
}
