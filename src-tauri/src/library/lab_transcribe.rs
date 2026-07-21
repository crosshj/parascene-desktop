//! Local Whisper CLI transcription for Lab lyric align.

use super::lab_deps::resolve_whisper;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
    text: String,
    start_sec: f64,
    end_sec: f64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptWord {
    word: String,
    start_sec: f64,
    end_sec: f64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTranscriptResult {
    segments: Vec<TranscriptSegment>,
    words: Vec<TranscriptWord>,
    full_text: String,
    language: Option<String>,
}

#[tauri::command]
pub fn library_transcribe_local(audio_path: String) -> Result<LocalTranscriptResult, String> {
    let whisper = resolve_whisper().ok_or_else(|| {
        "Whisper CLI not found. Install with: python3 -m pip install --user openai-whisper"
            .to_string()
    })?;
    let audio = PathBuf::from(audio_path.trim());
    if !audio.is_file() {
        return Err("Audio file not found for transcription.".into());
    }

    let out_dir = audio
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let stem = audio
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("audio");
    let json_path = out_dir.join(format!("{stem}.json"));

    let _ = fs::remove_file(&json_path);

    let output = Command::new(&whisper)
        .arg(audio.as_os_str())
        .args([
            "--model",
            "base",
            "--output_format",
            "json",
            "--word_timestamps",
            "True",
            "--no_speech_threshold",
            "0.6",
            "--compression_ratio_threshold",
            "2.4",
            "--logprob_threshold",
            "-1.0",
            "--output_dir",
        ])
        .arg(&out_dir)
        .args(["--fp16", "False", "--verbose", "False"])
        .output()
        .map_err(|e| format!("Could not run whisper: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "whisper failed (exit {}): {}",
            output.status,
            stderr.chars().take(400).collect::<String>()
        ));
    }

    if !json_path.is_file() {
        return Err("Whisper did not produce a JSON transcript.".into());
    }

    let raw = fs::read_to_string(&json_path).map_err(|e| format!("Could not read whisper JSON: {e}"))?;
    parse_whisper_json(&raw)
}

fn parse_word(seg: &serde_json::Value) -> Option<TranscriptWord> {
    let word = seg.get("word")?.as_str()?.trim();
    if word.is_empty() {
        return None;
    }
    let start = seg.get("start")?.as_f64()?;
    let end = seg.get("end")?.as_f64()?;
    if end <= start {
        return None;
    }
    Some(TranscriptWord {
        word: word.to_string(),
        start_sec: start,
        end_sec: end,
    })
}

fn parse_whisper_json(raw: &str) -> Result<LocalTranscriptResult, String> {
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("Invalid whisper JSON: {e}"))?;
    let full_text = value
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let language = value
        .get("language")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let mut words: Vec<TranscriptWord> = Vec::new();
    let segments = value
        .get("segments")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|seg| {
                    if let Some(word_arr) = seg.get("words").and_then(|v| v.as_array()) {
                        for w in word_arr {
                            if let Some(parsed) = parse_word(w) {
                                words.push(parsed);
                            }
                        }
                    }
                    let text = seg.get("text")?.as_str()?.trim();
                    if text.is_empty() {
                        return None;
                    }
                    let start = seg.get("start")?.as_f64()?;
                    let end = seg.get("end")?.as_f64()?;
                    if end <= start {
                        return None;
                    }
                    Some(TranscriptSegment {
                        text: text.to_string(),
                        start_sec: start,
                        end_sec: end,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(LocalTranscriptResult {
        segments,
        words,
        full_text,
        language,
    })
}
