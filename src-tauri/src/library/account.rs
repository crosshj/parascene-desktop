//! Account registry, login resolution, and fail-closed legacy → `users/<slug>/` migrate.

use super::paths::{
    account_root, ensure_directories, machine_root, resolve_paths, set_account_root, ParascenePaths,
};
use super::user_state::{
    leftover_old_prefix_in_user_db, merge_secrets_for_compact, read_hydrate, read_secrets,
    rewrite_prefix_in_json_files, rewrite_prefix_in_user_db, upsert_secret, user_db_path,
    verify_compact, write_compact, CompactPayload, HydratePayload, SECRET_KEYS,
};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const ACCOUNTS_FILE: &str = "accounts.json";
const JOURNAL_FILE: &str = "migrate-legacy.json";
const USER_DIRS: [&str; 4] = ["Library", "Projects", "Exports", "Cache"];

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountEntry {
    pub dir: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AccountsFile {
    pub version: u32,
    #[serde(default)]
    pub users: BTreeMap<String, AccountEntry>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MigrateJournal {
    phase: String,
    from_root: String,
    to_root: String,
    sub: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResult {
    pub kind: String,
    pub user_id: String,
    pub account_root: String,
    pub relaunch: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogoutResult {
    pub relaunch: bool,
    pub account_root: String,
    pub user_id: String,
}

pub fn slug_for_sub(sub: &str) -> String {
    let mut out = String::new();
    for ch in sub.chars() {
        if ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' || ch == '_' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    while out.contains("__") {
        out = out.replace("__", "_");
    }
    let out = out.trim_matches('_').to_string();
    if out.is_empty() {
        "user".into()
    } else {
        out.chars().take(80).collect()
    }
}

fn unique_rel_dir(accounts: &AccountsFile, sub: &str) -> String {
    let base = slug_for_sub(sub);
    let mut rel = format!("users/{base}");
    if !accounts.users.values().any(|e| e.dir == rel) {
        return rel;
    }
    for n in 2..1000 {
        rel = format!("users/{base}-{n}");
        if !accounts.users.values().any(|e| e.dir == rel) {
            return rel;
        }
    }
    format!("users/{base}-x")
}

pub fn accounts_path(machine: &Path) -> PathBuf {
    machine.join(ACCOUNTS_FILE)
}

fn journal_path(machine: &Path) -> PathBuf {
    machine.join(JOURNAL_FILE)
}

pub fn load_accounts(machine: &Path) -> Result<AccountsFile, String> {
    let path = accounts_path(machine);
    if !path.is_file() {
        return Ok(AccountsFile {
            version: 1,
            users: BTreeMap::new(),
        });
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| format!("accounts.json: {e}"))
}

pub fn save_accounts(machine: &Path, accounts: &AccountsFile) -> Result<(), String> {
    fs::create_dir_all(machine).map_err(|e| e.to_string())?;
    let path = accounts_path(machine);
    let tmp = path.with_extension("json.tmp");
    let raw = serde_json::to_string_pretty(accounts).map_err(|e| e.to_string())?;
    fs::write(&tmp, raw).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn catalog_has_library_data(account_or_machine: &Path) -> bool {
    let db = account_or_machine.join("Library").join("catalog.sqlite");
    if !db.is_file() {
        return false;
    }
    let Ok(conn) = Connection::open(&db) else {
        return false;
    };
    let creations: i64 = conn
        .query_row("SELECT COUNT(*) FROM creations", [], |row| row.get(0))
        .unwrap_or(0);
    let folders: i64 = conn
        .query_row("SELECT COUNT(*) FROM folders", [], |row| row.get(0))
        .unwrap_or(0);
    creations > 0 || folders > 0
}

fn unclaimed_legacy(machine: &Path, accounts: &AccountsFile) -> bool {
    if !accounts.users.is_empty() {
        return false;
    }
    catalog_has_library_data(machine)
}

/// After folder accounts exist, do not keep a second empty library at machine root.
pub fn prune_unbound_machine_payload(machine: &Path) -> Result<(), String> {
    if catalog_has_library_data(machine) {
        return Ok(());
    }
    let accounts = load_accounts(machine)?;
    let users_dir = machine.join("users");
    let has_user_bundle = accounts.users.values().any(|e| machine.join(&e.dir).is_dir())
        || (users_dir.is_dir()
            && fs::read_dir(&users_dir)
                .map(|entries| {
                    entries.filter_map(|e| e.ok()).any(|e| {
                        let p = e.path();
                        p.is_dir()
                            && (p.join("Library").join("catalog.sqlite").is_file()
                                || p.join(super::user_state::USER_DB_NAME).is_file())
                    })
                })
                .unwrap_or(false));
    if !has_user_bundle {
        return Ok(());
    }
    for name in USER_DIRS {
        let path = machine.join(name);
        if path.exists() {
            fs::remove_dir_all(&path).map_err(|e| format!("Prune {}: {e}", path.display()))?;
        }
    }
    Ok(())
}

fn ensure_bundle_dirs(root: &Path) -> Result<ParascenePaths, String> {
    let paths = resolve_paths(root.to_path_buf());
    ensure_directories(&paths)?;
    Ok(paths)
}

/// Bind this process to `sub`. Creates an empty folder for a new user.
pub fn bind_login_or_legacy(
    machine: &Path,
    sub: &str,
    allow_legacy: bool,
) -> Result<LoginResult, String> {
    let sub = sub.trim();
    if sub.is_empty() {
        return Err("user id is required".into());
    }
    recover_journal(machine)?;
    let mut accounts = load_accounts(machine)?;

    if let Some(entry) = accounts.users.get(sub) {
        let root = machine.join(&entry.dir);
        ensure_bundle_dirs(&root)?;
        return Ok(LoginResult {
            kind: "folder".into(),
            user_id: sub.to_string(),
            account_root: root.display().to_string(),
            relaunch: false,
            message: None,
        });
    }

    let guessed = machine.join("users").join(slug_for_sub(sub));
    if guessed.join("Library").join("catalog.sqlite").is_file()
        || guessed.join(super::user_state::USER_DB_NAME).is_file()
    {
        let rel = format!("users/{}", slug_for_sub(sub));
        accounts.users.insert(
            sub.to_string(),
            AccountEntry { dir: rel },
        );
        save_accounts(machine, &accounts)?;
        ensure_bundle_dirs(&guessed)?;
        return Ok(LoginResult {
            kind: "folder".into(),
            user_id: sub.to_string(),
            account_root: guessed.display().to_string(),
            relaunch: false,
            message: None,
        });
    }

    if unclaimed_legacy(machine, &accounts) {
        if allow_legacy {
            return Ok(LoginResult {
                kind: "legacy".into(),
                user_id: sub.to_string(),
                account_root: machine.display().to_string(),
                relaunch: false,
                message: None,
            });
        }
        return Ok(LoginResult {
            kind: "refuse".into(),
            user_id: sub.to_string(),
            account_root: machine.display().to_string(),
            relaunch: false,
            message: Some(
                "This Mac still has a library at the old location. Sign in as the owner and log out so it can move into a user folder."
                    .into(),
            ),
        });
    }

    let rel = unique_rel_dir(&accounts, sub);
    let root = machine.join(&rel);
    ensure_bundle_dirs(&root)?;
    accounts.version = 1;
    accounts.users.insert(
        sub.to_string(),
        AccountEntry { dir: rel },
    );
    save_accounts(machine, &accounts)?;
    Ok(LoginResult {
        kind: "created".into(),
        user_id: sub.to_string(),
        account_root: root.display().to_string(),
        // Account root is bound in-process; do not relaunch (single-instance
        // would race the quitting process and can leave a blank window).
        relaunch: false,
        message: None,
    })
}

pub fn is_legacy_root(machine: &Path, account: &Path) -> bool {
    same_path(machine, account)
}

fn same_path(a: &Path, b: &Path) -> bool {
    let ca = a.canonicalize().unwrap_or_else(|_| a.to_path_buf());
    let cb = b.canonicalize().unwrap_or_else(|_| b.to_path_buf());
    ca == cb
}

fn write_journal(machine: &Path, journal: &MigrateJournal) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(journal).map_err(|e| e.to_string())?;
    fs::write(journal_path(machine), raw).map_err(|e| e.to_string())
}

fn clear_journal(machine: &Path) {
    let _ = fs::remove_file(journal_path(machine));
}

pub fn recover_journal(machine: &Path) -> Result<(), String> {
    let path = journal_path(machine);
    if !path.is_file() {
        return Ok(());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let journal: MigrateJournal =
        serde_json::from_str(&raw).map_err(|e| format!("migrate journal: {e}"))?;
    let from = PathBuf::from(&journal.from_root);
    let to = PathBuf::from(&journal.to_root);
    let from_lib = from.join("Library");
    let to_lib = to.join("Library");
    if to_lib.is_dir() && !from_lib.is_dir() {
        rewrite_moved_bundle(&from, &to)?;
        sample_rewritten_paths_ok(
            &to,
            &from.display().to_string(),
            &to.display().to_string(),
        )?;
        let mut accounts = load_accounts(machine)?;
        let rel = to
            .strip_prefix(machine)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| format!("users/{}", slug_for_sub(&journal.sub)));
        accounts.version = 1;
        accounts.users.insert(
            journal.sub.clone(),
            AccountEntry { dir: rel },
        );
        save_accounts(machine, &accounts)?;
        clear_journal(machine);
        return Ok(());
    }
    if from_lib.is_dir() {
        revert_rename(&from, &to)?;
        clear_journal(machine);
        return Ok(());
    }
    clear_journal(machine);
    Ok(())
}

fn revert_rename(from: &Path, to: &Path) -> Result<(), String> {
    for name in USER_DIRS {
        let src = to.join(name);
        let dest = from.join(name);
        if src.is_dir() && !dest.exists() {
            fs::rename(&src, &dest).map_err(|e| format!("Revert {name}: {e}"))?;
        }
    }
    // Compact belongs in the user folder only. Never leave user.sqlite at machine root.
    let _ = fs::remove_file(user_db_path(to));
    if to.is_dir() {
        let _ = fs::remove_dir(to);
        if let Some(users) = to.parent() {
            let _ = fs::remove_dir(users);
        }
    }
    Ok(())
}

fn rename_user_dirs(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for name in USER_DIRS {
        let src = from.join(name);
        if !src.exists() {
            continue;
        }
        let dest = to.join(name);
        if dest.exists() {
            return Err(format!(
                "Cannot move {name}: {} already exists",
                dest.display()
            ));
        }
        match fs::rename(&src, &dest) {
            Ok(()) => {}
            Err(err) => {
                let cross = err.raw_os_error() == Some(18)
                    || err.to_string().to_ascii_lowercase().contains("cross-device");
                if cross {
                    return Err(
                        "Library is not on the same volume as the user folder. Logout aborted (no copy)."
                            .into(),
                    );
                }
                return Err(format!("Rename {name}: {err}"));
            }
        }
    }
    Ok(())
}

fn rewrite_sqlite_text_prefix(db: &Path, old: &str, new: &str) -> Result<u32, String> {
    if !db.is_file() {
        return Ok(0);
    }
    let conn = Connection::open(db).map_err(|e| e.to_string())?;
    let _ = conn.execute_batch("PRAGMA journal_mode=WAL;");
    let mut tables: Vec<String> = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| row.get(0)).map_err(|e| e.to_string())?;
        for row in rows {
            tables.push(row.map_err(|e| e.to_string())?);
        }
    }
    let mut changed = 0u32;
    for table in tables {
        let mut cols: Vec<String> = Vec::new();
        let pragma = format!("PRAGMA table_info({table})");
        let mut stmt = conn.prepare(&pragma).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let name: String = row.get(1)?;
                let typ: String = row.get(2)?;
                Ok((name, typ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (name, typ) = row.map_err(|e| e.to_string())?;
            if typ.to_ascii_uppercase().contains("TEXT") || typ.is_empty() {
                cols.push(name);
            }
        }
        for col in cols {
            let sql = format!(
                "UPDATE {table} SET {col} = replace({col}, ?1, ?2) WHERE instr({col}, ?1) > 0"
            );
            let n = conn
                .execute(&sql, params![old, new])
                .map_err(|e| e.to_string())?;
            changed += n as u32;
        }
    }
    let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    Ok(changed)
}

fn rewrite_moved_bundle(from: &Path, to: &Path) -> Result<(), String> {
    let old = from.display().to_string();
    let new = to.display().to_string();
    let catalog = to.join("Library").join("catalog.sqlite");
    rewrite_sqlite_text_prefix(&catalog, &old, &new)?;
    rewrite_prefix_in_user_db(to, &old, &new)?;
    rewrite_prefix_in_json_files(&to.join("Cache"), &old, &new)?;
    rewrite_prefix_in_json_files(&to.join("Projects"), &old, &new)?;
    rewrite_prefix_in_json_files(&to.join("Exports"), &old, &new)?;
    rewrite_prefix_in_json_files(&to.join("Library").join("logs"), &old, &new)?;
    Ok(())
}

fn sample_rewritten_paths_ok(to: &Path, old_prefix: &str, new_prefix: &str) -> Result<(), String> {
    let catalog = to.join("Library").join("catalog.sqlite");
    if !catalog.is_file() {
        return Ok(());
    }
    let conn = Connection::open(&catalog).map_err(|e| e.to_string())?;
    let leftover: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM creations WHERE
             (instr(COALESCE(local_path,''), ?1) > 0 AND instr(COALESCE(local_path,''), ?2) = 0)
             OR (instr(COALESCE(local_thumb_path,''), ?1) > 0 AND instr(COALESCE(local_thumb_path,''), ?2) = 0)",
            params![old_prefix, new_prefix],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if leftover > 0 {
        return Err(format!(
            "{leftover} catalog paths still use the old root prefix"
        ));
    }
    leftover_old_prefix_in_user_db(to, old_prefix, new_prefix)?;
    let mut stmt = conn
        .prepare(
            "SELECT local_path FROM creations
             WHERE local_path IS NOT NULL AND local_path != '' LIMIT 8",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let p = row.map_err(|e| e.to_string())?;
        if p.contains(old_prefix) && !p.contains(new_prefix) {
            return Err(format!("Sample path still old: {p}"));
        }
        if Path::new(&p).is_absolute() && !Path::new(&p).exists() {
            // File may have been listed but not downloaded; only fail if prefix is wrong.
            continue;
        }
    }
    Ok(())
}

pub fn wal_checkpoint(catalog_db: &Path) -> Result<(), String> {
    if !catalog_db.is_file() {
        return Ok(());
    }
    let conn = Connection::open(catalog_db).map_err(|e| e.to_string())?;
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn creations_count(root: &Path) -> i64 {
    let db = root.join("Library").join("catalog.sqlite");
    let Ok(conn) = Connection::open(db) else {
        return 0;
    };
    conn.query_row("SELECT COUNT(*) FROM creations", [], |row| row.get(0))
        .unwrap_or(0)
}

/// Fail-closed legacy migrate: rename dirs into `users/<slug>/`, rewrite paths, verify.
pub fn migrate_legacy_to_folder(
    machine: &Path,
    sub: &str,
    compact: &CompactPayload,
    secrets: &BTreeMap<String, String>,
    queues: &BTreeMap<String, Value>,
) -> Result<PathBuf, String> {
    let mut accounts = load_accounts(machine)?;
    let rel = unique_rel_dir(&accounts, sub);
    let to = machine.join(&rel);
    let from = machine.to_path_buf();
    let before_count = creations_count(&from);

    write_journal(
        machine,
        &MigrateJournal {
            phase: "renaming".into(),
            from_root: from.display().to_string(),
            to_root: to.display().to_string(),
            sub: sub.to_string(),
        },
    )?;

    if let Err(err) = (|| {
        fs::create_dir_all(&to).map_err(|e| e.to_string())?;
        write_compact(&to, compact, secrets, queues)?;
        verify_compact(&to, compact)?;
        rename_user_dirs(&from, &to)?;
        rewrite_moved_bundle(&from, &to)?;
        sample_rewritten_paths_ok(
            &to,
            &from.display().to_string(),
            &to.display().to_string(),
        )?;
        let after = creations_count(&to);
        if after != before_count {
            return Err(format!(
                "Catalog count mismatch after move ({before_count} → {after})"
            ));
        }
        Ok(())
    })() {
        let _ = revert_rename(&from, &to);
        clear_journal(machine);
        return Err(err);
    }

    accounts.version = 1;
    accounts.users.insert(
        sub.to_string(),
        AccountEntry { dir: rel },
    );
    save_accounts(machine, &accounts)?;
    clear_journal(machine);
    Ok(to)
}

pub fn compact_into_current_folder(
    account: &Path,
    compact: &CompactPayload,
    secrets: &BTreeMap<String, String>,
    queues: &BTreeMap<String, Value>,
) -> Result<(), String> {
    write_compact(account, compact, secrets, queues)?;
    verify_compact(account, compact)?;
    Ok(())
}

fn bind_account(root: Option<PathBuf>) {
    set_account_root(root);
    crate::media_stream::refresh_media_roots();
    crate::replicate::reset_account_memory();
    super::catalog::invalidate_disk_size_cache();
}

fn leftover_store_secrets(account: &Path) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut stores = vec![
        account.join("Library").join("catalog.sqlite"),
        account.join("session.sqlite"),
    ];
    if let Ok(machine) = machine_root() {
        stores.push(machine.join("session.sqlite"));
        stores.push(machine.join("Library").join("catalog.sqlite"));
    }
    for store in stores {
        for (key, value) in super::catalog::read_auth_store_secrets_from_catalog(&store) {
            out.entry(key).or_insert(value);
        }
    }
    out
}

/// Debug (`tauri dev`) keeps Settings secrets in machine `session.sqlite`,
/// not the OS keychain. Collect both stores plus leftover catalog rows.
fn collect_live_secrets() -> Result<BTreeMap<String, String>, String> {
    let mut secrets = BTreeMap::new();
    for key in SECRET_KEYS {
        match crate::auth_store::keychain_get((*key).to_string()) {
            Ok(Some(value)) if !value.trim().is_empty() => {
                secrets.insert((*key).to_string(), value);
            }
            Ok(_) => {}
            Err(err) => {
                return Err(format!("Cannot copy secret {key}: {err}"));
            }
        }
        if secrets.contains_key(*key) {
            continue;
        }
        if let Some(value) = crate::auth_store::keychain_get_os(key) {
            secrets.insert((*key).to_string(), value);
        }
    }
    if let Ok(root) = account_root() {
        for (key, value) in leftover_store_secrets(&root) {
            secrets.entry(key).or_insert(value);
        }
    }
    Ok(secrets)
}

#[tauri::command]
pub fn account_startup() -> Result<Value, String> {
    let machine = machine_root()?;
    recover_journal(&machine)?;
    prune_unbound_machine_payload(&machine)?;
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
pub fn account_login(user_id: String, allow_legacy: Option<bool>) -> Result<LoginResult, String> {
    let machine = machine_root()?;
    let allow = allow_legacy.unwrap_or(false);
    let result = bind_login_or_legacy(&machine, &user_id, allow)?;
    if result.kind == "refuse" {
        return Err(result
            .message
            .clone()
            .unwrap_or_else(|| "Cannot open this account here".into()));
    }
    bind_account(Some(PathBuf::from(&result.account_root)));
    Ok(result)
}

#[tauri::command]
pub fn account_hydrate() -> Result<HydratePayload, String> {
    let root = account_root()?;
    read_hydrate(&root)
}

#[tauri::command]
pub fn account_restore_secrets() -> Result<(), String> {
    let root = account_root()?;
    if !user_db_path(&root).is_file() {
        // Legacy-at-root (or brand-new folder) has not compacted yet.
        // Leave machine Keychain / debug KV alone.
        return Ok(());
    }
    let mut secrets = read_secrets(&root)?;
    if secrets.is_empty() {
        secrets = leftover_store_secrets(&root);
        for (key, value) in &secrets {
            let _ = upsert_secret(&root, key, value);
        }
    }
    for key in SECRET_KEYS {
        let _ = crate::auth_store::keychain_delete_machine((*key).to_string());
    }
    for (key, value) in secrets {
        crate::auth_store::keychain_set_machine(key, value)?;
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogoutRequest {
    pub local_storage: BTreeMap<String, String>,
    pub identity: super::user_state::UserIdentity,
}

#[tauri::command]
pub fn account_logout(request: LogoutRequest) -> Result<LogoutResult, String> {
    let machine = machine_root()?;
    recover_journal(&machine)?;
    let sub = request.identity.sub.trim();
    if sub.is_empty() {
        return Err("Logout requires a signed-in user".into());
    }
    super::download::quiesce_downloads();
    super::jobs::quiesce_jobs();

    let compact = CompactPayload {
        local_storage: request.local_storage,
        identity: request.identity.clone(),
    };
    let live = collect_live_secrets()?;
    let current = account_root()?;
    let secrets = merge_secrets_for_compact(&current, &live)?;
    let mut queues = BTreeMap::new();
    queues.insert(
        "downloads".into(),
        super::download::snapshot_queue(),
    );

    let catalog = resolve_paths(current.clone()).catalog_db;
    wal_checkpoint(&catalog)?;

    let dest = if is_legacy_root(&machine, &current) {
        migrate_legacy_to_folder(&machine, sub, &compact, &secrets, &queues)?
    } else {
        compact_into_current_folder(&current, &compact, &secrets, &queues)?;
        current
    };
    bind_account(None);
    let _ = prune_unbound_machine_payload(&machine);

    for key in SECRET_KEYS {
        let _ = crate::auth_store::keychain_delete_machine((*key).to_string());
    }
    let _ = crate::auth_store::keychain_delete_machine("parascene_session".into());

    Ok(LogoutResult {
        // Stay in this process and show the login screen. Relaunch races
        // single-instance and can leave a hidden/blank window.
        relaunch: false,
        account_root: dest.display().to_string(),
        user_id: sub.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::user_state::UserIdentity;
    use std::env;

    fn temp_machine(label: &str) -> PathBuf {
        let root = env::temp_dir().join(format!(
            "parascene-account-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn seed_legacy_catalog(machine: &Path, media_rel: &str) {
        let paths = ensure_bundle_dirs(machine).unwrap();
        let media = paths.media.join("clip.png");
        fs::write(&media, b"png").unwrap();
        let conn = Connection::open(&paths.catalog_db).unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE creations (
              id TEXT PRIMARY KEY NOT NULL,
              title TEXT NOT NULL,
              media_type TEXT NOT NULL,
              local_path TEXT,
              local_thumb_path TEXT
            );
            CREATE TABLE folders (id TEXT PRIMARY KEY NOT NULL);
            "#,
        )
        .unwrap();
        conn.execute(
            "INSERT INTO creations(id, title, media_type, local_path) VALUES (?1, ?2, ?3, ?4)",
            params!["1", "clip", "image", media.display().to_string()],
        )
        .unwrap();
        let _ = media_rel;
    }

    #[test]
    fn slug_replaces_pipe() {
        assert_eq!(slug_for_sub("auth0|abc"), "auth0_abc");
    }

    #[test]
    fn new_user_creates_folder_when_root_empty() {
        let machine = temp_machine("empty");
        let result = bind_login_or_legacy(&machine, "auth0|new", false).unwrap();
        assert_eq!(result.kind, "created");
        assert!(PathBuf::from(&result.account_root).join("Library").is_dir());
        assert!(!catalog_has_library_data(&machine));
        let accounts = load_accounts(&machine).unwrap();
        assert!(accounts.users.contains_key("auth0|new"));
        let _ = fs::remove_dir_all(&machine);
    }

    #[test]
    fn refuse_new_user_when_unclaimed_legacy() {
        let machine = temp_machine("refuse");
        seed_legacy_catalog(&machine, "x");
        let result = bind_login_or_legacy(&machine, "auth0|other", false).unwrap();
        assert_eq!(result.kind, "refuse");
        assert!(machine.join("Library").join("catalog.sqlite").is_file());
        let _ = fs::remove_dir_all(&machine);
    }

    #[test]
    fn allow_legacy_for_current_session() {
        let machine = temp_machine("legacy");
        seed_legacy_catalog(&machine, "x");
        let result = bind_login_or_legacy(&machine, "auth0|owner", true).unwrap();
        assert_eq!(result.kind, "legacy");
        assert_eq!(
            PathBuf::from(&result.account_root),
            machine
        );
        let _ = fs::remove_dir_all(&machine);
    }

    #[test]
    fn migrate_moves_library_and_rewrites_paths() {
        let machine = temp_machine("migrate");
        seed_legacy_catalog(&machine, "x");
        let old_media = machine.join("Library/media/clip.png");
        assert!(old_media.is_file());
        let compact = CompactPayload {
            local_storage: {
                let mut m = BTreeMap::new();
                m.insert(
                    "parascene.projects.v1".into(),
                    "[{\"id\":\"p1\"}]".into(),
                );
                m.insert(
                    "lab".into(),
                    format!("{}/Library/media/clip.png", machine.display()),
                );
                m
            },
            identity: UserIdentity {
                sub: "auth0|owner".into(),
                ..Default::default()
            },
        };
        let dest = migrate_legacy_to_folder(
            &machine,
            "auth0|owner",
            &compact,
            &BTreeMap::new(),
            &BTreeMap::new(),
        )
        .unwrap();
        assert!(!machine.join("Library").exists());
        assert!(dest.join("Library/media/clip.png").is_file());
        assert!(dest.join("user.sqlite").is_file());
        let hydrate = read_hydrate(&dest).unwrap();
        assert!(hydrate
            .local_storage
            .get("lab")
            .unwrap()
            .contains("users/"));
        assert!(!hydrate.local_storage.get("lab").unwrap().contains(
            &format!("{}/Library", machine.display())
        ));
        let conn = Connection::open(dest.join("Library/catalog.sqlite")).unwrap();
        let path: String = conn
            .query_row("SELECT local_path FROM creations WHERE id='1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(path.contains("users/"));
        assert!(!path.starts_with(&machine.join("Library").display().to_string()));
        assert!(accounts_path(&machine).is_file());
        assert!(!journal_path(&machine).exists());
        let _ = fs::remove_dir_all(&machine);
    }

    #[test]
    fn migrate_reverts_when_dest_already_has_library() {
        let machine = temp_machine("revert");
        seed_legacy_catalog(&machine, "x");
        let dest = machine.join("users/auth0_owner");
        fs::create_dir_all(dest.join("Library")).unwrap();
        let compact = CompactPayload {
            local_storage: BTreeMap::new(),
            identity: UserIdentity {
                sub: "auth0|owner".into(),
                ..Default::default()
            },
        };
        let err = migrate_legacy_to_folder(
            &machine,
            "auth0|owner",
            &compact,
            &BTreeMap::new(),
            &BTreeMap::new(),
        )
        .unwrap_err();
        assert!(err.contains("already exists") || err.contains("Cannot move"));
        assert!(machine.join("Library/catalog.sqlite").is_file());
        assert!(!accounts_path(&machine).is_file());
        assert!(!machine.join("user.sqlite").is_file());
        let _ = fs::remove_dir_all(&machine);
    }

    #[test]
    fn migrate_compact_includes_projects_lab_and_secret() {
        let machine = temp_machine("compact-all");
        seed_legacy_catalog(&machine, "x");
        let mut local_storage = BTreeMap::new();
        local_storage.insert("parascene.projects.v1".into(), "[{\"id\":\"p1\"}]".into());
        local_storage.insert("parascene.lab.draft".into(), "hello".into());
        let compact = CompactPayload {
            local_storage,
            identity: UserIdentity {
                sub: "auth0|owner".into(),
                name: Some("Pat".into()),
                ..Default::default()
            },
        };
        let mut secrets = BTreeMap::new();
        secrets.insert("replicate_api_token".into(), "r8_test".into());
        let dest = migrate_legacy_to_folder(
            &machine,
            "auth0|owner",
            &compact,
            &secrets,
            &BTreeMap::new(),
        )
        .unwrap();
        let hydrate = read_hydrate(&dest).unwrap();
        assert_eq!(
            hydrate.local_storage.get("parascene.projects.v1").unwrap(),
            "[{\"id\":\"p1\"}]"
        );
        assert_eq!(
            hydrate.local_storage.get("parascene.lab.draft").unwrap(),
            "hello"
        );
        assert_eq!(
            read_secrets(&dest)
                .unwrap()
                .get("replicate_api_token")
                .unwrap(),
            "r8_test"
        );
        let _ = fs::remove_dir_all(&machine);
    }

    #[test]
    fn other_sub_cannot_open_first_user_folder() {
        let machine = temp_machine("isolate");
        let first = bind_login_or_legacy(&machine, "auth0|one", false).unwrap();
        assert_eq!(first.kind, "created");
        let second = bind_login_or_legacy(&machine, "auth0|two", false).unwrap();
        assert_eq!(second.kind, "created");
        assert_ne!(first.account_root, second.account_root);
        assert!(PathBuf::from(&first.account_root).join("Library").is_dir());
        assert!(PathBuf::from(&second.account_root).join("Library").is_dir());
        let _ = fs::remove_dir_all(&machine);
    }

    #[test]
    fn relogin_after_migrate_opens_folder_not_root() {
        let machine = temp_machine("relogin");
        seed_legacy_catalog(&machine, "x");
        let compact = CompactPayload {
            local_storage: BTreeMap::new(),
            identity: UserIdentity {
                sub: "auth0|owner".into(),
                ..Default::default()
            },
        };
        let dest = migrate_legacy_to_folder(
            &machine,
            "auth0|owner",
            &compact,
            &BTreeMap::new(),
            &BTreeMap::new(),
        )
        .unwrap();
        let login = bind_login_or_legacy(&machine, "auth0|owner", true).unwrap();
        assert_eq!(login.kind, "folder");
        assert_eq!(login.account_root, dest.display().to_string());
        assert!(!machine.join("Library").exists());
        let other = bind_login_or_legacy(&machine, "auth0|other", false).unwrap();
        assert_eq!(other.kind, "created");
        assert_ne!(other.account_root, dest.display().to_string());
        let _ = fs::remove_dir_all(&machine);
    }

    #[test]
    fn second_login_opens_existing_folder() {
        let machine = temp_machine("second");
        let first = bind_login_or_legacy(&machine, "u1", false).unwrap();
        assert_eq!(first.kind, "created");
        set_account_root(None);
        let second = bind_login_or_legacy(&machine, "u1", false).unwrap();
        assert_eq!(second.kind, "folder");
        assert_eq!(second.account_root, first.account_root);
        let _ = fs::remove_dir_all(&machine);
    }

    #[test]
    fn prune_removes_empty_root_library_when_user_folder_exists() {
        let machine = temp_machine("prune");
        seed_legacy_catalog(&machine, "x");
        let compact = CompactPayload {
            local_storage: BTreeMap::new(),
            identity: UserIdentity {
                sub: "auth0|owner".into(),
                ..Default::default()
            },
        };
        let dest = migrate_legacy_to_folder(
            &machine,
            "auth0|owner",
            &compact,
            &BTreeMap::new(),
            &BTreeMap::new(),
        )
        .unwrap();
        let _ = ensure_bundle_dirs(&machine).unwrap();
        assert!(machine.join("Library").is_dir());
        assert!(!catalog_has_library_data(&machine));
        prune_unbound_machine_payload(&machine).unwrap();
        assert!(!machine.join("Library").exists());
        assert!(dest.join("Library/catalog.sqlite").is_file());
        let _ = fs::remove_dir_all(&machine);
    }

    #[test]
    fn prune_keeps_unclaimed_legacy_library() {
        let machine = temp_machine("prune-legacy");
        seed_legacy_catalog(&machine, "x");
        prune_unbound_machine_payload(&machine).unwrap();
        assert!(machine.join("Library/catalog.sqlite").is_file());
        let _ = fs::remove_dir_all(&machine);
    }

    #[test]
    fn recover_journal_renames_back_when_source_library_remains() {
        let machine = temp_machine("journal");
        seed_legacy_catalog(&machine, "x");
        let to = machine.join("users/partial");
        fs::create_dir_all(&to).unwrap();
        write_journal(
            &machine,
            &MigrateJournal {
                phase: "renaming".into(),
                from_root: machine.display().to_string(),
                to_root: to.display().to_string(),
                sub: "auth0|owner".into(),
            },
        )
        .unwrap();
        recover_journal(&machine).unwrap();
        assert!(machine.join("Library").is_dir());
        assert!(!journal_path(&machine).exists());
        let _ = fs::remove_dir_all(&machine);
    }

    #[test]
    fn recover_journal_finishes_when_library_already_moved() {
        let machine = temp_machine("journal-finish");
        seed_legacy_catalog(&machine, "x");
        let to = machine.join("users/auth0_owner");
        fs::create_dir_all(&to).unwrap();
        for name in USER_DIRS {
            let src = machine.join(name);
            if src.exists() {
                fs::rename(&src, to.join(name)).unwrap();
            }
        }
        write_journal(
            &machine,
            &MigrateJournal {
                phase: "rewriting".into(),
                from_root: machine.display().to_string(),
                to_root: to.display().to_string(),
                sub: "auth0|owner".into(),
            },
        )
        .unwrap();
        recover_journal(&machine).unwrap();
        assert!(to.join("Library/catalog.sqlite").is_file());
        assert!(!machine.join("Library").exists());
        let accounts = load_accounts(&machine).unwrap();
        assert!(accounts.users.contains_key("auth0|owner"));
        assert!(!journal_path(&machine).exists());
        let _ = fs::remove_dir_all(&machine);
    }

    #[test]
    fn leftover_catalog_auth_keys_are_recovered() {
        let machine = temp_machine("catalog-secrets");
        let catalog = machine.join("Library").join("catalog.sqlite");
        fs::create_dir_all(catalog.parent().unwrap()).unwrap();
        let conn = Connection::open(&catalog).unwrap();
        conn.execute_batch(
            "CREATE TABLE sync_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_meta(key, value) VALUES (?1, ?2)",
            params!["auth_store:replicate_api_token", "r8_from_catalog"],
        )
        .unwrap();
        let found = leftover_store_secrets(&machine);
        assert_eq!(
            found.get("replicate_api_token").unwrap(),
            "r8_from_catalog"
        );
        let _ = fs::remove_dir_all(&machine);
    }

    #[test]
    fn leftover_debug_session_sqlite_secrets_are_recovered() {
        let machine = temp_machine("session-secrets");
        let session = machine.join("session.sqlite");
        let conn = Connection::open(&session).unwrap();
        conn.execute_batch(
            "CREATE TABLE sync_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_meta(key, value) VALUES (?1, ?2)",
            params!["auth_store:parascene_openai_api_key", "sk-from-session"],
        )
        .unwrap();
        let found = leftover_store_secrets(&machine);
        assert_eq!(
            found.get("parascene_openai_api_key").unwrap(),
            "sk-from-session"
        );
        let _ = fs::remove_dir_all(&machine);
    }
}
