//! Provider-neutral language model.
//!
//! Callers ask for a completion. They do not pick a vendor or model.
//! OpenAI is the first adapter. Add another by extending `LlmBackend`.

mod openai;

use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LlmRole {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LlmToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LlmToolSpec {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

impl LlmToolSpec {
    pub fn new(
        name: impl Into<String>,
        description: impl Into<String>,
        parameters: Value,
    ) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            parameters,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LlmMessage {
    pub role: LlmRole,
    pub content: String,
    pub tool_call_id: Option<String>,
    pub tool_calls: Vec<LlmToolCall>,
}

impl LlmMessage {
    pub fn text(role: LlmRole, content: impl Into<String>) -> Self {
        Self {
            role,
            content: content.into(),
            tool_call_id: None,
            tool_calls: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LlmReply {
    pub content: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LlmTurn {
    Message(LlmReply),
    ToolCalls(Vec<LlmToolCall>),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LlmBackend {
    OpenAi,
    #[cfg(test)]
    TestReady,
    #[cfg(test)]
    TestMissing,
}

const MISSING_CREDENTIALS: &str = "Language model API key missing — set it in Settings.";

impl LlmBackend {
    pub fn all() -> &'static [LlmBackend] {
        &[LlmBackend::OpenAi]
    }

    #[cfg(test)]
    pub fn id(self) -> &'static str {
        match self {
            LlmBackend::OpenAi => "openai",
            #[cfg(test)]
            LlmBackend::TestReady => "test",
            #[cfg(test)]
            LlmBackend::TestMissing => "test-missing",
        }
    }

    pub fn configured(self) -> bool {
        match self {
            LlmBackend::OpenAi => openai::configured(),
            #[cfg(test)]
            LlmBackend::TestReady => true,
            #[cfg(test)]
            LlmBackend::TestMissing => false,
        }
    }

    pub async fn complete_turn(
        self,
        messages: &[LlmMessage],
        tools: &[LlmToolSpec],
    ) -> Result<LlmTurn, String> {
        match self {
            LlmBackend::OpenAi => openai::complete_turn(messages, tools).await,
            #[cfg(test)]
            LlmBackend::TestReady => Ok(test_ready_turn(messages, tools)),
            #[cfg(test)]
            LlmBackend::TestMissing => Err(MISSING_CREDENTIALS.into()),
        }
    }
}

#[cfg(test)]
fn test_ready_turn(messages: &[LlmMessage], tools: &[LlmToolSpec]) -> LlmTurn {
    if !tools.is_empty() && !messages.iter().any(|message| message.role == LlmRole::Tool) {
        return LlmTurn::ToolCalls(vec![LlmToolCall {
            id: "call_test".into(),
            name: tools[0].name.clone(),
            arguments: "{}".into(),
        }]);
    }
    LlmTurn::Message(LlmReply {
        content: "test reply".into(),
    })
}

pub fn any_configured() -> bool {
    LlmBackend::all().iter().any(|backend| backend.configured())
}

pub fn missing_credentials_message() -> String {
    MISSING_CREDENTIALS.into()
}

pub fn resolve() -> Result<LlmBackend, String> {
    resolve_from(LlmBackend::all())
}

fn resolve_from(backends: &[LlmBackend]) -> Result<LlmBackend, String> {
    backends
        .iter()
        .copied()
        .find(|backend| backend.configured())
        .ok_or_else(|| MISSING_CREDENTIALS.to_string())
}

/// One turn. May be a reply or tool calls for the caller to run.
pub async fn complete_turn(
    messages: &[LlmMessage],
    tools: &[LlmToolSpec],
) -> Result<LlmTurn, String> {
    resolve()?.complete_turn(messages, tools).await
}

#[cfg(test)]
mod tests {
    use super::{
        resolve_from, test_ready_turn, LlmBackend, LlmMessage, LlmRole, LlmTurn,
        LlmToolSpec, MISSING_CREDENTIALS,
    };
    use serde_json::json;

    #[test]
    fn picks_the_first_configured_backend() {
        let chosen = resolve_from(&[LlmBackend::TestMissing, LlmBackend::TestReady]).unwrap();
        assert_eq!(chosen, LlmBackend::TestReady);
        assert_eq!(chosen.id(), "test");
    }

    #[test]
    fn errors_when_no_backend_has_credentials() {
        let err = resolve_from(&[LlmBackend::TestMissing]).unwrap_err();
        assert_eq!(err, MISSING_CREDENTIALS);
    }

    #[test]
    fn test_backend_asks_for_the_first_tool_then_replies() {
        let tools = [LlmToolSpec::new(
            "project_info",
            "Read the open project.",
            json!({ "type": "object", "properties": {} }),
        )];
        let first = test_ready_turn(&[LlmMessage::text(LlmRole::User, "hi")], &tools);
        match first {
            LlmTurn::ToolCalls(calls) => {
                assert_eq!(calls.len(), 1);
                assert_eq!(calls[0].name, "project_info");
            }
            LlmTurn::Message(_) => panic!("expected a tool call"),
        }
        let with_tool = [
            LlmMessage::text(LlmRole::User, "hi"),
            LlmMessage::text(LlmRole::Tool, "{}"),
        ];
        match test_ready_turn(&with_tool, &tools) {
            LlmTurn::Message(reply) => assert_eq!(reply.content, "test reply"),
            LlmTurn::ToolCalls(_) => panic!("expected a text reply"),
        }
    }
}
