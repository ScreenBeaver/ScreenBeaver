//! Stub when not on Windows.

use serde_json::Value;

pub fn cursor_pos() -> (i32, i32) {
  (0, 0)
}

pub fn smooth_move_norm(_nx: f64, _ny: f64, _duration_ms: u64) -> Result<(), String> {
  Err("Input automation is Windows-only".into())
}

pub fn click_left() -> Result<(), String> {
  Err("Input automation is Windows-only".into())
}

pub fn click_right() -> Result<(), String> {
  Err("Input automation is Windows-only".into())
}

pub fn scroll(_delta: i32) -> Result<(), String> {
  Err("Input automation is Windows-only".into())
}

pub fn focus_hwnd(_hwnd: isize) -> Result<(), String> {
  Err("Input automation is Windows-only".into())
}

pub fn type_text(_text: &str, _delay_ms: u64, _on_key: &mut dyn FnMut()) -> Result<(), String> {
  Err("Input automation is Windows-only".into())
}

pub fn move_in_window(
  _hwnd: isize,
  _nx: f64,
  _ny: f64,
  _duration_ms: u64,
  _click: bool,
) -> Result<(), String> {
  Err("Input automation is Windows-only".into())
}

pub fn move_in_window_mapped(
  _hwnd: isize,
  _nx: f64,
  _ny: f64,
  _duration_ms: u64,
  _click: bool,
  _content_space: bool,
) -> Result<(), String> {
  Err("Input automation is Windows-only".into())
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct WindowLayout {
  pub hwnd: isize,
  pub screen: ScreenSize,
  pub window: RectPx,
  pub client: RectPx,
  pub content: RectPx,
  pub chrome_top_px: i32,
  pub notes: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ScreenSize {
  pub width: i32,
  pub height: i32,
  pub origin_x: i32,
  pub origin_y: i32,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct RectPx {
  pub left: i32,
  pub top: i32,
  pub width: i32,
  pub height: i32,
}

pub fn content_to_window_norm(_layout: &WindowLayout, cnx: f64, cny: f64) -> (f64, f64) {
  (cnx, cny)
}

pub fn window_layout(_hwnd: isize) -> Result<WindowLayout, String> {
  Err("Input automation is Windows-only".into())
}

pub fn capture_window_png_base64(_hwnd: isize, _max_edge: u32) -> Result<String, String> {
  Err("Window screenshot is Windows-only".into())
}

pub fn run_script<F>(
  _steps: &[Value],
  _default_hwnd: Option<isize>,
  _on_type_key: F,
) -> Result<usize, String>
where
  F: FnMut(),
{
  Err("Input automation is Windows-only".into())
}
