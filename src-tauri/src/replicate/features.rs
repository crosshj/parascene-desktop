use serde_json::Value;

/// Derive lightweight capability tags from list/detail model JSON (no LLM).
pub fn features_from_model(model: &Value) -> Vec<String> {
    let mut tags: Vec<String> = Vec::new();

    let desc = model
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_lowercase();

    if model
        .get("cover_image_url")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .is_some()
    {
        tags.push("cover".into());
    }

    for (needle, tag) in [
        ("image", "image"),
        ("video", "video"),
        ("audio", "audio"),
        ("music", "audio"),
        ("speech", "audio"),
        ("text", "text"),
        ("llm", "text"),
        ("upscal", "upscale"),
        ("inpaint", "inpaint"),
        ("mask", "mask"),
        ("lip", "lipsync"),
        ("motion", "motion"),
    ] {
        if desc.contains(needle) && !tags.iter().any(|t| t == tag) {
            tags.push(tag.into());
        }
    }

    // OpenAPI Input properties when detail is present.
    if let Some(props) = model
        .pointer("/latest_version/openapi_schema/components/schemas/Input/properties")
        .and_then(|v| v.as_object())
    {
        for (name, schema) in props {
            let n = name.to_lowercase();
            let title = schema
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_lowercase();
            let desc_f = schema
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_lowercase();
            let blob = format!("{n} {title} {desc_f}");

            let format = schema
                .get("format")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let typ = schema.get("type").and_then(|v| v.as_str()).unwrap_or("");

            if (format == "uri" || blob.contains("image") || n.contains("image"))
                && !tags.iter().any(|t| t == "image_in")
            {
                tags.push("image_in".into());
            }
            if (blob.contains("video") || n.contains("video"))
                && !tags.iter().any(|t| t == "video_in")
            {
                tags.push("video_in".into());
            }
            if (blob.contains("audio") || n.contains("audio"))
                && !tags.iter().any(|t| t == "audio_in")
            {
                tags.push("audio_in".into());
            }
            if (n.contains("prompt") || blob.contains("prompt"))
                && !tags.iter().any(|t| t == "prompt")
            {
                tags.push("prompt".into());
            }
            if (n.contains("mask") || blob.contains("mask"))
                && !tags.iter().any(|t| t == "mask")
            {
                tags.push("mask".into());
            }
            if (n.contains("seed") || blob.contains("seed"))
                && !tags.iter().any(|t| t == "seed")
            {
                tags.push("seed".into());
            }
            if schema.get("enum").is_some() && !tags.iter().any(|t| t == "enum") {
                tags.push("enum".into());
            }
            if typ == "boolean" && !tags.iter().any(|t| t == "bool") {
                tags.push("bool".into());
            }
            if (typ == "integer" || typ == "number") && !tags.iter().any(|t| t == "number") {
                tags.push("number".into());
            }
        }
        if !tags.iter().any(|t| t == "schema") {
            tags.push("schema".into());
        }
    }

    tags.sort();
    tags.dedup();
    tags
}

/// Compact input field summary for detail UI.
pub fn input_summary(model: &Value) -> Vec<InputFieldSummary> {
    let Some(props) = model
        .pointer("/latest_version/openapi_schema/components/schemas/Input/properties")
        .and_then(|v| v.as_object())
    else {
        return Vec::new();
    };
    let required: Vec<String> = model
        .pointer("/latest_version/openapi_schema/components/schemas/Input/required")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let mut fields: Vec<(i64, InputFieldSummary)> = props
        .iter()
        .map(|(name, schema)| {
            let order = schema
                .get("x-order")
                .and_then(|v| v.as_i64())
                .unwrap_or(999);
            let typ = schema
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or(
                    if schema.get("allOf").is_some() {
                        "enum"
                    } else if schema.get("anyOf").is_some() {
                        "union"
                    } else {
                        "unknown"
                    },
                )
                .to_string();
            (
                order,
                InputFieldSummary {
                    name: name.clone(),
                    title: schema
                        .get("title")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                    type_name: typ,
                    required: required.iter().any(|r| r == name),
                    description: schema
                        .get("description")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                },
            )
        })
        .collect();
    fields.sort_by_key(|(o, _)| *o);
    fields.into_iter().map(|(_, f)| f).collect()
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputFieldSummary {
    pub name: String,
    pub title: Option<String>,
    pub type_name: String,
    pub required: bool,
    pub description: Option<String>,
}
