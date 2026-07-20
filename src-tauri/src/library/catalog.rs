use super::paths::{default_root, ensure_directories, resolve_paths, ParascenePaths};
use chrono::Utc;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
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
    /// Playback fMP4 proxy path under Cache/proxies (when ready).
    pub proxy_play_path: Option<String>,
    /// All-intra scrub fMP4 proxy path.
    pub proxy_scrub_path: Option<String>,
    /// pending | generating | ready | failed | none
    pub proxy_status: Option<String>,
    pub proxy_hash: Option<String>,
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
    /// Excludes local-only imports (never existed in Parascene cloud).
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
    let conn =
        Connection::open(db_path).map_err(|e| format!("Could not open catalog DB: {e}"))?;
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
          updated_at TEXT NOT NULL
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
        "ALTER TABLE creations ADD COLUMN proxy_play_path TEXT",
        "ALTER TABLE creations ADD COLUMN proxy_scrub_path TEXT",
        "ALTER TABLE creations ADD COLUMN proxy_status TEXT",
        "ALTER TABLE creations ADD COLUMN proxy_hash TEXT",
    ] {
        let _ = conn.execute(ddl, []);
    }

    let _ = conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS proxy_assets (
          creation_id TEXT PRIMARY KEY NOT NULL,
          proxy_play_path TEXT,
          proxy_scrub_path TEXT,
          proxy_status TEXT NOT NULL DEFAULT 'pending',
          proxy_hash TEXT,
          updated_at TEXT NOT NULL
        );
        "#,
    );

    // Folders may be missing on catalogs created before this feature.
    let _ = conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS folders (
          id TEXT PRIMARY KEY NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
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

/// Debug-build auth backend: session KV in catalog.sqlite (avoids Keychain prompts).
const AUTH_KV_PREFIX: &str = "auth_store:";

fn auth_meta_key(key: &str) -> String {
    format!("{AUTH_KV_PREFIX}{key}")
}

/// Lightweight open for auth KV only — never runs migrate / folder migration.
/// `ready_connection` is far too heavy and contended for every token read.
fn open_auth_kv_connection() -> Result<Connection, String> {
    let paths = default_paths()?;
    ensure_directories(&paths)?;
    let conn = open_db(&paths.catalog_db)?;
    // Ensure sync_meta exists without the full catalog migrate path.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS sync_meta (
           key TEXT PRIMARY KEY NOT NULL,
           value TEXT NOT NULL
         );",
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
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

fn group_member_ids_from_remote_json(raw: &str) -> Vec<String> {
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
    stmt.query_row(rusqlite::params_from_iter(member_ids.iter()), |row| row.get(0))
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
        proxy_play_path: row.get(27)?,
        proxy_scrub_path: row.get(28)?,
        proxy_status: row.get(29)?,
        proxy_hash: row.get(30)?,
    })
}

const CREATION_SELECT: &str = r#"
    SELECT id, title, media_type, remote_url, thumbnail_url, fit_thumbnail_url, video_url,
           local_path, local_thumb_path,
           published, published_at, created_at, download_state, checksum, prompt, expires_at, updated_at,
           filename, description, color, status, width, height, aspect_ratio,
           COALESCE(nsfw, 0), COALESCE(is_moderated_error, 0), remote_json,
           proxy_play_path, proxy_scrub_path, proxy_status, proxy_hash
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
        stmt.query_map(rusqlite::params_from_iter(member_ids.iter()), map_creation_row)
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
    let sql = format!(
        "{CREATION_SELECT} {exclude} ORDER BY created_at DESC, title ASC LIMIT ? OFFSET ?"
    );
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

fn list_without_cloud_urls(conn: &Connection) -> Result<Vec<WithoutCloudUrl>, String> {
    // Matches unsyncableThumbCount ∪ unsyncableMediaCount: cloud-backed, no local
    // file, and no downloadable URL under the same rules as cache-missing queries.
    let mut stmt = conn
        .prepare(
            &format!(
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
            ),
        )
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
        r#"SELECT COUNT(*) FROM creations
           WHERE (local_path IS NULL OR local_path = '')
             AND remote_url IS NOT NULL AND remote_url != ''"#,
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

fn upsert_creation(conn: &Connection, row: &CreationUpsert, now: &str) -> Result<(), String> {
    // Group covers (and any row) can change cloud URLs when membership updates.
    // Keep stale local media/thumbs only when the remote pointers are unchanged.
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

    let urls_changed = prev
        .as_ref()
        .map(|(remote, thumb, fit, video, _, _)| {
            remote.as_deref() != row.remote_url.as_deref()
                || thumb.as_deref() != row.thumbnail_url.as_deref()
                || fit.as_deref() != row.fit_thumbnail_url.as_deref()
                || video.as_deref() != row.video_url.as_deref()
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
            urls_changed,
        ],
    )
    .map_err(|e| format!("Upsert creation failed: {e}"))?;

    if urls_changed {
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

/// Persist dual preview-proxy paths / status for a creation.
pub(crate) fn set_proxy_fields(
    conn: &Connection,
    id: &str,
    play_path: Option<&str>,
    scrub_path: Option<&str>,
    status: &str,
    hash: Option<&str>,
) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        r#"
        UPDATE creations
        SET proxy_play_path = ?1,
            proxy_scrub_path = ?2,
            proxy_status = ?3,
            proxy_hash = ?4,
            updated_at = ?5
        WHERE id = ?6
        "#,
        params![play_path, scrub_path, status, hash, now, id],
    )
    .map_err(|e| e.to_string())?;
    let _ = conn.execute(
        r#"
        INSERT INTO proxy_assets(creation_id, proxy_play_path, proxy_scrub_path, proxy_status, proxy_hash, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        ON CONFLICT(creation_id) DO UPDATE SET
          proxy_play_path = excluded.proxy_play_path,
          proxy_scrub_path = excluded.proxy_scrub_path,
          proxy_status = excluded.proxy_status,
          proxy_hash = excluded.proxy_hash,
          updated_at = excluded.updated_at
        "#,
        params![id, play_path, scrub_path, status, hash, now],
    );
    Ok(())
}

/// Delete a creation from the local catalog and remove its media/thumb files.
/// Only removes files under Library/media or Library/thumbs. Does not touch Parascene cloud.
pub(crate) fn delete_creation_local(
    conn: &Connection,
    paths: &ParascenePaths,
    id: &str,
) -> Result<(), String> {
    let creation =
        get_creation_by_id(conn, id)?.ok_or_else(|| format!("Creation {id} not found"))?;
    remove_file_under_root(&paths.media, creation.local_path.as_deref());
    remove_file_under_root(&paths.thumbs, creation.local_thumb_path.as_deref());
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
    // Migrate + folder UUID fix once per process — Sync status polls hit this
    // every couple seconds and were re-running the full setup path each time.
    static READY: AtomicBool = AtomicBool::new(false);
    if !READY.load(Ordering::Acquire) {
        migrate(&conn)?;
        meta_set(&conn, "root_path", &paths.root.display().to_string())?;
        conn.execute("DELETE FROM creations WHERE id LIKE 'fixture-%'", [])
            .map_err(|e| e.to_string())?;
        super::folders::ensure_folder_sync_ready(&conn)?;
        READY.store(true, Ordering::Release);
    }
    Ok(conn)
}

pub(crate) fn default_paths() -> Result<ParascenePaths, String> {
    Ok(resolve_paths(default_root()?))
}

pub(crate) fn sync_status_for(paths: &ParascenePaths) -> Result<SyncStatus, String> {
    let conn = ready_connection(paths)?;
    sync_status(&conn, paths)
}

fn apply_manifest(conn: &Connection, rows: &[CreationUpsert]) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    conn.execute("DELETE FROM creations WHERE id LIKE 'fixture-%'", [])
        .map_err(|e| e.to_string())?;
    for row in rows {
        upsert_creation(conn, row, &now)?;
    }
    meta_set(conn, "last_sync_at", &now)?;
    Ok(())
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
        let end = s[after..]
            .find('&')
            .map(|i| after + i)
            .unwrap_or(s.len());
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
/// - Absolutizes url / thumbnail / fit / video
/// - Infers media_type from video_url when missing
/// - Prefers video_url as remote_url for videos
/// - Derives aspect_ratio from meta.args, else width×height
/// - Synthesizes url/thumbnail from `file_path` when sparse (group source rows)
/// - Derives `fit_thumbnail_url` from thumbnail/url when the API omits it
/// - Stores an absolutized remote_json snapshot
pub(crate) fn map_remote_creation_json(
    raw: &serde_json::Value,
) -> Result<CreationUpsert, String> {
    let id = raw
        .get("id")
        .and_then(json_id)
        .ok_or_else(|| "remote creation missing id".to_string())?;

    let file_path = json_opt_string(raw.get("file_path"));
    let mut url = json_opt_string(raw.get("url"))
        .or_else(|| json_opt_string(raw.get("image_url")))
        .or_else(|| file_path.clone());
    let mut thumbnail_url = json_opt_string(raw.get("thumbnail_url")).or_else(|| {
        file_path
            .as_ref()
            .map(|p| format!("{p}?variant=thumbnail"))
    });
    let mut fit_thumbnail_url = json_opt_string(raw.get("fit_thumbnail_url"));
    let mut video_url = json_opt_string(raw.get("video_url"));

    let media_type = json_opt_string(raw.get("media_type")).unwrap_or_else(|| {
        if video_url.is_some() {
            "video".into()
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

    let remote_url = if media_type.eq_ignore_ascii_case("video") {
        video_url.clone().or_else(|| url.clone())
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
        obj.insert(
            "status".into(),
            serde_json::Value::String(status.clone()),
        );
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
    Ok(id)
}

#[tauri::command]
pub fn library_ensure_ready() -> Result<SyncStatus, String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    sync_status(&conn, &paths)
}

#[tauri::command]
pub fn library_list_creations() -> Result<Vec<Creation>, String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    list_creations(&conn)
}

#[tauri::command]
pub fn library_filter_counts() -> Result<CatalogFilterCounts, String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    catalog_filter_counts(&conn)
}

/// Plain list (no side effects). Prefer `library::library_list_creations_page` for UI,
/// which also kicks async thumb prefetch.
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

fn existing_creation_ids(conn: &Connection, ids: &[String]) -> Result<Vec<String>, String> {
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

fn cloud_ids_since(conn: &Connection, since_iso: &str) -> Result<Vec<CreationIdAt>, String> {
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

        delete_creation_local(&conn, &paths, "7").expect("delete");
        assert!(get_creation_by_id(&conn, "7").expect("get").is_none());
        assert!(!media.exists());
        assert!(!thumb.exists());

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
            &["20".into(), "missing".into(), "10".into(), "20".into(), " ".into()],
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

        let snap: serde_json::Value =
            serde_json::from_str(&mapped.remote_json).expect("snap");
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
            Some(
                "https://www.parascene.com/api/images/created/26_17804_x.png?variant=thumbnail"
            )
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
}
