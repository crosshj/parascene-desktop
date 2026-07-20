//! Preview session: playhead, staged fragment window, timeline commands.

use crate::library::paths::{default_root, resolve_paths};
use crate::library::proxy::{ensure_proxies, PROXY_CODEC_STRING};
use crate::preview::cache::{clear_compose_cache, invalidate_clips, invalidate_range};
use crate::preview::compose::{
    compose_audio_mix_fragment, compose_fragment_at, compose_gap_fragment,
};
use crate::preview::remux::{remux_fragment_at, remux_with_audio_mix};
use crate::preview::timeline::{
    build_spans, find_clip_at, needs_audio_lane_mix, timeline_duration, PreviewSeekMode,
    PreviewTimelineClip, SpanKind,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

const FRAGMENT_SEC: f64 = 1.0;
const STAGE_BEHIND: i32 = 1;
const STAGE_AHEAD: i32 = 8;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FragmentReady {
    pub session_id: String,
    pub fragment_id: String,
    pub timeline_start: f64,
    pub duration: f64,
    /// Filename under the session dir (for `preview_read_fragment`).
    pub init_file: String,
    pub media_file: String,
    /// Absolute paths (also served via `media://` if needed).
    pub init_path: String,
    pub media_path: String,
    pub reset: bool,
    pub mode: String,
    pub codec: String,
    pub generation: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewStateEvent {
    pub session_id: String,
    pub playhead_sec: f64,
    pub playing: bool,
    pub rate: f64,
    pub duration_sec: f64,
    pub mode: String,
    pub generation: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSessionInfo {
    pub session_id: String,
    pub codec: String,
}

struct SessionInner {
    id: String,
    app: AppHandle,
    clips: Vec<PreviewTimelineClip>,
    aspect: String,
    playhead: f64,
    playing: bool,
    rate: f64,
    mode: PreviewSeekMode,
    generation: u64,
    dir: PathBuf,
    /// fragment_id → timeline_start
    staged: HashMap<String, f64>,
    shared_init_written: bool,
    last_tick: Instant,
    /// Last fragment index that triggered a full stage+reset.
    last_stage_idx: i64,
    /// True while a background stage job owns the ffmpeg work.
    staging: bool,
    /// Another stage was requested while staging — run again when free.
    pending_stage: bool,
    pending_reset: bool,
}

impl SessionInner {
    fn duration(&self) -> f64 {
        timeline_duration(&self.clips)
    }

    fn emit_state(&self) {
        let _ = self.app.emit(
            "preview-state",
            PreviewStateEvent {
                session_id: self.id.clone(),
                playhead_sec: self.playhead,
                playing: self.playing,
                rate: self.rate,
                duration_sec: self.duration(),
                mode: match self.mode {
                    PreviewSeekMode::Playback => "playback".into(),
                    PreviewSeekMode::Scrub => "scrub".into(),
                },
                generation: self.generation,
            },
        );
    }

    fn fragment_files(&self, fragment_id: &str) -> (String, String, String, String) {
        let init_file = "shared.init.mp4".to_string();
        let media_file = format!("{fragment_id}.m4s");
        let init_path = self.dir.join(&init_file).display().to_string();
        let media_path = self.dir.join(&media_file).display().to_string();
        (init_file, media_file, init_path, media_path)
    }

    fn ensure_asset_proxies(&self) {
        for c in &self.clips {
            if let Some(id) = c.asset_id.as_deref() {
                let _ = ensure_proxies(Some(&self.app), id);
            }
        }
    }

    fn build_fragment(&mut self, timeline_start: f64, reset: bool) -> Result<(), String> {
        let dur_total = self.duration();
        if dur_total <= 0.0 {
            return Ok(());
        }
        let timeline_start = timeline_start.clamp(0.0, dur_total);
        let dur = FRAGMENT_SEC.min(dur_total - timeline_start).max(0.05);
        let idx = (timeline_start / FRAGMENT_SEC).floor() as i64;
        let fragment_id = format!("f{}_{}", self.generation, idx);
        if self.staged.contains_key(&fragment_id) && !reset {
            return Ok(());
        }

        let spans = build_spans(&self.clips);
        let span = spans.iter().find(|s| {
            timeline_start >= s.timeline_start - 0.001 && timeline_start < s.timeline_end
        });

        // One continuous stream recipe for scrub and play (same remux/A1 path).
        // Mode only affects how aggressively we stage — never changes codec layout
        // mid-session (that was wiping MSE on scrub↔play and killing playback).
        let wants_a1 = needs_audio_lane_mix(&self.clips, timeline_start, dur);
        let visual_compose = span
            .map(|s| matches!(s.kind, SpanKind::Compose))
            .unwrap_or(false);

        let out = if visual_compose {
            let recipe = span.map(|s| s.recipe_key.as_str()).unwrap_or("compose");
            match compose_fragment_at(
                &self.clips,
                timeline_start,
                dur,
                self.mode,
                &self.dir,
                &fragment_id,
                recipe,
                &self.aspect,
            ) {
                Ok(o) => o,
                Err(_) => compose_gap_fragment(timeline_start, dur, &self.dir, &fragment_id)?,
            }
        } else if wants_a1 {
            if find_clip_at(&self.clips, timeline_start).is_some() {
                match remux_with_audio_mix(
                    &self.clips,
                    timeline_start,
                    dur,
                    self.mode,
                    &self.dir,
                    &fragment_id,
                ) {
                    Ok(o) => o,
                    Err(_) => compose_gap_fragment(timeline_start, dur, &self.dir, &fragment_id)?,
                }
            } else {
                match compose_audio_mix_fragment(
                    &self.clips,
                    timeline_start,
                    dur,
                    &self.dir,
                    &fragment_id,
                ) {
                    Ok(o) => o,
                    Err(_) => compose_gap_fragment(timeline_start, dur, &self.dir, &fragment_id)?,
                }
            }
        } else if find_clip_at(&self.clips, timeline_start).is_some() {
            match remux_fragment_at(
                &self.clips,
                timeline_start,
                dur,
                self.mode,
                &self.dir,
                &fragment_id,
            ) {
                Ok(o) => o,
                Err(_) => compose_gap_fragment(timeline_start, dur, &self.dir, &fragment_id)?,
            }
        } else {
            // Timeline hole — still emit media so MSE never waits forever.
            compose_gap_fragment(timeline_start, dur, &self.dir, &fragment_id)?
        };

        // Keep a shared init for the session (first fragment wins).
        let shared_init = self.dir.join("shared.init.mp4");
        if !self.shared_init_written || reset {
            let _ = fs::copy(&out.init_path, &shared_init);
            self.shared_init_written = true;
        }
        if !out.media_path.is_file() {
            return Err(format!(
                "Missing media fragment {}",
                out.media_path.display()
            ));
        }

        self.staged.insert(fragment_id.clone(), out.timeline_start);
        let (init_file, media_file, init_path, media_path) = self.fragment_files(&fragment_id);
        let generation = self.generation;

        let _ = self.app.emit(
            "preview-fragment-ready",
            FragmentReady {
                session_id: self.id.clone(),
                fragment_id,
                timeline_start: out.timeline_start,
                duration: out.duration,
                init_file,
                media_file,
                init_path,
                media_path,
                reset,
                mode: match self.mode {
                    PreviewSeekMode::Playback => "playback".into(),
                    PreviewSeekMode::Scrub => "scrub".into(),
                },
                codec: PROXY_CODEC_STRING.into(),
                generation,
            },
        );
        Ok(())
    }

    fn emit_existing_fragment(
        &self,
        fragment_id: &str,
        timeline_start: f64,
        duration: f64,
        reset: bool,
    ) {
        let media_path = self.dir.join(format!("{fragment_id}.m4s"));
        if !media_path.is_file() {
            return;
        }
        let (init_file, media_file, init_path, media_path_s) = self.fragment_files(fragment_id);
        let _ = self.app.emit(
            "preview-fragment-ready",
            FragmentReady {
                session_id: self.id.clone(),
                fragment_id: fragment_id.to_string(),
                timeline_start,
                duration,
                init_file,
                media_file,
                init_path,
                media_path: media_path_s,
                reset,
                mode: match self.mode {
                    PreviewSeekMode::Playback => "playback".into(),
                    PreviewSeekMode::Scrub => "scrub".into(),
                },
                codec: PROXY_CODEC_STRING.into(),
                generation: self.generation,
            },
        );
    }

    /// Drop fragment files from older generations; keep current gen + shared init.
    fn prune_stale_fragments(&self) {
        let prefix = format!("f{}_", self.generation);
        if let Ok(entries) = fs::read_dir(&self.dir) {
            for e in entries.flatten() {
                let name = e.file_name();
                let Some(name) = name.to_str() else { continue };
                if name == "shared.init.mp4" {
                    continue;
                }
                // Keep current generation fragment files.
                if name.starts_with(&prefix) {
                    continue;
                }
                // Also keep remux side-products only for current gen.
                if name.starts_with("f") && name.contains('_') {
                    let _ = fs::remove_file(e.path());
                }
            }
        }
    }

    fn stage_window(&mut self, reset: bool) {
        let dur = self.duration();
        if dur <= 0.0 {
            let _ = self.app.emit(
                "preview-state",
                PreviewStateEvent {
                    session_id: self.id.clone(),
                    playhead_sec: self.playhead,
                    playing: self.playing,
                    rate: self.rate,
                    duration_sec: 0.0,
                    mode: match self.mode {
                        PreviewSeekMode::Playback => "playback".into(),
                        PreviewSeekMode::Scrub => "scrub".into(),
                    },
                    generation: self.generation,
                },
            );
            return;
        }
        let base = (self.playhead / FRAGMENT_SEC).floor() * FRAGMENT_SEC;
        self.last_stage_idx = (self.playhead / FRAGMENT_SEC).floor() as i64;
        // Prioritize current fragment first, then ahead, then behind.
        let mut starts: Vec<f64> = Vec::new();
        starts.push(base);
        for i in 1..=STAGE_AHEAD {
            let t = base + f64::from(i) * FRAGMENT_SEC;
            if t >= 0.0 && t < dur {
                starts.push(t);
            }
        }
        for i in 1..=STAGE_BEHIND {
            let t = base - f64::from(i) * FRAGMENT_SEC;
            if t >= 0.0 && t < dur {
                starts.push(t);
            }
        }
        let mut first = reset;
        for t in starts {
            if let Err(e) = self.build_fragment(t, first) {
                let _ = self.app.emit(
                    "preview-error",
                    serde_json::json!({
                        "sessionId": self.id,
                        "error": e,
                    }),
                );
            }
            first = false;
        }
        self.prune_stale_fragments();
    }

    fn tick_playhead(&mut self) {
        if !self.playing {
            return;
        }
        // Playhead is owned by the client stream clock (MSE <video> timeupdate
        // → preview_seek). The ticker only keeps the staged window warm.
        let _ = Instant::now();
        self.emit_state();
    }

    fn needs_stage(&self) -> bool {
        if self.staging {
            return false;
        }
        let dur = self.duration();
        if dur <= 0.0 {
            return false;
        }
        // Stage current + several ahead for continuous play.
        let idx = (self.playhead / FRAGMENT_SEC).floor() as i64;
        for i in 0..=STAGE_AHEAD {
            let fragment_id = format!("f{}_{}", self.generation, idx + i64::from(i));
            let t = (idx + i64::from(i)) as f64 * FRAGMENT_SEC;
            if t < dur && !self.staged.contains_key(&fragment_id) {
                return true;
            }
        }
        false
    }
}

struct SessionStore {
    sessions: HashMap<String, Arc<Mutex<SessionInner>>>,
}

fn store() -> &'static Mutex<SessionStore> {
    static STORE: OnceLock<Mutex<SessionStore>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(SessionStore {
        sessions: HashMap::new(),
    }))
}

fn session_dir(id: &str) -> Result<PathBuf, String> {
    let paths = resolve_paths(default_root()?);
    let dir = paths.cache.join("preview-sessions").join(id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub fn resolve_session_file(session_id: &str, file: &str) -> Result<PathBuf, String> {
    if file.contains("..") || file.contains('/') || file.contains('\\') {
        return Err("Invalid preview path".into());
    }
    let dir = session_dir(session_id)?;
    let path = dir.join(file);
    if !path.starts_with(&dir) {
        return Err("Path escape".into());
    }
    Ok(path)
}

fn spawn_ticker(app: AppHandle, session_id: String) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let arc = {
                let st = store().lock().unwrap_or_else(|e| e.into_inner());
                st.sessions.get(&session_id).cloned()
            };
            let Some(arc) = arc else { break };
            let should_stage = {
                let mut inner = arc.lock().unwrap_or_else(|e| e.into_inner());
                if inner.playing {
                    inner.tick_playhead();
                    inner.needs_stage()
                } else {
                    false
                }
            };
            if should_stage {
                schedule_stage(arc, false);
            }
            let _ = &app;
        }
    });
}

/// Run ffmpeg staging off the playhead lock so ticks stay realtime.
fn schedule_stage(arc: Arc<Mutex<SessionInner>>, reset: bool) {
    {
        let mut inner = arc.lock().unwrap_or_else(|e| e.into_inner());
        if inner.staging {
            inner.pending_stage = true;
            inner.pending_reset = inner.pending_reset || reset;
            return;
        }
        inner.staging = true;
        inner.pending_stage = false;
        inner.pending_reset = false;
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut do_reset = reset;
        loop {
            {
                let mut inner = arc.lock().unwrap_or_else(|e| e.into_inner());
                inner.stage_window(do_reset);
            }
            let (again, next_reset) = {
                let mut inner = arc.lock().unwrap_or_else(|e| e.into_inner());
                if inner.pending_stage {
                    let r = inner.pending_reset;
                    inner.pending_stage = false;
                    inner.pending_reset = false;
                    (true, r)
                } else {
                    inner.staging = false;
                    inner.emit_state();
                    (false, false)
                }
            };
            if !again {
                break;
            }
            do_reset = next_reset;
        }
    });
}

#[tauri::command]
pub fn preview_session_open(app: AppHandle) -> Result<PreviewSessionInfo, String> {
    let id = Uuid::new_v4().to_string();
    let dir = session_dir(&id)?;
    let inner = SessionInner {
        id: id.clone(),
        app: app.clone(),
        clips: Vec::new(),
        aspect: "16:9".into(),
        playhead: 0.0,
        playing: false,
        rate: 1.0,
        mode: PreviewSeekMode::Playback,
        generation: 1,
        dir,
        staged: HashMap::new(),
        shared_init_written: false,
        last_tick: Instant::now(),
        last_stage_idx: -1,
        staging: false,
        pending_stage: false,
        pending_reset: false,
    };
    {
        let mut st = store().lock().unwrap_or_else(|e| e.into_inner());
        st.sessions
            .insert(id.clone(), Arc::new(Mutex::new(inner)));
    }
    spawn_ticker(app, id.clone());
    Ok(PreviewSessionInfo {
        session_id: id,
        codec: PROXY_CODEC_STRING.into(),
    })
}

#[tauri::command]
pub fn preview_session_close(session_id: String) -> Result<(), String> {
    let mut st = store().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(arc) = st.sessions.remove(&session_id) {
        let inner = arc.lock().unwrap_or_else(|e| e.into_inner());
        let _ = fs::remove_dir_all(&inner.dir);
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetTimelineInput {
    pub session_id: String,
    pub clips: Vec<PreviewTimelineClip>,
    pub aspect_ratio: Option<String>,
    pub playhead_sec: Option<f64>,
}

#[tauri::command]
pub fn preview_set_timeline(input: SetTimelineInput) -> Result<(), String> {
    let arc = {
        let st = store().lock().unwrap_or_else(|e| e.into_inner());
        st.sessions
            .get(&input.session_id)
            .cloned()
            .ok_or_else(|| "Unknown preview session".to_string())?
    };
    {
        let mut inner = arc.lock().unwrap_or_else(|e| e.into_inner());
        let old_ids: Vec<String> = inner.clips.iter().map(|c| c.id.clone()).collect();
        invalidate_clips(&old_ids);
        if old_ids.len() != input.clips.len() {
            clear_compose_cache();
        } else {
            let start = input
                .clips
                .iter()
                .map(|c| c.start_sec)
                .fold(f64::INFINITY, f64::min);
            let end = input
                .clips
                .iter()
                .map(|c| c.end_sec)
                .fold(0.0_f64, f64::max);
            if start.is_finite() {
                invalidate_range(start, end);
            }
        }
        inner.clips = input.clips;
        if let Some(a) = input.aspect_ratio {
            inner.aspect = a;
        }
        if let Some(p) = input.playhead_sec {
            inner.playhead = p.max(0.0);
        }
        inner.generation += 1;
        inner.staged.clear();
        inner.shared_init_written = false;
        inner.last_stage_idx = -1;
        if let Ok(entries) = fs::read_dir(&inner.dir) {
            for e in entries.flatten() {
                let _ = fs::remove_file(e.path());
            }
        }
    }
    let arc2 = arc.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut inner = arc2.lock().unwrap_or_else(|e| e.into_inner());
        inner.ensure_asset_proxies();
        inner.staging = true;
        inner.stage_window(true);
        inner.staging = false;
        inner.emit_state();
    });
    Ok(())
}

#[tauri::command]
pub fn preview_play(session_id: String) -> Result<(), String> {
    let arc = {
        let st = store().lock().unwrap_or_else(|e| e.into_inner());
        st.sessions
            .get(&session_id)
            .cloned()
            .ok_or_else(|| "Unknown preview session".to_string())?
    };
    {
        let mut inner = arc.lock().unwrap_or_else(|e| e.into_inner());
        inner.mode = PreviewSeekMode::Playback;
        inner.playing = true;
        inner.last_tick = Instant::now();
        inner.emit_state();
    }
    // Warm a long ahead window without MSE reset — same fragment recipe as scrub.
    schedule_stage(arc, false);
    Ok(())
}

#[tauri::command]
pub fn preview_pause(session_id: String) -> Result<(), String> {
    let arc = {
        let st = store().lock().unwrap_or_else(|e| e.into_inner());
        st.sessions
            .get(&session_id)
            .cloned()
            .ok_or_else(|| "Unknown preview session".to_string())?
    };
    let mut inner = arc.lock().unwrap_or_else(|e| e.into_inner());
    inner.playing = false;
    inner.emit_state();
    Ok(())
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeekInput {
    pub session_id: String,
    pub playhead_sec: f64,
    pub mode: Option<String>,
}

#[tauri::command]
pub fn preview_seek(input: SeekInput) -> Result<(), String> {
    let arc = {
        let st = store().lock().unwrap_or_else(|e| e.into_inner());
        st.sessions
            .get(&input.session_id)
            .cloned()
            .ok_or_else(|| "Unknown preview session".to_string())?
    };
    {
        let mut inner = arc.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(m) = input.mode.as_deref() {
            // Mode is advisory for staging urgency only — never resets the stream.
            inner.mode = if m == "scrub" {
                PreviewSeekMode::Scrub
            } else {
                PreviewSeekMode::Playback
            };
        }
        inner.playhead = input.playhead_sec.max(0.0);
        let idx = (inner.playhead / FRAGMENT_SEC).floor() as i64;
        let fragment_id = format!("f{}_{}", inner.generation, idx);
        let already = inner.staged.contains_key(&fragment_id);
        inner.last_stage_idx = idx;
        inner.emit_state();
        if already && !inner.playing {
            // Paused scrub inside a staged second — FE seeks video.currentTime.
            return Ok(());
        }
        if already && inner.playing {
            // Re-emit current + next seconds so MSE can recover missed events.
            let gen = inner.generation;
            let dur_total = inner.duration();
            for i in 0i64..=2 {
                let id = format!("f{}_{}", gen, idx + i);
                if !inner.staged.contains_key(&id) {
                    continue;
                }
                let base = (idx + i) as f64 * FRAGMENT_SEC;
                if base >= dur_total {
                    break;
                }
                let dur = FRAGMENT_SEC.min(dur_total - base).max(0.05);
                inner.emit_existing_fragment(&id, base, dur, false);
            }
        }
        // Playing or entering a new second: keep staging ahead (no MSE reset).
    }
    schedule_stage(arc, false);
    Ok(())
}

#[tauri::command]
pub fn preview_set_rate(session_id: String, rate: f64) -> Result<(), String> {
    let arc = {
        let st = store().lock().unwrap_or_else(|e| e.into_inner());
        st.sessions
            .get(&session_id)
            .cloned()
            .ok_or_else(|| "Unknown preview session".to_string())?
    };
    let mut inner = arc.lock().unwrap_or_else(|e| e.into_inner());
    inner.rate = rate.clamp(0.25, 4.0);
    inner.emit_state();
    Ok(())
}

#[tauri::command]
pub fn preview_get_state(session_id: String) -> Result<PreviewStateEvent, String> {
    let arc = {
        let st = store().lock().unwrap_or_else(|e| e.into_inner());
        st.sessions
            .get(&session_id)
            .cloned()
            .ok_or_else(|| "Unknown preview session".to_string())?
    };
    let inner = arc.lock().unwrap_or_else(|e| e.into_inner());
    Ok(PreviewStateEvent {
        session_id: inner.id.clone(),
        playhead_sec: inner.playhead,
        playing: inner.playing,
        rate: inner.rate,
        duration_sec: inner.duration(),
        mode: match inner.mode {
            PreviewSeekMode::Playback => "playback".into(),
            PreviewSeekMode::Scrub => "scrub".into(),
        },
        generation: inner.generation,
    })
}

/// Read a session fragment file as raw bytes for MSE append (avoids WKWebView
/// `fetch` failing on custom protocols with "Load failed").
#[tauri::command]
pub fn preview_read_fragment(session_id: String, file: String) -> Result<Vec<u8>, String> {
    let path = resolve_session_file(&session_id, &file)?;
    // Brief retry — seek rebuilds are async and scrub can race the first read.
    for attempt in 0..8 {
        if path.is_file() {
            return fs::read(&path).map_err(|e| format!("Could not read fragment {file}: {e}"));
        }
        if attempt + 1 < 8 {
            std::thread::sleep(Duration::from_millis(25));
        }
    }
    Err(format!("Fragment not found: {file}"))
}
