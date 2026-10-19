//! Stub native capture when not on Windows.

use serde::Serialize;
use std::path::PathBuf;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureTarget {
  pub id: String,
  pub kind: String,
  pub title: String,
  pub process_name: String,
  pub width: u32,
  pub height: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorSampleDto {
  pub t: f64,
  pub x: f64,
  pub y: f64,
  pub down: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypingBurstDto {
  pub t: f64,
  pub duration: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStopResult {
  pub path: String,
  pub media_url: String,
  pub width: u32,
  pub height: u32,
  pub duration_ms: u64,
  pub source_label: String,
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub cursor: Vec<CursorSampleDto>,
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub typing: Vec<TypingBurstDto>,
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub caret: Vec<CaretSampleDto>,
  #[serde(default)]
  pub agent_driven: bool,
  #[serde(default)]
  pub finalizing: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaretSampleDto {
  pub t: f64,
  pub x: f64,
  pub y: f64,
}

pub fn mark_agent_driven() {}

pub fn push_typing_tick() {}

pub fn push_caret_sample(_x: f64, _y: f64) {}

pub fn set_finalize_hook(_hook: Box<dyn Fn(&CaptureStopResult, bool) + Send + Sync>) {}

pub fn is_finalizing() -> bool {
  false
}

pub fn stop_capture_ex(_auto_import: bool) -> Result<CaptureStopResult, String> {
  stop_capture()
}

pub fn media_url_for(path: &str) -> String {
  format!("http://127.0.0.1:17355/capture/file?path={path}")
}

pub fn last_capture_path() -> Option<String> {
  None
}

pub fn last_capture_meta() -> Option<CaptureStopResult> {
  None
}

pub fn store_last_capture(_result: CaptureStopResult) {}

pub fn active_hwnd() -> Option<isize> {
  None
}

pub fn resolve_capture_file(_path: &str) -> Result<PathBuf, String> {
  Err("Native capture is only available on Windows desktop".into())
}

pub fn list_targets() -> Result<Vec<CaptureTarget>, String> {
  Err("Native capture is only available on Windows desktop".into())
}

pub fn is_recording() -> bool {
  false
}

pub fn begin_cursor_log() {}

pub fn push_cursor_sample(_x: f64, _y: f64, _down: bool) {}

pub fn start_capture(
  _window_id: Option<String>,
  _title_contains: Option<String>,
) -> Result<serde_json::Value, String> {
  Err("Native capture is only available on Windows desktop".into())
}

pub fn recover_newest_capture() -> Option<CaptureStopResult> {
  None
}

pub fn stop_capture() -> Result<CaptureStopResult, String> {
  Err("Native capture is only available on Windows desktop".into())
}

pub fn open_url(url: &str) -> Result<(), String> {
  open::that(url).map_err(|e| e.to_string())
}

pub fn open_path(_path: &str) -> Result<(), String> {
  Err("Opening local paths via the bridge is Windows-desktop only".into())
}
