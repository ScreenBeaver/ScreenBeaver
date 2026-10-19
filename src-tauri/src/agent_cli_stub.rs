//! Non-desktop stub — agent CLI hosting unavailable.

use serde::Serialize;
use tauri::AppHandle;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCliProvider {
  pub id: String,
  pub label: String,
  pub command: String,
  pub detected: bool,
  pub path: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCliCapabilities {
  pub pty_available: bool,
  pub providers: Vec<AgentCliProvider>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCliStatus {
  pub running: bool,
  pub session_id: Option<String>,
  pub provider_id: Option<String>,
  pub url: Option<String>,
  pub started_at: Option<u64>,
  pub output_tail: String,
}

pub fn detect_capabilities() -> AgentCliCapabilities {
  AgentCliCapabilities {
    pty_available: false,
    providers: vec![],
  }
}

pub fn current_status() -> AgentCliStatus {
  AgentCliStatus {
    running: false,
    session_id: None,
    provider_id: None,
    url: None,
    started_at: None,
    output_tail: String::new(),
  }
}

pub fn start_session(
  _app: AppHandle,
  _provider_id: String,
  _url: String,
  _product_name: Option<String>,
  _cwd: Option<String>,
) -> Result<AgentCliStatus, String> {
  Err("Agent CLI hosting is only available in the desktop app.".into())
}

pub fn stop_session() -> Result<AgentCliStatus, String> {
  Ok(current_status())
}
