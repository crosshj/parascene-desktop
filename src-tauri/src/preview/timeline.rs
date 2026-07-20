//! Timeline span resolution: remuxable cuts vs compose regions.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewClipTransition {
    /// cut | dissolve | fadeBlack
    pub kind: String,
    pub duration_sec: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewClipEffect {
    /// opacity | blur (blur stub)
    pub kind: String,
    pub value: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewTimelineClip {
    pub id: String,
    pub label: String,
    pub start_sec: f64,
    pub end_sec: f64,
    pub asset_id: Option<String>,
    pub lane: Option<String>,
    pub kind: Option<String>,
    pub in_sec: Option<f64>,
    pub out_sec: Option<f64>,
    pub include_audio: Option<bool>,
    pub reverse: Option<bool>,
    pub transform: Option<String>,
    pub framing: Option<String>,
    pub bake_path: Option<String>,
    pub bake_key: Option<String>,
    pub transition_in: Option<PreviewClipTransition>,
    pub transition_out: Option<PreviewClipTransition>,
    pub effects: Option<Vec<PreviewClipEffect>>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PreviewSeekMode {
    Playback,
    Scrub,
}

#[derive(Clone, Debug)]
pub enum SpanKind {
    /// Hard cut remux from proxy (`-c copy`).
    Remux,
    /// Needs FFmpeg compose (transition, effect, Ken Burns, framing, slideshow, reverse, mid-GOP).
    Compose,
}

#[derive(Clone, Debug)]
pub struct TimelineSpan {
    pub timeline_start: f64,
    pub timeline_end: f64,
    pub kind: SpanKind,
    pub clip_ids: Vec<String>,
    /// Content-addressed cache key ingredients.
    pub recipe_key: String,
}

fn clip_needs_compose(clip: &PreviewTimelineClip) -> bool {
    let kind = clip.kind.as_deref().unwrap_or("video");
    if kind == "image" || kind == "slideshow" {
        return true;
    }
    if clip.reverse.unwrap_or(false) {
        return true;
    }
    if matches!(clip.transform.as_deref(), Some("kenBurns")) {
        return true;
    }
    if let Some(framing) = clip.framing.as_deref() {
        if framing != "fit" {
            // fill/stretch baked into stream for consistent matte
            return true;
        }
    }
    if let Some(t) = &clip.transition_in {
        if t.kind != "cut" && t.duration_sec > 0.001 {
            return true;
        }
    }
    if let Some(t) = &clip.transition_out {
        if t.kind != "cut" && t.duration_sec > 0.001 {
            return true;
        }
    }
    if let Some(effects) = &clip.effects {
        for e in effects {
            if e.kind == "opacity" && (e.value - 1.0).abs() > 0.001 {
                return true;
            }
            if e.kind == "blur" && e.value > 0.001 {
                return true;
            }
        }
    }
    false
}

fn recipe_for_clip(clip: &PreviewTimelineClip) -> String {
    format!(
        "{}|{}|{}|{}|{}|{}|{}|{}|{:?}|{:?}|{:?}",
        clip.id,
        clip.asset_id.as_deref().unwrap_or(""),
        clip.start_sec,
        clip.end_sec,
        clip.in_sec.unwrap_or(0.0),
        clip.out_sec.unwrap_or(clip.end_sec - clip.start_sec),
        clip.reverse.unwrap_or(false),
        clip.transform.as_deref().unwrap_or("hold"),
        clip.framing,
        clip.transition_in,
        clip.effects
    )
}

/// Build non-overlapping spans covering [0, duration]. Adjacent remux clips merge.
pub fn build_spans(clips: &[PreviewTimelineClip]) -> Vec<TimelineSpan> {
    let mut video: Vec<&PreviewTimelineClip> = clips
        .iter()
        .filter(|c| c.lane.as_deref() != Some("audio"))
        .collect();
    video.sort_by(|a, b| {
        a.start_sec
            .partial_cmp(&b.start_sec)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                b.end_sec
                    .partial_cmp(&a.end_sec)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });

    let mut spans: Vec<TimelineSpan> = Vec::new();
    for clip in video {
        let compose = clip_needs_compose(clip);
        let kind = if compose {
            SpanKind::Compose
        } else {
            SpanKind::Remux
        };
        let recipe = recipe_for_clip(clip);
        if let Some(last) = spans.last_mut() {
            if matches!(last.kind, SpanKind::Remux)
                && matches!(kind, SpanKind::Remux)
                && (last.timeline_end - clip.start_sec).abs() < 0.02
            {
                last.timeline_end = clip.end_sec.max(last.timeline_end);
                last.clip_ids.push(clip.id.clone());
                last.recipe_key = format!("{}+{}", last.recipe_key, recipe);
                continue;
            }
        }
        spans.push(TimelineSpan {
            timeline_start: clip.start_sec,
            timeline_end: clip.end_sec,
            kind,
            clip_ids: vec![clip.id.clone()],
            recipe_key: recipe,
        });
    }
    spans
}

pub fn timeline_duration(clips: &[PreviewTimelineClip]) -> f64 {
    clips
        .iter()
        .map(|c| c.end_sec)
        .fold(0.0_f64, f64::max)
        .max(0.0)
}

pub fn clip_source_sec(clip: &PreviewTimelineClip, timeline_sec: f64) -> f64 {
    let in_sec = clip.in_sec.unwrap_or(0.0);
    let out_sec = clip
        .out_sec
        .unwrap_or(in_sec + (clip.end_sec - clip.start_sec).max(0.0));
    let local = (timeline_sec - clip.start_sec).max(0.0);
    let src = in_sec + local;
    src.clamp(in_sec, out_sec.max(in_sec))
}

pub fn find_clip_at<'a>(
    clips: &'a [PreviewTimelineClip],
    timeline_sec: f64,
) -> Option<&'a PreviewTimelineClip> {
    let mut best: Option<&PreviewTimelineClip> = None;
    for c in clips {
        if c.lane.as_deref() == Some("audio") {
            continue;
        }
        if timeline_sec >= c.start_sec && timeline_sec < c.end_sec {
            best = Some(c);
        }
    }
    best
}

/// Audio-lane clips overlapping `[timeline_sec, timeline_sec + duration)`.
pub fn overlapping_audio_clips(
    clips: &[PreviewTimelineClip],
    timeline_sec: f64,
    duration: f64,
) -> Vec<&PreviewTimelineClip> {
    let end = timeline_sec + duration;
    clips
        .iter()
        .filter(|c| {
            c.lane.as_deref() == Some("audio")
                && timeline_sec < c.end_sec
                && end > c.start_sec
        })
        .collect()
}

/// True when any A1 (audio-lane) clip overlaps this window — needs compose mix.
pub fn needs_audio_lane_mix(
    clips: &[PreviewTimelineClip],
    timeline_sec: f64,
    duration: f64,
) -> bool {
    !overlapping_audio_clips(clips, timeline_sec, duration).is_empty()
}
