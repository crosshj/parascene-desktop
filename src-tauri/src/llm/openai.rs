//! OpenAI Chat Completions adapter. Not called by UI code.

use super::{LlmMessage, LlmReply, LlmRole, LlmToolCall, LlmToolSpec, LlmTurn};
use reqwest::Client;
use serde_json::{json, Value};
use std::time::Duration;

const OPENAI_KEYCHAIN_KEY: &str = "parascene_openai_api_key";
const OPENAI_CHAT_URL: &str = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL: &str = "gpt-4o-mini";

pub fn configured() -> bool {
    crate::auth_store::keychain_get(OPENAI_KEYCHAIN_KEY.into())
        .ok()
        .flatten()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
}

fn role_name(role: LlmRole) -> &'static str {
    match role {
        LlmRole::System => "system",
        LlmRole::User => "user",
        LlmRole::Assistant => "assistant",
        LlmRole::Tool => "tool",
    }
}

fn message_json(message: &LlmMessage) -> Value {
    match message.role {
        LlmRole::Tool => json!({
            "role": "tool",
            "tool_call_id": message.tool_call_id,
            "content": message.content,
        }),
        LlmRole::Assistant if !message.tool_calls.is_empty() => {
            let content = if message.content.trim().is_empty() {
                Value::Null
            } else {
                Value::String(message.content.clone())
            };
            let tool_calls: Vec<Value> = message
                .tool_calls
                .iter()
                .map(|call| {
                    json!({
                        "id": call.id,
                        "type": "function",
                        "function": {
                            "name": call.name,
                            "arguments": call.arguments,
                        }
                    })
                })
                .collect();
            json!({
                "role": "assistant",
                "content": content,
                "tool_calls": tool_calls,
            })
        }
        _ => json!({
            "role": role_name(message.role),
            "content": message.content,
        }),
    }
}

fn tools_json(tools: &[LlmToolSpec]) -> Vec<Value> {
    tools
        .iter()
        .map(|tool| {
            json!({
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.parameters,
                }
            })
        })
        .collect()
}

fn parse_tool_calls(message: &Value) -> Vec<LlmToolCall> {
    let Some(rows) = message.get("tool_calls").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    rows.iter()
        .filter_map(|row| {
            let id = row.get("id")?.as_str()?.trim();
            if id.is_empty() {
                return None;
            }
            let function = row.get("function")?;
            let name = function.get("name")?.as_str()?.trim();
            if name.is_empty() {
                return None;
            }
            let arguments = function
                .get("arguments")
                .and_then(|v| v.as_str())
                .unwrap_or("{}");
            Some(LlmToolCall {
                id: id.to_string(),
                name: name.to_string(),
                arguments: arguments.to_string(),
            })
        })
        .collect()
}

fn choice_error(body: &Value) -> Option<String> {
    body.get("error")
        .and_then(|v| v.get("message"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

fn parse_assistant_turn(body: &Value) -> Result<LlmTurn, String> {
    if let Some(message) = choice_error(body) {
        return Err(message);
    }
    let message = body
        .get("choices")
        .and_then(|v| v.as_array())
        .and_then(|rows| rows.first())
        .and_then(|row| row.get("message"))
        .ok_or_else(|| "Language model returned an empty reply".to_string())?;
    let calls = parse_tool_calls(message);
    if !calls.is_empty() {
        return Ok(LlmTurn::ToolCalls(calls));
    }
    let content = message
        .get("content")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Language model returned an empty reply".to_string())?;
    Ok(LlmTurn::Message(LlmReply {
        content: content.to_string(),
    }))
}

async fn post_chat(messages: &[LlmMessage], tools: &[LlmToolSpec]) -> Result<Value, String> {
    let api_key = crate::auth_store::keychain_get(OPENAI_KEYCHAIN_KEY.into())?.unwrap_or_default();
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err(super::missing_credentials_message());
    }

    let request_messages: Vec<Value> = messages.iter().map(message_json).collect();
    let mut request = json!({
        "model": DEFAULT_MODEL,
        "messages": request_messages,
    });
    if !tools.is_empty() {
        request
            .as_object_mut()
            .expect("request object")
            .insert("tools".into(), Value::Array(tools_json(tools)));
    }

    let client = Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .post(OPENAI_CHAT_URL)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .json(&request)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach the language model: {e}"))?;
    let status = res.status();
    let body: Value = res.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let message = choice_error(&body).unwrap_or_else(|| format!("Language model HTTP {status}"));
        return Err(message);
    }
    Ok(body)
}

pub async fn complete_turn(
    messages: &[LlmMessage],
    tools: &[LlmToolSpec],
) -> Result<LlmTurn, String> {
    let body = post_chat(messages, tools).await?;
    parse_assistant_turn(&body)
}

#[cfg(test)]
mod tests {
    use super::{message_json, parse_assistant_turn};
    use crate::llm::{LlmMessage, LlmRole, LlmToolCall, LlmTurn};
    use serde_json::json;

    #[test]
    fn reads_choice_content() {
        let body = json!({
            "choices": [{ "message": { "content": "  try a wider lens  " } }]
        });
        match parse_assistant_turn(&body).unwrap() {
            LlmTurn::Message(reply) => assert_eq!(reply.content, "try a wider lens"),
            LlmTurn::ToolCalls(_) => panic!("expected a text reply"),
        }
    }

    #[test]
    fn reads_tool_calls() {
        let body = json!({
            "choices": [{
                "message": {
                    "content": null,
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": { "name": "project_info", "arguments": "{}" }
                    }]
                }
            }]
        });
        match parse_assistant_turn(&body).unwrap() {
            LlmTurn::ToolCalls(calls) => {
                assert_eq!(calls.len(), 1);
                assert_eq!(calls[0].id, "call_1");
                assert_eq!(calls[0].name, "project_info");
            }
            LlmTurn::Message(_) => panic!("expected tool calls"),
        }
    }

    #[test]
    fn serializes_tool_result_and_assistant_calls() {
        let tool = LlmMessage {
            role: LlmRole::Tool,
            content: "{\"title\":\"Night\"}".into(),
            tool_call_id: Some("call_1".into()),
            tool_calls: Vec::new(),
        };
        let tool_json = message_json(&tool);
        assert_eq!(tool_json["role"], "tool");
        assert_eq!(tool_json["tool_call_id"], "call_1");

        let assistant = LlmMessage {
            role: LlmRole::Assistant,
            content: String::new(),
            tool_call_id: None,
            tool_calls: vec![LlmToolCall {
                id: "call_1".into(),
                name: "project_info".into(),
                arguments: "{}".into(),
            }],
        };
        let assistant_json = message_json(&assistant);
        assert_eq!(assistant_json["role"], "assistant");
        assert!(assistant_json["content"].is_null());
        assert_eq!(assistant_json["tool_calls"][0]["function"]["name"], "project_info");
    }
}
