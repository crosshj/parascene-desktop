//! Official Replicate models (MiniMax H3, etc.) often omit `latest_version`
//! on `GET /v1/models/{owner}/{name}` and 404 on `/versions`. The public
//! `/api` playground page still embeds OpenAPI. Fetch-full reads that page.
//! Never persist the page's playground token.

use serde_json::{json, Value};

const VERSIONLESS_KEY: &str = "_parascene_versionless";
const SCHEMA_SOURCE_KEY: &str = "_parascene_schema_source";
const SCHEMA_SOURCE_PAGE: &str = "replicate_api_page";

#[derive(Debug, Clone)]
pub struct PageSchema {
    pub version_id: Option<String>,
    pub created_at: Option<String>,
    pub openapi_schema: Value,
    pub versionless: bool,
}

pub fn is_versionless(raw: &Value) -> bool {
    raw.get(VERSIONLESS_KEY)
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

pub fn parse_api_page_schema(html: &str) -> Result<PageSchema, String> {
    let mut last_err: Option<String> = None;
    for blob in json_script_blobs(html) {
        match serde_json::from_str::<Value>(blob) {
            Ok(value) => {
                if let Some(parsed) = page_schema_from_json(&value) {
                    return Ok(parsed);
                }
            }
            Err(e) => last_err = Some(e.to_string()),
        }
    }
    Err(last_err.unwrap_or_else(|| {
        "Replicate API page did not include an OpenAPI schema".to_string()
    }))
}

pub fn apply_page_schema(model: &mut Value, page: &PageSchema) -> Result<(), String> {
    let obj = model
        .as_object_mut()
        .ok_or_else(|| "Model JSON is not an object".to_string())?;
    let mut latest = serde_json::Map::new();
    if let Some(id) = page.version_id.as_deref().filter(|s| !s.is_empty()) {
        latest.insert("id".into(), json!(id));
    }
    if let Some(ts) = page.created_at.as_deref().filter(|s| !s.is_empty()) {
        latest.insert("created_at".into(), json!(ts));
    }
    latest.insert("openapi_schema".into(), page.openapi_schema.clone());
    obj.insert("latest_version".into(), Value::Object(latest));
    obj.insert(VERSIONLESS_KEY.into(), json!(page.versionless));
    obj.insert(SCHEMA_SOURCE_KEY.into(), json!(SCHEMA_SOURCE_PAGE));
    Ok(())
}

fn json_script_blobs(html: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(rel) = html[i..].find("<script") {
        let start = i + rel;
        let after_tag_name = &html[start..];
        let Some(tag_end_rel) = after_tag_name.find('>') else {
            break;
        };
        let tag = &after_tag_name[..=tag_end_rel];
        let body_start = start + tag_end_rel + 1;
        let Some(close_rel) = html[body_start..].find("</script>") else {
            break;
        };
        let body = &html[body_start..body_start + close_rel];
        i = body_start + close_rel + 9;
        if tag.contains("application/json") {
            out.push(body);
        }
    }
    out
}

fn page_schema_from_json(value: &Value) -> Option<PageSchema> {
    let version = value.get("version")?;
    let extras = version.get("_extras")?;
    let openapi = extras.get("dereferenced_openapi_schema")?;
    if !openapi_has_input(openapi) {
        return None;
    }
    let versionless = value
        .get("usesVersionlessApi")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    Some(PageSchema {
        version_id: version
            .get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        created_at: version
            .get("created_at")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        openapi_schema: openapi.clone(),
        versionless,
    })
}

fn openapi_has_input(openapi: &Value) -> bool {
    openapi
        .pointer("/components/schemas/Input/properties")
        .and_then(|v| v.as_object())
        .map(|o| !o.is_empty())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = r#"<html><script id="react-component-props-a" type="application/json">{"theme":"light"}</script>
<script id="react-component-props-b" type="application/json">{"usesVersionlessApi":true,"token":"do-not-store","version":{"id":"c1496d254e0a0b09b6390942f1dabc9ba6c740323db0b4917463bde5912c4028","created_at":"2026-08-13T20:03:51.214641Z","_extras":{"dereferenced_openapi_schema":{"openapi":"3.0.2","components":{"schemas":{"Input":{"type":"object","required":["prompt"],"properties":{"prompt":{"type":"string"},"first_frame_image":{"type":"string","format":"uri"},"reference_image_urls":{"type":"array"}}}}}}}}}</script></html>"#;

    #[test]
    fn parses_dereferenced_schema_and_skips_token() {
        let parsed = parse_api_page_schema(PAGE).expect("parse");
        assert!(parsed.versionless);
        assert_eq!(
            parsed.version_id.as_deref(),
            Some("c1496d254e0a0b09b6390942f1dabc9ba6c740323db0b4917463bde5912c4028")
        );
        assert_eq!(
            parsed
                .openapi_schema
                .pointer("/components/schemas/Input/properties/reference_image_urls")
                .and_then(|v| v.get("type"))
                .and_then(|v| v.as_str()),
            Some("array")
        );

        let mut model = json!({
            "owner": "minimax",
            "name": "h3",
            "latest_version": null
        });
        apply_page_schema(&mut model, &parsed).expect("apply");
        assert_eq!(model.get("token"), None);
        assert_eq!(model.get(VERSIONLESS_KEY), Some(&json!(true)));
        assert!(is_versionless(&model));
        assert!(super::super::features::has_input_schema(&model));
    }

    #[test]
    fn missing_schema_is_an_error() {
        let html = r#"<script type="application/json">{"usesVersionlessApi":true}</script>"#;
        assert!(parse_api_page_schema(html).is_err());
    }
}
