//! Native Windows capture for agent-driven recording (no OS share picker).

use parking_lot::Mutex;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::encoder::{
  AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder,
};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
  ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
  MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};
use windows_capture::window::Window;

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
  /// Local HTTP URL the frontend can load without giant IPC byte arrays.
  pub media_url: String,
  pub width: u32,
  pub height: u32,
  pub duration_ms: u64,
  pub source_label: String,
  /// Optional pointer samples (e.g. Android mirror control).
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub cursor: Vec<CursorSampleDto>,
  /// Typing bursts (PC keyboard into scrcpy, or soft-keyboard tap clusters).
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub typing: Vec<TypingBurstDto>,
}

struct CaptureSession {
  stop: Arc<AtomicBool>,
  join: Option<thread::JoinHandle<Result<CaptureStopResult, String>>>,
  source_label: String,
  /// HWND of captured window (None for monitor capture).
  hwnd: Option<isize>,
}

static SESSION: Mutex<Option<CaptureSession>> = Mutex::new(None);
static LAST_CAPTURE_PATH: Mutex<Option<String>> = Mutex::new(None);
static LAST_CAPTURE_META: Mutex<Option<CaptureStopResult>> = Mutex::new(None);

pub fn media_url_for(path: &str) -> String {
  format!(
    "http://127.0.0.1:17355/capture/file?path={}",
    urlencoding_lite(path)
  )
}

fn urlencoding_lite(s: &str) -> String {
  let mut out = String::with_capacity(s.len() * 2);
  for b in s.bytes() {
    match b {
      b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
        out.push(b as char)
      }
      b' ' => out.push_str("%20"),
      b'\\' => out.push_str("%5C"),
      b':' => out.push_str("%3A"),
      _ => out.push_str(&format!("%{b:02X}")),
    }
  }
  out
}

pub fn last_capture_path() -> Option<String> {
  LAST_CAPTURE_PATH.lock().clone()
}

pub fn last_capture_meta() -> Option<CaptureStopResult> {
  LAST_CAPTURE_META.lock().clone()
}

/// Allow Android / other capture paths to publish the same stop payload shape.
pub fn store_last_capture(result: CaptureStopResult) {
  *LAST_CAPTURE_PATH.lock() = Some(result.path.clone());
  *LAST_CAPTURE_META.lock() = Some(result);
}

pub fn active_hwnd() -> Option<isize> {
  SESSION.lock().as_ref().and_then(|s| s.hwnd)
}

/// Sandbox: only files under %TEMP%/screen-weaver may be served.
pub fn resolve_capture_file(path: &str) -> Result<PathBuf, String> {
  let p = PathBuf::from(path);
  let tmp = std::env::temp_dir().join("screen-weaver");
  let canon = p.canonicalize().map_err(|e| e.to_string())?;
  let tmp_canon = tmp.canonicalize().unwrap_or(tmp);
  if !canon.starts_with(&tmp_canon) {
    return Err("Path is outside the Screen Beaver capture directory".into());
  }
  if !canon.is_file() {
    return Err("Capture file not found".into());
  }
  Ok(canon)
}

pub fn list_targets() -> Result<Vec<CaptureTarget>, String> {
  let mut out = Vec::new();

  if let Ok(windows) = Window::enumerate() {
    for w in windows {
      if !w.is_valid() {
        continue;
      }
      let title = w.title().unwrap_or_default();
      if title.trim().is_empty() {
        continue;
      }
      let process_name = w.process_name().unwrap_or_default();
      let width = w.width().unwrap_or(0).max(0) as u32;
      let height = w.height().unwrap_or(0).max(0) as u32;
      if width < 80 || height < 80 {
        continue;
      }
      let hwnd = w.as_raw_hwnd() as usize;
      out.push(CaptureTarget {
        id: format!("window:{hwnd}"),
        kind: "window".into(),
        title,
        process_name,
        width,
        height,
      });
    }
  }

  if let Ok(monitors) = Monitor::enumerate() {
    for (i, m) in monitors.into_iter().enumerate() {
      let name = m.name().unwrap_or_else(|_| format!("Monitor {}", i + 1));
      let width = m.width().unwrap_or(0);
      let height = m.height().unwrap_or(0);
      out.push(CaptureTarget {
        id: format!("monitor:{i}"),
        kind: "monitor".into(),
        title: name,
        process_name: String::new(),
        width,
        height,
      });
    }
  }

  Ok(out)
}

enum CaptureItem {
  Window(Window),
  Monitor(Monitor),
}

fn resolve_target(
  window_id: Option<&str>,
  title_contains: Option<&str>,
) -> Result<(CaptureItem, String, u32, u32), String> {
  if let Some(id) = window_id {
    if let Some(idx_str) = id.strip_prefix("monitor:") {
      let idx: usize = idx_str
        .parse()
        .map_err(|_| format!("Invalid monitor id: {id}"))?;
      let monitors = Monitor::enumerate().map_err(|e| e.to_string())?;
      let m = monitors
        .into_iter()
        .nth(idx)
        .ok_or_else(|| format!("Monitor index {idx} out of range"))?;
      let label = m.name().unwrap_or_else(|_| format!("Monitor {}", idx + 1));
      let w = m.width().unwrap_or(1920);
      let h = m.height().unwrap_or(1080);
      return Ok((CaptureItem::Monitor(m), label, w, h));
    }

    if let Some(hwnd_str) = id.strip_prefix("window:") {
      let hwnd = hwnd_str
        .parse::<usize>()
        .map_err(|_| format!("Invalid window id: {id}"))?;
      let w = Window::from_raw_hwnd(hwnd as *mut std::ffi::c_void);
      if !w.is_valid() {
        return Err("Window is no longer valid".into());
      }
      let label = w.title().unwrap_or_else(|_| id.to_string());
      let width = w.width().unwrap_or(1280).max(2) as u32;
      let height = w.height().unwrap_or(720).max(2) as u32;
      return Ok((CaptureItem::Window(w), label, width, height));
    }

    return Err(format!("Unknown target id: {id}"));
  }

  if let Some(sub) = title_contains {
    let sub_l = sub.to_lowercase();
    let windows = Window::enumerate().map_err(|e| e.to_string())?;
    let mut best: Option<(Window, String, u64)> = None;
    for w in windows {
      if !w.is_valid() {
        continue;
      }
      let title = w.title().unwrap_or_default();
      let proc = w.process_name().unwrap_or_default();
      let title_l = title.to_lowercase();
      let proc_l = proc.to_lowercase();
      if title_l.contains("screen weaver") || proc_l.contains("screen-weaver") {
        continue;
      }
      if title_l.contains(&sub_l) || proc_l.contains(&sub_l) {
        let width = w.width().unwrap_or(1280).max(2) as u32;
        let height = w.height().unwrap_or(720).max(2) as u32;
        let area = (width as u64).saturating_mul(height as u64);
        let take = match &best {
          None => true,
          Some((_, _, best_area)) => area > *best_area,
        };
        if take {
          best = Some((w, title, area));
        }
      }
    }
    if let Some((w, title, _)) = best {
      let width = w.width().unwrap_or(1280).max(2) as u32;
      let height = w.height().unwrap_or(720).max(2) as u32;
      return Ok((CaptureItem::Window(w), title, width, height));
    }
    return Err(format!("No window matching \"{sub}\""));
  }

  Err("Provide windowId or titleContains".into())
}

struct Handler {
  encoder: Option<VideoEncoder>,
  stop: Arc<AtomicBool>,
  path: PathBuf,
  frames: u64,
  width: u32,
  height: u32,
}

impl GraphicsCaptureApiHandler for Handler {
  type Flags = (u32, u32, PathBuf, Arc<AtomicBool>);
  type Error = Box<dyn std::error::Error + Send + Sync>;

  fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
    let (width, height, path, stop) = ctx.flags;
    Ok(Self {
      encoder: None,
      stop,
      path,
      frames: 0,
      width,
      height,
    })
  }

  fn on_frame_arrived(
    &mut self,
    frame: &mut Frame,
    capture_control: InternalCaptureControl,
  ) -> Result<(), Self::Error> {
    let stopping = self.stop.load(Ordering::SeqCst);

    // Encoder size must match the actual capture buffer (DPI / chrome can differ
    // from Window::width/height). Create lazily from the first real frame.
    if self.encoder.is_none() {
      let fw = frame.width().max(2) & !1;
      let fh = frame.height().max(2) & !1;
      self.width = fw;
      self.height = fh;
      let encoder = VideoEncoder::new(
        VideoSettingsBuilder::new(fw, fh),
        AudioSettingsBuilder::default().disabled(true),
        ContainerSettingsBuilder::default(),
        &self.path,
      )?;
      self.encoder = Some(encoder);
    }

    if let Some(enc) = self.encoder.as_mut() {
      enc.send_frame(frame)?;
      self.frames = self.frames.saturating_add(1);
    }

    if stopping {
      if let Some(enc) = self.encoder.take() {
        enc.finish()?;
      }
      capture_control.stop();
    }
    Ok(())
  }

  fn on_closed(&mut self) -> Result<(), Self::Error> {
    if let Some(enc) = self.encoder.take() {
      enc.finish()?;
    }
    Ok(())
  }
}

fn temp_mp4_path() -> PathBuf {
  let stamp = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis())
    .unwrap_or(0);
  let mut dir = std::env::temp_dir();
  dir.push("screen-weaver");
  let _ = std::fs::create_dir_all(&dir);
  dir.push(format!("capture-{stamp}.mp4"));
  dir
}

pub fn is_recording() -> bool {
  SESSION.lock().is_some()
}

pub fn start_capture(
  window_id: Option<String>,
  title_contains: Option<String>,
) -> Result<serde_json::Value, String> {
  let mut slot = SESSION.lock();
  if slot.is_some() {
    return Err("A native capture is already running".into());
  }

  let (item, label, width, height) =
    resolve_target(window_id.as_deref(), title_contains.as_deref())?;
  let hwnd = match &item {
    CaptureItem::Window(w) => Some(w.as_raw_hwnd() as isize),
    CaptureItem::Monitor(_) => None,
  };
  // Even dimensions required by many encoders
  let width = width & !1;
  let height = height & !1;
  let path = temp_mp4_path();
  let stop = Arc::new(AtomicBool::new(false));
  let stop_thread = stop.clone();
  let path_thread = path.clone();
  let label_thread = label.clone();

  let join = thread::spawn(move || {
    let flags = (width, height, path_thread.clone(), stop_thread);
    let started = Instant::now();

    let start_result = match item {
      CaptureItem::Window(w) => {
        let settings = Settings::new(
          w,
          CursorCaptureSettings::WithoutCursor,
          DrawBorderSettings::Default,
          SecondaryWindowSettings::Default,
          MinimumUpdateIntervalSettings::Default,
          DirtyRegionSettings::Default,
          ColorFormat::Bgra8,
          flags,
        );
        Handler::start(settings).map_err(|e| e.to_string())
      }
      CaptureItem::Monitor(m) => {
        let settings = Settings::new(
          m,
          CursorCaptureSettings::WithoutCursor,
          DrawBorderSettings::Default,
          SecondaryWindowSettings::Default,
          MinimumUpdateIntervalSettings::Default,
          DirtyRegionSettings::Default,
          ColorFormat::Bgra8,
          flags,
        );
        Handler::start(settings).map_err(|e| e.to_string())
      }
    };

    start_result?;

    let path_str = path_thread.to_string_lossy().to_string();
    Ok(CaptureStopResult {
      path: path_str.clone(),
      media_url: media_url_for(&path_str),
      width,
      height,
      duration_ms: started.elapsed().as_millis().max(1) as u64,
      source_label: label_thread,
      cursor: vec![],
      typing: vec![],
    })
  });

  *slot = Some(CaptureSession {
    stop,
    join: Some(join),
    source_label: label.clone(),
    hwnd,
  });

  Ok(serde_json::json!({
    "ok": true,
    "recording": true,
    "sourceLabel": label,
    "width": width,
    "height": height,
    "path": path.to_string_lossy(),
    "hwnd": hwnd,
  }))
}

pub fn stop_capture() -> Result<CaptureStopResult, String> {
  let mut session = SESSION
    .lock()
    .take()
    .ok_or_else(|| "No native capture is running".to_string())?;
  session.stop.store(true, Ordering::SeqCst);
  let join = session
    .join
    .take()
    .ok_or_else(|| "Capture thread missing".to_string())?;

  thread::sleep(Duration::from_millis(250));

  match join.join() {
    Ok(Ok(mut result)) => {
      if result.source_label.is_empty() {
        result.source_label = session.source_label;
      }
      // Encoder may still be flushing — brief settle before import.
      thread::sleep(Duration::from_millis(400));
      if result.media_url.is_empty() {
        result.media_url = media_url_for(&result.path);
      }
      *LAST_CAPTURE_PATH.lock() = Some(result.path.clone());
      *LAST_CAPTURE_META.lock() = Some(result.clone());
      Ok(result)
    }
    Ok(Err(e)) => Err(e),
    Err(_) => Err("Capture thread panicked".into()),
  }
}

pub fn open_url(url: &str) -> Result<(), String> {
  let u = if url.starts_with("http://") || url.starts_with("https://") {
    url.to_string()
  } else {
    format!("https://{url}")
  };
  open::that(&u).map_err(|e| e.to_string())
}

pub fn open_path(path: &str) -> Result<(), String> {
  let trimmed = path.trim();
  if trimmed.is_empty() {
    return Err("Empty path".into());
  }
  // Store / security: never launch scripts or shells via the local bridge.
  let lower = trimmed.to_ascii_lowercase();
  const BLOCKED: &[&str] = &[
    ".ps1", ".bat", ".cmd", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh", ".msi",
    ".scr", ".com", ".cpl", ".reg", ".lnk",
  ];
  if BLOCKED.iter().any(|ext| lower.ends_with(ext)) {
    return Err(
      "Opening script/installer paths is blocked. Use open_url for https links, or open a normal app/document."
        .into(),
    );
  }
  let base = std::path::Path::new(trimmed)
    .file_name()
    .and_then(|n| n.to_str())
    .unwrap_or("")
    .to_ascii_lowercase();
  const BLOCKED_NAMES: &[&str] = &[
    "powershell.exe",
    "pwsh.exe",
    "cmd.exe",
    "wscript.exe",
    "cscript.exe",
    "mshta.exe",
    "rundll32.exe",
    "regsvr32.exe",
  ];
  if BLOCKED_NAMES.iter().any(|n| base == *n) {
    return Err("Opening system shells/script hosts is blocked.".into());
  }
  open::that(trimmed).map_err(|e| e.to_string())
}
