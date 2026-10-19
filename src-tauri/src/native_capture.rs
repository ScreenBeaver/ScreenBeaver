//! Native Windows capture for agent-driven recording (no OS share picker).

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
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

#[derive(Clone, Serialize, Deserialize)]
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
pub struct CaretSampleDto {
  pub t: f64,
  pub x: f64,
  pub y: f64,
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
  /// Text-caret positions while typing, on the same clock as `cursor`.
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub caret: Vec<CaretSampleDto>,
  /// Input during the take came from the agent (/input/*), not a human hand.
  #[serde(default)]
  pub agent_driven: bool,
  /// Encoder is still writing the MP4 — not importable until a later stop/last says false.
  #[serde(default)]
  pub finalizing: bool,
}

struct CaptureSession {
  started: Instant,
  stop: Arc<AtomicBool>,
  join: Option<thread::JoinHandle<Result<CaptureStopResult, String>>>,
  source_label: String,
  /// HWND of captured window (None for monitor capture).
  hwnd: Option<isize>,
  path: PathBuf,
  width: u32,
  height: u32,
}

static SESSION: Mutex<Option<CaptureSession>> = Mutex::new(None);
static LAST_CAPTURE_PATH: Mutex<Option<String>> = Mutex::new(None);
static LAST_CAPTURE_META: Mutex<Option<CaptureStopResult>> = Mutex::new(None);
/// Pointer samples for Auto zooms — survive stop timeouts via `.cursor.json` sidecar.
static CURSOR_LOG: Mutex<Vec<CursorSampleDto>> = Mutex::new(Vec::new());
static CURSOR_T0: Mutex<Option<Instant>> = Mutex::new(None);
/// Typing key times + caret samples, timed like CURSOR_LOG so zooms never depend on WebView events.
static TYPING_LOG: Mutex<Vec<f64>> = Mutex::new(Vec::new());
static CARET_LOG: Mutex<Vec<CaretSampleDto>> = Mutex::new(Vec::new());
static AGENT_DRIVEN: AtomicBool = AtomicBool::new(false);
/// Stop returned but the encoder is still flushing frames into this MP4.
static FINALIZING: Mutex<Option<CaptureStopResult>> = Mutex::new(None);
type FinalizeHook = Box<dyn Fn(&CaptureStopResult, bool) + Send + Sync>;
/// Called once the MP4 is complete after a slow flush; bool = caller wants auto-import.
static FINALIZE_HOOK: Mutex<Option<FinalizeHook>> = Mutex::new(None);

pub fn set_finalize_hook(hook: FinalizeHook) {
  *FINALIZE_HOOK.lock() = Some(hook);
}

pub fn is_finalizing() -> bool {
  FINALIZING.lock().is_some()
}

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
  if let Some(pending) = FINALIZING.lock().clone() {
    return Some(pending);
  }
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
    // Prefer browser windows; skip chat/IDE titles that mention the product (e.g. Claude chat "Canva…").
    let mut best: Option<(Window, String, u64, u8)> = None;
    for w in windows {
      if !w.is_valid() {
        continue;
      }
      let title = w.title().unwrap_or_default();
      let proc = w.process_name().unwrap_or_default();
      let title_l = title.to_lowercase();
      let proc_l = proc.to_lowercase();
      if is_excluded_capture_window(&title_l, &proc_l) {
        continue;
      }
      if title_l.contains(&sub_l) || proc_l.contains(&sub_l) {
        let width = w.width().unwrap_or(1280).max(2) as u32;
        let height = w.height().unwrap_or(720).max(2) as u32;
        let area = (width as u64).saturating_mul(height as u64);
        let rank: u8 = if is_browser_process(&proc_l) { 2 } else { 1 };
        let take = match &best {
          None => true,
          Some((_, _, best_area, best_rank)) => {
            rank > *best_rank || (rank == *best_rank && area > *best_area)
          }
        };
        if take {
          best = Some((w, title, area, rank));
        }
      }
    }
    if let Some((w, title, _, _)) = best {
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
      // 30 fps / 10 Mbps keeps the encoder at or above real time on big windows;
      // 60 fps / 15 Mbps backed up for minutes after stop on long takes.
      let encoder = VideoEncoder::new(
        VideoSettingsBuilder::new(fw, fh).frame_rate(30).bitrate(10_000_000),
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

pub fn begin_cursor_log() {
  CURSOR_LOG.lock().clear();
  TYPING_LOG.lock().clear();
  CARET_LOG.lock().clear();
  AGENT_DRIVEN.store(false, Ordering::SeqCst);
  *CURSOR_T0.lock() = Some(Instant::now());
}

fn take_clock() -> Option<f64> {
  if !is_recording() {
    return None;
  }
  CURSOR_T0.lock().map(|t0| t0.elapsed().as_secs_f64())
}

pub fn mark_agent_driven() {
  if is_recording() {
    AGENT_DRIVEN.store(true, Ordering::SeqCst);
  }
}

pub fn push_typing_tick() {
  let Some(t) = take_clock() else { return };
  let mut log = TYPING_LOG.lock();
  if log.len() < 50_000 {
    log.push(t);
  }
}

pub fn push_caret_sample(x: f64, y: f64) {
  let Some(t) = take_clock() else { return };
  let mut log = CARET_LOG.lock();
  if let Some(last) = log.last() {
    if (last.x - x).abs() < 1e-5 && (last.y - y).abs() < 1e-5 && t - last.t < 0.25 {
      return;
    }
  }
  if log.len() < 50_000 {
    log.push(CaretSampleDto { t, x, y });
  }
}

/// Same merge rule as the studio: keys within ~0.55 s form one typing burst.
fn coalesce_typing(ticks: &[f64]) -> Vec<TypingBurstDto> {
  let mut out = Vec::new();
  let Some(&first) = ticks.first() else { return out };
  let (mut start, mut end) = (first, first + 0.35);
  for &t in &ticks[1..] {
    if t <= end + 0.55 {
      end = end.max(t + 0.35);
    } else {
      out.push(TypingBurstDto { t: start, duration: (end - start).max(0.45) });
      start = t;
      end = t + 0.35;
    }
  }
  out.push(TypingBurstDto { t: start, duration: (end - start).max(0.45) });
  out
}

/// Drain typing bursts, caret samples and the agent flag for the take being stopped.
fn take_input_extras() -> (Vec<TypingBurstDto>, Vec<CaretSampleDto>, bool) {
  let ticks = std::mem::take(&mut *TYPING_LOG.lock());
  let caret = std::mem::take(&mut *CARET_LOG.lock());
  (coalesce_typing(&ticks), caret, AGENT_DRIVEN.swap(false, Ordering::SeqCst))
}

pub fn push_cursor_sample(x: f64, y: f64, down: bool) {
  let Some(t) = take_clock() else { return };
  let mut log = CURSOR_LOG.lock();
  // ~25 Hz is enough for Auto zooms / clicks. Throttle by dropping, never by replacing:
  // a still pointer (agent between steps) must keep emitting samples or the editor
  // reads the gap as "no cursor" and hides it / stops following.
  if let Some(last) = log.last() {
    if !down && !last.down && (t - last.t) < 0.04 {
      return;
    }
  }
  if log.len() < 60_000 {
    log.push(CursorSampleDto { t, x, y, down });
  }
  // Flush sidecar periodically so a stop timeout still has Auto-zoom data.
  if log.len() % 40 == 0 {
    if let Some(path) = LAST_CAPTURE_PATH.lock().clone() {
      write_cursor_sidecar(&PathBuf::from(path), &log);
    }
  }
}

fn cursor_sidecar_path(mp4: &PathBuf) -> PathBuf {
  let mut p = mp4.clone();
  p.set_extension("cursor.json");
  p
}

fn write_cursor_sidecar(mp4: &PathBuf, samples: &[CursorSampleDto]) {
  if samples.is_empty() {
    return;
  }
  let path = cursor_sidecar_path(mp4);
  if let Ok(json) = serde_json::to_string(samples) {
    let _ = std::fs::write(path, json);
  }
}

fn load_cursor_sidecar(mp4: &PathBuf) -> Vec<CursorSampleDto> {
  let path = cursor_sidecar_path(mp4);
  let Ok(raw) = std::fs::read_to_string(path) else {
    return vec![];
  };
  serde_json::from_str(&raw).unwrap_or_default()
}

pub fn take_cursor_log() -> Vec<CursorSampleDto> {
  std::mem::take(&mut *CURSOR_LOG.lock())
}

fn capture_dir() -> PathBuf {
  let mut dir = std::env::temp_dir();
  dir.push("screen-weaver");
  let _ = std::fs::create_dir_all(&dir);
  dir
}

fn meta_from_path(
  path: &PathBuf,
  source_label: &str,
  width: u32,
  height: u32,
  duration_ms: u64,
) -> Option<CaptureStopResult> {
  let meta = std::fs::metadata(path).ok()?;
  if meta.len() < 1024 {
    return None;
  }
  let path_str = path.to_string_lossy().to_string();
  Some(CaptureStopResult {
    path: path_str.clone(),
    media_url: media_url_for(&path_str),
    width: width.max(2),
    height: height.max(2),
    duration_ms: duration_ms.max(1),
    source_label: source_label.to_string(),
    cursor: vec![],
    typing: vec![],
    caret: vec![],
    agent_driven: false,
    finalizing: false,
  })
}

/// Real take length for recovered files: last cursor sample, else filename stamp → mtime.
fn recovered_duration_ms(path: &PathBuf, cursor: &[CursorSampleDto]) -> u64 {
  if let Some(last) = cursor.last() {
    if last.t > 0.5 {
      return (last.t * 1000.0) as u64;
    }
  }
  let stamp = path
    .file_stem()
    .and_then(|s| s.to_str())
    .and_then(|s| s.strip_prefix("capture-"))
    .and_then(|s| s.parse::<u128>().ok());
  let modified = std::fs::metadata(path)
    .and_then(|m| m.modified())
    .ok()
    .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
    .map(|d| d.as_millis());
  match (stamp, modified) {
    (Some(s), Some(m)) if m > s => (m - s) as u64,
    _ => 1,
  }
}

/// Newest finished `capture-*.mp4` under the temp capture dir (import recovery).
pub fn recover_newest_capture() -> Option<CaptureStopResult> {
  if let Some(pending) = FINALIZING.lock().clone() {
    return Some(pending);
  }
  let dir = capture_dir();
  let mut best: Option<(std::time::SystemTime, PathBuf, u64)> = None;
  let entries = std::fs::read_dir(&dir).ok()?;
  for ent in entries.flatten() {
    let path = ent.path();
    let name = path.file_name()?.to_string_lossy();
    if !name.starts_with("capture-") || !name.ends_with(".mp4") {
      continue;
    }
    let meta = ent.metadata().ok()?;
    let len = meta.len();
    if len < 8_192 {
      continue;
    }
    let modified = meta.modified().ok().unwrap_or(std::time::UNIX_EPOCH);
    // Still being written (live take or a flush we don't own) — not a finished MP4.
    if modified.elapsed().map(|e| e < Duration::from_secs(4)).unwrap_or(false) {
      continue;
    }
    let take = match &best {
      None => true,
      Some((t, _, _)) => modified > *t,
    };
    if take {
      best = Some((modified, path, len));
    }
  }
  let (_, path, _) = best?;
  let cursor = load_cursor_sidecar(&path);
  let duration = recovered_duration_ms(&path, &cursor);
  let mut result = meta_from_path(&path, "Recovered capture", 1280, 720, duration)?;
  result.cursor = cursor;
  store_last_capture(result.clone());
  Some(result)
}

fn is_browser_process(proc_l: &str) -> bool {
  proc_l.contains("msedge")
    || proc_l.contains("chrome")
    || proc_l.contains("firefox")
    || proc_l.contains("brave")
    || proc_l.contains("opera")
    || proc_l.contains("chromium")
}

/// Skip Screen Beaver / chat **apps**. Do NOT exclude Edge/Chrome just because the
/// window title mentions "Claude" or "Cursor" (other tabs change the title).
pub fn is_excluded_capture_window(title_l: &str, proc_l: &str) -> bool {
  if proc_l.contains("screen-weaver")
    || proc_l.contains("screen_weaver")
    || proc_l.contains("claude")
    || proc_l.contains("cursor")
    || proc_l.contains("discord")
    || proc_l.contains("slack")
    || proc_l.contains("windsurf")
  {
    return true;
  }
  // Browser windows: never exclude by title (tab strip often includes chat names).
  if is_browser_process(proc_l) {
    return false;
  }
  title_l.contains("screen weaver")
    || title_l.contains("screen beaver")
    || title_l.contains("claude")
    || title_l.contains("chatgpt")
    || title_l.contains("cursor")
    || title_l.contains("windsurf")
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
          MinimumUpdateIntervalSettings::Custom(Duration::from_millis(33)),
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
          MinimumUpdateIntervalSettings::Custom(Duration::from_millis(33)),
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
      caret: vec![],
      agent_driven: false,
      finalizing: false,
    })
  });

  // Remember path immediately so import can recover even if stop times out.
  *LAST_CAPTURE_PATH.lock() = Some(path.to_string_lossy().to_string());
  begin_cursor_log();

  *slot = Some(CaptureSession {
    started: Instant::now(),
    stop,
    join: Some(join),
    source_label: label.clone(),
    hwnd,
    path: path.clone(),
    width,
    height,
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
  stop_capture_ex(false)
}

/// Stop recording. If the encoder needs longer than a few seconds to flush, returns
/// right away with `finalizing: true` and the real take length; the MP4 is only
/// published (last_capture_meta, finalize hook) once it is complete and playable.
/// `auto_import` is forwarded to the finalize hook for callers that don't poll.
pub fn stop_capture_ex(auto_import: bool) -> Result<CaptureStopResult, String> {
  let mut session = match SESSION.lock().take() {
    Some(s) => s,
    None => {
      // Session already gone (prior stop timed out on the client) — recover for import.
      if let Some(meta) = last_capture_meta() {
        return Ok(meta);
      }
      return recover_newest_capture()
        .ok_or_else(|| "No native capture is running".to_string());
    }
  };
  let duration_ms = session.started.elapsed().as_millis().max(1) as u64;
  session.stop.store(true, Ordering::SeqCst);
  let path = session.path.clone();
  let width = session.width;
  let height = session.height;
  let label = session.source_label.clone();
  let join = session
    .join
    .take()
    .ok_or_else(|| "Capture thread missing".to_string())?;

  let cursor = take_cursor_log();
  write_cursor_sidecar(&path, &cursor);
  let (typing, caret, agent_driven) = take_input_extras();

  let path_str = path.to_string_lossy().to_string();
  let base = CaptureStopResult {
    path: path_str.clone(),
    media_url: media_url_for(&path_str),
    width,
    height,
    duration_ms,
    source_label: label.clone(),
    cursor,
    typing,
    caret,
    agent_driven,
    finalizing: false,
  };

  let (tx, rx) = std::sync::mpsc::channel();
  thread::spawn(move || {
    let _ = tx.send(join.join());
  });

  let finish = move |joined: Result<Result<CaptureStopResult, String>, Box<dyn std::any::Any + Send>>,
                     base: CaptureStopResult|
        -> Result<CaptureStopResult, String> {
    let mut result = match joined {
      Ok(Ok(r)) => CaptureStopResult {
        width: r.width.max(2),
        height: r.height.max(2),
        ..base
      },
      Ok(Err(e)) => {
        if meta_from_path(&path, &label, width, height, duration_ms).is_none() {
          return Err(e);
        }
        base
      }
      Err(_) => return Err("Capture thread panicked".into()),
    };
    result.finalizing = false;
    write_cursor_sidecar(&path, &result.cursor);
    store_last_capture(result.clone());
    Ok(result)
  };

  const QUICK_WAIT: Duration = Duration::from_secs(15);
  match rx.recv_timeout(QUICK_WAIT) {
    Ok(joined) => finish(joined, base),
    Err(_) => {
      let pending = CaptureStopResult {
        finalizing: true,
        ..base.clone()
      };
      *FINALIZING.lock() = Some(pending.clone());
      thread::spawn(move || {
        let outcome = rx
          .recv()
          .map_err(|_| "Capture thread vanished".to_string())
          .and_then(|joined| finish(joined, base));
        *FINALIZING.lock() = None;
        if let Ok(done) = outcome {
          if let Some(hook) = FINALIZE_HOOK.lock().as_ref() {
            hook(&done, auto_import);
          }
        }
      });
      Ok(pending)
    }
  }
}

pub fn open_url(url: &str) -> Result<(), String> {
  if is_recording() {
    return Err(
      "Capture is running — do not open new browser tabs mid-take. Screenshot the existing product window instead."
        .into(),
    );
  }
  let lower = url.to_ascii_lowercase();
  // Allow Office app protocols so agents can open real desktop Excel/Word/etc.
  let u = if lower.starts_with("http://")
    || lower.starts_with("https://")
    || lower.starts_with("ms-excel:")
    || lower.starts_with("ms-word:")
    || lower.starts_with("ms-powerpoint:")
  {
    url.to_string()
  } else {
    format!("https://{url}")
  };

  // HTTP(S): open as a **new tab** in the existing Edge/Chrome window (not a new window).
  #[cfg(windows)]
  if u.starts_with("http://") || u.starts_with("https://") {
    if open_http_browser_tab(&u).is_ok() {
      return Ok(());
    }
  }

  open::that(&u).map_err(|e| e.to_string())
}

#[cfg(windows)]
fn open_http_browser_tab(url: &str) -> Result<(), String> {
  use std::os::windows::process::CommandExt;
  use std::process::Command;
  const CREATE_NO_WINDOW: u32 = 0x0800_0000;

  let candidates: &[&str] = &[
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
  ];
  for exe in candidates {
    if !std::path::Path::new(exe).is_file() {
      continue;
    }
    // No --new-window → Chromium opens a new tab in the existing window.
    Command::new(exe)
      .arg(url)
      .creation_flags(CREATE_NO_WINDOW)
      .spawn()
      .map_err(|e| e.to_string())?;
    return Ok(());
  }
  Err("No Edge/Chrome found".into())
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
