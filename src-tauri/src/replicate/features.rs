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

            let format = schema.get("format").and_then(|v| v.as_str()).unwrap_or("");
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
            if (n.contains("mask") || blob.contains("mask")) && !tags.iter().any(|t| t == "mask") {
                tags.push("mask".into());
            }
            if (n.contains("seed") || blob.contains("seed")) && !tags.iter().any(|t| t == "seed") {
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
    let schemas = model
        .pointer("/latest_version/openapi_schema/components/schemas")
        .and_then(|v| v.as_object());
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
            let enum_values = extract_enum_values(schema, schemas);
            let typ = resolve_field_type(schema, schemas, enum_values.as_ref());
            let format = schema
                .get("format")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let default_value = schema.get("default").cloned();
            let minimum = schema_number(schema, "minimum");
            let maximum = schema_number(schema, "maximum");
            let array_item_file_like = if typ == "array" {
                item_schema(schema, schemas)
                    .map(|item| schema_file_like(item, schemas))
                    .unwrap_or(false)
                    || looks_like_media_url_field(name, schema)
            } else {
                false
            };
            // URI / file inputs — format:uri, or string fields that clearly want a media URL
            // (e.g. minimax audio_url without format:uri).
            let file_like = schema_file_like(schema, schemas)
                || (typ == "string" && looks_like_media_url_field(name, schema));
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
                    format,
                    default_value,
                    enum_values,
                    minimum,
                    maximum,
                    file_like,
                    array_item_file_like,
                },
            )
        })
        .collect();
    fields.sort_by_key(|(o, _)| *o);
    fields.into_iter().map(|(_, f)| f).collect()
}

fn resolve_field_type(
    schema: &Value,
    schemas: Option<&serde_json::Map<String, Value>>,
    enum_values: Option<&Vec<String>>,
) -> String {
    if let Some(t) = schema.get("type").and_then(|v| v.as_str()) {
        return t.to_string();
    }
    if let Some(t) = resolve_type_from_schema(schema, schemas) {
        return t;
    }
    if let Some(vals) = enum_values {
        if !vals.is_empty() && vals.iter().all(|v| v.parse::<i64>().is_ok()) {
            return "integer".to_string();
        }
        if !vals.is_empty() && vals.iter().all(|v| v.parse::<f64>().is_ok()) {
            return "number".to_string();
        }
        if !vals.is_empty() {
            return "string".to_string();
        }
    }
    if schema.get("allOf").is_some() || schema.get("enum").is_some() {
        return "enum".to_string();
    }
    if schema.get("anyOf").is_some() || schema.get("oneOf").is_some() {
        return "union".to_string();
    }
    "unknown".to_string()
}

fn resolve_type_from_schema(
    schema: &Value,
    schemas: Option<&serde_json::Map<String, Value>>,
) -> Option<String> {
    if let Some(t) = schema.get("type").and_then(|v| v.as_str()) {
        return Some(t.to_string());
    }
    for key in ["allOf", "anyOf", "oneOf"] {
        let Some(items) = schema.get(key).and_then(|v| v.as_array()) else {
            continue;
        };
        for item in items {
            if let Some(t) = resolve_type_from_schema(item, schemas) {
                return Some(t);
            }
        }
    }
    if let Some(name) = schema
        .get("$ref")
        .and_then(|v| v.as_str())
        .and_then(local_schema_ref_name)
    {
        if let Some(resolved) = schemas.and_then(|m| m.get(name)) {
            return resolve_type_from_schema(resolved, schemas);
        }
    }
    None
}

fn schema_number(schema: &Value, key: &str) -> Option<f64> {
    schema.get(key).and_then(|v| {
        v.as_f64()
            .or_else(|| v.as_i64().map(|n| n as f64))
            .or_else(|| v.as_u64().map(|n| n as f64))
    })
}

fn item_schema<'a>(
    schema: &'a Value,
    schemas: Option<&'a serde_json::Map<String, Value>>,
) -> Option<&'a Value> {
    let items = schema.get("items")?;
    if let Some(name) = items
        .get("$ref")
        .and_then(|v| v.as_str())
        .and_then(local_schema_ref_name)
    {
        return schemas.and_then(|m| m.get(name));
    }
    Some(items)
}

fn schema_file_like(schema: &Value, schemas: Option<&serde_json::Map<String, Value>>) -> bool {
    if schema.get("format").and_then(|v| v.as_str()) == Some("uri") {
        return true;
    }
    if let Some(name) = schema
        .get("$ref")
        .and_then(|v| v.as_str())
        .and_then(local_schema_ref_name)
    {
        if let Some(resolved) = schemas.and_then(|m| m.get(name)) {
            return schema_file_like(resolved, schemas);
        }
    }
    false
}

/// Heuristic for string inputs that expect a publicly reachable media URL but omit `format: uri`.
fn looks_like_media_url_field(name: &str, schema: &Value) -> bool {
    if schema.get("enum").is_some() {
        return false;
    }
    let n = name.to_lowercase();
    let title = schema
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_lowercase();
    let desc = schema
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_lowercase();
    let blob = format!("{n} {title} {desc}");

    let urlish = n.ends_with("_url")
        || n.ends_with("_uri")
        || n.ends_with("_file")
        || n == "url"
        || n == "uri"
        || n == "audio"
        || n == "video"
        || n == "image"
        || desc.contains("publicly accessible")
        || desc.contains("http")
        || title.contains("url");
    let media = blob.contains("audio")
        || blob.contains("video")
        || blob.contains("image")
        || blob.contains("song")
        || blob.contains("music")
        || blob.contains("mp3")
        || blob.contains("wav")
        || blob.contains("mask")
        || blob.contains("photo")
        || blob.contains("picture");
    urlish && media
}

fn local_schema_ref_name(r: &str) -> Option<&str> {
    r.strip_prefix("#/components/schemas/")
}

fn schema_enum_array(schema: &Value) -> Option<&Vec<Value>> {
    schema.get("enum").and_then(|v| v.as_array())
}

/// Resolve inline `enum`, `allOf`/`anyOf` enums, and local `$ref`s under components/schemas.
fn extract_enum_values(
    schema: &Value,
    schemas: Option<&serde_json::Map<String, Value>>,
) -> Option<Vec<String>> {
    let mut out: Vec<String> = Vec::new();

    if let Some(arr) = schema_enum_array(schema) {
        push_enum_strings(arr, &mut out);
    }

    for key in ["allOf", "anyOf", "oneOf"] {
        let Some(items) = schema.get(key).and_then(|v| v.as_array()) else {
            continue;
        };
        for item in items {
            if let Some(arr) = schema_enum_array(item) {
                push_enum_strings(arr, &mut out);
            }
            if let Some(name) = item
                .get("$ref")
                .and_then(|v| v.as_str())
                .and_then(local_schema_ref_name)
            {
                if let Some(resolved) = schemas.and_then(|m| m.get(name)) {
                    if let Some(arr) = schema_enum_array(resolved) {
                        push_enum_strings(arr, &mut out);
                    }
                }
            }
        }
    }

    if let Some(name) = schema
        .get("$ref")
        .and_then(|v| v.as_str())
        .and_then(local_schema_ref_name)
    {
        if let Some(resolved) = schemas.and_then(|m| m.get(name)) {
            if let Some(arr) = schema_enum_array(resolved) {
                push_enum_strings(arr, &mut out);
            }
        }
    }

    if out.is_empty() {
        None
    } else {
        let mut deduped = Vec::new();
        for v in out {
            if !deduped.iter().any(|x| x == &v) {
                deduped.push(v);
            }
        }
        Some(deduped)
    }
}

fn push_enum_strings(arr: &[Value], out: &mut Vec<String>) {
    for x in arr {
        if let Some(s) = x.as_str() {
            out.push(s.to_string());
        } else if !x.is_null() {
            out.push(x.to_string());
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputFieldSummary {
    pub name: String,
    pub title: Option<String>,
    pub type_name: String,
    pub required: bool,
    pub description: Option<String>,
    pub format: Option<String>,
    pub default_value: Option<Value>,
    pub enum_values: Option<Vec<String>>,
    pub minimum: Option<f64>,
    pub maximum: Option<f64>,
    /// True when the field expects a URI/file scalar.
    pub file_like: bool,
    /// True when `type` is array and items are URI/file.
    pub array_item_file_like: bool,
}
