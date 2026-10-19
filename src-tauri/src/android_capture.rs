//! USB Android mirror + control via portable scrcpy/adb (app-local install).
//!
//! Talks only to Android Debug Bridge devices. Does not install system-wide USB
//! filters or claim keyboards/mice/drives on other ports.

use parking_lot::Mutex;
use serde::Serialize;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::native_capture::{media_url_for, CaptureStopResult, CursorSampleDto, TypingBurstDto};

const SCRCPY_VERSION: &str = "4.1";
const SCRCPY_ZIP_NAME: &str = "scrcpy-win64-v4.1.zip";
const SCRCPY_ZIP_URL: &str =
  "https://github.com/Genymobile/scrcpy/releases/download/v4.1/scrcpy-win64-v4.1.zip";
const SCRCPY_ZIP_SHA256: &str = "5b12172b3264b2889f4583ee64752ce832e29bc8b1089dca81093459697165db";
const WINDOW_TITLE: &str = "Screen Beaver Android";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidRuntimeStatus {
  pub ready: bool,
  pub version: String,
  pub runtime_dir: String,
  pub adb_path: String,
  pub scrcpy_path: String,
  pub message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidDevice {
  pub serial: String,
  pub state: String,
  pub model: String,
  pub manufacturer: String,
  pub product: String,
  pub transport: String,
  pub label: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidSessionStarted {
  pub serial: String,
  pub label: String,
  pub window_title: String,
  pub record_path: String,
  pub control: bool,
}

struct MirrorInputTrack {
  cursor: Vec<CursorSampleDto>,
  typing: Vec<TypingBurstDto>,
}

struct AndroidSession {
  child: Child,
  serial: String,
  label: String,
  record_path: PathBuf,
  started: Instant,
  stop_cursor: Arc<AtomicBool>,
  cursor_join: Option<thread::JoinHandle<MirrorInputTrack>>,
}

static SESSION: Mutex<Option<AndroidSession>> = Mutex::new(None);

fn local_app_data() -> PathBuf {
  std::env::var_os("LOCALAPPDATA")
    .map(PathBuf::from)
    .unwrap_or_else(|| std::env::temp_dir())
    .join("screen-weaver")
    .join("android-runtime")
}

fn runtime_root() -> PathBuf {
  local_app_data().join(format!("scrcpy-{SCRCPY_VERSION}"))
}

fn find_exe(root: &Path, name: &str) -> Option<PathBuf> {
  let direct = root.join(name);
  if direct.is_file() {
    return Some(direct);
  }
  if let Ok(rd) = fs::read_dir(root) {
    for ent in rd.flatten() {
      let p = ent.path().join(name);
      if p.is_file() {
        return Some(p);
      }
    }
  }
  None
}

fn adb_path() -> Result<PathBuf, String> {
  find_exe(&runtime_root(), "adb.exe").ok_or_else(|| {
    "Android tools not installed yet. Call android_ensure_runtime first.".into()
  })
}

fn scrcpy_path() -> Result<PathBuf, String> {
  find_exe(&runtime_root(), "scrcpy.exe").ok_or_else(|| {
    "Android tools not installed yet. Call android_ensure_runtime first.".into()
  })
}

pub fn runtime_status() -> AndroidRuntimeStatus {
  let root = runtime_root();
  let adb = find_exe(&root, "adb.exe");
  let scrcpy = find_exe(&root, "scrcpy.exe");
  let ready = adb.is_some() && scrcpy.is_some();
  AndroidRuntimeStatus {
    ready,
    version: SCRCPY_VERSION.into(),
    runtime_dir: root.display().to_string(),
    adb_path: adb
      .as_ref()
      .map(|p| p.display().to_string())
      .unwrap_or_default(),
    scrcpy_path: scrcpy
      .as_ref()
      .map(|p| p.display().to_string())
      .unwrap_or_default(),
    message: if ready {
      "Portable ADB + scrcpy ready (USB debug devices only).".into()
    } else {
      "Android tools will download once (~11 MB) into app data — no system USB driver install.".into()
    },
  }
}

fn run_powershell(script: &str) -> Result<(), String> {
  let output = Command::new("powershell")
    .args([
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ])
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .output()
    .map_err(|e| format!("PowerShell failed to start: {e}"))?;
  if output.status.success() {
    return Ok(());
  }
  let err = String::from_utf8_lossy(&output.stderr);
  let out = String::from_utf8_lossy(&output.stdout);
  Err(format!(
    "Failed to install Android tools: {} {}",
    err.trim(),
    out.trim()
  ))
}

pub fn ensure_runtime() -> Result<AndroidRuntimeStatus, String> {
  let status = runtime_status();
  if status.ready {
    return Ok(status);
  }

  let root = runtime_root();
  fs::create_dir_all(&root).map_err(|e| e.to_string())?;
  let zip_path = local_app_data().join(SCRCPY_ZIP_NAME);
  fs::create_dir_all(local_app_data()).map_err(|e| e.to_string())?;

  let zip_display = zip_path.display().to_string().replace('\'', "''");
  let root_display = root.display().to_string().replace('\'', "''");
  let script = format!(
    r#"
$ErrorActionPreference = 'Stop'
$zip = '{zip}'
$url = '{url}'
$dest = '{dest}'
$expect = '{sha}'.ToLowerInvariant()
if (-not (Test-Path $zip)) {{
  Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
}}
$hash = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLowerInvariant()
if ($hash -ne $expect) {{
  Remove-Item -Force $zip -ErrorAction SilentlyContinue
  throw "SHA256 mismatch for scrcpy zip (got $hash)"
}}
if (Test-Path $dest) {{ Remove-Item -Recurse -Force $dest }}
New-Item -ItemType Directory -Path $dest | Out-Null
Expand-Archive -Path $zip -DestinationPath $dest -Force
"#,
    zip = zip_display,
    url = SCRCPY_ZIP_URL,
    dest = root_display,
    sha = SCRCPY_ZIP_SHA256,
  );

  run_powershell(&script)?;

  let ready = runtime_status();
  if !ready.ready {
    return Err(
      "Downloaded scrcpy zip but adb.exe/scrcpy.exe were not found after extract.".into(),
    );
  }
  Ok(ready)
}

fn adb_cmd() -> Result<Command, String> {
  let adb = adb_path()?;
  let mut cmd = Command::new(&adb);
  if let Some(parent) = adb.parent() {
    cmd.env("ADB", &adb);
    cmd.env("ANDROID_HOME", parent);
    cmd.current_dir(parent);
  }
  Ok(cmd)
}

fn adb_output(args: &[&str]) -> Result<String, String> {
  let mut cmd = adb_cmd()?;
  let output = cmd
    .args(args)
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .output()
    .map_err(|e| format!("adb failed: {e}"))?;
  if !output.status.success() {
    let err = String::from_utf8_lossy(&output.stderr);
    return Err(format!("adb {}: {}", args.join(" "), err.trim()));
  }
  Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn adb_shell_prop(serial: &str, prop: &str) -> String {
  adb_output(&["-s", serial, "shell", "getprop", prop])
    .unwrap_or_default()
    .trim()
    .trim_matches('\r')
    .to_string()
}

fn transport_hint(serial: &str) -> String {
  if serial.contains(':') || serial.starts_with("emulator-") {
    "wifi-or-emulator".into()
  } else {
    "usb".into()
  }
}

pub fn list_devices() -> Result<Vec<AndroidDevice>, String> {
  ensure_runtime()?;
  let _ = adb_output(&["start-server"]);
  let raw = adb_output(&["devices", "-l"])?;
  let mut devices = Vec::new();
  for line in raw.lines() {
    let line = line.trim();
    if line.is_empty() || line.starts_with("List of devices") {
      continue;
    }
    let mut parts = line.split_whitespace();
    let serial = match parts.next() {
      Some(s) => s.to_string(),
      None => continue,
    };
    let state = parts.next().unwrap_or("unknown").to_string();
    let mut model = String::new();
    let mut product = String::new();
    let mut manufacturer = String::new();
    for token in parts {
      if let Some(v) = token.strip_prefix("model:") {
        model = v.replace('_', " ");
      } else if let Some(v) = token.strip_prefix("product:") {
        product = v.to_string();
      }
    }
    if state == "device" {
      if model.is_empty() {
        model = adb_shell_prop(&serial, "ro.product.model");
      }
      manufacturer = adb_shell_prop(&serial, "ro.product.manufacturer");
      if product.is_empty() {
        product = adb_shell_prop(&serial, "ro.product.device");
      }
    }
    let label = if !manufacturer.is_empty() && !model.is_empty() {
      format!("{manufacturer} {model}")
    } else if !model.is_empty() {
      model.clone()
    } else {
      serial.clone()
    };
    devices.push(AndroidDevice {
      serial: serial.clone(),
      state,
      model,
      manufacturer,
      product,
      transport: transport_hint(&serial),
      label,
    });
  }
  Ok(devices)
}

fn capture_dir() -> Result<PathBuf, String> {
  let dir = std::env::temp_dir().join("screen-weaver");
  fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  Ok(dir)
}

fn unique_record_path() -> Result<PathBuf, String> {
  let ms = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis())
    .unwrap_or(0);
  Ok(capture_dir()?.join(format!("android-{ms}.mp4")))
}

fn pick_device(serial: Option<&str>) -> Result<AndroidDevice, String> {
  let devices = list_devices()?;
  if devices.is_empty() {
    return Err(
      "No Android device found. Plug in USB, enable Developer options → USB debugging, then tap Allow."
        .into(),
    );
  }
  if let Some(want) = serial.filter(|s| !s.is_empty()) {
    return devices
      .into_iter()
      .find(|d| d.serial == want)
      .ok_or_else(|| format!("Device {want} is not connected"));
  }
  let ready: Vec<_> = devices
    .iter()
    .filter(|d| d.state == "device" && d.transport == "usb")
    .cloned()
    .collect();
  if ready.len() == 1 {
    return Ok(ready.into_iter().next().unwrap());
  }
  if ready.is_empty() {
    let unauthorized = devices.iter().any(|d| d.state == "unauthorized");
    if unauthorized {
      return Err("Phone is unauthorized — unlock it and allow USB debugging for this PC.".into());
    }
    if let Some(d) = devices.into_iter().find(|d| d.state == "device") {
      return Ok(d);
    }
    return Err("Android device connected but not ready (check USB debugging).".into());
  }
  Err("Multiple Android devices connected — pick one in the UI.".into())
}

pub fn start_session(serial: Option<String>) -> Result<AndroidSessionStarted, String> {
  {
    let guard = SESSION.lock();
    if guard.is_some() {
      return Err("An Android session is already running".into());
    }
  }

  ensure_runtime()?;
  let device = pick_device(serial.as_deref())?;
  if device.state != "device" {
    return Err(format!(
      "Device {} is '{}' — unlock phone and allow USB debugging",
      device.serial, device.state
    ));
  }

  let scrcpy = scrcpy_path()?;
  let record_path = unique_record_path()?;
  let record_str = record_path.display().to_string();

  let mut cmd = Command::new(&scrcpy);
  if let Some(parent) = scrcpy.parent() {
    cmd.current_dir(parent);
    if let Ok(adb) = adb_path() {
      cmd.env("ADB", &adb);
      cmd.env("SCRCPY_SERVER_PATH", parent.join("scrcpy-server"));
    }
  }
  cmd.args([
    "-s",
    &device.serial,
    "--window-title",
    WINDOW_TITLE,
    "--record",
    &record_str,
    "--record-format=mp4",
    "--stay-awake",
    "--disable-screensaver",
    "--max-size=1920",
  ]);
  cmd.stdin(Stdio::null());
  cmd.stdout(Stdio::piped());
  cmd.stderr(Stdio::piped());

  let mut child = cmd
    .spawn()
    .map_err(|e| format!("Failed to start scrcpy: {e}"))?;

  if let Some(stderr) = child.stderr.take() {
    thread::spawn(move || {
      let mut reader = BufReader::new(stderr);
      let mut line = String::new();
      while reader.read_line(&mut line).ok().filter(|n| *n > 0).is_some() {
        eprintln!("[scrcpy] {}", line.trim_end());
        line.clear();
      }
    });
  }
  if let Some(stdout) = child.stdout.take() {
    thread::spawn(move || {
      let mut buf = [0u8; 512];
      let mut r = stdout;
      while r.read(&mut buf).ok().filter(|n| *n > 0).is_some() {}
    });
  }

  thread::sleep(Duration::from_millis(700));
  if let Ok(Some(status)) = child.try_wait() {
    let _ = fs::remove_file(&record_path);
    return Err(format!(
      "scrcpy exited immediately ({status}). Check USB debugging and that only one ADB server is running."
    ));
  }

  let started = AndroidSessionStarted {
    serial: device.serial.clone(),
    label: device.label.clone(),
    window_title: WINDOW_TITLE.into(),
    record_path: record_str,
    control: true,
  };

  let stop_cursor = Arc::new(AtomicBool::new(false));
  let stop_flag = stop_cursor.clone();
  let t0 = Instant::now();
  let cursor_join = Some(thread::spawn(move || sample_mirror_input(stop_flag, t0)));

  *SESSION.lock() = Some(AndroidSession {
    child,
    serial: device.serial,
    label: device.label,
    record_path,
    started: t0,
    stop_cursor,
    cursor_join,
  });

  Ok(started)
}

fn find_mirror_hwnd() -> Option<windows::Win32::Foundation::HWND> {
  use std::os::windows::ffi::OsStrExt;
  use windows::core::PCWSTR;
  use windows::Win32::UI::WindowsAndMessaging::FindWindowW;

  let title: Vec<u16> = std::ffi::OsStr::new(WINDOW_TITLE)
    .encode_wide()
    .chain(std::iter::once(0))
    .collect();
  unsafe {
    FindWindowW(PCWSTR::null(), PCWSTR(title.as_ptr()))
      .ok()
      .filter(|h| !h.0.is_null())
  }
}

fn mirror_is_foreground(hwnd: windows::Win32::Foundation::HWND) -> bool {
  use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
  unsafe { GetForegroundWindow() == hwnd }
}

fn any_typeable_key_down(prev: &mut [bool; 256]) -> bool {
  use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
  // Letters, digits, space, enter, backspace, common OEM punctuation.
  const KEYS: &[i32] = &[
    0x08, 0x0D, 0x20, // back, enter, space
    0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, // 0-9
    0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4A, 0x4B, 0x4C, 0x4D, 0x4E, 0x4F,
    0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5A, // A-Z
    0xBA, 0xBB, 0xBC, 0xBD, 0xBE, 0xBF, 0xC0, 0xDB, 0xDC, 0xDD, 0xDE, // OEM
  ];
  let mut edged = false;
  for &vk in KEYS {
    let down = unsafe { GetAsyncKeyState(vk) } < 0;
    let idx = vk as usize;
    if down && !prev[idx] {
      edged = true;
    }
    prev[idx] = down;
  }
  edged
}

fn coalesce_typing(times: &[f64]) -> Vec<TypingBurstDto> {
  if times.is_empty() {
    return Vec::new();
  }
  let mut out = Vec::new();
  let mut start = times[0];
  let mut end = times[0];
  for &t in &times[1..] {
    if t - end <= 0.55 {
      end = t;
    } else {
      out.push(TypingBurstDto {
        t: start,
        duration: (end - start + 0.28).max(0.35),
      });
      start = t;
      end = t;
    }
  }
  out.push(TypingBurstDto {
    t: start,
    duration: (end - start + 0.28).max(0.35),
  });
  out
}

/// Mouse path + PC keyboard (into scrcpy) + soft-keyboard tap clusters.
fn sample_mirror_input(stop: Arc<AtomicBool>, t0: Instant) -> MirrorInputTrack {
  use windows::Win32::Foundation::{POINT, RECT};
  use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
  use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, GetWindowRect};

  let mut cursor: Vec<CursorSampleDto> = Vec::new();
  let mut key_times: Vec<f64> = Vec::new();
  let mut soft_tap_times: Vec<f64> = Vec::new();
  let mut last_down = false;
  let mut key_prev = [false; 256];

  for _ in 0..80 {
    if stop.load(Ordering::SeqCst) {
      return MirrorInputTrack {
        cursor,
        typing: Vec::new(),
      };
    }
    if find_mirror_hwnd().is_some() {
      break;
    }
    thread::sleep(Duration::from_millis(80));
  }

  while !stop.load(Ordering::SeqCst) {
    let Some(hwnd) = find_mirror_hwnd() else {
      thread::sleep(Duration::from_millis(40));
      continue;
    };

    let t = t0.elapsed().as_secs_f64();
    let focused = mirror_is_foreground(hwnd);

    // PC keyboard → phone via scrcpy while mirror is focused.
    if focused && any_typeable_key_down(&mut key_prev) {
      key_times.push(t);
    }

    unsafe {
      let mut pt = POINT { x: 0, y: 0 };
      if GetCursorPos(&mut pt).is_err() {
        thread::sleep(Duration::from_millis(12));
        continue;
      }
      let mut rect = RECT::default();
      if GetWindowRect(hwnd, &mut rect).is_err() {
        thread::sleep(Duration::from_millis(12));
        continue;
      }
      let border = ((rect.right - rect.left) as f64 * 0.01).clamp(2.0, 8.0) as i32;
      let title = ((rect.bottom - rect.top) as f64 * 0.018).clamp(0.0, 32.0) as i32;
      let left = rect.left + border;
      let top = rect.top + title + border;
      let right = rect.right - border;
      let bottom = rect.bottom - border;
      let cw = (right - left).max(1) as f64;
      let ch = (bottom - top).max(1) as f64;
      let inside = pt.x >= left && pt.y >= top && pt.x <= right && pt.y <= bottom;

      if inside || focused {
        let down = GetAsyncKeyState(VK_LBUTTON.0 as i32) < 0;
        let x = if inside {
          ((pt.x - left) as f64 / cw).clamp(0.0, 1.0)
        } else {
          cursor.last().map(|s| s.x).unwrap_or(0.5)
        };
        let y = if inside {
          ((pt.y - top) as f64 / ch).clamp(0.0, 1.0)
        } else {
          cursor.last().map(|s| s.y).unwrap_or(0.5)
        };

        let edge = down != last_down;
        // Rising edge in lower UI = likely soft keyboard tap.
        if edge && down && inside && y > 0.55 {
          soft_tap_times.push(t);
        }

        if inside
          && (edge
            || cursor.is_empty()
            || cursor.last().map(|s| t - s.t > 0.028).unwrap_or(true))
        {
          cursor.push(CursorSampleDto { t, x, y, down });
        }
        last_down = down;
      }
    }
    thread::sleep(Duration::from_millis(12));
  }

  // Soft-keyboard: only keep tap clusters (≥3 taps with short gaps).
  let mut soft_burst_times = Vec::new();
  if soft_tap_times.len() >= 3 {
    let mut i = 0;
    while i < soft_tap_times.len() {
      let mut j = i + 1;
      while j < soft_tap_times.len() && soft_tap_times[j] - soft_tap_times[j - 1] <= 0.45 {
        j += 1;
      }
      if j - i >= 3 {
        for &tt in &soft_tap_times[i..j] {
          soft_burst_times.push(tt);
        }
      }
      i = j;
    }
  }

  let mut all_keys = key_times;
  all_keys.extend(soft_burst_times);
  all_keys.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

  MirrorInputTrack {
    cursor,
    typing: coalesce_typing(&all_keys),
  }
}

fn close_scrcpy_window() {
  use windows::Win32::Foundation::{LPARAM, WPARAM};
  use windows::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_CLOSE};

  if let Some(hwnd) = find_mirror_hwnd() {
    unsafe {
      let _ = PostMessageW(hwnd, WM_CLOSE, WPARAM(0), LPARAM(0));
    }
  }
}

pub fn stop_session() -> Result<CaptureStopResult, String> {
  let mut session = SESSION
    .lock()
    .take()
    .ok_or_else(|| "No Android session is running".to_string())?;

  session.stop_cursor.store(true, Ordering::SeqCst);
  let track = session
    .cursor_join
    .take()
    .and_then(|j| j.join().ok())
    .unwrap_or(MirrorInputTrack {
      cursor: Vec::new(),
      typing: Vec::new(),
    });

  let duration_hint_ms = session.started.elapsed().as_millis() as u64;
  close_scrcpy_window();

  let deadline = Instant::now() + Duration::from_secs(8);
  loop {
    match session.child.try_wait() {
      Ok(Some(_)) => break,
      Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(150)),
      _ => {
        let _ = session.child.kill();
        let _ = session.child.wait();
        break;
      }
    }
  }

  let path = session.record_path;
  if !path.is_file() {
    return Err(
      "Recording file missing — scrcpy may have failed to start. Try unplug/replug USB.".into(),
    );
  }
  let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
  if meta.len() < 1024 {
    return Err("Recording file is too small — capture likely failed.".into());
  }

  let path_str = path.display().to_string();
  let result = CaptureStopResult {
    path: path_str.clone(),
    media_url: media_url_for(&path_str),
    width: 1080,
    height: 1920,
    duration_ms: duration_hint_ms,
    source_label: format!("Android · {}", session.label),
    cursor: track.cursor,
    typing: track.typing,
    caret: vec![],
    agent_driven: false,
    finalizing: false,
  };

  crate::native_capture::store_last_capture(result.clone());
  let _ = session.serial;
  Ok(result)
}

pub fn session_active() -> bool {
  SESSION.lock().is_some()
}

/// HWND of the scrcpy mirror window (for MCP demo_move / click while phone capture is active).
pub fn active_hwnd() -> Option<isize> {
  find_mirror_hwnd().map(|h| h.0 as isize)
}

pub fn usb_safety_note() -> String {
  "Screen Beaver uses portable ADB in app data. It only addresses Android devices with USB debugging enabled — other USB ports/devices are left alone. Windows may still install a per-phone composite driver the first time you enable debugging; that is normal PnP, not a system-wide USB hijack.".into()
}
