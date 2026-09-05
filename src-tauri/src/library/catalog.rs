use super::paths::{account_root, ensure_directories, resolve_paths, ParascenePaths};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Creation {
    pub id: String,
    pub title: String,
    pub media_type: String,
    pub remote_url: Option<String>,
    pub thumbnail_url: Option<String>,
    /// Native-aspect cloud thumb (`?variant=fit`); preferred over square thumbnail.
    pub fit_thumbnail_url: Option<String>,
    pub video_url: Option<String>,
    pub local_path: Option<String>,
    pub local_thumb_path: Option<String>,
    pub published: bool,
    pub published_at: Option<String>,
    pub created_at: String,
    pub download_state: String,
    pub checksum: Option<String>,
    pub prompt: Option<String>,
    pub expires_at: Option<String>,
    pub updated_at: String,
    pub filename: Option<String>,
    pub description: Option<String>,
    pub color: Option<String>,
    pub status: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub aspect_ratio: Option<String>,
    pub nsfw: bool,
    pub is_moderated_error: bool,
    /// Full Parascene create-images row as synced (JSON).
    pub remote_json: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreationUpsert {
    pub id: String,
    pub title: String,
    pub media_type: String,
    pub remote_url: Option<String>,
    pub thumbnail_url: Option<String>,
    #[serde(default)]
    pub fit_thumbnail_url: Option<String>,
    pub video_url: Option<String>,
    pub published: bool,
    pub published_at: Option<String>,
    pub created_at: String,
    pub download_state: String,
    pub prompt: Option<String>,
    pub filename: Option<String>,
    pub description: Option<String>,
    pub color: Option<String>,
    pub status: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub aspect_ratio: Option<String>,
    pub nsfw: bool,
    pub is_moderated_error: bool,
    pub remote_json: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub root_path: String,
    pub last_sync_at: Option<String>,
    pub total: u32,
    pub local: u32,
    pub remote: u32,
    pub queued: u32,
    pub downloading: u32,
    pub failed: u32,
    /// Rows with a local thumbnail file path set.
    pub with_thumb: u32,
    /// Rows with full local media on disk (`download_state = local` already counted separately).
    pub with_media: u32,
    /// Missing thumbs that still have a downloadable preview URL.
    pub missing_thumb_cacheable: u32,
    /// Missing full media that still have a remote URL.
    pub missing_media_cacheable: u32,
    /// Cloud-backed creations with no local thumb and no downloadable preview URL.
    pub missing_thumb_uncacheable: u32,
    /// Cloud-backed creations with no local media and no remote URL.
    pub missing_media_uncacheable: u32,
    /// Bytes used under Library/media.
    pub media_bytes: u64,
    /// Bytes used under Library/thumbs.
    pub thumbs_bytes: u64,
    /// Cloud-backed creations that can't be cached (no downloadable URLs). Capped.
    /// Excludes local-only imports and cover-only cloud A/V (Suno/YouTube).
    pub without_cloud_urls: Vec<WithoutCloudUrl>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WithoutCloudUrl {
    pub id: String,
    pub title: String,
    pub filename: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreationPage {
    pub creations: Vec<Creation>,
    pub total: u32,
    pub offset: u32,
    pub limit: u32,
    pub has_more: bool,
}

/// Sidebar filter tallies over the full SQLite catalog (not the loaded page window).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogFilterCounts {
    pub all: u32,
    pub video: u32,
    pub image: u32,
    pub audio: u32,
    pub groups: u32,
    pub local_only: u32,
    pub published: u32,
    pub unpublished: u32,
    /// Approximate from denormalized aspect_ratio / width×height (not remote_json).
    pub aspect11: u32,
    pub aspect916: u32,
    pub aspect45: u32,
    pub aspect169: u32,
}

fn open_db(db_path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(db_path).map_err(|e| format!("Could not open catalog DB: {e}"))?;
    // Fail fast under writer contention instead of hanging Sync/auth IPC.
    conn.busy_timeout(std::time::Duration::from_secs(2))
        .map_err(|e| e.to_string())?;
    let _ = conn.execute_batch("PRAGMA journal_mode=WAL;");
    Ok(conn)
}

fn migrate(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS creations (
          id TEXT PRIMARY KEY NOT NULL,
          title TEXT NOT NULL,
          media_type TEXT NOT NULL,
          remote_url TEXT,
          thumbnail_url TEXT,
          video_url TEXT,
          local_path TEXT,
          local_thumb_path TEXT,
          published INTEGER NOT NULL DEFAULT 0,
          published_at TEXT,
          created_at TEXT NOT NULL,
          download_state TEXT NOT NULL,
          checksum TEXT,
          prompt TEXT,
          expires_at TEXT,
          updated_at TEXT NOT NULL,
          filename TEXT,
          description TEXT,
          color TEXT,
          status TEXT,
          width INTEGER,
          height INTEGER,
          aspect_ratio TEXT,
          nsfw INTEGER NOT NULL DEFAULT 0,
          is_moderated_error INTEGER NOT NULL DEFAULT 0,
          remote_json TEXT
        );

        CREATE TABLE IF NOT EXISTS sync_meta (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS folders (
          id TEXT PRIMARY KEY NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'regular',
          project_id TEXT,
          cover_creation_id TEXT
        );

        CREATE TABLE IF NOT EXISTS folder_items (
          folder_id TEXT NOT NULL,
          creation_id TEXT NOT NULL,
          added_at TEXT NOT NULL,
          PRIMARY KEY (folder_id, creation_id),
          FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE
        );

        CREATE UNIQUE INDEX IF NOT EXISTS folder_items_creation_unique
          ON folder_items(creation_id);

        CREATE TABLE IF NOT EXISTS folder_pending_ops (
          seq INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
          op_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS project_library_bindings (
          project_id TEXT PRIMARY KEY NOT NULL,
          folder_id TEXT,
          binding_known INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS project_assets (
          project_id TEXT NOT NULL,
          creation_id TEXT NOT NULL,
          added_at TEXT NOT NULL,
          PRIMARY KEY (project_id, creation_id)
        );

        CREATE TABLE IF NOT EXISTS project_asset_usage (
          project_id TEXT NOT NULL,
          creation_id TEXT NOT NULL,
          usage_kind TEXT NOT NULL,
          usage_owner_id TEXT NOT NULL,
          usage_owner_label TEXT NOT NULL,
          document_revision TEXT NOT NULL,
          PRIMARY KEY (project_id, creation_id, usage_kind, usage_owner_id)
        );

        CREATE INDEX IF NOT EXISTS project_asset_usage_creation_idx
          ON project_asset_usage(creation_id);

        CREATE TABLE IF NOT EXISTS project_usage_revisions (
          project_id TEXT PRIMARY KEY NOT NULL,
          document_revision TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('stale', 'ready')),
          indexed_at TEXT
        );

        CREATE TABLE IF NOT EXISTS project_membership_revisions (
          project_id TEXT PRIMARY KEY NOT NULL,
          revision INTEGER NOT NULL DEFAULT 0
        );
        "#,
    )
    .map_err(|e| format!("Catalog migrate failed: {e}"))?;

    // Older DBs may lack later columns.
    for ddl in [
        "ALTER TABLE creations ADD COLUMN thumbnail_url TEXT",
        "ALTER TABLE creations ADD COLUMN local_thumb_path TEXT",
        "ALTER TABLE creations ADD COLUMN video_url TEXT",
        "ALTER TABLE creations ADD COLUMN published_at TEXT",
        "ALTER TABLE creations ADD COLUMN filename TEXT",
        "ALTER TABLE creations ADD COLUMN description TEXT",
        "ALTER TABLE creations ADD COLUMN color TEXT",
        "ALTER TABLE creations ADD COLUMN status TEXT",
        "ALTER TABLE creations ADD COLUMN width INTEGER",
        "ALTER TABLE creations ADD COLUMN height INTEGER",
        "ALTER TABLE creations ADD COLUMN aspect_ratio TEXT",
        "ALTER TABLE creations ADD COLUMN nsfw INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE creations ADD COLUMN is_moderated_error INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE creations ADD COLUMN remote_json TEXT",
        "ALTER TABLE creations ADD COLUMN fit_thumbnail_url TEXT",
        "ALTER TABLE project_library_bindings ADD COLUMN binding_known INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE folders ADD COLUMN kind TEXT NOT NULL DEFAULT 'regular'",
        "ALTER TABLE folders ADD COLUMN project_id TEXT",
        "ALTER TABLE folders ADD COLUMN cover_creation_id TEXT",
    ] {
        let _ = conn.execute(ddl, []);
    }

    // Folders may be missing on catalogs created before this feature.
    let _ = conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS folders (
          id TEXT PRIMARY KEY NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'regular',
          project_id TEXT,
          cover_creation_id TEXT
        );
        CREATE TABLE IF NOT EXISTS folder_items (
          folder_id TEXT NOT NULL,
          creation_id TEXT NOT NULL,
          added_at TEXT NOT NULL,
          PRIMARY KEY (folder_id, creation_id)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS folder_items_creation_unique
          ON folder_items(creation_id);
        CREATE TABLE IF NOT EXISTS folder_pending_ops (
          seq INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
          op_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS project_library_bindings (
          project_id TEXT PRIMARY KEY NOT NULL,
          folder_id TEXT,
          binding_known INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS project_assets (
          project_id TEXT NOT NULL,
          creation_id TEXT NOT NULL,
          added_at TEXT NOT NULL,
          PRIMARY KEY (project_id, creation_id)
        );
        CREATE TABLE IF NOT EXISTS project_asset_usage (
          project_id TEXT NOT NULL,
          creation_id TEXT NOT NULL,
          usage_kind TEXT NOT NULL,
          usage_owner_id TEXT NOT NULL,
          usage_owner_label TEXT NOT NULL,
          document_revision TEXT NOT NULL,
          PRIMARY KEY (project_id, creation_id, usage_kind, usage_owner_id)
        );
        CREATE INDEX IF NOT EXISTS project_asset_usage_creation_idx
          ON project_asset_usage(creation_id);
        CREATE TABLE IF NOT EXISTS project_usage_revisions (
          project_id TEXT PRIMARY KEY NOT NULL,
          document_revision TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('stale', 'ready')),
          indexed_at TEXT
        );
        CREATE TABLE IF NOT EXISTS project_membership_revisions (
          project_id TEXT PRIMARY KEY NOT NULL,
          revision INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY NOT NULL,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          project_id TEXT,
          label TEXT,
          payload_json TEXT NOT NULL,
          result_json TEXT,
          checkpoint_json TEXT,
          progress_note TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS jobs_status_created_idx
          ON jobs(status, created_at);
        CREATE INDEX IF NOT EXISTS jobs_project_idx
          ON jobs(project_id);
        "#,
    );

    conn.execute_batch(
        r#"
        CREATE UNIQUE INDEX IF NOT EXISTS folders_project_id_unique
          ON folders(project_id) WHERE project_id IS NOT NULL;
        CREATE TRIGGER IF NOT EXISTS folders_project_shape_insert
        BEFORE INSERT ON folders
        WHEN NOT (
          (NEW.kind = 'regular' AND NEW.project_id IS NULL) OR
          (NEW.kind = 'project' AND NEW.project_id IS NOT NULL AND length(trim(NEW.project_id)) > 0)
        )
        BEGIN
          SELECT RAISE(ABORT, 'invalid project folder identity');
        END;
        CREATE TRIGGER IF NOT EXISTS folders_project_shape_update
        BEFORE UPDATE OF kind, project_id ON folders
        WHEN NOT (
          (NEW.kind = 'regular' AND NEW.project_id IS NULL) OR
          (NEW.kind = 'project' AND NEW.project_id IS NOT NULL AND length(trim(NEW.project_id)) > 0)
        )
        BEGIN
          SELECT RAISE(ABORT, 'invalid project folder identity');
        END;
        "#,
    )
    .map_err(|e| format!("Project folder schema migrate failed: {e}"))?;

    // Jobs may be missing on catalogs created before the generation queue.
    let _ = conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY NOT NULL,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          project_id TEXT,
          label TEXT,
          payload_json TEXT NOT NULL,
          result_json TEXT,
          checkpoint_json TEXT,
          progress_note TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS jobs_status_created_idx
          ON jobs(status, created_at);
        CREATE INDEX IF NOT EXISTS jobs_project_idx
          ON jobs(project_id);
        "#,
    );

    Ok(())
}

pub(crate) fn meta_get(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    let mut stmt = conn
        .prepare("SELECT value FROM sync_meta WHERE key = ?1")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query(params![key]).map_err(|e| e.to_string())?;
    if let Some(row) = rows.next().map_err(|e| e.to_string())? {
        Ok(Some(row.get(0).map_err(|e| e.to_string())?))
    } else {
        Ok(None)
    }
}

pub(crate) fn meta_set(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO sync_meta(key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn meta_delete(conn: &Connection, key: &str) -> Result<(), String> {
    conn.execute("DELETE FROM sync_meta WHERE key = ?1", params![key])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Debug-build auth backend: session KV in machine `session.sqlite` (never the library catalog).
const AUTH_KV_PREFIX: &str = "auth_store:";

fn auth_meta_key(key: &str) -> String {
    format!("{AUTH_KV_PREFIX}{key}")
}

/// Lightweight open for auth KV only — never runs migrate / folder migration.
/// Lives on the machine plane (`session.sqlite`), never the active library catalog.
fn open_auth_kv_connection() -> Result<Connection, String> {
    let machine = super::paths::machine_root()?;
    fs::create_dir_all(&machine)
        .map_err(|e| format!("Could not create machine root: {e}"))?;
    let session_db = machine.join("session.sqlite");
    migrate_auth_kv_from_catalog(&machine, &session_db)?;
    let conn = Connection::open(&session_db).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS sync_meta (
           key TEXT PRIMARY KEY NOT NULL,
           value TEXT NOT NULL
         );",
    )
    .map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&session_db, fs::Permissions::from_mode(0o600));
    }
    Ok(conn)
}

fn migrate_auth_kv_from_catalog(machine: &Path, session_db: &Path) -> Result<(), String> {
    let catalog = machine.join("Library").join("catalog.sqlite");
    copy_auth_kv_from_catalog(&catalog, session_db)
}

/// Pull leftover `auth_store:*` rows from a library catalog into `session.sqlite`.
/// Runs even when session.sqlite already exists — otherwise keys saved before
/// the machine-plane split never leave `Library/catalog.sqlite`.
fn copy_auth_kv_from_catalog(catalog: &Path, session_db: &Path) -> Result<(), String> {
    if !catalog.is_file() {
        return Ok(());
    }
    let src = Connection::open(&catalog).map_err(|e| e.to_string())?;
    src.execute_batch(
        "CREATE TABLE IF NOT EXISTS sync_meta (
           key TEXT PRIMARY KEY NOT NULL,
           value TEXT NOT NULL
         );",
    )
    .map_err(|e| e.to_string())?;
    let mut stmt = src
        .prepare("SELECT key, value FROM sync_meta WHERE key LIKE 'auth_store:%'")
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    if rows.is_empty() {
        return Ok(());
    }
    let dest = Connection::open(session_db).map_err(|e| e.to_string())?;
    dest.execute_batch(
        "CREATE TABLE IF NOT EXISTS sync_meta (
           key TEXT PRIMARY KEY NOT NULL,
           value TEXT NOT NULL
         );",
    )
    .map_err(|e| e.to_string())?;
    for (key, value) in &rows {
        if value.trim().is_empty() {
            let _ = src.execute("DELETE FROM sync_meta WHERE key = ?1", params![key]);
            continue;
        }
        let existing: Option<String> = dest
            .query_row(
                "SELECT value FROM sync_meta WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .ok();
        let dest_empty = existing
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty();
        if dest_empty {
            dest.execute(
                "INSERT INTO sync_meta(key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .map_err(|e| e.to_string())?;
        }
        let _ = src.execute("DELETE FROM sync_meta WHERE key = ?1", params![key]);
    }
    Ok(())
}

/// Account secrets left in a library catalog (`auth_store:*`) from before
/// session.sqlite existed. Used to recover keys the live store never copied.
pub(crate) fn read_auth_store_secrets_from_catalog(
    catalog: &Path,
) -> BTreeMap<String, String> {
    use super::user_state::is_account_secret_key;
    let mut out = BTreeMap::new();
    if !catalog.is_file() {
        return out;
    }
    let Ok(conn) = Connection::open(catalog) else {
        return out;
    };
    let Ok(mut stmt) = conn.prepare(
        "SELECT key, value FROM sync_meta WHERE key LIKE 'auth_store:%'",
    ) else {
        return out;
    };
    let Ok(rows) = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    }) else {
        return out;
    };
    for row in rows.flatten() {
        let name = row
            .0
            .strip_prefix(AUTH_KV_PREFIX)
            .unwrap_or(row.0.as_str())
            .to_string();
        if is_account_secret_key(&name) && !row.1.trim().is_empty() {
            out.insert(name, row.1);
        }
    }
    out
}

pub(crate) fn auth_kv_get(key: &str) -> Result<Option<String>, String> {
    let conn = open_auth_kv_connection()?;
    meta_get(&conn, &auth_meta_key(key))
}

pub(crate) fn auth_kv_set(key: &str, value: &str) -> Result<(), String> {
    let conn = open_auth_kv_connection()?;
    meta_set(&conn, &auth_meta_key(key), value)
}

pub(crate) fn auth_kv_delete(key: &str) -> Result<(), String> {
    let conn = open_auth_kv_connection()?;
    meta_delete(&conn, &auth_meta_key(key))
}

fn count_creations(conn: &Connection) -> Result<i64, String> {
    conn.query_row("SELECT COUNT(*) FROM creations", [], |row| row.get(0))
        .map_err(|e| e.to_string())
}

fn catalog_filter_counts(conn: &Connection) -> Result<CatalogFilterCounts, String> {
    let member_ids = collect_group_member_ids(conn)?;
    let exclude_sql = group_member_exclude_sql(member_ids.len());
    let sql = format!(
        r#"
        SELECT
          COUNT(*) AS all_count,
          COALESCE(SUM(CASE
            WHEN lower(media_type) = 'video'
             AND NOT (
               lower(COALESCE(filename, '')) LIKE 'group/%'
               OR instr(COALESCE(remote_json, ''), '"kind":"group_creations"') > 0
               OR instr(COALESCE(remote_json, ''), '"kind": "group_creations"') > 0
             )
            THEN 1 ELSE 0 END), 0) AS video_count,
          COALESCE(SUM(CASE
            WHEN lower(media_type) = 'image'
             AND NOT (
               lower(COALESCE(filename, '')) LIKE 'group/%'
               OR instr(COALESCE(remote_json, ''), '"kind":"group_creations"') > 0
               OR instr(COALESCE(remote_json, ''), '"kind": "group_creations"') > 0
             )
            THEN 1 ELSE 0 END), 0) AS image_count,
          COALESCE(SUM(CASE
            WHEN lower(media_type) = 'audio'
             AND NOT (
               lower(COALESCE(filename, '')) LIKE 'group/%'
               OR instr(COALESCE(remote_json, ''), '"kind":"group_creations"') > 0
               OR instr(COALESCE(remote_json, ''), '"kind": "group_creations"') > 0
             )
            THEN 1 ELSE 0 END), 0) AS audio_count,
          COALESCE(SUM(CASE
            WHEN lower(COALESCE(filename, '')) LIKE 'group/%' THEN 1
            WHEN instr(COALESCE(remote_json, ''), '"kind":"group_creations"') > 0 THEN 1
            WHEN instr(COALESCE(remote_json, ''), '"kind": "group_creations"') > 0 THEN 1
            ELSE 0
          END), 0) AS groups_count,
          -- Local-only = not in Parascene cloud (no remote URL / snapshot), not "on disk".
          COALESCE(SUM(CASE
            WHEN (remote_url IS NULL OR remote_url = '')
             AND (remote_json IS NULL OR remote_json = '')
            THEN 1
            ELSE 0
          END), 0) AS local_only_count,
          COALESCE(SUM(CASE WHEN published != 0 THEN 1 ELSE 0 END), 0) AS published_count,
          COALESCE(SUM(CASE WHEN published = 0 THEN 1 ELSE 0 END), 0) AS unpublished_count,
          COALESCE(SUM(CASE
            WHEN trim(COALESCE(aspect_ratio, '')) = '1:1' THEN 1
            WHEN width IS NOT NULL AND height IS NOT NULL AND width > 0 AND height > 0
                 AND width = height THEN 1
            ELSE 0
          END), 0) AS aspect11_count,
          COALESCE(SUM(CASE
            WHEN trim(COALESCE(aspect_ratio, '')) = '9:16' THEN 1
            WHEN width IS NOT NULL AND height IS NOT NULL AND width > 0 AND height > 0
                 AND width * 16 = height * 9 THEN 1
            ELSE 0
          END), 0) AS aspect916_count,
          COALESCE(SUM(CASE
            WHEN trim(COALESCE(aspect_ratio, '')) = '4:5' THEN 1
            WHEN width IS NOT NULL AND height IS NOT NULL AND width > 0 AND height > 0
                 AND width * 5 = height * 4 THEN 1
            ELSE 0
          END), 0) AS aspect45_count,
          COALESCE(SUM(CASE
            WHEN trim(COALESCE(aspect_ratio, '')) = '16:9' THEN 1
            WHEN width IS NOT NULL AND height IS NOT NULL AND width > 0 AND height > 0
                 AND width * 9 = height * 16 THEN 1
            ELSE 0
          END), 0) AS aspect169_count
        FROM creations
        {exclude_sql}
        "#
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let params = rusqlite::params_from_iter(member_ids.iter());
    stmt.query_row(params, |row| {
        Ok(CatalogFilterCounts {
            all: row.get::<_, i64>(0)? as u32,
            video: row.get::<_, i64>(1)? as u32,
            image: row.get::<_, i64>(2)? as u32,
            audio: row.get::<_, i64>(3)? as u32,
            groups: row.get::<_, i64>(4)? as u32,
            local_only: row.get::<_, i64>(5)? as u32,
            published: row.get::<_, i64>(6)? as u32,
            unpublished: row.get::<_, i64>(7)? as u32,
            aspect11: row.get::<_, i64>(8)? as u32,
            aspect916: row.get::<_, i64>(9)? as u32,
            aspect45: row.get::<_, i64>(10)? as u32,
            aspect169: row.get::<_, i64>(11)? as u32,
        })
    })
    .map_err(|e| e.to_string())
}

/// Ids referenced by group covers — kept in SQLite for lightbox/editor, hidden on the board.
fn collect_group_member_ids(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT id, filename, remote_json FROM creations
            WHERE lower(COALESCE(filename, '')) LIKE 'group/%'
               OR instr(COALESCE(remote_json, ''), '"kind":"group_creations"') > 0
               OR instr(COALESCE(remote_json, ''), '"kind": "group_creations"') > 0
            "#,
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut out = std::collections::HashSet::new();
    for row in rows {
        let (cover_id, _filename, remote_json) = row.map_err(|e| e.to_string())?;
        let Some(raw) = remote_json else { continue };
        for id in group_member_ids_from_remote_json(&raw) {
            if id != cover_id {
                out.insert(id);
            }
        }
    }
    let mut list: Vec<String> = out.into_iter().collect();
    list.sort();
    Ok(list)
}

pub(crate) fn group_member_ids_from_remote_json(raw: &str) -> Vec<String> {
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(raw) else {
        return Vec::new();
    };
    let group = parsed
        .get("meta")
        .and_then(|m| m.get("group"))
        .or_else(|| parsed.get("group"));
    let Some(group) = group else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    if let Some(ids) = group.get("source_creation_ids").and_then(|v| v.as_array()) {
        for id in ids {
            let s = match id {
                serde_json::Value::String(s) => s.trim().to_string(),
                serde_json::Value::Number(n) => n.to_string(),
                _ => continue,
            };
            if s.is_empty() || !seen.insert(s.clone()) {
                continue;
            }
            out.push(s);
        }
    }
    if let Some(sources) = group.get("source_creations").and_then(|v| v.as_array()) {
        for source in sources {
            let id = source.get("id").and_then(|v| match v {
                serde_json::Value::String(s) => Some(s.trim().to_string()),
                serde_json::Value::Number(n) => Some(n.to_string()),
                _ => None,
            });
            let Some(s) = id else { continue };
            if s.is_empty() || !seen.insert(s.clone()) {
                continue;
            }
            out.push(s);
        }
    }
    out
}

fn group_member_exclude_sql(member_count: usize) -> String {
    if member_count == 0 {
        return String::new();
    }
    let placeholders = std::iter::repeat("?")
        .take(member_count)
        .collect::<Vec<_>>()
        .join(", ");
    format!("WHERE id NOT IN ({placeholders})")
}

fn count_board_creations(conn: &Connection, member_ids: &[String]) -> Result<i64, String> {
    if member_ids.is_empty() {
        return count_creations(conn);
    }
    let exclude = group_member_exclude_sql(member_ids.len());
    let sql = format!("SELECT COUNT(*) FROM creations {exclude}");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    stmt.query_row(rusqlite::params_from_iter(member_ids.iter()), |row| {
        row.get(0)
    })
    .map_err(|e| e.to_string())
}

/// Dev/test seed only — not called from ready_connection (real catalog comes from sync).
#[cfg(test)]
fn seed_if_empty(conn: &Connection) -> Result<bool, String> {
    if count_creations(conn)? > 0 {
        return Ok(false);
    }

    let now = Utc::now().to_rfc3339();
    let fixtures: &[(&str, &str, &str, &str, i64)] = &[
        ("fixture-a1", "cam_a.mp4", "video", "remote", 1),
        ("fixture-a2", "cam_b.mp4", "video", "remote", 0),
        ("fixture-a3", "voiceover.wav", "audio", "remote", 0),
        ("fixture-a4", "logo.png", "image", "local", 1),
    ];

    for (id, title, media_type, state, published) in fixtures {
        conn.execute(
            r#"
            INSERT INTO creations (
              id, title, media_type, remote_url, thumbnail_url, local_path, local_thumb_path, published,
              created_at, download_state, checksum, prompt, expires_at, updated_at
            ) VALUES (?1, ?2, ?3, NULL, NULL, NULL, NULL, ?4, ?5, ?6, NULL, NULL, NULL, ?5)
            "#,
            params![id, title, media_type, published, now, state],
        )
        .map_err(|e| format!("Seed insert failed: {e}"))?;
    }

    Ok(true)
}

fn map_creation_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Creation> {
    Ok(Creation {
        id: row.get(0)?,
        title: row.get(1)?,
        media_type: row.get(2)?,
        remote_url: row.get(3)?,
        thumbnail_url: row.get(4)?,
        fit_thumbnail_url: row.get(5)?,
        video_url: row.get(6)?,
        local_path: row.get(7)?,
        local_thumb_path: row.get(8)?,
        published: row.get::<_, i64>(9)? != 0,
        published_at: row.get(10)?,
        created_at: row.get(11)?,
        download_state: row.get(12)?,
        checksum: row.get(13)?,
        prompt: row.get(14)?,
        expires_at: row.get(15)?,
        updated_at: row.get(16)?,
        filename: row.get(17)?,
        description: row.get(18)?,
        color: row.get(19)?,
        status: row.get(20)?,
        width: row.get(21)?,
        height: row.get(22)?,
        aspect_ratio: row.get(23)?,
        nsfw: row.get::<_, i64>(24).unwrap_or(0) != 0,
        is_moderated_error: row.get::<_, i64>(25).unwrap_or(0) != 0,
        remote_json: row.get(26)?,
    })
}

const CREATION_SELECT: &str = r#"
    SELECT id, title, media_type, remote_url, thumbnail_url, fit_thumbnail_url, video_url,
           local_path, local_thumb_path,
           published, published_at, created_at, download_state, checksum, prompt, expires_at, updated_at,
           filename, description, color, status, width, height, aspect_ratio,
           COALESCE(nsfw, 0), COALESCE(is_moderated_error, 0), remote_json
    FROM creations
"#;

pub(crate) fn list_creations(conn: &Connection) -> Result<Vec<Creation>, String> {
    let member_ids = collect_group_member_ids(conn)?;
    let exclude = group_member_exclude_sql(member_ids.len());
    let sql = format!("{CREATION_SELECT} {exclude} ORDER BY created_at DESC, title ASC");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = if member_ids.is_empty() {
        stmt.query_map([], map_creation_row)
            .map_err(|e| e.to_string())?
    } else {
        stmt.query_map(
            rusqlite::params_from_iter(member_ids.iter()),
            map_creation_row,
        )
        .map_err(|e| e.to_string())?
    };

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// Every catalog row, including group members hidden from the board.
/// Used by Sync bulk-cache so counts match `missing_*_cacheable` status fields.
pub(crate) fn list_all_creations(conn: &Connection) -> Result<Vec<Creation>, String> {
    let sql = format!("{CREATION_SELECT} ORDER BY created_at DESC, title ASC");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], map_creation_row)
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// Predicates aligned with [`catalog_filter_counts`] for sparse sidebar filters.
fn filter_listing_predicate(filter: &str) -> Result<&'static str, String> {
    match filter {
        "audio" => Ok(r#"
            lower(media_type) = 'audio'
            AND NOT (
              lower(COALESCE(filename, '')) LIKE 'group/%'
              OR instr(COALESCE(remote_json, ''), '"kind":"group_creations"') > 0
              OR instr(COALESCE(remote_json, ''), '"kind": "group_creations"') > 0
            )
            "#),
        "localOnly" => Ok(r#"
            (remote_url IS NULL OR remote_url = '')
            AND (remote_json IS NULL OR remote_json = '')
            "#),
        other => Err(format!("Unsupported filter listing: {other}")),
    }
}

/// All board rows matching a sparse filter (Audio / Local-only), newest first.
/// Excludes group members the same way as [`list_creations_page`].
pub(crate) fn list_creations_for_filter(
    conn: &Connection,
    filter: &str,
) -> Result<Vec<Creation>, String> {
    let predicate = filter_listing_predicate(filter)?;
    let member_ids = collect_group_member_ids(conn)?;
    let exclude = group_member_exclude_sql(member_ids.len());
    let where_clause = if exclude.is_empty() {
        format!("WHERE {predicate}")
    } else {
        format!("{exclude} AND ({predicate})")
    };
    let sql = format!("{CREATION_SELECT} {where_clause} ORDER BY created_at DESC, title ASC");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = if member_ids.is_empty() {
        stmt.query_map([], map_creation_row)
            .map_err(|e| e.to_string())?
    } else {
        stmt.query_map(
            rusqlite::params_from_iter(member_ids.iter()),
            map_creation_row,
        )
        .map_err(|e| e.to_string())?
    };
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

pub(crate) fn list_creations_page(
    conn: &Connection,
    limit: u32,
    offset: u32,
) -> Result<CreationPage, String> {
    let limit = limit.clamp(1, 200);
    let member_ids = collect_group_member_ids(conn)?;
    let total = count_board_creations(conn, &member_ids)? as u32;
    let exclude = group_member_exclude_sql(member_ids.len());
    let sql =
        format!("{CREATION_SELECT} {exclude} ORDER BY created_at DESC, title ASC LIMIT ? OFFSET ?");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;

    // Bind exclude ids first, then limit/offset.
    let mut bindings: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    for id in &member_ids {
        bindings.push(Box::new(id.clone()));
    }
    bindings.push(Box::new(limit));
    bindings.push(Box::new(offset));
    let param_refs: Vec<&dyn rusqlite::types::ToSql> =
        bindings.iter().map(|b| b.as_ref()).collect();

    let rows = stmt
        .query_map(param_refs.as_slice(), map_creation_row)
        .map_err(|e| e.to_string())?;

    let mut creations = Vec::new();
    for row in rows {
        creations.push(row.map_err(|e| e.to_string())?);
    }
    let next_offset = offset.saturating_add(creations.len() as u32);
    Ok(CreationPage {
        has_more: next_offset < total,
        creations,
        total,
        offset,
        limit,
    })
}

pub(crate) fn get_creations_by_ids(
    conn: &Connection,
    ids: &[String],
) -> Result<Vec<Creation>, String> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    // Preserve caller order; de-dupe for the query.
    let mut unique: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for id in ids {
        if seen.insert(id.as_str()) {
            unique.push(id.clone());
        }
    }

    let mut by_id: std::collections::HashMap<String, Creation> = std::collections::HashMap::new();
    const CHUNK: usize = 400;
    for chunk in unique.chunks(CHUNK) {
        let placeholders = std::iter::repeat("?")
            .take(chunk.len())
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!("{CREATION_SELECT} WHERE id IN ({placeholders})");
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(chunk.iter()), map_creation_row)
            .map_err(|e| e.to_string())?;
        for row in rows {
            let creation = row.map_err(|e| e.to_string())?;
            by_id.insert(creation.id.clone(), creation);
        }
    }

    let mut out = Vec::with_capacity(ids.len());
    let mut emitted = std::collections::HashSet::new();
    for id in ids {
        if !emitted.insert(id.as_str()) {
            continue;
        }
        if let Some(creation) = by_id.remove(id) {
            out.push(creation);
        }
    }
    Ok(out)
}

pub(crate) fn get_creation_by_id(conn: &Connection, id: &str) -> Result<Option<Creation>, String> {
    let mut stmt = conn
        .prepare(&format!("{CREATION_SELECT} WHERE id = ?1 LIMIT 1"))
        .map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query_map(params![id], map_creation_row)
        .map_err(|e| e.to_string())?;
    match rows.next() {
        Some(row) => Ok(Some(row.map_err(|e| e.to_string())?)),
        None => Ok(None),
    }
}

fn count_by_state(conn: &Connection, state: &str) -> Result<u32, String> {
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM creations WHERE download_state = ?1",
            params![state],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(n as u32)
}

fn count_where(conn: &Connection, sql: &str) -> Result<u32, String> {
    let n: i64 = conn
        .query_row(sql, [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    Ok(n as u32)
}

fn dir_size_bytes(path: &Path) -> u64 {
    let mut total = 0u64;
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.is_file() {
            total = total.saturating_add(meta.len());
        } else if meta.is_dir() {
            total = total.saturating_add(dir_size_bytes(&entry.path()));
        }
    }
    total
}

/// Walking multi‑GB media trees on every Sync status poll freezes the UI.
/// Cache for a short TTL; “On disk” is a summary, not a live meter.
const DISK_SIZE_CACHE_TTL: Duration = Duration::from_secs(90);

struct DiskSizeCache {
    media_path: PathBuf,
    thumbs_path: PathBuf,
    media_bytes: u64,
    thumbs_bytes: u64,
    computed_at: Instant,
}

fn disk_size_cache() -> &'static Mutex<Option<DiskSizeCache>> {
    static CACHE: OnceLock<Mutex<Option<DiskSizeCache>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// Drop cached media/thumbs byte totals (e.g. after large download batches).
pub(crate) fn invalidate_disk_size_cache() {
    if let Ok(mut guard) = disk_size_cache().lock() {
        *guard = None;
    }
}

fn cached_dir_sizes(paths: &ParascenePaths) -> (u64, u64) {
    if let Ok(guard) = disk_size_cache().lock() {
        if let Some(cache) = guard.as_ref() {
            if cache.media_path == paths.media
                && cache.thumbs_path == paths.thumbs
                && cache.computed_at.elapsed() < DISK_SIZE_CACHE_TTL
            {
                return (cache.media_bytes, cache.thumbs_bytes);
            }
        }
    }

    let media_bytes = dir_size_bytes(&paths.media);
    let thumbs_bytes = dir_size_bytes(&paths.thumbs);
    if let Ok(mut guard) = disk_size_cache().lock() {
        *guard = Some(DiskSizeCache {
            media_path: paths.media.clone(),
            thumbs_path: paths.thumbs.clone(),
            media_bytes,
            thumbs_bytes,
            computed_at: Instant::now(),
        });
    }
    (media_bytes, thumbs_bytes)
}

const WITHOUT_CLOUD_URLS_LIMIT: u32 = 50;

/// Cloud-backed rows only (not desktop-local imports). Local-only never had
/// cloud URLs, so they must not appear on Sync as “can't cache.”
const CLOUD_BACKED: &str = r#"
  (
    (remote_url IS NOT NULL AND remote_url != '')
    OR (remote_json IS NOT NULL AND remote_json != '')
  )
"#;

/// Audio/video whose remote_url is cover/poster art — caching cannot produce
/// playable media (same idea as download::needs_download).
const AV_REMOTE_IS_COVER: &str = r#"
  lower(media_type) IN ('audio', 'video')
  AND remote_url IS NOT NULL AND remote_url != ''
  AND (
    lower(remote_url) LIKE '%.png%'
    OR lower(remote_url) LIKE '%.jpg%'
    OR lower(remote_url) LIKE '%.jpeg%'
    OR lower(remote_url) LIKE '%.webp%'
    OR lower(remote_url) LIKE '%.gif%'
  )
"#;

fn list_without_cloud_urls(conn: &Connection) -> Result<Vec<WithoutCloudUrl>, String> {
    // Matches unsyncableThumbCount ∪ unsyncableMediaCount. Cover-only Suno/YouTube
    // A/V are expected to stay on the host — don't list them as a Sync problem.
    let mut stmt = conn
        .prepare(&format!(
            r#"
            SELECT id, title, filename FROM creations
            WHERE
              {CLOUD_BACKED}
              AND (
                (
                  (local_thumb_path IS NULL OR local_thumb_path = '')
                  AND NOT (
                    (fit_thumbnail_url IS NOT NULL AND fit_thumbnail_url != '')
                    OR (thumbnail_url IS NOT NULL AND thumbnail_url != '')
                    OR (media_type = 'image' AND remote_url IS NOT NULL AND remote_url != '')
                  )
                )
                OR
                (
                  (local_path IS NULL OR local_path = '')
                  AND (remote_url IS NULL OR remote_url = '')
                )
              )
            ORDER BY created_at DESC
            LIMIT ?1
            "#
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![WITHOUT_CLOUD_URLS_LIMIT], |row| {
            Ok(WithoutCloudUrl {
                id: row.get(0)?,
                title: row.get(1)?,
                filename: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

fn sync_status(conn: &Connection, paths: &ParascenePaths) -> Result<SyncStatus, String> {
    let total = count_creations(conn)? as u32;
    let with_thumb = count_where(
        conn,
        "SELECT COUNT(*) FROM creations WHERE local_thumb_path IS NOT NULL AND local_thumb_path != ''",
    )?;
    let with_media = count_where(
        conn,
        "SELECT COUNT(*) FROM creations WHERE local_path IS NOT NULL AND local_path != ''",
    )?;
    // Same URL rules as download::needs_thumb / needs_download (no local file required here).
    let missing_thumb_cacheable = count_where(
        conn,
        r#"SELECT COUNT(*) FROM creations
           WHERE (local_thumb_path IS NULL OR local_thumb_path = '')
             AND (
               (fit_thumbnail_url IS NOT NULL AND fit_thumbnail_url != '')
               OR (thumbnail_url IS NOT NULL AND thumbnail_url != '')
               OR (media_type = 'image' AND remote_url IS NOT NULL AND remote_url != '')
             )"#,
    )?;
    let missing_media_cacheable = count_where(
        conn,
        &format!(
            r#"SELECT COUNT(*) FROM creations
           WHERE (local_path IS NULL OR local_path = '')
             AND remote_url IS NOT NULL AND remote_url != ''
             AND NOT ({AV_REMOTE_IS_COVER})"#
        ),
    )?;
    let missing_thumb_uncacheable = count_where(
        conn,
        &format!(
            r#"SELECT COUNT(*) FROM creations
           WHERE {CLOUD_BACKED}
             AND (local_thumb_path IS NULL OR local_thumb_path = '')
             AND NOT (
               (fit_thumbnail_url IS NOT NULL AND fit_thumbnail_url != '')
               OR (thumbnail_url IS NOT NULL AND thumbnail_url != '')
               OR (media_type = 'image' AND remote_url IS NOT NULL AND remote_url != '')
             )"#
        ),
    )?;
    let missing_media_uncacheable = count_where(
        conn,
        &format!(
            r#"SELECT COUNT(*) FROM creations
           WHERE {CLOUD_BACKED}
             AND (local_path IS NULL OR local_path = '')
             AND (remote_url IS NULL OR remote_url = '')"#
        ),
    )?;
    let (media_bytes, thumbs_bytes) = cached_dir_sizes(paths);
    Ok(SyncStatus {
        root_path: paths.root.display().to_string(),
        last_sync_at: meta_get(conn, "last_sync_at")?,
        total,
        local: count_by_state(conn, "local")?,
        remote: count_by_state(conn, "remote")?,
        queued: count_by_state(conn, "queued")?,
        downloading: count_by_state(conn, "downloading")?,
        failed: count_by_state(conn, "failed")?,
        with_thumb,
        with_media,
        missing_thumb_cacheable,
        missing_media_cacheable,
        missing_thumb_uncacheable,
        missing_media_uncacheable,
        media_bytes,
        thumbs_bytes,
        without_cloud_urls: list_without_cloud_urls(conn)?,
    })
}

fn url_slot(value: Option<&str>) -> &str {
    value.map(str::trim).filter(|s| !s.is_empty()).unwrap_or("")
}

fn upsert_creation(conn: &Connection, row: &CreationUpsert, now: &str) -> Result<(), String> {
    // Wipe local files only when the playable media URL changes. Thumb/fit URLs
    // often arrive later (Generate wait vs Newest list) and must not delete a
    // cache this app already wrote.
    let prev = match conn.query_row(
        r#"
        SELECT remote_url, thumbnail_url, fit_thumbnail_url, video_url,
               local_path, local_thumb_path
        FROM creations WHERE id = ?1
        "#,
        params![&row.id],
        |r| {
            Ok((
                r.get::<_, Option<String>>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<String>>(5)?,
            ))
        },
    ) {
        Ok(v) => Some(v),
        Err(rusqlite::Error::QueryReturnedNoRows) => None,
        Err(e) => return Err(format!("Lookup creation before upsert failed: {e}")),
    };

    // Only the playable media pointer invalidates local files. Generate wait
    // often lands a video/image before Parascene has thumbnail_url; Newest
    // sync then fills thumbs. That is metadata enrichment, not a new asset.
    let media_changed = prev
        .as_ref()
        .map(|(remote, _, _, _, _, _)| {
            url_slot(remote.as_deref()) != url_slot(row.remote_url.as_deref())
        })
        .unwrap_or(false);

    conn.execute(
        r#"
        INSERT INTO creations (
          id, title, media_type, remote_url, thumbnail_url, fit_thumbnail_url, video_url,
          local_path, local_thumb_path, published, published_at, created_at, download_state,
          checksum, prompt, expires_at, updated_at,
          filename, description, color, status, width, height, aspect_ratio,
          nsfw, is_moderated_error, remote_json
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7,
          NULL, NULL, ?8, ?9, ?10, ?11,
          NULL, ?12, NULL, ?13,
          ?14, ?15, ?16, ?17, ?18, ?19, ?20,
          ?21, ?22, ?23
        )
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          media_type = excluded.media_type,
          remote_url = excluded.remote_url,
          thumbnail_url = excluded.thumbnail_url,
          fit_thumbnail_url = excluded.fit_thumbnail_url,
          video_url = excluded.video_url,
          published = excluded.published,
          published_at = excluded.published_at,
          created_at = excluded.created_at,
          prompt = excluded.prompt,
          filename = excluded.filename,
          description = excluded.description,
          color = excluded.color,
          status = excluded.status,
          width = excluded.width,
          height = excluded.height,
          aspect_ratio = excluded.aspect_ratio,
          nsfw = excluded.nsfw,
          is_moderated_error = excluded.is_moderated_error,
          remote_json = excluded.remote_json,
          updated_at = excluded.updated_at,
          download_state = CASE
            WHEN ?24 THEN 'remote'
            WHEN creations.local_path IS NOT NULL AND creations.download_state = 'local'
              THEN creations.download_state
            ELSE excluded.download_state
          END,
          local_path = CASE WHEN ?24 THEN NULL ELSE creations.local_path END,
          local_thumb_path = CASE WHEN ?24 THEN NULL ELSE creations.local_thumb_path END
        "#,
        params![
            row.id,
            row.title,
            row.media_type,
            row.remote_url,
            row.thumbnail_url,
            row.fit_thumbnail_url,
            row.video_url,
            if row.published { 1 } else { 0 },
            row.published_at,
            row.created_at,
            row.download_state,
            row.prompt,
            now,
            row.filename,
            row.description,
            row.color,
            row.status,
            row.width,
            row.height,
            row.aspect_ratio,
            if row.nsfw { 1 } else { 0 },
            if row.is_moderated_error { 1 } else { 0 },
            row.remote_json,
            media_changed,
        ],
    )
    .map_err(|e| format!("Upsert creation failed: {e}"))?;

    if media_changed {
        if let Some((_, _, _, _, local_path, local_thumb)) = prev {
            if let Ok(paths) = default_paths() {
                remove_file_under_root(&paths.media, local_path.as_deref());
                remove_file_under_root(&paths.thumbs, local_thumb.as_deref());
            }
        }
    }
    Ok(())
}

/// Drop local preview path so the next thumb download can prefer a new fit URL.
pub(crate) fn clear_local_thumb_paths(conn: &Connection, ids: &[String]) -> Result<u32, String> {
    if ids.is_empty() {
        return Ok(0);
    }
    let now = Utc::now().to_rfc3339();
    let mut cleared = 0u32;
    for id in ids {
        let path: Option<String> = conn
            .query_row(
                "SELECT local_thumb_path FROM creations WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .ok()
            .flatten();
        if let Some(p) = path.as_deref().filter(|p| !p.is_empty()) {
            let _ = std::fs::remove_file(p);
        }
        let n = conn
            .execute(
                "UPDATE creations SET local_thumb_path = NULL, updated_at = ?1 WHERE id = ?2",
                params![now, id],
            )
            .map_err(|e| e.to_string())?;
        if n > 0 {
            cleared += 1;
        }
    }
    Ok(cleared)
}

pub(crate) fn set_download_state(conn: &Connection, id: &str, state: &str) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE creations SET download_state = ?1, updated_at = ?2 WHERE id = ?3",
        params![state, now, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn set_local_thumb_path(
    conn: &Connection,
    id: &str,
    local_thumb_path: &str,
) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE creations SET local_thumb_path = ?1, updated_at = ?2 WHERE id = ?3",
        params![local_thumb_path, now, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Persist board geometry from a generated thumb (width/height + creative aspect).
pub(crate) fn set_creation_geometry(
    conn: &Connection,
    id: &str,
    width: i64,
    height: i64,
    aspect_ratio: &str,
) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        r#"
        UPDATE creations
        SET width = ?1,
            height = ?2,
            aspect_ratio = ?3,
            updated_at = ?4
        WHERE id = ?5
        "#,
        params![width, height, aspect_ratio, now, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn mark_downloaded(
    conn: &Connection,
    id: &str,
    local_path: &str,
    local_thumb_path: Option<&str>,
) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        r#"
        UPDATE creations
        SET local_path = ?1,
            local_thumb_path = COALESCE(?2, local_thumb_path),
            download_state = 'local',
            updated_at = ?3
        WHERE id = ?4
        "#,
        params![local_path, local_thumb_path, now, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Clear a bogus full-media path (e.g. cover PNG stored as audio local_path).
pub(crate) fn clear_local_media_path(conn: &Connection, id: &str) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        r#"
        UPDATE creations
        SET local_path = NULL,
            download_state = CASE
              WHEN remote_url IS NOT NULL AND remote_url != '' THEN 'remote'
              ELSE download_state
            END,
            updated_at = ?1
        WHERE id = ?2
        "#,
        params![now, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Cloud audio imports often saved the cover image as `local_path` and marked
/// download_state=local. That makes the lightbox feed a PNG into `<audio>`.
pub(crate) fn heal_audio_cover_local_paths(conn: &Connection) -> Result<u32, String> {
    let now = Utc::now().to_rfc3339();
    let changed = conn
        .execute(
            r#"
            UPDATE creations
            SET local_thumb_path = COALESCE(local_thumb_path, local_path),
                local_path = NULL,
                download_state = CASE
                  WHEN remote_url IS NOT NULL AND remote_url != '' THEN 'remote'
                  ELSE download_state
                END,
                updated_at = ?1
            WHERE lower(media_type) = 'audio'
              AND local_path IS NOT NULL
              AND local_path != ''
              AND (
                   lower(local_path) LIKE '%.png'
                OR lower(local_path) LIKE '%.jpg'
                OR lower(local_path) LIKE '%.jpeg'
                OR lower(local_path) LIKE '%.webp'
                OR lower(local_path) LIKE '%.gif'
                OR lower(local_path) LIKE '%.bmp'
              )
            "#,
            params![now],
        )
        .map_err(|e| e.to_string())? as u32;
    Ok(changed)
}

/// Drop usage/index rows for a project that is no longer native-owned.
pub(crate) fn clear_native_project_index(
    conn: &Connection,
    project_id: &str,
) -> Result<(), String> {
    for sql in [
        "DELETE FROM project_asset_usage WHERE project_id = ?1",
        "DELETE FROM project_usage_revisions WHERE project_id = ?1",
        "DELETE FROM project_assets WHERE project_id = ?1",
        "DELETE FROM project_membership_revisions WHERE project_id = ?1",
        "DELETE FROM project_library_bindings WHERE project_id = ?1",
    ] {
        conn.execute(sql, params![project_id])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn project_has_live_folder(conn: &Connection, project_id: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM folders WHERE kind = 'project' AND project_id = ?1)",
        params![project_id],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

/// Ghost usage from a deleted project (no project folder, and/or not in the
/// current stored-project set) must not block Library deletes.
pub(crate) fn prune_stale_creation_usage(
    conn: &Connection,
    creation_id: &str,
    audited_project_ids: Option<&[String]>,
) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT DISTINCT project_id FROM project_asset_usage WHERE creation_id = ?1")
        .map_err(|e| e.to_string())?;
    let cited: Vec<String> = stmt
        .query_map(params![creation_id], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);
    let audited: Option<BTreeSet<&str>> = audited_project_ids.map(|ids| {
        ids.iter()
            .map(|id| id.as_str())
            .filter(|id| !id.is_empty())
            .collect()
    });
    for project_id in cited {
        let live_folder = project_has_live_folder(conn, &project_id)?;
        let in_store = audited
            .as_ref()
            .map(|set| set.contains(project_id.as_str()))
            .unwrap_or(true);
        if !live_folder || !in_store {
            clear_native_project_index(conn, &project_id)?;
        }
    }
    Ok(())
}

/// Drop cloud-backed catalog rows and their local files. Keeps disk imports.
/// Does not touch Parascene cloud and does not enqueue folder unfile ops.
pub(crate) fn clear_cloud_backed_local(
    conn: &Connection,
    paths: &ParascenePaths,
) -> Result<u32, String> {
    let sql = format!(
        "SELECT id, local_path, local_thumb_path FROM creations WHERE {CLOUD_BACKED}"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut ids = Vec::new();
    for row in rows {
        let (id, local_path, thumb) = row.map_err(|e| e.to_string())?;
        remove_file_under_root(&paths.media, local_path.as_deref());
        remove_file_under_root(&paths.thumbs, thumb.as_deref());
        ids.push(id);
    }
    if !ids.is_empty() {
        let in_cloud = format!("IN (SELECT id FROM creations WHERE {CLOUD_BACKED})");
        conn.execute(
            &format!("DELETE FROM folder_items WHERE creation_id {in_cloud}"),
            [],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            &format!("UPDATE folders SET cover_creation_id = NULL WHERE cover_creation_id {in_cloud}"),
            [],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            &format!("DELETE FROM project_assets WHERE creation_id {in_cloud}"),
            [],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            &format!("DELETE FROM project_asset_usage WHERE creation_id {in_cloud}"),
            [],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(&format!("DELETE FROM creations WHERE {CLOUD_BACKED}"), [])
            .map_err(|e| e.to_string())?;
    }
    meta_delete(conn, "last_sync_at")?;
    invalidate_disk_size_cache();
    Ok(ids.len() as u32)
}

/// Delete a creation from the local catalog and remove its media/thumb files.
/// Only removes files under Library/media or Library/thumbs. Does not touch Parascene cloud.
///
/// Item-scoped: unrelated orphan/stale project folders do not block deletion.
/// Callers must unfile project-folder members first (or use
/// `library_delete_creation_checked`, which audits the owning folder).
pub(crate) fn delete_creation_local(
    conn: &Connection,
    paths: &ParascenePaths,
    id: &str,
) -> Result<(), String> {
    prune_stale_creation_usage(conn, id, None)?;
    let uses: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM project_asset_usage u
             WHERE u.creation_id = ?1
               AND EXISTS (
                 SELECT 1 FROM folders f
                 WHERE f.kind = 'project' AND f.project_id = u.project_id
               )",
            params![id],
            |row| row.get(0),
        )
        .map_err(|e| format!("Could not verify project usage: {e}"))?;
    if uses > 0 {
        return Err("This creation is used by a project and cannot be deleted".into());
    }
    let project_owner: Option<(String, String)> = conn
        .query_row(
            "SELECT f.project_id, f.title FROM folder_items fi
             JOIN folders f ON f.id = fi.folder_id
             WHERE fi.creation_id = ?1 AND f.kind = 'project' LIMIT 1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| format!("Could not verify project membership: {e}"))?;
    if let Some((project_id, title)) = project_owner {
        return Err(format!(
            "This creation belongs to project folder \"{title}\" ({project_id}). Remove it from the project before deleting it."
        ));
    }
    let creation =
        get_creation_by_id(conn, id)?.ok_or_else(|| format!("Creation {id} not found"))?;
    remove_file_under_root(&paths.media, creation.local_path.as_deref());
    remove_file_under_root(&paths.thumbs, creation.local_thumb_path.as_deref());
    // A deleted creation must stop counting as a folder member. This also
    // records the folder move for cloud-backed rows; local-only project output
    // simply has its local membership removed.
    super::folders::remove_from_folder(conn, &[id.to_string()])?;
    // Drop folder/project artwork pointers that referenced this creation.
    super::folders::clear_folder_covers_for_creation(conn, id)?;
    conn.execute(
        "DELETE FROM project_assets WHERE creation_id = ?1",
        params![id],
    )
    .map_err(|e| format!("Delete project asset membership failed: {e}"))?;
    let n = conn
        .execute("DELETE FROM creations WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(format!("Creation {id} not found"));
    }
    Ok(())
}

fn remove_file_under_root(root: &Path, stored: Option<&str>) {
    let Some(stored) = stored.filter(|s| !s.is_empty()) else {
        return;
    };
    let path = Path::new(stored);
    let Ok(root_canon) = root.canonicalize() else {
        return;
    };
    let candidate = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    let Ok(file_canon) = candidate.canonicalize() else {
        // Missing file is fine — still delete the catalog row.
        return;
    };
    if file_canon.starts_with(&root_canon) && file_canon.is_file() {
        let _ = std::fs::remove_file(&file_canon);
    }
}

pub(crate) fn ready_connection(paths: &ParascenePaths) -> Result<Connection, String> {
    ensure_directories(paths)?;
    let conn = open_db(&paths.catalog_db)?;
    // Migrate once per catalog DB path (Sync status polls hit the same default
    // path often). Tests use unique temp roots and must each get a full migrate.
    static READY_DBS: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
    let db_key = paths.catalog_db.to_string_lossy().into_owned();
    let ready = READY_DBS.get_or_init(|| Mutex::new(std::collections::HashSet::new()));
    let mut guard = ready
        .lock()
        .map_err(|_| "Catalog ready lock poisoned".to_string())?;
    if guard.insert(db_key) {
        migrate(&conn)?;
        meta_set(&conn, "root_path", &paths.root.display().to_string())?;
        conn.execute("DELETE FROM creations WHERE id LIKE 'fixture-%'", [])
            .map_err(|e| e.to_string())?;
        super::folders::ensure_folder_sync_ready(&conn)?;
        let healed = heal_audio_cover_local_paths(&conn).unwrap_or(0);
        if healed > 0 {
            eprintln!("[library] healed {healed} audio rows that stored cover art as local media");
        }
    }
    Ok(conn)
}

pub(crate) fn default_paths() -> Result<ParascenePaths, String> {
    Ok(resolve_paths(account_root()?))
}

pub(crate) fn sync_status_for(paths: &ParascenePaths) -> Result<SyncStatus, String> {
    let conn = ready_connection(paths)?;
    sync_status(&conn, paths)
}

pub fn current_sync_status() -> Result<SyncStatus, String> {
    sync_status_for(&default_paths()?)
}

pub(crate) fn apply_manifest(conn: &Connection, rows: &[CreationUpsert]) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    conn.execute_batch("BEGIN")
        .map_err(|e| format!("Begin catalog write: {e}"))?;
    let result = (|| {
        conn.execute("DELETE FROM creations WHERE id LIKE 'fixture-%'", [])
            .map_err(|e| e.to_string())?;
        for row in rows {
            upsert_creation(conn, row, &now)?;
        }
        meta_set(conn, "last_sync_at", &now)?;
        Ok(())
    })();
    match result {
        Ok(()) => {
            conn.execute_batch("COMMIT")
                .map_err(|e| format!("Commit catalog write: {e}"))?;
            Ok(())
        }
        Err(err) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(err)
        }
    }
}

/// Site origin used when absolutizing relative Parascene asset paths.
/// Must stay aligned with the TypeScript `getEnvConfig().baseUrl` / SDK origin.
const PARASCENE_ORIGIN: &str = "https://www.parascene.com";

fn json_id(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        }
        serde_json::Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn json_opt_string(value: Option<&serde_json::Value>) -> Option<String> {
    value.and_then(|v| match v {
        serde_json::Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        }
        _ => None,
    })
}

fn json_bool(raw: &serde_json::Value, key: &str) -> bool {
    match raw.get(key) {
        Some(serde_json::Value::Bool(b)) => *b,
        Some(serde_json::Value::Number(n)) => n.as_i64().unwrap_or(0) != 0,
        _ => false,
    }
}

fn json_positive_int(raw: &serde_json::Value, key: &str) -> Option<i64> {
    match raw.get(key)? {
        serde_json::Value::Number(n) => n.as_i64().filter(|v| *v > 0),
        serde_json::Value::String(s) => s.parse::<i64>().ok().filter(|v| *v > 0),
        _ => None,
    }
}

/// Mirror of TypeScript `absolutizeAssetUrl`.
fn absolutize_asset_url(value: Option<&str>, origin: &str) -> Option<String> {
    let v = value.map(str::trim).filter(|s| !s.is_empty())?;
    if v.starts_with("http://") || v.starts_with("https://") {
        return Some(v.to_string());
    }
    if let Some(rest) = v.strip_prefix("//") {
        return Some(format!("https:{rest}"));
    }
    let base = origin.trim_end_matches('/');
    if v.starts_with('/') {
        return Some(format!("{base}{v}"));
    }
    Some(v.to_string())
}

/// Mirror of TypeScript `deriveFitThumbnailUrl`.
/// Create/detail often omit `fit_thumbnail_url` even when `?variant=fit` exists.
fn derive_fit_thumbnail_url(
    thumbnail_url: Option<&str>,
    image_url: Option<&str>,
) -> Option<String> {
    if let Some(t) = thumbnail_url.map(str::trim).filter(|s| !s.is_empty()) {
        if t.contains("variant=fit") {
            return Some(t.to_string());
        }
        if t.contains("variant=thumbnail") {
            return Some(t.replace("variant=thumbnail", "variant=fit"));
        }
        return Some(if t.contains('?') {
            format!("{t}&variant=fit")
        } else {
            format!("{t}?variant=fit")
        });
    }
    let u = image_url.map(str::trim).filter(|s| !s.is_empty())?;
    let lower = u.to_ascii_lowercase();
    if lower.contains(".mp4") || lower.contains("/videos/") {
        return None;
    }
    if let Some(start) = u.find("variant=") {
        let mut s = u.to_string();
        let after = start + "variant=".len();
        let end = s[after..].find('&').map(|i| after + i).unwrap_or(s.len());
        s.replace_range(after..end, "fit");
        return Some(s);
    }
    Some(if u.contains('?') {
        format!("{u}&variant=fit")
    } else {
        format!("{u}?variant=fit")
    })
}

fn prompt_from_meta(meta: Option<&serde_json::Value>) -> Option<String> {
    let meta = meta?;
    if let Some(s) = json_opt_string(meta.get("prompt")) {
        return Some(s);
    }
    meta.get("args")
        .and_then(|args| json_opt_string(args.get("prompt")))
}

/// Mirror of TypeScript `aspectRatioFromMeta` (trusts `meta.args.aspect_ratio`).
fn aspect_ratio_from_meta(meta: Option<&serde_json::Value>) -> Option<String> {
    let raw = meta?
        .get("args")
        .and_then(|args| json_opt_string(args.get("aspect_ratio")))?;
    // Accept preset-like or numeric "W:H" strings (same as FE parseAspectRatioString).
    let parts: Vec<_> = raw.split(':').map(str::trim).collect();
    if parts.len() != 2 {
        return None;
    }
    let (Ok(w), Ok(h)) = (parts[0].parse::<f64>(), parts[1].parse::<f64>()) else {
        return None;
    };
    if w <= 0.0 || h <= 0.0 {
        return None;
    }
    Some(raw)
}

/// Map a Parascene create-images JSON row the same way FE `mapRemoteCreation` does.
///
/// - Absolutizes url / thumbnail / fit / video / audio
/// - Infers media_type from video_url when missing
/// - Prefers video_url / audio_url as remote_url for video / audio
/// - Derives aspect_ratio from meta.args, else width×height
/// - Synthesizes url/thumbnail from `file_path` when sparse (group source rows)
/// - Derives `fit_thumbnail_url` from thumbnail/url when the API omits it
/// - Stores an absolutized remote_json snapshot
pub(crate) fn map_remote_creation_json(raw: &serde_json::Value) -> Result<CreationUpsert, String> {
    let id = raw
        .get("id")
        .and_then(json_id)
        .ok_or_else(|| "remote creation missing id".to_string())?;

    let file_path = json_opt_string(raw.get("file_path"));
    let mut url = json_opt_string(raw.get("url"))
        .or_else(|| json_opt_string(raw.get("image_url")))
        .or_else(|| file_path.clone());
    let mut thumbnail_url = json_opt_string(raw.get("thumbnail_url"))
        .or_else(|| file_path.as_ref().map(|p| format!("{p}?variant=thumbnail")));
    let mut fit_thumbnail_url = json_opt_string(raw.get("fit_thumbnail_url"));
    let mut video_url = json_opt_string(raw.get("video_url"));
    let mut audio_url = json_opt_string(raw.get("audio_url"));

    let media_type = json_opt_string(raw.get("media_type")).unwrap_or_else(|| {
        if video_url.is_some() {
            "video".into()
        } else if audio_url.is_some() {
            "audio".into()
        } else {
            "image".into()
        }
    });

    let origin = PARASCENE_ORIGIN;
    url = absolutize_asset_url(url.as_deref(), origin);
    thumbnail_url = absolutize_asset_url(thumbnail_url.as_deref(), origin);
    fit_thumbnail_url = absolutize_asset_url(fit_thumbnail_url.as_deref(), origin)
        .or_else(|| derive_fit_thumbnail_url(thumbnail_url.as_deref(), url.as_deref()));
    video_url = absolutize_asset_url(video_url.as_deref(), origin);
    audio_url = absolutize_asset_url(audio_url.as_deref(), origin);

    // Prefer playable media. Cover art stays on `url` / thumbs.
    // Audio without audio_url (cover-only Suno) keeps image remote_url → skip download.
    let remote_url = if media_type.eq_ignore_ascii_case("video") {
        video_url.clone().or_else(|| url.clone())
    } else if media_type.eq_ignore_ascii_case("audio") {
        audio_url.clone().or_else(|| url.clone())
    } else {
        url.clone().or_else(|| video_url.clone())
    };

    let filename = json_opt_string(raw.get("filename"));
    let title = json_opt_string(raw.get("title"))
        .or_else(|| filename.clone())
        .unwrap_or_else(|| format!("Creation {id}"));
    let width = json_positive_int(raw, "width");
    let height = json_positive_int(raw, "height");
    let meta = raw.get("meta");
    let aspect_ratio = aspect_ratio_from_meta(meta).or_else(|| match (width, height) {
        (Some(w), Some(h)) => Some(format!("{w}:{h}")),
        _ => None,
    });
    let status = json_opt_string(raw.get("status")).unwrap_or_else(|| "completed".into());
    let created_at =
        json_opt_string(raw.get("created_at")).unwrap_or_else(|| Utc::now().to_rfc3339());
    let description = json_opt_string(raw.get("description"));
    let color = json_opt_string(raw.get("color"));
    let published = json_bool(raw, "published");
    let published_at = json_opt_string(raw.get("published_at"));
    let nsfw = json_bool(raw, "nsfw");
    let is_moderated_error = json_bool(raw, "is_moderated_error");
    let prompt = prompt_from_meta(meta);

    // Absolutized cloud snapshot — same fields FE writes into remoteJson.
    let mut snapshot = raw.clone();
    if let Some(obj) = snapshot.as_object_mut() {
        obj.insert("id".into(), serde_json::Value::String(id.clone()));
        obj.insert(
            "url".into(),
            match &url {
                Some(u) => serde_json::Value::String(u.clone()),
                None => serde_json::Value::Null,
            },
        );
        obj.insert(
            "thumbnail_url".into(),
            match &thumbnail_url {
                Some(u) => serde_json::Value::String(u.clone()),
                None => serde_json::Value::Null,
            },
        );
        obj.insert(
            "fit_thumbnail_url".into(),
            match &fit_thumbnail_url {
                Some(u) => serde_json::Value::String(u.clone()),
                None => serde_json::Value::Null,
            },
        );
        obj.insert(
            "video_url".into(),
            match &video_url {
                Some(u) => serde_json::Value::String(u.clone()),
                None => serde_json::Value::Null,
            },
        );
        obj.insert(
            "audio_url".into(),
            match &audio_url {
                Some(u) => serde_json::Value::String(u.clone()),
                None => serde_json::Value::Null,
            },
        );
        obj.insert(
            "media_type".into(),
            serde_json::Value::String(media_type.clone()),
        );
        if let Some(w) = width {
            obj.insert("width".into(), serde_json::json!(w));
        }
        if let Some(h) = height {
            obj.insert("height".into(), serde_json::json!(h));
        }
        obj.insert(
            "filename".into(),
            match &filename {
                Some(f) => serde_json::Value::String(f.clone()),
                None => serde_json::Value::Null,
            },
        );
        obj.insert(
            "title".into(),
            match json_opt_string(raw.get("title")) {
                Some(t) => serde_json::Value::String(t),
                None => serde_json::Value::Null,
            },
        );
        obj.insert(
            "description".into(),
            match &description {
                Some(d) => serde_json::Value::String(d.clone()),
                None => serde_json::Value::Null,
            },
        );
        obj.insert(
            "color".into(),
            match &color {
                Some(c) => serde_json::Value::String(c.clone()),
                None => serde_json::Value::Null,
            },
        );
        obj.insert("status".into(), serde_json::Value::String(status.clone()));
        obj.insert("published".into(), serde_json::Value::Bool(published));
        obj.insert(
            "published_at".into(),
            match &published_at {
                Some(p) => serde_json::Value::String(p.clone()),
                None => serde_json::Value::Null,
            },
        );
        obj.insert(
            "created_at".into(),
            serde_json::Value::String(created_at.clone()),
        );
        obj.insert("nsfw".into(), serde_json::Value::Bool(nsfw));
        obj.insert(
            "is_moderated_error".into(),
            serde_json::Value::Bool(is_moderated_error),
        );
        if !obj.contains_key("meta") {
            obj.insert("meta".into(), serde_json::Value::Null);
        }
    }

    Ok(CreationUpsert {
        id,
        title,
        media_type,
        remote_url,
        thumbnail_url,
        fit_thumbnail_url,
        video_url,
        published,
        published_at,
        created_at,
        // Match FE mapRemoteCreation — always "remote"; upsert preserves local when present.
        download_state: "remote".into(),
        prompt,
        filename,
        description,
        color,
        status: Some(status),
        width,
        height,
        aspect_ratio,
        nsfw,
        is_moderated_error,
        remote_json: serde_json::to_string(&snapshot).unwrap_or_else(|_| "{}".into()),
    })
}

/// Upsert a Parascene create-images JSON row into the local catalog (job worker path).
pub(crate) fn ingest_remote_creation_json(raw: &serde_json::Value) -> Result<String, String> {
    let row = map_remote_creation_json(raw)?;
    let id = row.id.clone();
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    let now = Utc::now().to_rfc3339();
    upsert_creation(&conn, &row, &now)?;
    meta_set(&conn, "last_sync_at", &now)?;
    Ok(id)
}

#[tauri::command]
pub fn library_ensure_ready() -> Result<SyncStatus, String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    sync_status(&conn, &paths)
}

#[tauri::command]
pub async fn library_list_creations() -> Result<Vec<Creation>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let paths = default_paths()?;
        let conn = ready_connection(&paths)?;
        list_creations(&conn)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn library_filter_counts() -> Result<CatalogFilterCounts, String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    catalog_filter_counts(&conn)
}

/// Full match set for sparse filters (`audio`, `localOnly`) — not limited to newest pages.
#[tauri::command]
pub fn library_list_filter_creations(filter: String) -> Result<Vec<Creation>, String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    list_creations_for_filter(&conn, filter.trim())
}

/// Plain list (no side effects). UI paging uses `library::library_list_creations_page`
/// which is also local SQLite only — Sync owns downloads.
pub(crate) fn query_creations_page(limit: u32, offset: u32) -> Result<CreationPage, String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    list_creations_page(&conn, limit, offset)
}

#[tauri::command]
pub fn library_get_creation(id: String) -> Result<Creation, String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    get_creation_by_id(&conn, &id)?.ok_or_else(|| format!("Creation {id} not found"))
}

#[tauri::command]
pub fn library_get_creations(ids: Vec<String>) -> Result<Vec<Creation>, String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    get_creations_by_ids(&conn, &ids)
}

/// Which of the given creation ids already exist in the local catalog.
#[tauri::command]
pub fn library_existing_creation_ids(ids: Vec<String>) -> Result<Vec<String>, String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    existing_creation_ids(&conn, &ids)
}

pub(crate) fn existing_creation_ids(
    conn: &Connection,
    ids: &[String],
) -> Result<Vec<String>, String> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut unique: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for id in ids {
        let trimmed = id.trim();
        if trimmed.is_empty() || !seen.insert(trimmed.to_string()) {
            continue;
        }
        unique.push(trimmed.to_string());
    }
    if unique.is_empty() {
        return Ok(Vec::new());
    }

    let mut found: std::collections::HashSet<String> = std::collections::HashSet::new();
    const CHUNK: usize = 400;
    for chunk in unique.chunks(CHUNK) {
        let placeholders = std::iter::repeat("?")
            .take(chunk.len())
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!("SELECT id FROM creations WHERE id IN ({placeholders})");
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(chunk.iter()), |row| {
                row.get::<_, String>(0)
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            found.insert(row.map_err(|e| e.to_string())?);
        }
    }

    // Preserve caller order among matches.
    Ok(unique.into_iter().filter(|id| found.contains(id)).collect())
}

fn remote_json_has_group_members(filename: Option<&str>, remote_json: Option<&str>) -> bool {
    let is_group = filename
        .map(|f| f.trim().to_ascii_lowercase().starts_with("group/"))
        .unwrap_or(false)
        || remote_json
            .map(|raw| {
                raw.contains("\"kind\":\"group_creations\"")
                    || raw.contains("\"kind\": \"group_creations\"")
            })
            .unwrap_or(false);
    if !is_group {
        return true;
    }
    remote_json
        .map(|raw| !group_member_ids_from_remote_json(raw).is_empty())
        .unwrap_or(false)
}

/// Ids that still need a list-page refresh (missing locally, or group cover
/// without source membership). Skip the rest so Editor open does not walk
/// the remote catalog.
pub(crate) fn ids_needing_group_list_refresh(
    conn: &Connection,
    ids: &[String],
) -> Result<Vec<String>, String> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut unique: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for id in ids {
        let trimmed = id.trim();
        if trimmed.is_empty() || !seen.insert(trimmed.to_string()) {
            continue;
        }
        unique.push(trimmed.to_string());
    }
    if unique.is_empty() {
        return Ok(Vec::new());
    }

    let mut by_id: std::collections::HashMap<String, (Option<String>, Option<String>)> =
        std::collections::HashMap::new();
    const CHUNK: usize = 400;
    for chunk in unique.chunks(CHUNK) {
        let placeholders = std::iter::repeat("?")
            .take(chunk.len())
            .collect::<Vec<_>>()
            .join(", ");
        let sql =
            format!("SELECT id, filename, remote_json FROM creations WHERE id IN ({placeholders})");
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(chunk.iter()), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (id, filename, remote_json) = row.map_err(|e| e.to_string())?;
            by_id.insert(id, (filename, remote_json));
        }
    }

    Ok(unique
        .into_iter()
        .filter(|id| match by_id.get(id) {
            None => true,
            Some((filename, remote_json)) => {
                !remote_json_has_group_members(filename.as_deref(), remote_json.as_deref())
            }
        })
        .collect())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreationIdAt {
    pub id: String,
    pub created_at: String,
}

/// Cloud catalog ids with `created_at >= since_iso` (excludes local-only imports).
#[tauri::command]
pub fn library_cloud_ids_since(since_iso: String) -> Result<Vec<CreationIdAt>, String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    cloud_ids_since(&conn, &since_iso)
}

pub(crate) fn cloud_ids_since(
    conn: &Connection,
    since_iso: &str,
) -> Result<Vec<CreationIdAt>, String> {
    let since = since_iso.trim();
    if since.is_empty() {
        return Ok(Vec::new());
    }
    let mut stmt = conn
        .prepare(
            "SELECT id, created_at FROM creations
             WHERE created_at >= ?1
               AND id NOT LIKE 'local-%'
               AND id NOT LIKE 'fixture-%'
             ORDER BY created_at DESC, id DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![since], |row| {
            Ok(CreationIdAt {
                id: row.get(0)?,
                created_at: row.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[tauri::command]
pub fn library_list_group_member_ids() -> Result<Vec<String>, String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    collect_group_member_ids(&conn)
}

#[tauri::command]
pub async fn library_sync_status() -> Result<SyncStatus, String> {
    tokio::task::spawn_blocking(|| {
        let paths = default_paths()?;
        sync_status_for(&paths)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn library_apply_manifest(creations: Vec<CreationUpsert>) -> Result<SyncStatus, String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    apply_manifest(&conn, &creations)?;
    sync_status(&conn, &paths)
}

/// Clear local preview files/paths so thumbs can be re-downloaded (e.g. after fit repair).
#[tauri::command]
pub fn library_invalidate_thumbs(ids: Vec<String>) -> Result<u32, String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    clear_local_thumb_paths(&conn, &ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_paths() -> ParascenePaths {
        let root = std::env::temp_dir().join(format!(
            "parascene-catalog-test-{}-{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&root);
        resolve_paths(root)
    }

    #[test]
    fn migrate_seed_is_idempotent() {
        let paths = temp_paths();
        let conn = ready_connection(&paths).expect("ready");
        seed_if_empty(&conn).expect("seed");
        let first = list_creations(&conn).expect("list");
        assert_eq!(first.len(), 4);
        seed_if_empty(&conn).expect("seed again");
        let second = list_creations(&conn).expect("list again");
        assert_eq!(second.len(), 4);

        let _ = fs::remove_dir_all(&paths.root);
    }

    #[test]
    fn heal_audio_cover_local_paths_clears_png_media() {
        let paths = temp_paths();
        let conn = ready_connection(&paths).expect("ready");
        let now = Utc::now().to_rfc3339();
        conn.execute(
            r#"
            INSERT INTO creations (
              id, title, media_type, remote_url, local_path, local_thumb_path,
              published, created_at, download_state, updated_at
            ) VALUES (?1, ?2, 'audio', ?3, ?4, NULL, 0, ?5, 'local', ?5)
            "#,
            params![
                "audio-cover",
                "Cover Only",
                "https://cdn.example/cover.png",
                "/tmp/cover.png",
                now,
            ],
        )
        .expect("insert");
        let healed = heal_audio_cover_local_paths(&conn).expect("heal");
        assert_eq!(healed, 1);
        let row = get_creation_by_id(&conn, "audio-cover")
            .expect("get")
            .expect("exists");
        assert!(row.local_path.is_none());
        assert_eq!(row.local_thumb_path.as_deref(), Some("/tmp/cover.png"));
        assert_eq!(row.download_state, "remote");

        let _ = fs::remove_dir_all(&paths.root);
    }

    #[test]
    fn apply_manifest_replaces_fixtures_and_sets_last_sync() {
        let paths = temp_paths();
        let conn = ready_connection(&paths).expect("ready");
        seed_if_empty(&conn).expect("seed");
        apply_manifest(
            &conn,
            &[CreationUpsert {
                id: "42".into(),
                title: "My clip".into(),
                media_type: "video".into(),
                remote_url: Some("https://cdn.example/v.mp4".into()),
                thumbnail_url: Some("https://cdn.example/t.jpg".into()),
                fit_thumbnail_url: Some("https://cdn.example/t.jpg?variant=fit".into()),
                video_url: Some("https://cdn.example/v.mp4".into()),
                published: true,
                published_at: Some("2026-01-03T00:00:00Z".into()),
                created_at: "2026-01-02T00:00:00Z".into(),
                download_state: "remote".into(),
                prompt: Some("a prompt".into()),
                filename: Some("clip.mp4".into()),
                description: Some("desc".into()),
                color: Some("#112233".into()),
                status: Some("completed".into()),
                width: Some(1920),
                height: Some(1080),
                aspect_ratio: Some("16:9".into()),
                nsfw: false,
                is_moderated_error: false,
                remote_json: r#"{"id":"42","width":1920,"height":1080}"#.into(),
            }],
        )
        .expect("apply");
        let rows = list_creations(&conn).expect("list");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "42");
        assert_eq!(rows[0].title, "My clip");
        assert!(rows[0].thumbnail_url.is_some());
        assert!(rows[0].fit_thumbnail_url.is_some());
        assert_eq!(rows[0].width, Some(1920));
        assert_eq!(rows[0].height, Some(1080));
        assert_eq!(rows[0].aspect_ratio.as_deref(), Some("16:9"));
        assert_eq!(rows[0].color.as_deref(), Some("#112233"));
        assert!(rows[0].remote_json.is_some());
        let status = sync_status(&conn, &paths).expect("status");
        assert_eq!(status.total, 1);
        assert!(status.last_sync_at.is_some());

        let _ = fs::remove_dir_all(&paths.root);
    }

    #[test]
    fn newest_thumb_urls_do_not_wipe_generate_cache() {
        let paths = temp_paths();
        let conn = ready_connection(&paths).expect("ready");
        apply_manifest(
            &conn,
            &[CreationUpsert {
                id: "99".into(),
                title: "Gen".into(),
                media_type: "video".into(),
                remote_url: Some("https://cdn.example/v.mp4".into()),
                thumbnail_url: None,
                fit_thumbnail_url: None,
                video_url: Some("https://cdn.example/v.mp4".into()),
                published: false,
                published_at: None,
                created_at: "2026-01-02T00:00:00Z".into(),
                download_state: "remote".into(),
                prompt: None,
                filename: Some("v.mp4".into()),
                description: None,
                color: None,
                status: Some("completed".into()),
                width: Some(1280),
                height: Some(720),
                aspect_ratio: Some("16:9".into()),
                nsfw: false,
                is_moderated_error: false,
                remote_json: r#"{"id":"99"}"#.into(),
            }],
        )
        .expect("ingest");
        let media = paths.media.join("99.mp4");
        let thumb = paths.thumbs.join("99.jpg");
        fs::create_dir_all(&paths.media).expect("media dir");
        fs::create_dir_all(&paths.thumbs).expect("thumbs dir");
        fs::write(&media, b"video").expect("media");
        fs::write(&thumb, b"thumb").expect("thumb");
        mark_downloaded(
            &conn,
            "99",
            &media.display().to_string(),
            Some(&thumb.display().to_string()),
        )
        .expect("mark");

        apply_manifest(
            &conn,
            &[CreationUpsert {
                id: "99".into(),
                title: "Gen".into(),
                media_type: "video".into(),
                remote_url: Some("https://cdn.example/v.mp4".into()),
                thumbnail_url: Some("https://cdn.example/t.jpg".into()),
                fit_thumbnail_url: Some("https://cdn.example/t.jpg?variant=fit".into()),
                video_url: Some("https://cdn.example/v.mp4".into()),
                published: false,
                published_at: None,
                created_at: "2026-01-02T00:00:00Z".into(),
                download_state: "remote".into(),
                prompt: None,
                filename: Some("v.mp4".into()),
                description: None,
                color: None,
                status: Some("completed".into()),
                width: Some(1280),
                height: Some(720),
                aspect_ratio: Some("16:9".into()),
                nsfw: false,
                is_moderated_error: false,
                remote_json: r#"{"id":"99","thumbnail_url":"https://cdn.example/t.jpg"}"#.into(),
            }],
        )
        .expect("newest");

        let row = get_creation_by_id(&conn, "99")
            .expect("get")
            .expect("exists");
        let media_s = media.display().to_string();
        let thumb_s = thumb.display().to_string();
        assert_eq!(row.local_path.as_deref(), Some(media_s.as_str()));
        assert_eq!(row.local_thumb_path.as_deref(), Some(thumb_s.as_str()));
        assert_eq!(row.download_state, "local");
        assert!(media.exists());
        assert!(thumb.exists());
        assert_eq!(
            row.thumbnail_url.as_deref(),
            Some("https://cdn.example/t.jpg")
        );

        let _ = fs::remove_dir_all(&paths.root);
    }

    #[test]
    fn delete_creation_local_removes_disk_and_row() {
        let paths = temp_paths();
        let conn = ready_connection(&paths).expect("ready");
        apply_manifest(
            &conn,
            &[CreationUpsert {
                id: "7".into(),
                title: "Clip".into(),
                media_type: "image".into(),
                remote_url: Some("https://cdn.example/a.png".into()),
                thumbnail_url: Some("https://cdn.example/t.png".into()),
                fit_thumbnail_url: None,
                video_url: None,
                published: true,
                published_at: None,
                created_at: "2026-01-01T00:00:00Z".into(),
                download_state: "remote".into(),
                prompt: None,
                filename: Some("a.png".into()),
                description: None,
                color: None,
                status: None,
                width: Some(10),
                height: Some(10),
                aspect_ratio: Some("1:1".into()),
                nsfw: false,
                is_moderated_error: false,
                remote_json: "{}".into(),
            }],
        )
        .expect("apply");

        let media = paths.media.join("7.png");
        let thumb = paths.thumbs.join("7.png");
        fs::write(&media, b"media").expect("media");
        fs::write(&thumb, b"thumb").expect("thumb");
        mark_downloaded(
            &conn,
            "7",
            &media.display().to_string(),
            Some(&thumb.display().to_string()),
        )
        .expect("mark");
        conn.execute(
            "INSERT INTO folders(id, title, description, created_at, updated_at)
             VALUES ('f1', 'Project', '', '2026-01-01', '2026-01-01')",
            [],
        )
        .expect("folder");
        conn.execute(
            "INSERT INTO folder_items(folder_id, creation_id, added_at)
             VALUES ('f1', '7', '2026-01-01')",
            [],
        )
        .expect("membership");

        delete_creation_local(&conn, &paths, "7").expect("delete");
        assert!(get_creation_by_id(&conn, "7").expect("get").is_none());
        assert!(!media.exists());
        assert!(!thumb.exists());
        let membership_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM folder_items WHERE creation_id = '7'",
                [],
                |row| row.get(0),
            )
            .expect("membership count");
        assert_eq!(membership_count, 0);

        let _ = fs::remove_dir_all(&paths.root);
    }

    #[test]
    fn clear_cloud_backed_keeps_local_imports_and_clears_last_sync() {
        let paths = temp_paths();
        let conn = ready_connection(&paths).expect("ready");
        apply_manifest(
            &conn,
            &[CreationUpsert {
                id: "cloud-1".into(),
                title: "Cloud".into(),
                media_type: "image".into(),
                remote_url: Some("https://cdn.example/c.png".into()),
                thumbnail_url: Some("https://cdn.example/t.png".into()),
                fit_thumbnail_url: None,
                video_url: None,
                published: true,
                published_at: None,
                created_at: "2026-01-01T00:00:00Z".into(),
                download_state: "remote".into(),
                prompt: None,
                filename: Some("c.png".into()),
                description: None,
                color: None,
                status: None,
                width: Some(10),
                height: Some(10),
                aspect_ratio: Some("1:1".into()),
                nsfw: false,
                is_moderated_error: false,
                remote_json: "{}".into(),
            }],
        )
        .expect("apply");
        let now = "2026-01-01T00:00:00Z";
        conn.execute(
            r#"
            INSERT INTO creations (
              id, title, media_type, remote_url, local_path, local_thumb_path,
              published, created_at, download_state, updated_at, remote_json
            ) VALUES ('local-1', 'Disk import', 'image', NULL, NULL, NULL, 0, ?1, 'local', ?1, NULL)
            "#,
            params![now],
        )
        .expect("local import");
        let media = paths.media.join("cloud-1.png");
        fs::create_dir_all(&paths.media).expect("media dir");
        fs::write(&media, b"media").expect("media");
        mark_downloaded(&conn, "cloud-1", &media.display().to_string(), None).expect("mark");

        let cleared = clear_cloud_backed_local(&conn, &paths).expect("clear");
        assert_eq!(cleared, 1);
        assert!(!media.exists());
        assert!(get_creation_by_id(&conn, "cloud-1").expect("get cloud").is_none());
        assert!(get_creation_by_id(&conn, "local-1").expect("get local").is_some());
        assert!(meta_get(&conn, "last_sync_at").expect("meta").is_none());

        let _ = fs::remove_dir_all(&paths.root);
    }

    #[test]
    fn delete_creation_local_ignores_unrelated_orphan_project_folder() {
        let paths = temp_paths();
        let conn = ready_connection(&paths).expect("ready");
        apply_manifest(
            &conn,
            &[
                CreationUpsert {
                    id: "root-1".into(),
                    title: "Frog".into(),
                    media_type: "image".into(),
                    remote_url: Some("https://cdn.example/frog.png".into()),
                    thumbnail_url: None,
                    fit_thumbnail_url: None,
                    video_url: None,
                    published: true,
                    published_at: None,
                    created_at: "2026-01-01T00:00:00Z".into(),
                    download_state: "remote".into(),
                    prompt: None,
                    filename: Some("frog.png".into()),
                    description: None,
                    color: None,
                    status: None,
                    width: Some(10),
                    height: Some(10),
                    aspect_ratio: Some("1:1".into()),
                    nsfw: false,
                    is_moderated_error: false,
                    remote_json: "{}".into(),
                },
                CreationUpsert {
                    id: "member-1".into(),
                    title: "Inside".into(),
                    media_type: "image".into(),
                    remote_url: Some("https://cdn.example/in.png".into()),
                    thumbnail_url: None,
                    fit_thumbnail_url: None,
                    video_url: None,
                    published: true,
                    published_at: None,
                    created_at: "2026-01-01T00:00:00Z".into(),
                    download_state: "remote".into(),
                    prompt: None,
                    filename: Some("in.png".into()),
                    description: None,
                    color: None,
                    status: None,
                    width: Some(10),
                    height: Some(10),
                    aspect_ratio: Some("1:1".into()),
                    nsfw: false,
                    is_moderated_error: false,
                    remote_json: "{}".into(),
                },
            ],
        )
        .expect("apply");
        conn.execute(
            "INSERT INTO folders(id, title, description, created_at, updated_at, kind, project_id)
             VALUES ('orphan', 'Untitled project', '', 't', 't', 'project', 'gone-project')",
            [],
        )
        .expect("orphan folder");
        conn.execute(
            "INSERT INTO folder_items(folder_id, creation_id, added_at)
             VALUES ('orphan', 'member-1', 't')",
            [],
        )
        .expect("member");

        delete_creation_local(&conn, &paths, "root-1").expect("root delete");
        assert!(get_creation_by_id(&conn, "root-1").expect("get").is_none());

        let member_err = delete_creation_local(&conn, &paths, "member-1").expect_err("member");
        assert!(
            member_err.contains("Untitled project"),
            "unexpected error: {member_err}"
        );
        assert!(get_creation_by_id(&conn, "member-1")
            .expect("get")
            .is_some());

        let _ = fs::remove_dir_all(&paths.root);
    }

    fn test_image_upsert(id: &str) -> CreationUpsert {
        CreationUpsert {
            id: id.into(),
            title: id.into(),
            media_type: "image".into(),
            remote_url: Some(format!("https://cdn.example/{id}.png")),
            thumbnail_url: None,
            fit_thumbnail_url: None,
            video_url: None,
            published: true,
            published_at: None,
            created_at: "2026-01-01T00:00:00Z".into(),
            download_state: "remote".into(),
            prompt: None,
            filename: Some(format!("{id}.png")),
            description: None,
            color: None,
            status: None,
            width: Some(10),
            height: Some(10),
            aspect_ratio: Some("1:1".into()),
            nsfw: false,
            is_moderated_error: false,
            remote_json: "{}".into(),
        }
    }

    #[test]
    fn delete_creation_local_ignores_usage_from_deleted_project() {
        let paths = temp_paths();
        let conn = ready_connection(&paths).expect("ready");
        apply_manifest(&conn, &[test_image_upsert("cover-1")]).expect("apply");
        conn.execute(
            "INSERT INTO project_asset_usage(
               project_id, creation_id, usage_kind, usage_owner_id, usage_owner_label, document_revision
             ) VALUES ('597877a3-d251-4287-8414-d62ad83fe63a', 'cover-1', 'cabinet', 'images', 'Project Images', 'rev1')",
            [],
        )
        .expect("ghost usage");
        conn.execute(
            "INSERT INTO project_usage_revisions(project_id, document_revision, state, indexed_at)
             VALUES ('597877a3-d251-4287-8414-d62ad83fe63a', 'rev1', 'ready', 't')",
            [],
        )
        .expect("ghost revision");

        delete_creation_local(&conn, &paths, "cover-1").expect("delete");
        assert!(get_creation_by_id(&conn, "cover-1").expect("get").is_none());
        let leftover: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM project_asset_usage WHERE project_id = '597877a3-d251-4287-8414-d62ad83fe63a'",
                [],
                |row| row.get(0),
            )
            .expect("count");
        assert_eq!(leftover, 0);

        let _ = fs::remove_dir_all(&paths.root);
    }

    #[test]
    fn delete_creation_local_still_blocks_live_project_usage() {
        let paths = temp_paths();
        let conn = ready_connection(&paths).expect("ready");
        apply_manifest(&conn, &[test_image_upsert("cover-2")]).expect("apply");
        conn.execute(
            "INSERT INTO folders(id, title, description, created_at, updated_at, kind, project_id)
             VALUES ('pf', 'Images', '', 't', 't', 'project', 'live-project')",
            [],
        )
        .expect("folder");
        conn.execute(
            "INSERT INTO project_asset_usage(
               project_id, creation_id, usage_kind, usage_owner_id, usage_owner_label, document_revision
             ) VALUES ('live-project', 'cover-2', 'cabinet', 'images', 'Project Images', 'rev1')",
            [],
        )
        .expect("usage");

        let err = delete_creation_local(&conn, &paths, "cover-2").expect_err("blocked");
        assert!(err.contains("used by a project"), "unexpected error: {err}");
        assert!(get_creation_by_id(&conn, "cover-2").expect("get").is_some());

        let _ = fs::remove_dir_all(&paths.root);
    }

    #[test]
    fn prune_stale_creation_usage_drops_projects_missing_from_store() {
        let paths = temp_paths();
        let conn = ready_connection(&paths).expect("ready");
        apply_manifest(&conn, &[test_image_upsert("cover-3")]).expect("apply");
        conn.execute(
            "INSERT INTO folders(id, title, description, created_at, updated_at, kind, project_id)
             VALUES ('pf', 'Images', '', 't', 't', 'project', 'gone-from-store')",
            [],
        )
        .expect("folder");
        conn.execute(
            "INSERT INTO project_asset_usage(
               project_id, creation_id, usage_kind, usage_owner_id, usage_owner_label, document_revision
             ) VALUES ('gone-from-store', 'cover-3', 'cabinet', 'images', 'Project Images', 'rev1')",
            [],
        )
        .expect("usage");

        prune_stale_creation_usage(&conn, "cover-3", Some(&["other-project".into()]))
            .expect("prune");
        let leftover: i64 = conn
            .query_row("SELECT COUNT(*) FROM project_asset_usage", [], |row| {
                row.get(0)
            })
            .expect("count");
        assert_eq!(leftover, 0);
        delete_creation_local(&conn, &paths, "cover-3").expect("delete");

        let _ = fs::remove_dir_all(&paths.root);
    }

    #[test]
    fn existing_creation_ids_returns_only_local_matches_in_order() {
        let paths = temp_paths();
        let conn = ready_connection(&paths).expect("ready");
        apply_manifest(
            &conn,
            &[
                CreationUpsert {
                    id: "10".into(),
                    title: "A".into(),
                    media_type: "image".into(),
                    remote_url: None,
                    thumbnail_url: None,
                    fit_thumbnail_url: None,
                    video_url: None,
                    published: false,
                    published_at: None,
                    created_at: "2026-01-01T00:00:00Z".into(),
                    download_state: "remote".into(),
                    prompt: None,
                    filename: None,
                    description: None,
                    color: None,
                    status: None,
                    width: None,
                    height: None,
                    aspect_ratio: None,
                    nsfw: false,
                    is_moderated_error: false,
                    remote_json: "{}".into(),
                },
                CreationUpsert {
                    id: "20".into(),
                    title: "B".into(),
                    media_type: "image".into(),
                    remote_url: None,
                    thumbnail_url: None,
                    fit_thumbnail_url: None,
                    video_url: None,
                    published: false,
                    published_at: None,
                    created_at: "2026-01-02T00:00:00Z".into(),
                    download_state: "remote".into(),
                    prompt: None,
                    filename: None,
                    description: None,
                    color: None,
                    status: None,
                    width: None,
                    height: None,
                    aspect_ratio: None,
                    nsfw: false,
                    is_moderated_error: false,
                    remote_json: "{}".into(),
                },
            ],
        )
        .expect("apply");

        let found = existing_creation_ids(
            &conn,
            &[
                "20".into(),
                "missing".into(),
                "10".into(),
                "20".into(),
                " ".into(),
            ],
        )
        .expect("lookup");
        assert_eq!(found, vec!["20".to_string(), "10".to_string()]);
        assert!(existing_creation_ids(&conn, &[]).expect("empty").is_empty());

        let _ = fs::remove_dir_all(&paths.root);
    }

    #[test]
    fn map_remote_creation_mirrors_fe_sync_fields() {
        let raw = serde_json::json!({
            "id": 7,
            "filename": "clip.mp4",
            "video_url": "https://cdn.example/clip.mp4",
            "thumbnail_url": "https://cdn.example/thumb.jpg",
            "fit_thumbnail_url": "https://cdn.example/thumb.jpg?variant=fit",
            "media_type": "video",
            "width": 1920,
            "height": 1080,
            "color": "#abcdef",
            "published": false,
            "published_at": "2026-03-02T00:00:00Z",
            "created_at": "2026-03-01T12:00:00Z",
            "description": "noir",
            "status": "completed",
            "meta": { "args": { "prompt": "noir alley", "aspect_ratio": "16:9" } }
        });
        let mapped = map_remote_creation_json(&raw).expect("map");
        assert_eq!(mapped.id, "7");
        assert_eq!(mapped.title, "clip.mp4");
        assert_eq!(mapped.media_type, "video");
        assert_eq!(
            mapped.remote_url.as_deref(),
            Some("https://cdn.example/clip.mp4")
        );
        assert_eq!(
            mapped.thumbnail_url.as_deref(),
            Some("https://cdn.example/thumb.jpg")
        );
        assert_eq!(
            mapped.fit_thumbnail_url.as_deref(),
            Some("https://cdn.example/thumb.jpg?variant=fit")
        );
        assert_eq!(mapped.aspect_ratio.as_deref(), Some("16:9"));
        assert_eq!(mapped.prompt.as_deref(), Some("noir alley"));
        assert_eq!(mapped.download_state, "remote");

        let snap: serde_json::Value = serde_json::from_str(&mapped.remote_json).expect("snap");
        assert_eq!(
            snap.get("fit_thumbnail_url").and_then(|v| v.as_str()),
            Some("https://cdn.example/thumb.jpg?variant=fit")
        );
    }

    #[test]
    fn map_remote_creation_absolutizes_and_synthesizes_from_file_path() {
        let raw = serde_json::json!({
            "id": 17804,
            "file_path": "/api/images/created/26_17804_x.png",
            "media_type": "image",
            "meta": { "prompt": "member" }
        });
        let mapped = map_remote_creation_json(&raw).expect("map");
        assert_eq!(
            mapped.remote_url.as_deref(),
            Some("https://www.parascene.com/api/images/created/26_17804_x.png")
        );
        assert_eq!(
            mapped.thumbnail_url.as_deref(),
            Some("https://www.parascene.com/api/images/created/26_17804_x.png?variant=thumbnail")
        );
        assert_eq!(mapped.prompt.as_deref(), Some("member"));
    }

    #[test]
    fn map_remote_creation_infers_video_and_width_height_aspect() {
        let raw = serde_json::json!({
            "id": "99",
            "video_url": "/cdn/v.mp4",
            "thumbnail_url": "/cdn/t.jpg",
            "width": 1080,
            "height": 1920
        });
        let mapped = map_remote_creation_json(&raw).expect("map");
        assert_eq!(mapped.media_type, "video");
        assert_eq!(
            mapped.remote_url.as_deref(),
            Some("https://www.parascene.com/cdn/v.mp4")
        );
        assert_eq!(mapped.aspect_ratio.as_deref(), Some("1080:1920"));
        assert_eq!(
            mapped.fit_thumbnail_url.as_deref(),
            Some("https://www.parascene.com/cdn/t.jpg?variant=fit")
        );
    }

    #[test]
    fn map_remote_creation_prefers_audio_url_for_cdn_audio() {
        let raw = serde_json::json!({
            "id": 27140,
            "filename": "cover.png",
            "title": "Dichotomy (blegh)",
            "url": "/api/images/created/cover.png",
            "thumbnail_url": "/api/images/created/cover.png?variant=thumbnail",
            "audio_url": "/api/create/images/27140/audio",
            "media_type": "audio",
            "created_at": "2026-08-30T08:23:53Z",
            "meta": {
                "audio": {
                    "cdn_id": "o_8972e00517b91de76c0d3c64",
                    "duration": 314.24,
                    "content_type": "audio/mpeg",
                    "filename": "Dichotomy (blegh).mp3"
                }
            }
        });
        let mapped = map_remote_creation_json(&raw).expect("map");
        assert_eq!(mapped.media_type, "audio");
        assert_eq!(
            mapped.remote_url.as_deref(),
            Some("https://www.parascene.com/api/create/images/27140/audio")
        );
        assert_eq!(
            mapped.thumbnail_url.as_deref(),
            Some("https://www.parascene.com/api/images/created/cover.png?variant=thumbnail")
        );
        let snap: serde_json::Value = serde_json::from_str(&mapped.remote_json).expect("snap");
        assert_eq!(
            snap.get("audio_url").and_then(|v| v.as_str()),
            Some("https://www.parascene.com/api/create/images/27140/audio")
        );
        assert_eq!(
            snap.get("url").and_then(|v| v.as_str()),
            Some("https://www.parascene.com/api/images/created/cover.png")
        );
    }

    #[test]
    fn map_remote_creation_cover_only_audio_keeps_image_remote_url() {
        let raw = serde_json::json!({
            "id": 99,
            "url": "https://cdn.example/suno-cover.png",
            "media_type": "audio",
            "created_at": "2026-08-01T00:00:00Z"
        });
        let mapped = map_remote_creation_json(&raw).expect("map");
        assert_eq!(
            mapped.remote_url.as_deref(),
            Some("https://cdn.example/suno-cover.png")
        );
        let snap: serde_json::Value = serde_json::from_str(&mapped.remote_json).expect("snap");
        assert!(snap.get("audio_url").unwrap_or(&serde_json::Value::Null).is_null());
    }

    #[test]
    fn map_remote_creation_derives_fit_from_thumbnail_query() {
        let raw = serde_json::json!({
            "id": "18843",
            "video_url": "/api/videos/created/video/x.mp4",
            "thumbnail_url": "/api/images/created/x.png?creation_id=18843&variant=thumbnail",
            "media_type": "video",
            "width": 576,
            "height": 1024
        });
        let mapped = map_remote_creation_json(&raw).expect("map");
        assert_eq!(
            mapped.fit_thumbnail_url.as_deref(),
            Some(
                "https://www.parascene.com/api/images/created/x.png?creation_id=18843&variant=fit"
            )
        );
    }

    #[test]
    fn list_creations_for_filter_returns_buried_audio_and_local_only() {
        let paths = temp_paths();
        let conn = ready_connection(&paths).expect("ready");
        let now = "2026-07-28T00:00:00Z";
        for i in 0..120 {
            conn.execute(
                r#"
                INSERT INTO creations (
                  id, title, media_type, remote_url, published, created_at,
                  download_state, updated_at, remote_json
                ) VALUES (?1, ?2, 'image', 'https://cdn.example/x.png', 0, ?3, 'remote', ?4, '{}')
                "#,
                params![
                    format!("img-{i}"),
                    format!("Image {i}"),
                    format!("2026-07-20T{:02}:00:{:02}Z", i / 60, i % 60),
                    now,
                ],
            )
            .expect("insert image");
        }
        conn.execute(
            r#"
            INSERT INTO creations (
              id, title, media_type, remote_url, published, created_at,
              download_state, updated_at, remote_json
            ) VALUES (
              'local-audio-1', 'Take me back', 'audio', NULL, 0,
              '2026-07-15T21:37:00Z', 'local', ?1, NULL
            )
            "#,
            params![now],
        )
        .expect("insert audio");

        let page = list_creations_page(&conn, 80, 0).expect("page");
        assert!(
            page.creations.iter().all(|c| c.id != "local-audio-1"),
            "buried audio must not be on the newest page"
        );

        let audio = list_creations_for_filter(&conn, "audio").expect("audio");
        assert_eq!(audio.len(), 1);
        assert_eq!(audio[0].id, "local-audio-1");

        let local_only = list_creations_for_filter(&conn, "localOnly").expect("localOnly");
        assert_eq!(local_only.len(), 1);
        assert_eq!(local_only[0].id, "local-audio-1");

        let _ = fs::remove_dir_all(&paths.root);
    }
}
