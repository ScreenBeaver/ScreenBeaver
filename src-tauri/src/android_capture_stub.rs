//! Non-Windows stub — Android USB mirror is desktop Windows only.

use serde::Serialize;

use crate::native_capture::CaptureStopResult;

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

fn unsupported<T>() -> Result<T, String> {
  Err("Android USB capture requires the Windows desktop app".into())
}

pub fn runtime_status() -> AndroidRuntimeStatus {
  AndroidRuntimeStatus {
    ready: false,
    version: String::new(),
    runtime_dir: String::new(),
    adb_path: String::new(),
    scrcpy_path: String::new(),
    message: "Android USB is available in the Windows desktop app only.".into(),
  }
}

pub fn ensure_runtime() -> Result<AndroidRuntimeStatus, String> {
  unsupported()
}

pub fn list_devices() -> Result<Vec<AndroidDevice>, String> {
  unsupported()
}

pub fn start_session(_serial: Option<String>) -> Result<AndroidSessionStarted, String> {
  unsupported()
}

pub fn stop_session() -> Result<CaptureStopResult, String> {
  unsupported()
}

pub fn session_active() -> bool {
  false
}

pub fn active_hwnd() -> Option<isize> {
  None
}

pub fn usb_safety_note() -> String {
  "Android USB requires Windows.".into()
}
