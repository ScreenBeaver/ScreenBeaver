//! Non-desktop stub — remote MCP unavailable.

use serde::Serialize;
use tauri::AppHandle;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMcpStatus {
  pub enabled: bool,
  pub running: bool,
  pub port: u16,
  pub local_url: String,
  pub public_url: Option<String>,
  pub token: Option<String>,
  pub mcp_pid: Option<u32>,
  pub tunnel_pid: Option<u32>,
  pub tunnel_mode: Option<String>,
  pub last_error: Option<String>,
  pub node_found: bool,
}

fn empty() -> RemoteMcpStatus {
  RemoteMcpStatus {
    enabled: false,
    running: false,
    port: 17356,
    local_url: "http://127.0.0.1:17356/mcp".into(),
    public_url: None,
    token: None,
    mcp_pid: None,
    tunnel_pid: None,
    tunnel_mode: None,
    last_error: Some("Remote MCP is only available in the Windows desktop app.".into()),
    node_found: false,
  }
}

pub fn status(_app: &AppHandle) -> RemoteMcpStatus {
  empty()
}

pub fn sync(_app: &AppHandle, _enabled: bool) -> Result<RemoteMcpStatus, String> {
  Err("Remote MCP is only available in the Windows desktop app.".into())
}

pub fn regenerate_token(_app: &AppHandle) -> Result<RemoteMcpStatus, String> {
  Err("Remote MCP is only available in the Windows desktop app.".into())
}

pub fn refresh_tunnel(_app: &AppHandle) -> Result<RemoteMcpStatus, String> {
  Err("Remote MCP is only available in the Windows desktop app.".into())
}

pub fn shutdown() {}
