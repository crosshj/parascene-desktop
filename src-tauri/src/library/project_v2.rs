//! Project v2 is a typed group v2. Create/patch go through /api/create/group.

use super::parascene_api::{create_group_v2, get_creation, patch_group_v2};
use serde_json::{json, Value};

#[tauri::command]
pub async fn library_create_project_v2(
    title: String,
    items: Option<Value>,
    ids: Option<Vec<Value>>,
) -> Result<Value, String> {
    let items = items.filter(|value| value.is_array()).unwrap_or_else(|| json!([]));
    let ids = ids.unwrap_or_default();
    create_group_v2(title.trim(), &items, &ids, Some("project")).await
}

#[tauri::command]
pub async fn library_get_project_v2(id: String) -> Result<Value, String> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Err("project id is required".into());
    }
    get_creation(trimmed).await
}

#[tauri::command]
pub async fn library_patch_project_v2(id: String, body: Value) -> Result<Value, String> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Err("project id is required".into());
    }
    patch_group_v2(trimmed, &body).await
}
