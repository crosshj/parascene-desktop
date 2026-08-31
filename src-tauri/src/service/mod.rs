//! Service kernel — describe / invoke front door over the jobs table.
//!
//! See docs/PLAN-service-and-forms.md. FE never owns provider recipes.

use crate::auth_store;
use crate::library::clip_thumb::ensure_clip_thumb_path;
use crate::library::run_refresh_creations_by_id;
use crate::library::{
    delete_audio_clip, delete_creation, get_creation, get_credits, get_library_folders,
    group_creations, jobs_cancel, jobs_enqueue, jobs_get, jobs_list, library_read_file_base64,
    library_read_local_thumb_base64, mutate_library_folders, record_audio_clip, ungroup_creations,
    upload_ephemeral_still, upload_fit_thumbnail, upload_generic_image, EnqueueJobRequest, Job,
};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlacementPolicy {
    pub lane: String,
    pub inputs: String,
    pub outputs: String,
    pub intermediates: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldSchema {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub kind: String,
    pub required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_value: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enum_values: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minimum: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub maximum: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_slot: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hidden: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub advanced: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub persist: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceCredentialGate {
    pub required: bool,
    pub configured: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceListEntry {
    pub service: String,
    pub operation: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceDescribeRequest {
    pub service: String,
    pub operation: String,
    #[serde(default)]
    pub context: Option<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceDescribe {
    pub service: String,
    pub operation: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub fields: Vec<FieldSchema>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placement: Option<PlacementPolicy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credentials: Option<ServiceCredentialGate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub needs_timeline_context: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allowed_targets: Option<Vec<String>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceInvokeRequest {
    pub service: String,
    pub operation: String,
    #[serde(default)]
    pub payload: Value,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub client_request_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum ServiceHandle {
    #[serde(rename_all = "camelCase")]
    Job { id: String },
    #[serde(rename_all = "camelCase")]
    Result { data: Value },
}

struct OpDef {
    service: &'static str,
    operation: &'static str,
    status: &'static str,
    label: &'static str,
    description: &'static str,
    /// Existing jobs.kind when invoke enqueues durable work.
    job_kind: Option<&'static str>,
    placement: Option<PlacementPolicy>,
}

fn placement_parascene_creation() -> PlacementPolicy {
    PlacementPolicy {
        lane: "parascene".into(),
        inputs: "creation_required".into(),
        outputs: "creation_and_catalog".into(),
        intermediates: "transport_only".into(),
    }
}

fn placement_blue_direct() -> PlacementPolicy {
    PlacementPolicy {
        lane: "blue_direct".into(),
        inputs: "local_ok".into(),
        outputs: "local_catalog_only".into(),
        intermediates: "durable_local".into(),
    }
}

fn placement_replicate() -> PlacementPolicy {
    PlacementPolicy {
        lane: "replicate".into(),
        inputs: "local_ok".into(),
        outputs: "local_catalog_only".into(),
        intermediates: "durable_local".into(),
    }
}

fn placement_sync() -> PlacementPolicy {
    PlacementPolicy {
        lane: "parascene".into(),
        inputs: "none".into(),
        outputs: "creation_and_catalog".into(),
        intermediates: "transport_only".into(),
    }
}

fn placement_local() -> PlacementPolicy {
    PlacementPolicy {
        lane: "local".into(),
        inputs: "local_ok".into(),
        outputs: "local_catalog_only".into(),
        intermediates: "durable_local".into(),
    }
}

fn placement_publisher() -> PlacementPolicy {
    PlacementPolicy {
        lane: "local".into(),
        inputs: "local_ok".into(),
        outputs: "files_only".into(),
        intermediates: "durable_local".into(),
    }
}

fn registry() -> Vec<OpDef> {
    vec![
        OpDef {
            service: "parascene",
            operation: "ensure_project_groups",
            status: "wired",
            label: "Ensure project groups",
            description: "Create or resume Images/Videos cabinets for a project.",
            job_kind: Some("ensure_project_groups"),
            placement: Some(placement_parascene_creation()),
        },
        OpDef {
            service: "parascene",
            operation: "cleanup_project_groups",
            status: "wired",
            label: "Cleanup project groups",
            description: "Delete project group creations on Parascene and locally.",
            job_kind: Some("cleanup_project_groups"),
            placement: Some(placement_parascene_creation()),
        },
        OpDef {
            service: "parascene",
            operation: "generate",
            status: "wired",
            label: "Generate",
            description: "Create → wait → ingest → file into project Images (stills first).",
            job_kind: Some("parascene_generate"),
            placement: Some(placement_parascene_creation()),
        },
        OpDef {
            service: "parascene",
            operation: "create_media",
            status: "wired",
            label: "Create media",
            description: "Create a Parascene Creation (generic primitive).",
            job_kind: Some("create_media"),
            placement: Some(placement_parascene_creation()),
        },
        OpDef {
            service: "parascene",
            operation: "wait_creation",
            status: "wired",
            label: "Wait creation",
            description: "Poll until a Parascene Creation completes.",
            job_kind: Some("wait_creation"),
            placement: Some(placement_parascene_creation()),
        },
        OpDef {
            service: "parascene",
            operation: "group_creations",
            status: "wired",
            label: "Group creations",
            description: "Group Parascene Creations into a cabinet.",
            job_kind: Some("group_creations"),
            placement: Some(placement_parascene_creation()),
        },
        OpDef {
            service: "parascene",
            operation: "delete_creation",
            status: "wired",
            label: "Delete creation",
            description: "Delete a Parascene Creation.",
            job_kind: Some("delete_creation"),
            placement: Some(placement_parascene_creation()),
        },
        OpDef {
            service: "parascene",
            operation: "get_creation",
            status: "wired",
            label: "Get creation",
            description: "Fetch one Parascene creation record (sync Result handle).",
            job_kind: None,
            placement: Some(placement_parascene_creation()),
        },
        OpDef {
            service: "parascene",
            operation: "upload_fit_thumbnail",
            status: "wired",
            label: "Upload fit thumbnail",
            description: "Push local board preview JPEG to Parascene as ?variant=fit.",
            job_kind: None,
            placement: Some(placement_parascene_creation()),
        },
        OpDef {
            service: "parascene",
            operation: "group_append",
            status: "wired",
            label: "Group append",
            description: "Group creations synchronously (Library filing).",
            job_kind: None,
            placement: Some(placement_parascene_creation()),
        },
        OpDef {
            service: "parascene",
            operation: "get_credits",
            status: "wired",
            label: "Get credits",
            description: "Fetch Parascene credit balance (sync Result handle).",
            job_kind: None,
            placement: None,
        },
        OpDef {
            service: "parascene",
            operation: "record_audio_clip",
            status: "wired",
            label: "Record audio clip",
            description: "Upload raw audio bytes as a reusable library clip.",
            job_kind: None,
            placement: Some(placement_parascene_creation()),
        },
        OpDef {
            service: "parascene",
            operation: "delete_audio_clip",
            status: "wired",
            label: "Delete audio clip",
            description: "Remove a previously uploaded audio clip.",
            job_kind: None,
            placement: Some(placement_parascene_creation()),
        },
        OpDef {
            service: "parascene",
            operation: "upload_generic_image",
            status: "wired",
            label: "Upload generic image",
            description: "Upload bytes to Parascene generic image storage.",
            job_kind: None,
            placement: Some(placement_parascene_creation()),
        },
        OpDef {
            service: "parascene",
            operation: "upload_ephemeral_still",
            status: "wired",
            label: "Upload ephemeral still",
            description: "PUT a jpeg to Parascene-minted Blue CDN; no Creation row.",
            job_kind: None,
            placement: Some(placement_parascene_creation()),
        },
        OpDef {
            service: "parascene",
            operation: "ungroup",
            status: "wired",
            label: "Ungroup creations",
            description: "Restore grouped sources and archive the group cover row.",
            job_kind: None,
            placement: Some(placement_parascene_creation()),
        },
        OpDef {
            service: "parascene",
            operation: "delete_creation_sync",
            status: "wired",
            label: "Delete creation (sync)",
            description: "Delete one Parascene creation inline (sync Result handle).",
            job_kind: None,
            placement: Some(placement_parascene_creation()),
        },
        OpDef {
            service: "blue",
            operation: "generate",
            status: "wired",
            label: "Blue generate",
            description: "Run a Parascene Blue method (local-only output).",
            job_kind: Some("blue_generate"),
            placement: Some(placement_blue_direct()),
        },
        OpDef {
            service: "replicate",
            operation: "generate",
            status: "wired",
            label: "Replicate generate",
            description: "Run a Replicate model prediction (local-only output).",
            job_kind: Some("replicate_generate"),
            placement: Some(placement_replicate()),
        },
        OpDef {
            service: "sync",
            operation: "sync_newest",
            status: "wired",
            label: "Sync newest",
            description: "Fetch a small newest window of creations into the local catalog.",
            job_kind: Some("sync_newest"),
            placement: Some(placement_sync()),
        },
        OpDef {
            service: "sync",
            operation: "sync_full",
            status: "wired",
            label: "Sync full catalog",
            description: "Fetch every creation page and upsert the full local catalog.",
            job_kind: Some("sync_full"),
            placement: Some(placement_sync()),
        },
        OpDef {
            service: "sync",
            operation: "refresh_ids",
            status: "wired",
            label: "Refresh creations by id",
            description: "Page the catalog until wanted ids are found and upsert those rows.",
            job_kind: None,
            placement: Some(placement_sync()),
        },
        OpDef {
            service: "sync",
            operation: "folder_pull",
            status: "wired",
            label: "Pull library folders",
            description: "Fetch the Parascene library folders snapshot.",
            job_kind: None,
            placement: Some(placement_sync()),
        },
        OpDef {
            service: "sync",
            operation: "folder_mutate",
            status: "wired",
            label: "Mutate library folders",
            description: "Apply folder operations when base revision matches.",
            job_kind: None,
            placement: Some(placement_sync()),
        },
        OpDef {
            service: "sync",
            operation: "cloud_repair",
            status: "wired",
            label: "Cloud repair",
            description: "Heal group aspects and fit thumbnails (local-first, then cloud).",
            job_kind: Some("cloud_repair"),
            placement: Some(placement_sync()),
        },
        OpDef {
            service: "local",
            operation: "merge",
            status: "wired",
            label: "Merge timeline clips",
            description: "Concatenate selected local video clips into one catalog creation.",
            job_kind: Some("merge"),
            placement: Some(placement_local()),
        },
        OpDef {
            service: "local",
            operation: "extract_frame",
            status: "wired",
            label: "Extract frame",
            description: "Cached ffmpeg still for a trimmed clip (sync Result handle).",
            job_kind: None,
            placement: Some(placement_local()),
        },
        OpDef {
            service: "publisher",
            operation: "render",
            status: "wired",
            label: "Render timeline",
            description: "Download media if needed, encode timeline to a scratch MP4.",
            job_kind: Some("publisher_render"),
            placement: Some(placement_publisher()),
        },
        OpDef {
            service: "auth",
            operation: "status",
            status: "wired",
            label: "Auth status",
            description: "Whether a Parascene session is present in the keychain.",
            job_kind: None,
            placement: None,
        },
    ]
}

fn lookup(service: &str, operation: &str) -> Result<OpDef, String> {
    let svc = service.trim();
    let op = operation.trim();
    if svc.is_empty() || op.is_empty() {
        return Err("service and operation are required".into());
    }
    registry()
        .into_iter()
        .find(|d| d.service == svc && d.operation == op)
        .ok_or_else(|| format!("unknown service operation: {svc}.{op}"))
}

#[tauri::command]
pub fn service_list() -> Result<Vec<ServiceListEntry>, String> {
    Ok(registry()
        .into_iter()
        .map(|d| ServiceListEntry {
            service: d.service.into(),
            operation: d.operation.into(),
            status: d.status.into(),
            label: Some(d.label.into()),
        })
        .collect())
}

fn text_to_image_fields() -> Vec<FieldSchema> {
    vec![
        FieldSchema {
            name: "prompt".into(),
            title: Some("Prompt".into()),
            description: Some("Describe the image…".into()),
            kind: "text".into(),
            required: true,
            default_value: None,
            enum_values: None,
            minimum: None,
            maximum: None,
            media_slot: None,
            hidden: None,
            advanced: None,
            persist: Some(true),
        },
        FieldSchema {
            name: "model".into(),
            title: Some("Model".into()),
            description: None,
            kind: "enum".into(),
            required: true,
            default_value: None,
            enum_values: None,
            minimum: None,
            maximum: None,
            media_slot: None,
            hidden: None,
            advanced: None,
            persist: Some(true),
        },
    ]
}

#[tauri::command]
pub fn service_describe(request: ServiceDescribeRequest) -> Result<ServiceDescribe, String> {
    let def = lookup(&request.service, &request.operation)?;
    let mut describe = ServiceDescribe {
        service: def.service.into(),
        operation: def.operation.into(),
        status: def.status.into(),
        label: Some(def.label.into()),
        description: Some(def.description.into()),
        fields: vec![],
        placement: def.placement,
        credentials: Some(ServiceCredentialGate {
            required: true,
            // Auth is checked when the job runs; describe stays soft.
            configured: true,
            code: None,
            message: None,
        }),
        needs_timeline_context: Some(false),
        default_target: None,
        allowed_targets: None,
    };
    if def.operation == "generate" {
        describe.default_target = Some("assets".into());
        describe.allowed_targets = Some(vec!["assets".into(), "timeline".into()]);
        describe.fields = text_to_image_fields();
    }
    Ok(describe)
}

#[tauri::command]
pub async fn service_invoke(
    app: AppHandle,
    request: ServiceInvokeRequest,
) -> Result<ServiceHandle, String> {
    let def = lookup(&request.service, &request.operation)?;

    let mut payload = request.payload;
    if !payload.is_object() {
        payload = json!({});
    }
    if let Some(obj) = payload.as_object_mut() {
        if let Some(target) = request.target.as_ref().filter(|t| !t.trim().is_empty()) {
            obj.insert("target".into(), Value::String(target.trim().to_string()));
        }
        if let Some(cid) = request
            .client_request_id
            .as_ref()
            .filter(|t| !t.trim().is_empty())
        {
            obj.insert(
                "clientRequestId".into(),
                Value::String(cid.trim().to_string()),
            );
        }
    }

    // Cheap sync ops return Result immediately (no jobs row).
    if def.job_kind.is_none() {
        let data = run_sync_operation(def.service, def.operation, &payload).await?;
        return Ok(ServiceHandle::Result { data });
    }

    let job_kind = def.job_kind.expect("job_kind checked above");
    let label = request
        .label
        .filter(|s| !s.trim().is_empty())
        .or_else(|| Some(def.label.to_string()));

    let job = jobs_enqueue(
        app,
        EnqueueJobRequest {
            kind: job_kind.into(),
            project_id: request.project_id,
            label,
            payload,
        },
    )?;

    Ok(ServiceHandle::Job { id: job.id })
}

fn payload_bytes(payload: &Value) -> Result<Vec<u8>, String> {
    if let Some(path) = payload
        .get("path")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let b64 = library_read_file_base64(path.to_string())?;
        return base64::engine::general_purpose::STANDARD
            .decode(b64.trim())
            .map_err(|e| format!("Invalid base64 body: {e}"));
    }
    let b64 = payload
        .get("bytesBase64")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "requires path or bytesBase64".to_string())?;
    base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("Invalid base64 body: {e}"))
}

async fn run_sync_operation(
    service: &str,
    operation: &str,
    payload: &Value,
) -> Result<Value, String> {
    match (service, operation) {
        ("local", "extract_frame") => {
            let id = payload
                .get("id")
                .or_else(|| payload.get("assetId"))
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "extract_frame requires id".to_string())?
                .to_string();
            let reverse = payload
                .get("reverse")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let time_sec = payload
                .get("timeSec")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            let framing = payload
                .get("framing")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let aspect_ratio = payload
                .get("aspectRatio")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let zoom = payload.get("zoom").and_then(|v| v.as_f64());
            let center_x = payload.get("centerX").and_then(|v| v.as_f64());
            let center_y = payload.get("centerY").and_then(|v| v.as_f64());
            let path = ensure_clip_thumb_path(
                id,
                reverse,
                time_sec,
                framing,
                aspect_ratio,
                zoom,
                center_x,
                center_y,
            )
            .await?;
            Ok(json!({ "path": path }))
        }
        ("auth", "status") => {
            let status = auth_store::auth_session_status().await?;
            Ok(status)
        }
        ("parascene", "get_creation") => {
            let id = payload
                .get("id")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "get_creation requires id".to_string())?;
            let row = get_creation(id).await?;
            Ok(row)
        }
        ("parascene", "upload_fit_thumbnail") => {
            let id = payload
                .get("id")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "upload_fit_thumbnail requires id".to_string())?
                .to_string();
            let b64 = library_read_local_thumb_base64(id.clone())?;
            let value = upload_fit_thumbnail(&id, &b64).await?;
            Ok(value)
        }
        ("parascene", "group_append") => {
            let ids: Vec<String> = payload
                .get("ids")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| match v {
                            Value::String(s) => {
                                let t = s.trim();
                                if t.is_empty() {
                                    None
                                } else {
                                    Some(t.to_string())
                                }
                            }
                            Value::Number(n) => Some(n.to_string()),
                            _ => None,
                        })
                        .collect()
                })
                .unwrap_or_default();
            if ids.is_empty() {
                return Err("group_append requires ids".into());
            }
            let party_name = payload
                .get("partyName")
                .or_else(|| payload.get("party_name"))
                .and_then(|v| v.as_str());
            let meta = payload.get("meta");
            let value = group_creations(&ids, party_name, meta).await?;
            Ok(value)
        }
        ("parascene", "get_credits") => get_credits().await,
        ("parascene", "record_audio_clip") => {
            let bytes = payload_bytes(payload)?;
            let content_type = payload
                .get("contentType")
                .and_then(|v| v.as_str())
                .unwrap_or("audio/wav");
            let title = payload.get("title").and_then(|v| v.as_str());
            let duration_sec = payload
                .get("durationSec")
                .or_else(|| payload.get("duration_sec"))
                .and_then(|v| v.as_f64());
            let source_type = payload
                .get("sourceType")
                .or_else(|| payload.get("source_type"))
                .and_then(|v| v.as_str());
            record_audio_clip(&bytes, content_type, title, duration_sec, source_type).await
        }
        ("parascene", "delete_audio_clip") => {
            let id = payload
                .get("id")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "delete_audio_clip requires id".to_string())?;
            delete_audio_clip(id).await?;
            Ok(json!({ "ok": true }))
        }
        ("parascene", "upload_generic_image") => {
            let bytes = payload_bytes(payload)?;
            let content_type = payload
                .get("contentType")
                .and_then(|v| v.as_str())
                .unwrap_or("image/jpeg");
            let filename = payload
                .get("filename")
                .and_then(|v| v.as_str())
                .unwrap_or("lab-frame.jpg");
            upload_generic_image(&bytes, content_type, filename).await
        }
        ("parascene", "upload_ephemeral_still") => {
            let bytes = payload_bytes(payload)?;
            let content_type = payload
                .get("contentType")
                .and_then(|v| v.as_str())
                .unwrap_or("image/jpeg");
            let filename = payload
                .get("filename")
                .and_then(|v| v.as_str())
                .unwrap_or("frame.jpg");
            upload_ephemeral_still(&bytes, content_type, filename).await
        }
        ("parascene", "ungroup") => {
            let id = payload
                .get("id")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "ungroup requires id".to_string())?;
            let restored = ungroup_creations(id).await?;
            Ok(json!({ "restoredCreationIds": restored }))
        }
        ("parascene", "delete_creation_sync") => {
            let id = payload
                .get("id")
                .or_else(|| payload.get("creationId"))
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "delete_creation_sync requires id".to_string())?;
            delete_creation(id).await?;
            Ok(json!({ "ok": true }))
        }
        ("sync", "refresh_ids") => {
            let ids: Vec<String> = payload
                .get("ids")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| match v {
                            Value::String(s) => {
                                let t = s.trim();
                                if t.is_empty() {
                                    None
                                } else {
                                    Some(t.to_string())
                                }
                            }
                            Value::Number(n) => Some(n.to_string()),
                            _ => None,
                        })
                        .collect()
                })
                .unwrap_or_default();
            let max_pages = payload
                .get("maxPages")
                .and_then(|v| v.as_u64())
                .unwrap_or(40) as u32;
            let page_size = payload
                .get("pageSize")
                .and_then(|v| v.as_u64())
                .unwrap_or(50) as u32;
            run_refresh_creations_by_id(&ids, max_pages, page_size).await
        }
        ("sync", "folder_pull") => get_library_folders().await,
        ("sync", "folder_mutate") => {
            let base_revision = payload
                .get("baseRevision")
                .or_else(|| payload.get("base_revision"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let operations = payload
                .get("operations")
                .cloned()
                .unwrap_or_else(|| json!([]));
            mutate_library_folders(base_revision, &operations).await
        }
        (svc, op) => Err(format!("{svc}.{op} is not invokable yet")),
    }
}

#[tauri::command]
pub async fn service_get(id: String) -> Result<Option<Job>, String> {
    jobs_get(id).await
}

#[tauri::command]
pub fn service_cancel(app: AppHandle, id: String) -> Result<Job, String> {
    jobs_cancel(app, id)
}

#[tauri::command]
pub fn service_list_runs(
    project_id: Option<String>,
    status: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<Job>, String> {
    jobs_list(project_id, status, limit)
}
