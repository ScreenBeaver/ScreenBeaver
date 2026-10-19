use device_query::{DeviceQuery, DeviceState, Keycode};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

mod edge_tts;
mod screen_ocr;
mod win_path;

#[cfg(desktop)]
#[path = "agent_cli.rs"]
mod agent_cli;

#[cfg(not(desktop))]
#[path = "agent_cli_stub.rs"]
mod agent_cli;

#[cfg(desktop)]
#[path = "remote_mcp.rs"]
mod remote_mcp;

#[cfg(not(desktop))]
#[path = "remote_mcp_stub.rs"]
mod remote_mcp;

#[cfg(windows)]
#[path = "native_capture.rs"]
mod native_capture;

#[cfg(not(windows))]
#[path = "native_capture_stub.rs"]
mod native_capture;

#[cfg(windows)]
#[path = "android_capture.rs"]
mod android_capture;

#[cfg(not(windows))]
#[path = "android_capture_stub.rs"]
mod android_capture;

#[cfg(windows)]
#[path = "input_automation.rs"]
mod input_automation;

#[cfg(not(windows))]
#[path = "input_automation_stub.rs"]
mod input_automation;

#[cfg(windows)]
mod cursor_cloak;

const EXT_PORT: u16 = 17355;

/// Synced from the signed-in account (`plan.features.mcp`). Fail closed until UI sets it.
// Open-source desktop: MCP bridge is entitled by default (UI can still sync).
static MCP_ENTITLED: AtomicBool = AtomicBool::new(true);

const MCP_UPGRADE_ERROR: &str = "MCP requires Pro or Team. Upgrade at screenbeaver.com.";

fn mcp_entitled() -> bool {
  MCP_ENTITLED.load(Ordering::Relaxed)
}

#[tauri::command]
fn set_mcp_entitled(entitled: bool) {
  MCP_ENTITLED.store(entitled, Ordering::Relaxed);
}

#[tauri::command]
fn remote_mcp_status(app: AppHandle) -> remote_mcp::RemoteMcpStatus {
  remote_mcp::status(&app)
}

#[tauri::command]
fn remote_mcp_sync(app: AppHandle, enabled: bool) -> Result<remote_mcp::RemoteMcpStatus, String> {
  remote_mcp::sync(&app, enabled)
}

#[tauri::command]
fn remote_mcp_regenerate_token(app: AppHandle) -> Result<remote_mcp::RemoteMcpStatus, String> {
  remote_mcp::regenerate_token(&app)
}

#[tauri::command]
fn remote_mcp_refresh_tunnel(app: AppHandle) -> Result<remote_mcp::RemoteMcpStatus, String> {
  remote_mcp::refresh_tunnel(&app)
}

fn respond_mcp_upgrade(request: tiny_http::Request) {
  let body = serde_json::json!({
    "ok": false,
    "error": MCP_UPGRADE_ERROR,
    "code": "upgrade_required",
  })
  .to_string()
  .into_bytes();
  let response = cors_ok(
    tiny_http::Response::from_data(body)
      .with_status_code(403)
      .with_header(
        tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap(),
      ),
  );
  let _ = request.respond(response);
}

/// Routes that need Pro/Team MCP. Extension `/event` and health probes stay open.
fn bridge_route_requires_mcp(method: &str, url: &str) -> bool {
  let path = url.split('?').next().unwrap_or(url);
  if method == "OPTIONS" {
    return false;
  }
  if method == "GET" && (path == "/" || path == "/health" || path == "/agent") {
    return false;
  }
  // Browser companion markers while recording — not MCP automation.
  if method == "POST" && path.starts_with("/event") {
    return false;
  }
  // Parsed inline so status/notify can stay free (same as AgentHost).
  if method == "POST" && path.starts_with("/agent/command") {
    return false;
  }
  path.starts_with("/capture")
    || path.starts_with("/input")
    || path.starts_with("/android")
    || path.starts_with("/voices")
    || path.starts_with("/tts")
    || path.starts_with("/agent")
    || path.starts_with("/ocr")
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CursorIconPayload {
  w: u32,
  h: u32,
  hx: i32,
  hy: i32,
  rgba: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CursorPayload {
  x: f64,
  y: f64,
  down: bool,
  /// Right mouse button held.
  right: bool,
  shift: bool,
  ctrl: bool,
  alt: bool,
  shape: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  icon_id: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  icon: Option<CursorIconPayload>,
  source: &'static str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MarkerPayload {
  kind: &'static str,
  x: f64,
  y: f64,
  #[serde(skip_serializing_if = "Option::is_none")]
  duration: Option<f64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  preset: Option<&'static str>,
  source: &'static str,
}

struct HookState {
  running: Arc<AtomicBool>,
}

impl Default for HookState {
  fn default() -> Self {
    Self {
      running: Arc::new(AtomicBool::new(false)),
    }
  }
}

#[cfg(windows)]
fn virtual_screen() -> (i32, i32, i32, i32) {
  use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
  };
  unsafe {
    (
      GetSystemMetrics(SM_XVIRTUALSCREEN),
      GetSystemMetrics(SM_YVIRTUALSCREEN),
      GetSystemMetrics(SM_CXVIRTUALSCREEN).max(1),
      GetSystemMetrics(SM_CYVIRTUALSCREEN).max(1),
    )
  }
}

#[cfg(not(windows))]
fn virtual_screen() -> (i32, i32, i32, i32) {
  (0, 0, 1920, 1080)
}

fn normalize(px: i32, py: i32) -> (f64, f64) {
  let (ox, oy, w, h) = virtual_screen();
  let x = ((px - ox) as f64 / w as f64).clamp(0.0, 1.0);
  let y = ((py - oy) as f64 / h as f64).clamp(0.0, 1.0);
  (x, y)
}

/// Screen position of the focused text caret (Win32 caret, then MSAA OBJID_CARET for Chromium).
#[cfg(windows)]
fn read_caret_screen() -> Option<(i32, i32)> {
  use windows::core::{Interface, VARIANT};
  use windows::Win32::Foundation::{HWND, POINT};
  use windows::Win32::Graphics::Gdi::ClientToScreen;
  use windows::Win32::UI::Accessibility::{AccessibleObjectFromWindow, IAccessible};
  use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetGUIThreadInfo, GetWindowThreadProcessId, GUITHREADINFO, OBJID_CARET,
  };
  thread_local! {
    static COM_READY: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
  }
  COM_READY.with(|ready| {
    if !ready.get() {
      unsafe {
        let _ = windows::Win32::System::Com::CoInitializeEx(
          None,
          windows::Win32::System::Com::COINIT_MULTITHREADED,
        );
      }
      ready.set(true);
    }
  });
  unsafe {
    let fg = GetForegroundWindow();
    if fg.0.is_null() {
      return None;
    }
    let tid = GetWindowThreadProcessId(fg, None);
    let mut gti = GUITHREADINFO {
      cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
      ..Default::default()
    };
    let have_gti = GetGUIThreadInfo(tid, &mut gti).is_ok();
    if have_gti && !gti.hwndCaret.0.is_null() {
      let r = gti.rcCaret;
      if r.bottom > r.top {
        let mut pt = POINT {
          x: r.left,
          y: (r.top + r.bottom) / 2,
        };
        if ClientToScreen(gti.hwndCaret, &mut pt).as_bool() {
          return Some((pt.x, pt.y));
        }
      }
    }
    let target: HWND = if have_gti && !gti.hwndFocus.0.is_null() {
      gti.hwndFocus
    } else {
      fg
    };
    let mut raw: *mut std::ffi::c_void = std::ptr::null_mut();
    if AccessibleObjectFromWindow(target, OBJID_CARET.0 as u32, &IAccessible::IID, &mut raw).is_err()
      || raw.is_null()
    {
      return None;
    }
    let acc = IAccessible::from_raw(raw);
    let (mut l, mut t, mut w, mut h) = (0i32, 0i32, 0i32, 0i32);
    let child = VARIANT::from(0i32);
    if acc.accLocation(&mut l, &mut t, &mut w, &mut h, &child).is_err() {
      return None;
    }
    if h <= 0 || (l == 0 && t == 0) {
      return None;
    }
    Some((l, t + h / 2))
  }
}

#[cfg(not(windows))]
fn read_caret_screen() -> Option<(i32, i32)> {
  None
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaretPayload {
  x: f64,
  y: f64,
  source: &'static str,
}

fn emit_caret(app: &AppHandle, pos: (i32, i32)) {
  let (x, y) = normalize(pos.0, pos.1);
  native_capture::push_caret_sample(x, y);
  let _ = app.emit(
    "native-caret",
    CaretPayload {
      x,
      y,
      source: "desktop",
    },
  );
}

fn emit_cursor(app: &AppHandle, payload: CursorPayload) {
  // Persist for Auto zooms even if the UI misses stop/import (sidecar on the MP4).
  native_capture::push_cursor_sample(payload.x, payload.y, payload.down);
  let _ = app.emit("native-cursor", payload);
}

fn emit_marker(app: &AppHandle, payload: MarkerPayload) {
  let _ = app.emit("native-marker", payload);
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SoundPayload {
  kind: &'static str,
  source: &'static str,
}

fn emit_sound(app: &AppHandle, payload: SoundPayload) {
  if payload.kind == "typing" {
    native_capture::push_typing_tick();
  }
  let _ = app.emit("native-sound", payload);
}

/// Last key the agent typed — the pointer hook samples the caret after it, exactly
/// like a human keystroke (injected keys are too short for the 8 ms key poll).
static AGENT_KEY_AT: Mutex<Option<std::time::Instant>> = Mutex::new(None);

fn agent_key_tick(app: &AppHandle) {
  native_capture::mark_agent_driven();
  *AGENT_KEY_AT.lock() = Some(std::time::Instant::now());
  emit_sound(
    app,
    SoundPayload {
      kind: "typing",
      source: "desktop",
    },
  );
}

/// Record the pointer at an agent click edge so down/up never fall between polls.
fn agent_pointer_sample(down: bool) {
  native_capture::mark_agent_driven();
  let (px, py) = input_automation::cursor_pos();
  let (x, y) = normalize(px, py);
  native_capture::push_cursor_sample(x, y, down);
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct KeystrokePayload {
  label: String,
  keys: Vec<String>,
  source: &'static str,
}

fn emit_keystroke(app: &AppHandle, payload: KeystrokePayload) {
  let _ = app.emit("native-keystroke", payload);
}

fn keycode_label(k: &Keycode) -> Option<&'static str> {
  Some(match k {
    Keycode::A => "A",
    Keycode::B => "B",
    Keycode::C => "C",
    Keycode::D => "D",
    Keycode::E => "E",
    Keycode::F => "F",
    Keycode::G => "G",
    Keycode::H => "H",
    Keycode::I => "I",
    Keycode::J => "J",
    Keycode::K => "K",
    Keycode::L => "L",
    Keycode::M => "M",
    Keycode::N => "N",
    Keycode::O => "O",
    Keycode::P => "P",
    Keycode::Q => "Q",
    Keycode::R => "R",
    Keycode::S => "S",
    Keycode::T => "T",
    Keycode::U => "U",
    Keycode::V => "V",
    Keycode::W => "W",
    Keycode::X => "X",
    Keycode::Y => "Y",
    Keycode::Z => "Z",
    Keycode::Key0 => "0",
    Keycode::Key1 => "1",
    Keycode::Key2 => "2",
    Keycode::Key3 => "3",
    Keycode::Key4 => "4",
    Keycode::Key5 => "5",
    Keycode::Key6 => "6",
    Keycode::Key7 => "7",
    Keycode::Key8 => "8",
    Keycode::Key9 => "9",
    Keycode::F1 => "F1",
    Keycode::F2 => "F2",
    Keycode::F3 => "F3",
    Keycode::F4 => "F4",
    Keycode::F5 => "F5",
    Keycode::F6 => "F6",
    Keycode::F7 => "F7",
    Keycode::F8 => "F8",
    Keycode::F9 => "F9",
    Keycode::F10 => "F10",
    Keycode::F11 => "F11",
    Keycode::F12 => "F12",
    Keycode::Escape => "Esc",
    Keycode::Enter => "Enter",
    Keycode::Tab => "Tab",
    Keycode::Space => "Space",
    Keycode::Backspace => "⌫",
    Keycode::Delete => "Del",
    Keycode::Up => "↑",
    Keycode::Down => "↓",
    Keycode::Left => "←",
    Keycode::Right => "→",
    Keycode::Home => "Home",
    Keycode::End => "End",
    Keycode::PageUp => "PgUp",
    Keycode::PageDown => "PgDn",
    _ => return None,
  })
}

fn is_modifier_keycode(k: &Keycode) -> bool {
  matches!(
    k,
    Keycode::LShift
      | Keycode::RShift
      | Keycode::LControl
      | Keycode::RControl
      | Keycode::LAlt
      | Keycode::RAlt
      | Keycode::LMeta
      | Keycode::RMeta
      | Keycode::Command
  )
}

fn is_function_or_escape(k: &Keycode) -> bool {
  matches!(
    k,
    Keycode::F1
      | Keycode::F2
      | Keycode::F3
      | Keycode::F4
      | Keycode::F5
      | Keycode::F6
      | Keycode::F7
      | Keycode::F8
      | Keycode::F9
      | Keycode::F10
      | Keycode::F11
      | Keycode::F12
      | Keycode::Escape
  )
}

/// Build a shortcut label for a newly pressed non-modifier key, if it qualifies.
fn shortcut_from_press(
  keys: &[Keycode],
  pressed: &Keycode,
) -> Option<(String, Vec<String>)> {
  if is_modifier_keycode(pressed) {
    return None;
  }
  let main = keycode_label(pressed)?;
  let ctrl = keys.contains(&Keycode::LControl) || keys.contains(&Keycode::RControl);
  let alt = keys.contains(&Keycode::LAlt) || keys.contains(&Keycode::RAlt);
  let shift = keys.contains(&Keycode::LShift) || keys.contains(&Keycode::RShift);
  let meta = keys.contains(&Keycode::LMeta)
    || keys.contains(&Keycode::RMeta)
    || keys.contains(&Keycode::Command);

  let show = is_function_or_escape(pressed)
    || ctrl
    || alt
    || meta
    || (shift && matches!(pressed, Keycode::Space));
  if !show {
    return None;
  }

  let mut parts = Vec::new();
  if ctrl {
    parts.push("Ctrl".into());
  }
  if meta {
    parts.push("⌘".into());
  }
  if alt {
    parts.push("Alt".into());
  }
  if shift {
    parts.push("Shift".into());
  }
  parts.push(main.into());
  let label = parts.join(" + ");
  Some((label, parts))
}

/// MCP / agent command bus — HTTP posts a command, the UI reports the JSON result.
struct AgentBus {
  results: Mutex<HashMap<String, String>>,
}

fn agent_bus() -> &'static AgentBus {
  static BUS: OnceLock<AgentBus> = OnceLock::new();
  BUS.get_or_init(|| AgentBus {
    results: Mutex::new(HashMap::new()),
  })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentCommandPayload {
  id: String,
  action: String,
  payload: serde_json::Value,
}

fn emit_agent_command(app: &AppHandle, payload: AgentCommandPayload) {
  let _ = app.emit("agent-command", payload);
}

#[tauri::command]
fn agent_report_result(id: String, body: String) {
  agent_bus().results.lock().insert(id, body);
}

#[tauri::command]
fn agent_cli_capabilities() -> agent_cli::AgentCliCapabilities {
  agent_cli::detect_capabilities()
}

#[tauri::command]
fn agent_cli_status() -> agent_cli::AgentCliStatus {
  agent_cli::current_status()
}

#[tauri::command]
fn agent_cli_start(
  app: AppHandle,
  provider_id: String,
  url: String,
  product_name: Option<String>,
  cwd: Option<String>,
) -> Result<agent_cli::AgentCliStatus, String> {
  agent_cli::start_session(app, provider_id, url, product_name, cwd)
}

#[tauri::command]
fn agent_cli_stop() -> Result<agent_cli::AgentCliStatus, String> {
  agent_cli::stop_session()
}

fn wait_agent_result(id: &str, timeout: Duration) -> Option<String> {
  let start = Instant::now();
  while start.elapsed() < timeout {
    if let Some(body) = agent_bus().results.lock().remove(id) {
      return Some(body);
    }
    thread::sleep(Duration::from_millis(40));
  }
  None
}

fn is_typing_keycode(k: &Keycode) -> bool {
  matches!(
    k,
    Keycode::A
      | Keycode::B
      | Keycode::C
      | Keycode::D
      | Keycode::E
      | Keycode::F
      | Keycode::G
      | Keycode::H
      | Keycode::I
      | Keycode::J
      | Keycode::K
      | Keycode::L
      | Keycode::M
      | Keycode::N
      | Keycode::O
      | Keycode::P
      | Keycode::Q
      | Keycode::R
      | Keycode::S
      | Keycode::T
      | Keycode::U
      | Keycode::V
      | Keycode::W
      | Keycode::X
      | Keycode::Y
      | Keycode::Z
      | Keycode::Key0
      | Keycode::Key1
      | Keycode::Key2
      | Keycode::Key3
      | Keycode::Key4
      | Keycode::Key5
      | Keycode::Key6
      | Keycode::Key7
      | Keycode::Key8
      | Keycode::Key9
      | Keycode::Space
      | Keycode::Enter
      | Keycode::Backspace
      | Keycode::Tab
  )
}

/// Classify / capture the current OS cursor (Windows).
#[cfg(windows)]
fn read_cursor_shape(last_handle: &mut isize, sent_icons: &mut std::collections::HashSet<String>) -> (String, Option<String>, Option<CursorIconPayload>) {
  use windows::core::PCWSTR;
  use windows::Win32::Foundation::POINT;
  use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, SelectObject, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
  };
  use windows::Win32::UI::WindowsAndMessaging::{
    DrawIconEx, GetCursorInfo, GetIconInfo, LoadCursorW, CURSORINFO, CURSOR_SHOWING, DI_NORMAL,
    ICONINFO, IDC_APPSTARTING, IDC_ARROW, IDC_CROSS, IDC_HAND, IDC_IBEAM, IDC_NO, IDC_SIZEALL,
    IDC_SIZENESW, IDC_SIZENS, IDC_SIZENWSE, IDC_SIZEWE, IDC_WAIT,
  };

  unsafe {
    let mut info = CURSORINFO {
      cbSize: std::mem::size_of::<CURSORINFO>() as u32,
      flags: Default::default(),
      hCursor: Default::default(),
      ptScreenPos: POINT::default(),
    };
    if GetCursorInfo(&mut info).is_err() || (info.flags.0 & CURSOR_SHOWING.0) == 0 {
      // Games / apps that hide the OS pointer and draw their own — don't overlay ours.
      *last_handle = 0;
      return ("hidden".into(), None, None);
    }
    let h = info.hCursor;
    let handle = h.0 as isize;

    // While cloaked, standard slots are blanks — map those handles back to names.
    if let Some(name) = cursor_cloak::cloaked_shape(handle) {
      *last_handle = handle;
      return (name.into(), None, None);
    }

    let standards: &[(&str, PCWSTR)] = &[
      ("arrow", IDC_ARROW),
      ("ibeam", IDC_IBEAM),
      ("cross", IDC_CROSS),
      ("hand", IDC_HAND),
      ("wait", IDC_WAIT),
      ("wait", IDC_APPSTARTING),
      ("move", IDC_SIZEALL),
      ("resize-ns", IDC_SIZENS),
      ("resize-ew", IDC_SIZEWE),
      ("resize-nesw", IDC_SIZENESW),
      ("resize-nwse", IDC_SIZENWSE),
      ("not-allowed", IDC_NO),
    ];
    for (name, id) in standards {
      if let Ok(std_cur) = LoadCursorW(None, *id) {
        if std_cur.0 == h.0 {
          *last_handle = handle;
          return ((*name).into(), None, None);
        }
      }
    }

    // Custom cursor (Excel plus, etc.) — capture bitmap when handle changes
    let icon_id = format!("{:x}", handle as usize);
    let mut icon_payload = None;
    if handle != *last_handle || !sent_icons.contains(&icon_id) {
      *last_handle = handle;
      let mut ii = ICONINFO::default();
      if GetIconInfo(h, &mut ii).is_ok() {
        let w = 128u32;
        let hgt = 128u32;
        let bmi = BITMAPINFO {
          bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w as i32,
            biHeight: -(hgt as i32),
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0 as u32,
            ..Default::default()
          },
          ..Default::default()
        };
        let hdc = CreateCompatibleDC(None);
        if !hdc.is_invalid() {
          let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
          if let Ok(dib) = CreateDIBSection(hdc, &bmi, DIB_RGB_COLORS, &mut bits, None, 0) {
            if !bits.is_null() {
              let old = SelectObject(hdc, HGDIOBJ(dib.0));
              // Draw large — Windows scales the glyph; we store 128² so export stays sharp.
              let _ = DrawIconEx(hdc, 0, 0, h, w as i32, hgt as i32, 0, None, DI_NORMAL);
              let len = (w * hgt * 4) as usize;
              let slice = std::slice::from_raw_parts(bits as *const u8, len);
              // BGRA → RGBA
              let mut rgba = Vec::with_capacity(len);
              for px in slice.chunks_exact(4) {
                rgba.push(px[2]);
                rgba.push(px[1]);
                rgba.push(px[0]);
                rgba.push(px[3]);
              }
              // Hotspot scales with the draw size (icons are typically authored at 32×32).
              let hx = ((ii.xHotspot as f32) * (w as f32 / 32.0)).round() as i32;
              let hy = ((ii.yHotspot as f32) * (hgt as f32 / 32.0)).round() as i32;
              let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &rgba);
              icon_payload = Some(CursorIconPayload {
                w,
                h: hgt,
                hx,
                hy,
                rgba: encoded,
              });
              sent_icons.insert(icon_id.clone());
              SelectObject(hdc, old);
              let _ = DeleteObject(dib);
            }
          }
          let _ = DeleteDC(hdc);
        }
        if !ii.hbmColor.is_invalid() {
          let _ = DeleteObject(ii.hbmColor);
        }
        if !ii.hbmMask.is_invalid() {
          let _ = DeleteObject(ii.hbmMask);
        }
      }
    } else {
      *last_handle = handle;
    }

    ("custom".into(), Some(icon_id), icon_payload)
  }
}

#[cfg(not(windows))]
fn read_cursor_shape(
  _last_handle: &mut isize,
  _sent_icons: &mut std::collections::HashSet<String>,
) -> (String, Option<String>, Option<CursorIconPayload>) {
  ("arrow".into(), None, None)
}

#[tauri::command]
fn is_desktop() -> bool {
  true
}

#[tauri::command]
fn extension_bridge_port() -> u16 {
  EXT_PORT
}

#[tauri::command]
fn edge_tts_list_voices() -> Result<Vec<edge_tts::EdgeVoiceDto>, String> {
  edge_tts::list_edge_voices()
}

#[tauri::command]
fn edge_tts_synthesize(text: String, voice: String) -> Result<edge_tts::EdgeTtsResult, String> {
  edge_tts::synthesize_edge_tts(&text, &voice)
}

#[tauri::command]
fn start_pointer_hook(app: AppHandle, state: State<'_, HookState>) -> Result<(), String> {
  if state.running.swap(true, Ordering::SeqCst) {
    return Ok(());
  }

  let running = Arc::clone(&state.running);
  let last_space = Arc::new(Mutex::new(false));
  let app_thread = app.clone();

  thread::spawn(move || {
    // Chromium ignores cursor:"never" — blank the OS pointer for the take and
    // show an exclude-from-capture overlay so the user can still aim.
    // Skip while USB Android mirror is active (user needs a real cursor on scrcpy).
    #[cfg(windows)]
    if !android_capture::session_active() {
      cursor_cloak::start();
    }

    let device = DeviceState::new();
    let mut last_typing_at: Option<std::time::Instant> = None;
    let mut last_caret_query = std::time::Instant::now();
    let mut last_caret: Option<(i32, i32)> = None;
    let mut prev_left = false;
    let mut prev_keys: std::collections::HashSet<Keycode> = std::collections::HashSet::new();
    let mut last_handle: isize = 0;
    let mut sent_icons = std::collections::HashSet::new();
    while running.load(Ordering::SeqCst) {
      let mouse = device.get_mouse();
      let keys = device.get_keys();
      let shift = keys.contains(&Keycode::LShift) || keys.contains(&Keycode::RShift);
      let ctrl = keys.contains(&Keycode::LControl) || keys.contains(&Keycode::RControl);
      let alt = keys.contains(&Keycode::LAlt) || keys.contains(&Keycode::RAlt);
      let space = keys.contains(&Keycode::Space);
      let left = mouse.button_pressed.get(1).copied().unwrap_or(false);
      let right = mouse.button_pressed.get(2).copied().unwrap_or(false);
      let (x, y) = normalize(mouse.coords.0, mouse.coords.1);
      // Classify the live OS cursor (blank-map while cloaked, bitmaps for custom).
      let (shape, icon_id, icon) = read_cursor_shape(&mut last_handle, &mut sent_icons);

      emit_cursor(
        &app_thread,
        CursorPayload {
          x,
          y,
          down: left,
          right,
          shift,
          ctrl,
          alt,
          shape,
          icon_id,
          icon,
          source: "desktop",
        },
      );

      if left && !prev_left && (shift || ctrl) {
        emit_marker(
          &app_thread,
          MarkerPayload {
            kind: "zoom",
            x,
            y,
            duration: None,
            preset: None,
            source: "desktop",
          },
        );
      }

      {
        let mut prev_space = last_space.lock();
        if space && !*prev_space && shift {
          emit_marker(
            &app_thread,
            MarkerPayload {
              kind: "camera-move",
              x,
              y,
              duration: None,
              preset: None,
              source: "desktop",
            },
          );
        }
        *prev_space = space;
      }

      // Ctrl+1…6 cinematic scene effects
      if ctrl && !alt {
        let digit_preset: Option<&'static str> = if keys.contains(&Keycode::Key1)
          && !prev_keys.contains(&Keycode::Key1)
        {
          Some("hero-zoom")
        } else if keys.contains(&Keycode::Key2) && !prev_keys.contains(&Keycode::Key2) {
          Some("tilt-3d")
        } else if keys.contains(&Keycode::Key3) && !prev_keys.contains(&Keycode::Key3) {
          Some("focus-zoom")
        } else if keys.contains(&Keycode::Key4) && !prev_keys.contains(&Keycode::Key4) {
          Some("spin-3d")
        } else if keys.contains(&Keycode::Key5) && !prev_keys.contains(&Keycode::Key5) {
          Some("glare")
        } else if keys.contains(&Keycode::Key6) && !prev_keys.contains(&Keycode::Key6) {
          Some("mockup-tilt")
        } else if keys.contains(&Keycode::Key7) && !prev_keys.contains(&Keycode::Key7) {
          // Ctrl+7 = normal glare only (window-reveal is auto intro, not a hotkey)
          Some("glare")
        } else {
          None
        };
        if let Some(preset) = digit_preset {
          emit_marker(
            &app_thread,
            MarkerPayload {
              kind: "scene-effect",
              x,
              y,
              duration: None,
              preset: Some(preset),
              source: "desktop",
            },
          );
        }
      }

      // Typing keys (skip Shift+Space camera chord)
      let key_set: std::collections::HashSet<Keycode> = keys.iter().copied().collect();
      if !(shift && space) && !ctrl && !alt {
        for k in key_set.iter() {
          if is_typing_keycode(k) && !prev_keys.contains(k) {
            // Space alone counts as typing; Shift+Space handled above
            if *k == Keycode::Space && shift {
              continue;
            }
            emit_sound(
              &app_thread,
              SoundPayload {
                kind: "typing",
                source: "desktop",
              },
            );
            last_typing_at = Some(std::time::Instant::now());
            break; // one typing tick per poll
          }
        }
      }

      if let Some(agent_at) = *AGENT_KEY_AT.lock() {
        if last_typing_at.map_or(true, |h| agent_at > h) {
          last_typing_at = Some(agent_at);
        }
      }

      // Caret moves after the app handles the key — keep sampling briefly after each keystroke.
      if let Some(at) = last_typing_at {
        if at.elapsed() < Duration::from_millis(450)
          && last_caret_query.elapsed() >= Duration::from_millis(45)
        {
          last_caret_query = std::time::Instant::now();
          if let Some(pos) = read_caret_screen() {
            if last_caret != Some(pos) {
              last_caret = Some(pos);
              emit_caret(&app_thread, pos);
            }
          }
        } else if at.elapsed() >= Duration::from_millis(450) {
          last_typing_at = None;
        }
      }

      // Shortcut overlays — Ctrl/Alt/⌘ chords, F-keys, Esc, Shift+Space
      for k in key_set.difference(&prev_keys) {
        if let Some((label, parts)) = shortcut_from_press(&keys, k) {
          emit_keystroke(
            &app_thread,
            KeystrokePayload {
              label,
              keys: parts,
              source: "desktop",
            },
          );
        }
      }
      prev_keys = key_set;

      prev_left = left;
      thread::sleep(Duration::from_millis(8));
    }

    #[cfg(windows)]
    cursor_cloak::stop();
  });

  Ok(())
}

#[tauri::command]
fn stop_pointer_hook(state: State<'_, HookState>) -> Result<(), String> {
  state.running.store(false, Ordering::SeqCst);
  #[cfg(windows)]
  cursor_cloak::stop();
  Ok(())
}

#[tauri::command]
fn capture_list_targets() -> Result<Vec<native_capture::CaptureTarget>, String> {
  native_capture::list_targets()
}

#[tauri::command]
fn capture_start(
  app: AppHandle,
  state: State<'_, HookState>,
  window_id: Option<String>,
  title_contains: Option<String>,
) -> Result<serde_json::Value, String> {
  let _ = start_pointer_hook(app.clone(), state);
  let started = native_capture::start_capture(window_id, title_contains)?;
  let _ = app.emit("native-capture-started", &started);
  Ok(started)
}

#[tauri::command]
fn capture_stop(
  app: AppHandle,
  state: State<'_, HookState>,
) -> Result<native_capture::CaptureStopResult, String> {
  let result = native_capture::stop_capture()?;
  let _ = stop_pointer_hook(state);
  if !result.finalizing {
    let _ = app.emit("native-capture-stopped", &result);
  }
  Ok(result)
}

#[tauri::command]
fn capture_open_url(url: String) -> Result<(), String> {
  native_capture::open_url(&url)
}

#[tauri::command]
fn capture_open_path(path: String) -> Result<(), String> {
  native_capture::open_path(&path)
}

#[tauri::command]
fn android_runtime_status() -> android_capture::AndroidRuntimeStatus {
  android_capture::runtime_status()
}

#[tauri::command]
fn android_ensure_runtime() -> Result<android_capture::AndroidRuntimeStatus, String> {
  android_capture::ensure_runtime()
}

#[tauri::command]
fn android_list_devices() -> Result<Vec<android_capture::AndroidDevice>, String> {
  android_capture::list_devices()
}

#[tauri::command]
fn android_usb_note() -> String {
  android_capture::usb_safety_note()
}

#[tauri::command]
fn android_start(
  app: AppHandle,
  serial: Option<String>,
) -> Result<android_capture::AndroidSessionStarted, String> {
  let started = android_capture::start_session(serial)?;
  let _ = app.emit("native-capture-started", &started);
  Ok(started)
}

#[tauri::command]
fn android_stop(app: AppHandle) -> Result<native_capture::CaptureStopResult, String> {
  let result = android_capture::stop_session()?;
  let _ = app.emit("native-capture-stopped", &result);
  Ok(result)
}

#[tauri::command]
fn android_session_active() -> bool {
  android_capture::session_active()
}

#[tauri::command]
fn read_capture_file(path: String) -> Result<Vec<u8>, String> {
  // Only allow reading our temp capture directory
  let p = std::path::Path::new(&path);
  let tmp = std::env::temp_dir().join("screen-weaver");
  let canon = p.canonicalize().map_err(|e| e.to_string())?;
  let tmp_canon = tmp.canonicalize().unwrap_or(tmp);
  if !canon.starts_with(&tmp_canon) {
    return Err("Path is outside the Screen Beaver capture directory".into());
  }
  std::fs::read(canon).map_err(|e| e.to_string())
}

fn cors_ok<R: std::io::Read>(response: tiny_http::Response<R>) -> tiny_http::Response<R> {
  // Bridge listens on 127.0.0.1 only. Extension + Tauri webview need cross-origin GETs.
  response
    .with_header(
      tiny_http::Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap(),
    )
    .with_header(
      tiny_http::Header::from_bytes(&b"Access-Control-Allow-Methods"[..], &b"POST, GET, OPTIONS"[..])
        .unwrap(),
    )
    .with_header(
      tiny_http::Header::from_bytes(&b"Access-Control-Allow-Headers"[..], &b"Content-Type"[..])
        .unwrap(),
    )
}

/// Demo mouse control is only allowed while Screen Beaver is actively recording
/// (native window capture or USB Android mirror).
fn require_active_demo_capture() -> Result<Option<isize>, String> {
  require_demo_hwnd(None, None)
}

/// Input target: active capture, or an explored window (title/hwnd) without recording.
fn require_demo_hwnd(
  hwnd: Option<isize>,
  title_contains: Option<&str>,
) -> Result<Option<isize>, String> {
  if android_capture::session_active() {
    return Ok(android_capture::active_hwnd().or(hwnd));
  }
  if native_capture::is_recording() {
    return Ok(native_capture::active_hwnd().or(hwnd));
  }
  // Explore phase — drive the real cursor on a live window without capturing yet.
  if hwnd.is_some() || title_contains.is_some() {
    let h = resolve_capture_hwnd(hwnd, title_contains)?;
    return Ok(Some(h));
  }
  Err(
    "Demo input needs an active capture, or hwnd/titleContains for explore-without-record."
      .into(),
  )
}

/// Resolve a window for layout / scout screenshots (works without an active capture).
fn resolve_capture_hwnd(hwnd: Option<isize>, title_contains: Option<&str>) -> Result<isize, String> {
  if let Some(h) = hwnd {
    return Ok(h);
  }
  if android_capture::session_active() {
    if let Some(h) = android_capture::active_hwnd() {
      return Ok(h);
    }
  }
  if native_capture::is_recording() {
    if let Some(h) = native_capture::active_hwnd() {
      return Ok(h);
    }
  }
  let needle = title_contains.unwrap_or("Edge").to_lowercase();
  let targets = native_capture::list_targets()?;
  // Prefer browser windows; never pick Claude/Cursor chats that mention the product name.
  let mut best: Option<(isize, u8, u64)> = None;
  for t in targets {
    if t.kind != "window" {
      continue;
    }
    let title_l = t.title.to_lowercase();
    let proc_l = t.process_name.to_lowercase();
    if native_capture::is_excluded_capture_window(&title_l, &proc_l) {
      continue;
    }
    if !(title_l.contains(&needle) || proc_l.contains(&needle)) {
      continue;
    }
    let hwnd = match t.id.strip_prefix("window:").and_then(|s| s.parse::<isize>().ok()) {
      Some(h) => h,
      None => continue,
    };
    let area = (t.width as u64).saturating_mul(t.height as u64);
    let rank: u8 = if proc_l.contains("msedge")
      || proc_l.contains("chrome")
      || proc_l.contains("firefox")
      || proc_l.contains("brave")
    {
      2
    } else {
      1
    };
    let take = match best {
      None => true,
      Some((_, br, ba)) => rank > br || (rank == br && area > ba),
    };
    if take {
      best = Some((hwnd, rank, area));
    }
  }
  best
    .map(|(h, _, _)| h)
    .ok_or_else(|| format!("No window matching '{needle}'"))
}

fn spawn_extension_bridge(app: AppHandle) {
  let hook_app = app.clone();
  native_capture::set_finalize_hook(Box::new(move |result, auto_import| {
    let _ = hook_app.emit("native-capture-finalized", result);
    if auto_import {
      emit_agent_command(
        &hook_app,
        AgentCommandPayload {
          id: format!(
            "import-final-{}",
            std::time::SystemTime::now()
              .duration_since(std::time::UNIX_EPOCH)
              .map(|d| d.as_millis())
              .unwrap_or(0)
          ),
          action: "import_last_capture".into(),
          payload: serde_json::json!({}),
        },
      );
    }
  }));
  thread::spawn(move || {
    let server = match tiny_http::Server::http(format!("127.0.0.1:{EXT_PORT}")) {
      Ok(s) => s,
      Err(e) => {
        eprintln!("extension bridge failed to bind: {e}");
        return;
      }
    };
    eprintln!("Screen Beaver extension bridge on 127.0.0.1:{EXT_PORT}");

    for request in server.incoming_requests() {
      let app = app.clone();
      thread::spawn(move || {
        handle_bridge_request(request, app);
      });
    }
  });
}

fn handle_bridge_request(mut request: tiny_http::Request, app: AppHandle) {
      let url = request.url().to_string();
      let method = request.method().as_str().to_string();

      if method == "OPTIONS" {
        let response = cors_ok(tiny_http::Response::from_data(vec![]).with_status_code(204));
        let _ = request.respond(response);
        return;
      }

      if method == "GET"
        && (url.starts_with("/auth/callback") || url.starts_with("/desktop-auth"))
      {
        emit_auth_callback(&app, &url);
        let html = br#"<!doctype html><html><body style="font-family:Segoe UI,sans-serif;padding:40px;background:#11151c;color:#fff">
<p>Signed in. You can close this tab and return to Screen Beaver.</p>
</body></html>"#;
        let response = cors_ok(
          tiny_http::Response::from_data(html.to_vec()).with_header(
            tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..])
              .unwrap(),
          ),
        );
        let _ = request.respond(response);
        return;
      }

      if method == "GET" && (url == "/" || url.starts_with("/health")) {
        let body = serde_json::json!({
          "ok": true,
          "service": "screen-beaver",
          "agent": true,
          "port": EXT_PORT,
          "mcpEntitled": mcp_entitled(),
        })
        .to_string()
        .into_bytes();
        let response = cors_ok(
          tiny_http::Response::from_data(body).with_header(
            tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap(),
          ),
        );
        let _ = request.respond(response);
        return;
      }

      if method == "GET" && (url == "/agent" || url.starts_with("/agent?")) {
        let body = serde_json::json!({
          "ok": true,
          "mcpEntitled": mcp_entitled(),
          "actions": [
            "status","list_windows","list_capture_targets","focus_studio","open_record_picker",
            "open_url","open_path","start_capture","stop_capture","android_ensure_runtime",
            "android_list_devices","android_start","android_stop","run_demo","notify","seek",
            "open_tab","apply_recipe","apply_preset","patch_frame","set_name","add_caption",
            "add_zoom","add_effect","add_sound","add_camera_move","set_captions","regenerate_zooms",
            "translate_captions","generate_voiceover","ready_for_export","export"
          ],
          "docs": "Drive via Screen Beaver MCP tools only (no shell scripts). MCP requires Pro or Team. POST /agent/command, /capture/*, /android/*, /input/* during active capture. User clicks Export."
        })
        .to_string()
        .into_bytes();
        let response = cors_ok(
          tiny_http::Response::from_data(body).with_header(
            tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap(),
          ),
        );
        let _ = request.respond(response);
        return;
      }

      if bridge_route_requires_mcp(&method, &url) && !mcp_entitled() {
        respond_mcp_upgrade(request);
        return;
      }

      if method == "POST" && url.starts_with("/agent/command") {
        let mut buf = String::new();
        let _ = request.as_reader().read_to_string(&mut buf);
        let parsed: Result<(String, String, serde_json::Value, u64), String> = (|| {
          let v: serde_json::Value =
            serde_json::from_str(&buf).map_err(|e| format!("Invalid JSON: {e}"))?;
          let action = v
            .get("action")
            .and_then(|t| t.as_str())
            .ok_or_else(|| "Missing action".to_string())?
            .to_string();
          let id = v
            .get("id")
            .and_then(|t| t.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("cmd-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)));
          let payload = v.get("payload").cloned().unwrap_or(serde_json::json!({}));
          let timeout_ms = v
            .get("timeoutMs")
            .and_then(|t| t.as_u64())
            .unwrap_or(if action == "export"
              || action == "import_last_capture"
              || action == "stop_capture"
              || action == "generate_voiceover"
            {
              90_000
            } else {
              12_000
            });
          Ok((id, action, payload, timeout_ms))
        })();

        match parsed {
          Ok((id, action, payload, timeout_ms)) => {
            let free_ok = action == "status" || action == "notify" || action == "focus_studio";
            if !free_ok && !mcp_entitled() {
              respond_mcp_upgrade(request);
              return;
            }

            // Fast paths that must NOT depend on a responsive WebView.
            // After capture starts the UI can stall; Claude still needs stop/focus/status.
            if action == "focus_studio" {
              if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
              }
              // Best-effort nudge UI into studio chrome (ignore if frozen).
              emit_agent_command(
                &app,
                AgentCommandPayload {
                  id: format!("{id}-ui"),
                  action: "focus_studio".into(),
                  payload: payload.clone(),
                },
              );
              let body = serde_json::json!({
                "ok": true,
                "message": "Screen Beaver focused (Rust)",
                "id": id,
              })
              .to_string()
              .into_bytes();
              let response = cors_ok(
                tiny_http::Response::from_data(body).with_header(
                  tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                    .unwrap(),
                ),
              );
              let _ = request.respond(response);
              return;
            }

            if action == "stop_capture" {
              let stopped = if android_capture::session_active() {
                android_capture::stop_session()
              } else {
                native_capture::stop_capture_ex(true).map(|r| {
                  let _ = stop_pointer_hook(app.state::<HookState>());
                  r
                })
              };
              match stopped {
                Ok(result) => {
                  let _ = app.emit("native-capture-stopped", &result);
                  if !result.finalizing {
                    // Ask UI to import when awake — do not block on it.
                    emit_agent_command(
                      &app,
                      AgentCommandPayload {
                        id: format!("{id}-import"),
                        action: "import_last_capture".into(),
                        payload: serde_json::json!({}),
                      },
                    );
                  }
                  let body = serde_json::json!({
                    "ok": true,
                    "finalizing": result.finalizing,
                    "message": if result.finalizing {
                      "Capture stopped — encoder still writing the MP4; studio imports automatically when it's finished"
                    } else {
                      "Capture stopped (Rust) — studio will import when responsive"
                    },
                    "id": id,
                    "path": result.path,
                    "mediaUrl": result.media_url,
                    "width": result.width,
                    "height": result.height,
                    "durationMs": result.duration_ms,
                    "sourceLabel": result.source_label,
                    "hasTake": true,
                  })
                  .to_string()
                  .into_bytes();
                  let response = cors_ok(
                    tiny_http::Response::from_data(body).with_header(
                      tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                        .unwrap(),
                    ),
                  );
                  let _ = request.respond(response);
                }
                Err(e) => {
                  let body = serde_json::json!({ "ok": false, "error": e, "id": id })
                    .to_string()
                    .into_bytes();
                  let response = cors_ok(
                    tiny_http::Response::from_data(body)
                      .with_status_code(500)
                      .with_header(
                        tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                          .unwrap(),
                      ),
                  );
                  let _ = request.respond(response);
                }
              }
              return;
            }

            if action == "status" || action == "verify_take" {
              // Prefer UI status, but fall back fast so Claude isn't stuck mid-capture.
              agent_bus().results.lock().remove(&id);
              emit_agent_command(
                &app,
                AgentCommandPayload {
                  id: id.clone(),
                  action: action.clone(),
                  payload: payload.clone(),
                },
              );
              let body = match wait_agent_result(&id, Duration::from_millis(2_500)) {
                Some(result) => result.into_bytes(),
                None => serde_json::json!({
                  "ok": true,
                  "degraded": true,
                  "recording": native_capture::is_recording() || android_capture::session_active(),
                  "message": "Studio UI slow — bridge alive. Prefer stop_capture / scout; avoid long UI waits.",
                  "id": id,
                })
                .to_string()
                .into_bytes(),
              };
              let response = cors_ok(
                tiny_http::Response::from_data(body).with_header(
                  tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                    .unwrap(),
                ),
              );
              let _ = request.respond(response);
              return;
            }

            agent_bus().results.lock().remove(&id);
            emit_agent_command(
              &app,
              AgentCommandPayload {
                id: id.clone(),
                action,
                payload,
              },
            );
            let timeout = Duration::from_millis(timeout_ms.clamp(1_000, 180_000));
            let body = match wait_agent_result(&id, timeout) {
              Some(result) => result.into_bytes(),
              None => serde_json::json!({
                "ok": false,
                "error": "Timed out waiting for Screen Beaver UI. Keep the desktop app open with the studio loaded.",
                "id": id,
              })
              .to_string()
              .into_bytes(),
            };
            let response = cors_ok(
              tiny_http::Response::from_data(body).with_header(
                tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                  .unwrap(),
              ),
            );
            let _ = request.respond(response);
          }
          Err(e) => {
            let body = serde_json::json!({ "ok": false, "error": e }).to_string().into_bytes();
            let response = cors_ok(
              tiny_http::Response::from_data(body)
                .with_status_code(400)
                .with_header(
                  tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                    .unwrap(),
                ),
            );
            let _ = request.respond(response);
          }
        }
        return;
      }

      if method == "GET" && (url == "/voices" || url.starts_with("/voices?")) {
        match edge_tts::list_edge_voices() {
          Ok(voices) => {
            let body = serde_json::to_vec(&voices).unwrap_or_else(|_| b"[]".to_vec());
            let response = cors_ok(
              tiny_http::Response::from_data(body).with_header(
                tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                  .unwrap(),
              ),
            );
            let _ = request.respond(response);
          }
          Err(e) => {
            let body = serde_json::json!({ "error": e }).to_string().into_bytes();
            let response = cors_ok(
              tiny_http::Response::from_data(body)
                .with_status_code(500)
                .with_header(
                  tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                    .unwrap(),
                ),
            );
            let _ = request.respond(response);
          }
        }
        return;
      }

      if method == "POST" && url.starts_with("/tts") {
        let mut buf = String::new();
        let _ = request.as_reader().read_to_string(&mut buf);
        let parsed: Result<(String, String), String> = (|| {
          let v: serde_json::Value =
            serde_json::from_str(&buf).map_err(|e| format!("Invalid JSON: {e}"))?;
          let text = v
            .get("text")
            .and_then(|t| t.as_str())
            .ok_or_else(|| "Missing text".to_string())?
            .to_string();
          let voice = v
            .get("voice")
            .and_then(|t| t.as_str())
            .unwrap_or("en-US-JennyNeural")
            .to_string();
          Ok((text, voice))
        })();
        match parsed.and_then(|(text, voice)| edge_tts::synthesize_edge_tts(&text, &voice)) {
          Ok(result) => {
            let body = serde_json::to_vec(&result).unwrap_or_else(|_| b"{}".to_vec());
            let response = cors_ok(
              tiny_http::Response::from_data(body).with_header(
                tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                  .unwrap(),
              ),
            );
            let _ = request.respond(response);
          }
          Err(e) => {
            let body = serde_json::json!({ "error": e }).to_string().into_bytes();
            let response = cors_ok(
              tiny_http::Response::from_data(body)
                .with_status_code(500)
                .with_header(
                  tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                    .unwrap(),
                ),
            );
            let _ = request.respond(response);
          }
        }
        return;
      }

      if method == "POST" && url.starts_with("/event") {
        let mut buf = String::new();
        let _ = request.as_reader().read_to_string(&mut buf);
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&buf) {
          let kind = v.get("kind").and_then(|k| k.as_str()).unwrap_or("");
          let x = v.get("x").and_then(|k| k.as_f64()).unwrap_or(0.5);
          let y = v.get("y").and_then(|k| k.as_f64()).unwrap_or(0.5);
          let down = v.get("down").and_then(|k| k.as_bool()).unwrap_or(false);
          let right = v.get("right").and_then(|k| k.as_bool()).unwrap_or(false);
          let shift = v.get("shift").and_then(|k| k.as_bool()).unwrap_or(false);
          let ctrl = v.get("ctrl").and_then(|k| k.as_bool()).unwrap_or(false);
          let alt = v.get("alt").and_then(|k| k.as_bool()).unwrap_or(false);
          let shape = v
            .get("shape")
            .and_then(|k| k.as_str())
            .unwrap_or("arrow")
            .to_string();

          match kind {
            "cursor" => emit_cursor(
              &app,
              CursorPayload {
                x: x.clamp(0.0, 1.0),
                y: y.clamp(0.0, 1.0),
                down,
                right,
                shift,
                ctrl,
                alt,
                shape,
                icon_id: None,
                icon: None,
                source: "extension",
              },
            ),
            "zoom" => emit_marker(
              &app,
              MarkerPayload {
                kind: "zoom",
                x: x.clamp(0.0, 1.0),
                y: y.clamp(0.0, 1.0),
                duration: None,
                preset: None,
                source: "extension",
              },
            ),
            "camera-move" => emit_marker(
              &app,
              MarkerPayload {
                kind: "camera-move",
                x: x.clamp(0.0, 1.0),
                y: y.clamp(0.0, 1.0),
                duration: None,
                preset: None,
                source: "extension",
              },
            ),
            "scene-effect" => {
              let preset = v
                .get("preset")
                .and_then(|k| k.as_str())
                .map(|s| match s {
                  "hero-zoom" | "tilt-3d" | "focus-zoom" | "spin-3d" | "glare" | "mockup-tilt"
                  | "window-reveal" => {
                    Some(s)
                  }
                  _ => None,
                })
                .flatten();
              // Leak-free: only emit known static presets
              let preset_static: Option<&'static str> = match preset {
                Some("hero-zoom") => Some("hero-zoom"),
                Some("tilt-3d") => Some("tilt-3d"),
                Some("focus-zoom") => Some("focus-zoom"),
                Some("spin-3d") => Some("spin-3d"),
                Some("glare") => Some("glare"),
                Some("mockup-tilt") => Some("mockup-tilt"),
                Some("window-reveal") => Some("window-reveal"),
                _ => None,
              };
              if let Some(p) = preset_static {
                emit_marker(
                  &app,
                  MarkerPayload {
                    kind: "scene-effect",
                    x: x.clamp(0.0, 1.0),
                    y: y.clamp(0.0, 1.0),
                    duration: None,
                    preset: Some(p),
                    source: "extension",
                  },
                );
              }
            }
            _ => {}
          }
        }
        let body = br#"{"ok":true}"#.to_vec();
        let response = cors_ok(
          tiny_http::Response::from_data(body).with_header(
            tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap(),
          ),
        );
        let _ = request.respond(response);
        return;
      }

      if method == "GET" && (url == "/capture/targets" || url.starts_with("/capture/targets?")) {
        match native_capture::list_targets() {
          Ok(targets) => {
            let body = serde_json::to_vec(&targets).unwrap_or_else(|_| b"[]".to_vec());
            let response = cors_ok(
              tiny_http::Response::from_data(body).with_header(
                tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                  .unwrap(),
              ),
            );
            let _ = request.respond(response);
          }
          Err(e) => {
            let body = serde_json::json!({ "ok": false, "error": e }).to_string().into_bytes();
            let response = cors_ok(
              tiny_http::Response::from_data(body)
                .with_status_code(500)
                .with_header(
                  tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                    .unwrap(),
                ),
            );
            let _ = request.respond(response);
          }
        }
        return;
      }

      if method == "POST" && url.starts_with("/capture/open") {
        let mut buf = String::new();
        let _ = request.as_reader().read_to_string(&mut buf);
        let parsed: Result<(), String> = (|| {
          let v: serde_json::Value =
            serde_json::from_str(&buf).map_err(|e| format!("Invalid JSON: {e}"))?;
          if let Some(u) = v.get("url").and_then(|t| t.as_str()) {
            native_capture::open_url(u)?;
            return Ok(());
          }
          if let Some(p) = v.get("path").and_then(|t| t.as_str()) {
            native_capture::open_path(p)?;
            return Ok(());
          }
          Err("Provide url or path".into())
        })();
        match parsed {
          Ok(()) => {
            let body = br#"{"ok":true}"#.to_vec();
            let response = cors_ok(
              tiny_http::Response::from_data(body).with_header(
                tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                  .unwrap(),
              ),
            );
            let _ = request.respond(response);
          }
          Err(e) => {
            let body = serde_json::json!({ "ok": false, "error": e }).to_string().into_bytes();
            let response = cors_ok(
              tiny_http::Response::from_data(body)
                .with_status_code(400)
                .with_header(
                  tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                    .unwrap(),
                ),
            );
            let _ = request.respond(response);
          }
        }
        return;
      }

      if method == "POST" && url.starts_with("/capture/start") {
        let mut buf = String::new();
        let _ = request.as_reader().read_to_string(&mut buf);
        let parsed: Result<(Option<String>, Option<String>), String> = (|| {
          let v: serde_json::Value =
            serde_json::from_str(&buf).map_err(|e| format!("Invalid JSON: {e}"))?;
          let window_id = v
            .get("windowId")
            .and_then(|t| t.as_str())
            .map(|s| s.to_string());
          let title_contains = v
            .get("titleContains")
            .and_then(|t| t.as_str())
            .map(|s| s.to_string());
          Ok((window_id, title_contains))
        })();
        match parsed.and_then(|(id, title)| {
          let _ = start_pointer_hook(app.clone(), app.state::<HookState>());
          let started = native_capture::start_capture(id, title)?;
          let _ = app.emit("native-capture-started", &started);
          Ok(started)
        }) {
          Ok(started) => {
            let body = serde_json::to_vec(&started).unwrap_or_else(|_| b"{}".to_vec());
            let response = cors_ok(
              tiny_http::Response::from_data(body).with_header(
                tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                  .unwrap(),
              ),
            );
            let _ = request.respond(response);
          }
          Err(e) => {
            let body = serde_json::json!({ "ok": false, "error": e }).to_string().into_bytes();
            let response = cors_ok(
              tiny_http::Response::from_data(body)
                .with_status_code(500)
                .with_header(
                  tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                    .unwrap(),
                ),
            );
            let _ = request.respond(response);
          }
        }
        return;
      }

      if method == "POST" && url.starts_with("/capture/stop") {
        let result = if android_capture::session_active() {
          android_capture::stop_session()
        } else {
          native_capture::stop_capture_ex(false).map(|r| {
            let _ = stop_pointer_hook(app.state::<HookState>());
            r
          })
        };
        match result {
          Ok(result) => {
            let _ = app.emit("native-capture-stopped", &result);
            // Kick UI import even if the agent times out — WebView may be slow after a long take.
            if !result.finalizing {
              emit_agent_command(
                &app,
                AgentCommandPayload {
                  id: format!("import-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)),
                  action: "import_last_capture".into(),
                  payload: serde_json::json!({}),
                },
              );
            }
            let body = serde_json::to_vec(&serde_json::json!({
              "ok": true,
              "finalizing": result.finalizing,
              "path": result.path,
              "mediaUrl": result.media_url,
              "width": result.width,
              "height": result.height,
              "durationMs": result.duration_ms,
              "sourceLabel": result.source_label,
            }))
            .unwrap_or_else(|_| b"{}".to_vec());
            let response = cors_ok(
              tiny_http::Response::from_data(body).with_header(
                tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                  .unwrap(),
              ),
            );
            let _ = request.respond(response);
          }
          Err(e) => {
            let body = serde_json::json!({ "ok": false, "error": e }).to_string().into_bytes();
            let response = cors_ok(
              tiny_http::Response::from_data(body)
                .with_status_code(500)
                .with_header(
                  tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                    .unwrap(),
                ),
            );
            let _ = request.respond(response);
          }
        }
        return;
      }

      // --- Android USB (portable ADB/scrcpy) ---
      if method == "GET" && (url == "/android/note" || url.starts_with("/android/note?")) {
        let body = serde_json::json!({ "ok": true, "note": android_capture::usb_safety_note() })
          .to_string()
          .into_bytes();
        let response = cors_ok(
          tiny_http::Response::from_data(body).with_header(
            tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap(),
          ),
        );
        let _ = request.respond(response);
        return;
      }

      if method == "GET" && (url == "/android/runtime" || url.starts_with("/android/runtime?")) {
        let status = android_capture::runtime_status();
        let body = serde_json::to_vec(&status).unwrap_or_else(|_| b"{}".to_vec());
        let response = cors_ok(
          tiny_http::Response::from_data(body).with_header(
            tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap(),
          ),
        );
        let _ = request.respond(response);
        return;
      }

      if method == "POST" && url.starts_with("/android/ensure_runtime") {
        match android_capture::ensure_runtime() {
          Ok(status) => {
            let body = serde_json::to_vec(&status).unwrap_or_else(|_| b"{}".to_vec());
            let response = cors_ok(
              tiny_http::Response::from_data(body).with_header(
                tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                  .unwrap(),
              ),
            );
            let _ = request.respond(response);
          }
          Err(e) => {
            let body = serde_json::json!({ "ok": false, "error": e }).to_string().into_bytes();
            let response = cors_ok(
              tiny_http::Response::from_data(body)
                .with_status_code(500)
                .with_header(
                  tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                    .unwrap(),
                ),
            );
            let _ = request.respond(response);
          }
        }
        return;
      }

      if method == "GET" && (url == "/android/devices" || url.starts_with("/android/devices?")) {
        match android_capture::list_devices() {
          Ok(devices) => {
            let body = serde_json::to_vec(&serde_json::json!({ "ok": true, "devices": devices }))
              .unwrap_or_else(|_| b"{}".to_vec());
            let response = cors_ok(
              tiny_http::Response::from_data(body).with_header(
                tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                  .unwrap(),
              ),
            );
            let _ = request.respond(response);
          }
          Err(e) => {
            let body = serde_json::json!({ "ok": false, "error": e }).to_string().into_bytes();
            let response = cors_ok(
              tiny_http::Response::from_data(body)
                .with_status_code(500)
                .with_header(
                  tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                    .unwrap(),
                ),
            );
            let _ = request.respond(response);
          }
        }
        return;
      }

      if method == "POST" && url.starts_with("/android/start") {
        let mut buf = String::new();
        let _ = request.as_reader().read_to_string(&mut buf);
        let serial = serde_json::from_str::<serde_json::Value>(&buf)
          .ok()
          .and_then(|v| v.get("serial").and_then(|s| s.as_str()).map(|s| s.to_string()));
        match android_capture::start_session(serial) {
          Ok(started) => {
            let _ = app.emit("native-capture-started", &started);
            let body = serde_json::to_vec(&started).unwrap_or_else(|_| b"{}".to_vec());
            let response = cors_ok(
              tiny_http::Response::from_data(body).with_header(
                tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                  .unwrap(),
              ),
            );
            let _ = request.respond(response);
          }
          Err(e) => {
            let body = serde_json::json!({ "ok": false, "error": e }).to_string().into_bytes();
            let response = cors_ok(
              tiny_http::Response::from_data(body)
                .with_status_code(500)
                .with_header(
                  tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                    .unwrap(),
                ),
            );
            let _ = request.respond(response);
          }
        }
        return;
      }

      if method == "POST" && url.starts_with("/android/stop") {
        match android_capture::stop_session() {
          Ok(result) => {
            let _ = app.emit("native-capture-stopped", &result);
            let body = serde_json::to_vec(&serde_json::json!({
              "ok": true,
              "path": result.path,
              "mediaUrl": result.media_url,
              "width": result.width,
              "height": result.height,
              "durationMs": result.duration_ms,
              "sourceLabel": result.source_label,
            }))
            .unwrap_or_else(|_| b"{}".to_vec());
            let response = cors_ok(
              tiny_http::Response::from_data(body).with_header(
                tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                  .unwrap(),
              ),
            );
            let _ = request.respond(response);
          }
          Err(e) => {
            let body = serde_json::json!({ "ok": false, "error": e }).to_string().into_bytes();
            let response = cors_ok(
              tiny_http::Response::from_data(body)
                .with_status_code(500)
                .with_header(
                  tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                    .unwrap(),
                ),
            );
            let _ = request.respond(response);
          }
        }
        return;
      }

      // Metadata for the most recent capture (used by import_last_capture).
      if method == "GET" && (url == "/capture/last" || url.starts_with("/capture/last?")) {
        let meta = native_capture::last_capture_meta()
          .or_else(native_capture::recover_newest_capture);
        match meta {
          Some(meta) => {
            let body = serde_json::to_vec(&meta).unwrap_or_else(|_| b"{}".to_vec());
            let response = cors_ok(
              tiny_http::Response::from_data(body).with_header(
                tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                  .unwrap(),
              ),
            );
            let _ = request.respond(response);
          }
          None => {
            let body = br#"{"ok":false,"error":"No capture yet"}"#.to_vec();
            let response = cors_ok(
              tiny_http::Response::from_data(body)
                .with_status_code(404)
                .with_header(
                  tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                    .unwrap(),
                ),
            );
            let _ = request.respond(response);
          }
        }
        return;
      }

      // Serve last (or queried) capture MP4 over HTTP so the UI never loads multi-MB via IPC.
      if method == "GET" && (url == "/capture/file" || url.starts_with("/capture/file?")) {
        let path_q = url
          .split('?')
          .nth(1)
          .unwrap_or("")
          .split('&')
          .find_map(|pair| {
            let mut it = pair.splitn(2, '=');
            let k = it.next()?;
            let v = it.next().unwrap_or("");
            if k == "path" {
              Some(percent_decode(v))
            } else {
              None
            }
          })
          .or_else(native_capture::last_capture_path);
        match path_q
          .ok_or_else(|| "No capture path".to_string())
          .and_then(|p| native_capture::resolve_capture_file(&p))
        {
          Ok(path) => match std::fs::File::open(&path) {
            Ok(file) => {
              let len = file.metadata().ok().map(|m| m.len() as usize);
              let response = cors_ok(
                tiny_http::Response::new(
                  tiny_http::StatusCode(200),
                  vec![
                    tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"video/mp4"[..]).unwrap(),
                    tiny_http::Header::from_bytes(&b"Accept-Ranges"[..], &b"bytes"[..]).unwrap(),
                    tiny_http::Header::from_bytes(&b"Cache-Control"[..], &b"no-store"[..]).unwrap(),
                  ],
                  file,
                  len,
                  None,
                ),
              );
              let _ = request.respond(response);
            }
            Err(e) => {
              let body = serde_json::json!({ "ok": false, "error": e.to_string() })
                .to_string()
                .into_bytes();
              let response = cors_ok(
                tiny_http::Response::from_data(body)
                  .with_status_code(404)
                  .with_header(
                    tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                      .unwrap(),
                  ),
              );
              let _ = request.respond(response);
            }
          },
          Err(e) => {
            let body = serde_json::json!({ "ok": false, "error": e }).to_string().into_bytes();
            let response = cors_ok(
              tiny_http::Response::from_data(body)
                .with_status_code(400)
                .with_header(
                  tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                    .unwrap(),
                ),
            );
            let _ = request.respond(response);
          }
        }
        return;
      }

      if method == "POST" && url.starts_with("/input/run") {
        let mut buf = String::new();
        let _ = request.as_reader().read_to_string(&mut buf);
        let app_for_type = app.clone();
        let parsed: Result<usize, String> = (|| {
          let v: serde_json::Value =
            serde_json::from_str(&buf).map_err(|e| format!("Invalid JSON: {e}"))?;
          let hwnd_opt = v.get("hwnd").and_then(|h| h.as_i64()).map(|h| h as isize);
          let title = v.get("titleContains").and_then(|t| t.as_str());
          let active = require_demo_hwnd(hwnd_opt, title)?;
          let steps = v
            .get("steps")
            .and_then(|s| s.as_array())
            .ok_or_else(|| "steps array required".to_string())?;
          let hwnd = hwnd_opt.or(active);
          native_capture::mark_agent_driven();
          input_automation::run_script(steps, hwnd, || agent_key_tick(&app_for_type))
        })();
        match parsed {
          Ok(ran) => {
            let body = serde_json::json!({ "ok": true, "ran": ran }).to_string().into_bytes();
            let response = cors_ok(
              tiny_http::Response::from_data(body).with_header(
                tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                  .unwrap(),
              ),
            );
            let _ = request.respond(response);
          }
          Err(e) => {
            let body = serde_json::json!({ "ok": false, "error": e }).to_string().into_bytes();
            let response = cors_ok(
              tiny_http::Response::from_data(body)
                .with_status_code(400)
                .with_header(
                  tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                    .unwrap(),
                ),
            );
            let _ = request.respond(response);
          }
        }
        return;
      }

      if method == "POST" && url.starts_with("/input/move") {
        let mut buf = String::new();
        let _ = request.as_reader().read_to_string(&mut buf);
        let parsed: Result<(), String> = (|| {
          let v: serde_json::Value =
            serde_json::from_str(&buf).map_err(|e| format!("Invalid JSON: {e}"))?;
          let hwnd_opt = v.get("hwnd").and_then(|h| h.as_i64()).map(|h| h as isize);
          let title = v.get("titleContains").and_then(|t| t.as_str());
          let active = require_demo_hwnd(hwnd_opt, title)?;
          let nx = v
            .get("contentNx")
            .or_else(|| v.get("nx"))
            .and_then(|t| t.as_f64())
            .unwrap_or(0.5);
          let ny = v
            .get("contentNy")
            .or_else(|| v.get("ny"))
            .and_then(|t| t.as_f64())
            .unwrap_or(0.5);
          let duration_ms = v.get("durationMs").and_then(|t| t.as_u64()).unwrap_or(500);
          let click = v.get("click").and_then(|t| t.as_bool()).unwrap_or(false);
          let in_window = v.get("inWindow").and_then(|t| t.as_bool()).unwrap_or(true);
          let content_space = v.get("contentNx").and_then(|t| t.as_f64()).is_some()
            || v.get("space").and_then(|t| t.as_str()) == Some("content");
          let hwnd = hwnd_opt.or(active);
          native_capture::mark_agent_driven();
          if in_window {
            let hwnd = hwnd.ok_or_else(|| {
              "No window hwnd — start_capture, or pass titleContains for explore".to_string()
            })?;
            // Always animate the real cursor — never teleport (min 400ms).
            let duration_ms = duration_ms.max(400);
            input_automation::move_in_window_mapped(hwnd, nx, ny, duration_ms, click, content_space)?;
          } else {
            let duration_ms = duration_ms.max(400);
            input_automation::smooth_move_norm(nx, ny, duration_ms)?;
            if click {
              input_automation::click_left()?;
            }
          }
          Ok(())
        })();
        match parsed {
          Ok(()) => {
            let body = br#"{"ok":true}"#.to_vec();
            let response = cors_ok(
              tiny_http::Response::from_data(body).with_header(
                tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                  .unwrap(),
              ),
            );
            let _ = request.respond(response);
          }
          Err(e) => {
            let body = serde_json::json!({ "ok": false, "error": e }).to_string().into_bytes();
            let response = cors_ok(
              tiny_http::Response::from_data(body)
                .with_status_code(400)
                .with_header(
                  tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                    .unwrap(),
                ),
            );
            let _ = request.respond(response);
          }
        }
        return;
      }

      if method == "POST" && url.starts_with("/input/click") {
        let mut buf = String::new();
        let _ = request.as_reader().read_to_string(&mut buf);
        let result = (|| {
          let _ = require_active_demo_capture()?;
          let right = serde_json::from_str::<serde_json::Value>(&buf)
            .ok()
            .and_then(|v| v.get("button").and_then(|b| b.as_str()).map(|s| s == "right"))
            .unwrap_or(false);
          if right {
            input_automation::click_right()
          } else {
            input_automation::click_left()
          }
        })();
        match result {
          Ok(()) => {
            let body = br#"{"ok":true}"#.to_vec();
            let response = cors_ok(
              tiny_http::Response::from_data(body).with_header(
                tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                  .unwrap(),
              ),
            );
            let _ = request.respond(response);
          }
          Err(e) => {
            let body = serde_json::json!({ "ok": false, "error": e }).to_string().into_bytes();
            let response = cors_ok(
              tiny_http::Response::from_data(body)
                .with_status_code(500)
                .with_header(
                  tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                    .unwrap(),
                ),
            );
            let _ = request.respond(response);
          }
        }
        return;
      }

      if method == "POST" && url.starts_with("/input/scroll") {
        let mut buf = String::new();
        let _ = request.as_reader().read_to_string(&mut buf);
        let delta = serde_json::from_str::<serde_json::Value>(&buf)
          .ok()
          .and_then(|v| v.get("delta").and_then(|d| d.as_i64()))
          .unwrap_or(-3) as i32;
        match require_active_demo_capture().and_then(|_| input_automation::scroll(delta)) {
          Ok(()) => {
            let body = br#"{"ok":true}"#.to_vec();
            let response = cors_ok(
              tiny_http::Response::from_data(body).with_header(
                tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                  .unwrap(),
              ),
            );
            let _ = request.respond(response);
          }
          Err(e) => {
            let body = serde_json::json!({ "ok": false, "error": e }).to_string().into_bytes();
            let response = cors_ok(
              tiny_http::Response::from_data(body)
                .with_status_code(500)
                .with_header(
                  tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                    .unwrap(),
                ),
            );
            let _ = request.respond(response);
          }
        }
        return;
      }

      if method == "POST" && url.starts_with("/input/type") {
        let mut buf = String::new();
        let _ = request.as_reader().read_to_string(&mut buf);
        let app_for_type = app.clone();
        let parsed: Result<(), String> = (|| {
          let active = require_active_demo_capture()?;
          let v: serde_json::Value =
            serde_json::from_str(&buf).map_err(|e| format!("Invalid JSON: {e}"))?;
          let text = v
            .get("text")
            .and_then(|t| t.as_str())
            .ok_or_else(|| "text required".to_string())?;
          if text.chars().count() > 500 {
            return Err("text too long (max 500 chars)".to_string());
          }
          let delay_ms = v.get("delayMs").and_then(|t| t.as_u64()).unwrap_or(150);
          if let Some(hwnd) = active {
            input_automation::focus_hwnd(hwnd)?;
            std::thread::sleep(std::time::Duration::from_millis(80));
          }
          input_automation::type_text(text, delay_ms, &mut || {
            agent_key_tick(&app_for_type);
            if let Some(pos) = read_caret_screen() {
              emit_caret(&app_for_type, pos);
            }
          })
        })();
        match parsed {
          Ok(()) => {
            let body = br#"{"ok":true}"#.to_vec();
            let response = cors_ok(
              tiny_http::Response::from_data(body).with_header(
                tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                  .unwrap(),
              ),
            );
            let _ = request.respond(response);
          }
          Err(e) => {
            let body = serde_json::json!({ "ok": false, "error": e }).to_string().into_bytes();
            let response = cors_ok(
              tiny_http::Response::from_data(body)
                .with_status_code(400)
                .with_header(
                  tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                    .unwrap(),
                ),
            );
            let _ = request.respond(response);
          }
        }
        return;
      }

      if method == "GET" && (url == "/capture/window_layout" || url.starts_with("/capture/window_layout?")) {
        let q = url.split('?').nth(1).unwrap_or("");
        let mut hwnd: Option<isize> = None;
        let mut title_contains: Option<String> = None;
        for part in q.split('&') {
          let mut it = part.splitn(2, '=');
          let k = it.next().unwrap_or("");
          let v = percent_decode(it.next().unwrap_or(""));
          if k == "hwnd" {
            if let Ok(n) = v.parse::<isize>() {
              hwnd = Some(n);
            }
          } else if k == "titleContains" || k == "title" {
            title_contains = Some(v);
          }
        }
        let resolved = (|| -> Result<input_automation::WindowLayout, String> {
          let h = resolve_capture_hwnd(hwnd, title_contains.as_deref())?;
          input_automation::window_layout(h)
        })();
        match resolved {
          Ok(layout) => {
            let body = serde_json::json!({ "ok": true, "layout": layout }).to_string().into_bytes();
            let response = cors_ok(
              tiny_http::Response::from_data(body).with_header(
                tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                  .unwrap(),
              ),
            );
            let _ = request.respond(response);
          }
          Err(e) => {
            let body = serde_json::json!({ "ok": false, "error": e }).to_string().into_bytes();
            let response = cors_ok(
              tiny_http::Response::from_data(body)
                .with_status_code(400)
                .with_header(
                  tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                    .unwrap(),
                ),
            );
            let _ = request.respond(response);
          }
        }
        return;
      }

      if method == "POST" && (url == "/ocr" || url.starts_with("/ocr?")) {
        let mut buf = String::new();
        let _ = request.as_reader().read_to_string(&mut buf);
        let resolved = (|| -> Result<screen_ocr::OcrResult, String> {
          use base64::Engine as _;
          let v: serde_json::Value =
            serde_json::from_str(&buf).map_err(|e| format!("Invalid JSON: {e}"))?;
          let b64 = v
            .get("pngBase64")
            .and_then(|t| t.as_str())
            .ok_or_else(|| "pngBase64 required".to_string())?;
          let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64.trim())
            .map_err(|e| format!("bad base64: {e}"))?;
          screen_ocr::ocr_png(&bytes)
        })();
        let (status, body) = match resolved {
          Ok(r) => (200, serde_json::json!({ "ok": true, "ocr": r })),
          Err(e) => (400, serde_json::json!({ "ok": false, "error": e })),
        };
        let response = cors_ok(
          tiny_http::Response::from_data(body.to_string().into_bytes())
            .with_status_code(status)
            .with_header(
              tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                .unwrap(),
            ),
        );
        let _ = request.respond(response);
        return;
      }

      if method == "GET" && (url == "/capture/window_shot" || url.starts_with("/capture/window_shot?")) {
        let q = url.split('?').nth(1).unwrap_or("");
        let mut hwnd: Option<isize> = None;
        let mut title_contains: Option<String> = None;
        let mut max_edge: u32 = 1280;
        for part in q.split('&') {
          let mut it = part.splitn(2, '=');
          let k = it.next().unwrap_or("");
          let v = percent_decode(it.next().unwrap_or(""));
          if k == "hwnd" {
            if let Ok(n) = v.parse::<isize>() {
              hwnd = Some(n);
            }
          } else if k == "titleContains" || k == "title" {
            title_contains = Some(v);
          } else if k == "maxEdge" {
            if let Ok(n) = v.parse::<u32>() {
              max_edge = n;
            }
          }
        }
        let resolved = (|| -> Result<(isize, String, input_automation::WindowLayout), String> {
          let h = resolve_capture_hwnd(hwnd, title_contains.as_deref())?;
          let layout = input_automation::window_layout(h)?;
          let png = input_automation::capture_window_png_base64(h, max_edge)?;
          Ok((h, png, layout))
        })();
        match resolved {
          Ok((h, png_b64, layout)) => {
            let body = serde_json::json!({
              "ok": true,
              "hwnd": h,
              "mimeType": "image/png",
              "pngBase64": png_b64,
              "layout": layout,
            })
            .to_string()
            .into_bytes();
            let response = cors_ok(
              tiny_http::Response::from_data(body).with_header(
                tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                  .unwrap(),
              ),
            );
            let _ = request.respond(response);
          }
          Err(e) => {
            let body = serde_json::json!({ "ok": false, "error": e }).to_string().into_bytes();
            let response = cors_ok(
              tiny_http::Response::from_data(body)
                .with_status_code(400)
                .with_header(
                  tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                    .unwrap(),
                ),
            );
            let _ = request.respond(response);
          }
        }
        return;
      }

      let _ = request.respond(tiny_http::Response::empty(404));
}

fn query_param(url: &str, key: &str) -> Option<String> {
  let q = url.split('?').nth(1)?;
  for pair in q.split('&') {
    let mut it = pair.splitn(2, '=');
    let k = it.next().unwrap_or("");
    if k == key {
      return Some(percent_decode(it.next().unwrap_or("")));
    }
  }
  None
}

fn focus_main_window(app: &AppHandle) {
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
  }
}

fn emit_auth_callback(app: &AppHandle, raw_url: &str) {
  let code = query_param(raw_url, "code").unwrap_or_default();
  let state = query_param(raw_url, "state").unwrap_or_default();
  if code.is_empty() {
    return;
  }
  let auth = format!(
    "screenbeaver://auth?code={}&state={}",
    urlencoding_lite(&code),
    urlencoding_lite(&state)
  );
  let _ = app.emit("deep-link://new-url", vec![auth]);
  focus_main_window(app);
}

fn urlencoding_lite(s: &str) -> String {
  let mut out = String::with_capacity(s.len());
  for b in s.bytes() {
    match b {
      b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
        out.push(b as char);
      }
      _ => out.push_str(&format!("%{b:02X}")),
    }
  }
  out
}

/// Store / MSIX already declares `screenbeaver://` in Package.appxmanifest.
/// `register_all()` writes HKCU and overrides that handler with a raw EXE
/// launch, which certification testers hit when they click Open after login.
#[cfg(windows)]
fn is_msix_packaged() -> bool {
  #[link(name = "kernel32")]
  extern "system" {
    fn GetCurrentPackageFullName(length: *mut u32, name: *mut u16) -> i32;
  }
  const APPMODEL_ERROR_NO_PACKAGE: i32 = 15700;
  unsafe {
    let mut len: u32 = 0;
    GetCurrentPackageFullName(&mut len, std::ptr::null_mut()) != APPMODEL_ERROR_NO_PACKAGE
  }
}

#[cfg(windows)]
fn clear_hkcu_protocol_override(scheme: &str) {
  use windows_registry::CURRENT_USER;
  let path = format!("Software\\Classes\\{scheme}");
  let _ = CURRENT_USER.remove_tree(&path);
}

fn percent_decode(s: &str) -> String {
  let bytes = s.as_bytes();
  let mut out = Vec::with_capacity(bytes.len());
  let mut i = 0;
  while i < bytes.len() {
    if bytes[i] == b'%' && i + 2 < bytes.len() {
      let h = |c: u8| -> Option<u8> {
        match c {
          b'0'..=b'9' => Some(c - b'0'),
          b'a'..=b'f' => Some(c - b'a' + 10),
          b'A'..=b'F' => Some(c - b'A' + 10),
          _ => None,
        }
      };
      if let (Some(a), Some(b)) = (h(bytes[i + 1]), h(bytes[i + 2])) {
        out.push((a << 4) | b);
        i += 3;
        continue;
      }
    }
    if bytes[i] == b'+' {
      out.push(b' ');
    } else {
      out.push(bytes[i]);
    }
    i += 1;
  }
  String::from_utf8_lossy(&out).into_owned()
}

fn install_rustls_crypto_provider() {
  // tauri-plugin-http / reqwest pull both rustls `ring` and `aws-lc-rs` features.
  // Without an explicit default, the first HTTPS call panics (WebView / plugin-http).
  let _ = rustls::crypto::ring::default_provider().install_default();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  install_rustls_crypto_provider();
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
      // `deep-link` feature already forwards a lone `exe <url>` argument.
      // MSIX protocol activation can include extra argv — catch those here.
      let extra: Vec<&String> = argv.iter().skip(1).filter(|a| !a.is_empty()).collect();
      let protocol: Vec<String> = extra
        .iter()
        .filter(|a| a.starts_with("screenbeaver://"))
        .map(|a| (*a).clone())
        .collect();
      if protocol.len() != extra.len() || extra.len() != 1 {
        if !protocol.is_empty() {
          let _ = app.emit("deep-link://new-url", protocol);
        }
      }
      focus_main_window(app);
    }))
    .plugin(tauri_plugin_deep_link::init())
    .plugin(tauri_plugin_http::init())
    .manage(HookState::default())
    .invoke_handler(tauri::generate_handler![
      is_desktop,
      extension_bridge_port,
      set_mcp_entitled,
      remote_mcp_status,
      remote_mcp_sync,
      remote_mcp_regenerate_token,
      remote_mcp_refresh_tunnel,
      start_pointer_hook,
      stop_pointer_hook,
      edge_tts_list_voices,
      edge_tts_synthesize,
      agent_report_result,
      agent_cli_capabilities,
      agent_cli_status,
      agent_cli_start,
      agent_cli_stop,
      capture_list_targets,
      capture_start,
      capture_stop,
      capture_open_url,
      capture_open_path,
      read_capture_file,
      android_runtime_status,
      android_ensure_runtime,
      android_list_devices,
      android_usb_note,
      android_start,
      android_stop,
      android_session_active
    ])
    .setup(|app| {
      #[cfg(desktop)]
      {
        use tauri_plugin_deep_link::DeepLinkExt;
        #[cfg(windows)]
        {
          if is_msix_packaged() {
            // Leftover HKCU keys from older builds survive Store uninstall
            // and still override the packaged protocol handler.
            clear_hkcu_protocol_override("screenbeaver");
          } else {
            let _ = app.deep_link().register_all();
          }
        }
        #[cfg(not(windows))]
        {
          let _ = app.deep_link().register_all();
        }
      }
      spawn_extension_bridge(app.handle().clone());
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building Screen Beaver")
    .run(|_app_handle, event| {
      if let tauri::RunEvent::Exit = event {
        remote_mcp::shutdown();
      }
    });
}
