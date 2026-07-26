//! Export-time Looks — GPU CRT presets (preferred) + FFmpeg CPU fallback for TV.
//!
//! **Color policy:** no purposeful vintage grade (identity `eq`). Structural
//! effects only (scanlines, bloom, ghost, chroma mush). Optional `params`
//! overrides still apply to the FFmpeg TV fallback.

use serde::Deserialize;
use std::collections::HashMap;

use super::crt_gpu::{first_enabled_crt_preset, CrtPreset};

/// Catalog order for stacking / preference.
const LOOK_IDS: &[&str] = &["tv", "afterglow", "broadcast"];

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RenderLookState {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub params: Option<HashMap<String, f64>>,
}

/// Project looks payload from the publisher render invoke.
#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RenderLooks {
    #[serde(default)]
    pub tv: Option<RenderLookState>,
    #[serde(default)]
    pub afterglow: Option<RenderLookState>,
    #[serde(default)]
    pub broadcast: Option<RenderLookState>,
}

impl RenderLooks {
    pub fn has_any_enabled(&self) -> bool {
        LOOK_IDS.iter().any(|id| self.is_enabled(id))
    }

    pub fn is_enabled(&self, id: &str) -> bool {
        match id {
            "tv" => self.tv.as_ref().is_some_and(|s| s.enabled),
            "afterglow" => self.afterglow.as_ref().is_some_and(|s| s.enabled),
            "broadcast" => self.broadcast.as_ref().is_some_and(|s| s.enabled),
            _ => false,
        }
    }

    fn params_for(&self, id: &str) -> Option<&HashMap<String, f64>> {
        match id {
            "tv" => self.tv.as_ref().and_then(|s| s.params.as_ref()),
            "afterglow" => self.afterglow.as_ref().and_then(|s| s.params.as_ref()),
            "broadcast" => self.broadcast.as_ref().and_then(|s| s.params.as_ref()),
            _ => None,
        }
    }

    /// Preferred GPU CRT preset when any Look is enabled.
    pub fn crt_preset(&self) -> Option<CrtPreset> {
        first_enabled_crt_preset(
            self.is_enabled("tv"),
            self.is_enabled("afterglow"),
            self.is_enabled("broadcast"),
        )
    }

    /// Human label for the active Look, if any.
    pub fn enabled_label(&self) -> Option<&'static str> {
        match self.crt_preset()? {
            CrtPreset::Tv => Some("TV"),
            CrtPreset::Afterglow => Some("Afterglow"),
            CrtPreset::Broadcast => Some("Broadcast"),
        }
    }
}

/// Every tunable for the FFmpeg TV fallback — single place to iterate.
#[derive(Clone, Debug)]
pub struct TvLookParams {
    pub glow_sigma: f64,
    pub glow_opacity: f64,
    pub ghost_shift_px: f64,
    pub ghost_opacity: f64,
    pub ghost_blur: f64,
    pub chroma_shift_px: f64,
    pub noise_strength: f64,
    pub vignette_angle: f64,
    pub scanline_strength: f64,
    pub scanline_period: f64,
    pub contrast: f64,
    pub saturation: f64,
    pub brightness: f64,
}

impl Default for TvLookParams {
    fn default() -> Self {
        Self {
            glow_sigma: 2.0,
            glow_opacity: 0.10,
            ghost_shift_px: 3.0,
            ghost_opacity: 0.16,
            ghost_blur: 0.7,
            // Keep fringe tiny so it doesn't read as a cast.
            chroma_shift_px: 0.0,
            noise_strength: 4.0,
            vignette_angle: std::f64::consts::PI / 5.5,
            scanline_strength: 0.45,
            scanline_period: 2.0,
            // Identity grade — no vintage styling.
            contrast: 1.0,
            saturation: 1.0,
            brightness: 0.0,
        }
    }
}

impl TvLookParams {
    fn from_overrides(overrides: Option<&HashMap<String, f64>>) -> Self {
        let mut p = Self::default();
        let Some(map) = overrides else {
            return p;
        };
        if let Some(v) = map.get("glowSigma").copied().filter(|v| v.is_finite()) {
            p.glow_sigma = v.max(0.01);
        }
        if let Some(v) = map.get("glowOpacity").copied().filter(|v| v.is_finite()) {
            p.glow_opacity = v.clamp(0.0, 1.0);
        }
        if let Some(v) = map.get("ghostShiftPx").copied().filter(|v| v.is_finite()) {
            p.ghost_shift_px = v.clamp(0.0, 32.0);
        }
        if let Some(v) = map.get("ghostOpacity").copied().filter(|v| v.is_finite()) {
            p.ghost_opacity = v.clamp(0.0, 1.0);
        }
        if let Some(v) = map.get("ghostBlur").copied().filter(|v| v.is_finite()) {
            p.ghost_blur = v.max(0.0);
        }
        if let Some(v) = map.get("chromaShiftPx").copied().filter(|v| v.is_finite()) {
            p.chroma_shift_px = v.clamp(0.0, 16.0);
        }
        if let Some(v) = map.get("noiseStrength").copied().filter(|v| v.is_finite()) {
            p.noise_strength = v.clamp(0.0, 100.0);
        }
        if let Some(v) = map.get("vignetteAngle").copied().filter(|v| v.is_finite()) {
            p.vignette_angle = v.max(0.01);
        }
        if let Some(v) = map
            .get("scanlineStrength")
            .copied()
            .filter(|v| v.is_finite())
        {
            p.scanline_strength = v.clamp(0.0, 1.0);
        }
        if let Some(v) = map.get("scanlinePeriod").copied().filter(|v| v.is_finite()) {
            p.scanline_period = v.max(1.0);
        }
        if let Some(v) = map.get("contrast").copied().filter(|v| v.is_finite()) {
            p.contrast = v.max(0.0);
        }
        if let Some(v) = map.get("saturation").copied().filter(|v| v.is_finite()) {
            p.saturation = v.max(0.0);
        }
        if let Some(v) = map.get("brightness").copied().filter(|v| v.is_finite()) {
            p.brightness = v.clamp(-1.0, 1.0);
        }
        p
    }
}

/// Build a labeled FFmpeg filter_complex fragment for CPU fallback.
/// Only **TV** has an FFmpeg graph; Afterglow/Broadcast require the GPU path.
/// Returns `None` when no FFmpeg-capable look is enabled.
pub fn build_look_video_filter(
    looks: &RenderLooks,
    input_label: &str,
    output_label: &str,
) -> Option<String> {
    if !looks.is_enabled("tv") {
        return None;
    }
    // If a non-TV look is also preferred first, GPU path handles it — still
    // allow TV fallback graph when only TV (or TV is the selected preset).
    let preset = looks.crt_preset()?;
    if preset != CrtPreset::Tv {
        return None;
    }
    Some(build_tv_look(
        input_label,
        output_label,
        0,
        &TvLookParams::from_overrides(looks.params_for("tv")),
    ))
}

/// Soft bloom + CRT ghost trail + noise + vignette + scanlines (identity eq).
fn build_tv_look(input: &str, output: &str, stage: usize, p: &TvLookParams) -> String {
    let base = format!("tvb{stage}");
    let glow_src = format!("tvgs{stage}");
    let glow = format!("tvglow{stage}");
    let bloomed = format!("tvbloom{stage}");
    let ghost_src = format!("tvghs{stage}");
    let ghost = format!("tvgh{stage}");
    let ghosted = format!("tvghosted{stage}");

    let scan = p.scanline_strength;
    let period = p.scanline_period.max(1.0);
    let geq = format!(
        "geq=lum='lum(X\\,Y)*(1-{scan:.4}*0.5*(1+sin(Y*2*PI/{period:.4})))':\
cb='cb(X\\,Y)':cr='cr(X\\,Y)'"
    );

    let shift = p.ghost_shift_px.round().clamp(0.0, 32.0) as i32;
    let chroma = p.chroma_shift_px.round().clamp(0.0, 16.0) as i32;

    let ghost_chain = if shift > 0 && p.ghost_opacity > 0.001 {
        format!(
            "[{bloomed}]split[{base}g][{ghost_src}];\
[{ghost_src}]gblur=sigma={ghost_blur:.4},\
crop=iw-{shift}:ih:0:0,\
pad=iw+{shift}:ih:{shift}:0[{ghost}];\
[{base}g][{ghost}]blend=all_mode=screen:all_opacity={ghost_opacity:.4}[{ghosted}];",
            ghost_blur = p.ghost_blur.max(0.01),
            ghost_opacity = p.ghost_opacity,
        )
    } else {
        format!("[{bloomed}]null[{ghosted}];")
    };

    let chroma_chain = if chroma > 0 {
        format!(
            "[{ghosted}]format=rgba,rgbashift=rh={chroma}:bh=-{chroma},\
format=yuv420p,"
        )
    } else {
        format!("[{ghosted}]")
    };

    format!(
        "[{input}]split[{base}][{glow_src}];\
[{glow_src}]gblur=sigma={glow_sigma:.4}[{glow}];\
[{base}][{glow}]blend=all_mode=screen:all_opacity={glow_opacity:.4}[{bloomed}];\
{ghost_chain}\
{chroma_chain}eq=contrast={contrast:.4}:saturation={saturation:.4}:brightness={brightness:.4},\
noise=alls={noise:.2}:allf=t+u,\
vignette=angle={vignette:.6},\
{geq},\
format=yuv420p[{output}]",
        glow_sigma = p.glow_sigma,
        glow_opacity = p.glow_opacity,
        contrast = p.contrast,
        saturation = p.saturation,
        brightness = p.brightness,
        noise = p.noise_strength,
        vignette = p.vignette_angle,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_looks_returns_none() {
        assert!(build_look_video_filter(&RenderLooks::default(), "0:v", "vout").is_none());
    }

    #[test]
    fn tv_look_builds_identity_eq_and_scanlines() {
        let looks = RenderLooks {
            tv: Some(RenderLookState {
                enabled: true,
                params: None,
            }),
            ..Default::default()
        };
        let graph = build_look_video_filter(&looks, "0:v", "vout").expect("graph");
        assert!(graph.contains("[0:v]split"));
        assert!(graph.contains("gblur="));
        assert!(graph.contains("noise="));
        assert!(graph.contains("vignette="));
        assert!(graph.contains("geq="));
        assert!(graph.contains("sin(Y*2*PI/"));
        assert!(graph.contains("eq=contrast=1.0000:saturation=1.0000:brightness=0.0000"));
        assert!(!graph.contains("rgbashift="));
        assert!(graph.contains("[vout]"));
    }

    #[test]
    fn afterglow_has_no_ffmpeg_graph() {
        let looks = RenderLooks {
            afterglow: Some(RenderLookState {
                enabled: true,
                params: None,
            }),
            ..Default::default()
        };
        assert!(build_look_video_filter(&looks, "0:v", "vout").is_none());
        assert_eq!(looks.crt_preset(), Some(CrtPreset::Afterglow));
    }

    #[test]
    fn broadcast_has_no_ffmpeg_graph() {
        let looks = RenderLooks {
            broadcast: Some(RenderLookState {
                enabled: true,
                params: None,
            }),
            ..Default::default()
        };
        assert!(build_look_video_filter(&looks, "0:v", "vout").is_none());
        assert_eq!(looks.crt_preset(), Some(CrtPreset::Broadcast));
    }
}
