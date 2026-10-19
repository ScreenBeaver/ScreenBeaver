//! Remote MCP (Streamable HTTP) for Pro/Team.
//! Prefers branded `mcp.screenbeaver.com` relay; falls back to Cloudflare quick tunnel.

use parking_lot::Mutex;
use serde::Serialize;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const DEFAULT_PORT: u16 = 17356;
const CLOUDFLARED_EXE: &str = "cloudflared.exe";
const CLOUDFLARED_URL: &str =
  "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";
/// Portable Node runtime (shipped on first Remote MCP start — users do not install Node).
const NODE_EXE: &str = "node.exe";
const NODE_DIST_VERSION: &str = "v22.14.0";
const NODE_DIST_ZIP: &str = "node-v22.14.0-win-x64.zip";
const TOKEN_FILE: &str = "remote_mcp_token";
/// Branded public host (Cloudflare Worker relay). Override with SCREEN_BEAVER_MCP_RELAY.
const DEFAULT_RELAY_BASE: &str = "https://mcp.screenbeaver.com";

/// Cache resolved node.exe so status polls never re-scan PATH.
static NODE_PATH: Mutex<Option<String>> = Mutex::new(None);

fn hide_console(cmd: &mut Command) {
  crate::win_path::hide_console(cmd);
}

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
  /// "relay" | "quick" | null
  pub tunnel_mode: Option<String>,
  pub last_error: Option<String>,
  pub node_found: bool,
}

struct RemoteMcpState {
  enabled: bool,
  /// Prevents React Strict Mode / double sync from spawning two MCP servers.
  starting: bool,
  token: String,
  port: u16,
  public_url: Option<String>,
  tunnel_mode: Option<String>,
  last_error: Option<String>,
  /// Tail of MCP child stderr (for crash diagnostics).
  mcp_stderr: String,
  mcp_child: Option<Child>,
  tunnel_child: Option<Child>,
  relay_stop: Option<Arc<AtomicBool>>,
}

static STATE: Mutex<RemoteMcpState> = Mutex::new(RemoteMcpState {
  enabled: false,
  starting: false,
  token: String::new(),
  port: DEFAULT_PORT,
  public_url: None,
  tunnel_mode: None,
  last_error: None,
  mcp_stderr: String::new(),
  mcp_child: None,
  tunnel_child: None,
  relay_stop: None,
});

fn relay_base() -> String {
  std::env::var("SCREEN_BEAVER_MCP_RELAY")
    .ok()
    .map(|s| s.trim().trim_end_matches('/').to_string())
    .filter(|s| !s.is_empty())
    .unwrap_or_else(|| DEFAULT_RELAY_BASE.to_string())
}

/// Forever-stable Claude/BetterClaw URL — same host + persisted token across restarts.
fn stable_public_url(token: &str) -> String {
  format!(
    "{}/mcp?token={}",
    relay_base(),
    urlencoding_token(token)
  )
}

fn allow_quick_tunnel_fallback() -> bool {
  matches!(
    std::env::var("SCREEN_BEAVER_MCP_ALLOW_QUICK")
      .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
      .unwrap_or(false),
    true
  )
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
  app
    .path()
    .app_data_dir()
    .map_err(|e| format!("app data dir: {e}"))
}

fn token_path(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(data_dir(app)?.join(TOKEN_FILE))
}

fn load_or_create_token(app: &AppHandle) -> Result<String, String> {
  let path = token_path(app)?;
  if let Ok(existing) = fs::read_to_string(&path) {
    let t = existing.trim().to_string();
    if t.len() >= 16 {
      return Ok(t);
    }
  }
  let token = generate_token();
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  }
  fs::write(&path, &token).map_err(|e| e.to_string())?;
  Ok(token)
}

fn generate_token() -> String {
  use std::hash::{Hash, Hasher};
  let mut h = std::collections::hash_map::DefaultHasher::new();
  std::process::id().hash(&mut h);
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_nanos())
    .unwrap_or(0)
    .hash(&mut h);
  let mut n = h.finish() ^ 0x9e37_79b9_7f4a_7c15;
  let mut bytes = [0u8; 24];
  for b in bytes.iter_mut() {
    n = n.wrapping_mul(6364136223846793005).wrapping_add(1);
    *b = (n >> 33) as u8;
  }
  let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
  format!("sb_{hex}")
}

/// Kill whatever is listening on our MCP port (orphan node from a previous run).
fn free_listen_port(port: u16) {
  #[cfg(windows)]
  {
    // cmd + netstat — no PowerShell window flash on second launch.
    let script = format!(
      "for /f \"tokens=5\" %p in ('netstat -ano ^| findstr \":{port}\" ^| findstr LISTENING') do taskkill /F /PID %p >nul 2>&1",
      port = port
    );
    let mut cmd = Command::new("cmd.exe");
    cmd
      .args(["/C", &script])
      .stdout(Stdio::null())
      .stderr(Stdio::null());
    hide_console(&mut cmd);
    let _ = cmd.status();
    thread::sleep(Duration::from_millis(300));
  }
  #[cfg(not(windows))]
  {
    let _ = port;
  }
}

fn node_portable_path(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(data_dir(app)?.join("bin").join(NODE_EXE))
}

fn find_system_node() -> Option<String> {
  // Prefer real node.exe — node.cmd breaks paths with spaces (EISDIR on `D:`).
  // Walk PATH — never spawn `where` (CMD flashes on every second launch).
  if let Some(p) = crate::win_path::find_on_path("node.exe") {
    if p.to_ascii_lowercase().ends_with("node.exe") {
      return Some(p);
    }
  }
  crate::win_path::find_on_path("node").and_then(|p| {
    if p.to_ascii_lowercase().ends_with("node.exe") {
      Some(p)
    } else {
      None
    }
  })
}

/// Resolve node without downloading. Prefers app-data portable, then system PATH.
fn resolve_node(app: &AppHandle) -> Option<String> {
  {
    let cached = NODE_PATH.lock();
    if let Some(p) = cached.as_ref() {
      if Path::new(p).is_file() {
        return Some(p.clone());
      }
    }
  }

  if let Ok(portable) = node_portable_path(app) {
    if portable.is_file() {
      let s = portable.to_string_lossy().to_string();
      *NODE_PATH.lock() = Some(s.clone());
      return Some(s);
    }
  }

  if let Some(sys) = find_system_node() {
    *NODE_PATH.lock() = Some(sys.clone());
    return Some(sys);
  }
  None
}

/// Ensure a Node runtime exists — download official win-x64 binary into app data if needed.
fn ensure_node(app: &AppHandle) -> Result<String, String> {
  if let Some(existing) = resolve_node(app) {
    return Ok(existing);
  }

  #[cfg(windows)]
  {
    let dest = node_portable_path(app)?;
    if let Some(parent) = dest.parent() {
      fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let dest_display = dest.display().to_string().replace('\'', "''");
    let url = format!(
      "https://nodejs.org/dist/{ver}/{zip}",
      ver = NODE_DIST_VERSION,
      zip = NODE_DIST_ZIP
    );
    let url_display = url.replace('\'', "''");
    let folder = NODE_DIST_ZIP.trim_end_matches(".zip");
    let script = format!(
      r#"
$ErrorActionPreference = 'Stop'
$zip = Join-Path $env:TEMP 'screenbeaver-node.zip'
$extract = Join-Path $env:TEMP 'screenbeaver-node-extract'
$url = '{url}'
$out = '{out}'
if (Test-Path $extract) {{ Remove-Item -Recurse -Force $extract }}
Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
Expand-Archive -Path $zip -DestinationPath $extract -Force
$src = Join-Path $extract '{folder}\node.exe'
if (-not (Test-Path $src)) {{ throw "node.exe missing in Node dist zip" }}
Copy-Item -Force $src $out
Remove-Item -Force $zip -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $extract -ErrorAction SilentlyContinue
"#,
      url = url_display,
      out = dest_display,
      folder = folder,
    );

    let mut cmd = Command::new("powershell");
    cmd
      .args([
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        &script,
      ])
      .stdout(Stdio::piped())
      .stderr(Stdio::piped());
    hide_console(&mut cmd);

    let output = cmd
      .output()
      .map_err(|e| format!("Failed to download Node runtime: {e}"))?;

    if !output.status.success() || !dest.is_file() {
      let err = String::from_utf8_lossy(&output.stderr);
      return Err(format!(
        "Could not prepare MCP runtime: {}",
        err.trim()
      ));
    }

    let s = dest.to_string_lossy().to_string();
    *NODE_PATH.lock() = Some(s.clone());
    Ok(s)
  }

  #[cfg(not(windows))]
  {
    Err("Node.js runtime not found.".into())
  }
}

/// Windows `canonicalize()` returns `\\?\C:\...`. Node's main-module realpath
/// mishandles that prefix (EISDIR on `D:` when the path has spaces). Strip it.
fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
  #[cfg(windows)]
  {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\") {
      if let Some(unc) = rest.strip_prefix(r"UNC\") {
        return PathBuf::from(format!(r"\\{unc}"));
      }
      return PathBuf::from(rest);
    }
  }
  path
}

fn absolute_if_file(path: PathBuf) -> Option<PathBuf> {
  if !path.is_file() {
    return None;
  }
  let abs = path.canonicalize().unwrap_or(path);
  Some(strip_verbatim_prefix(abs))
}

fn resolve_mcp_script(app: &AppHandle) -> Result<PathBuf, String> {
  // Packaged resource: resources/mcp/index.js
  if let Ok(resource) = app.path().resource_dir() {
    if let Some(p) = absolute_if_file(resource.join("mcp").join("index.js")) {
      return Ok(p);
    }
    if let Some(p) = absolute_if_file(resource.join("resources").join("mcp").join("index.js")) {
      return Ok(p);
    }
  }

  // Dev / monorepo: walk up from cwd and from exe dir
  let candidates = [
    PathBuf::from("mcp/dist/index.js"),
    PathBuf::from("../mcp/dist/index.js"),
    PathBuf::from("../../mcp/dist/index.js"),
    PathBuf::from("src-tauri/resources/mcp/index.js"),
    PathBuf::from("../src-tauri/resources/mcp/index.js"),
  ];
  for c in candidates {
    if let Some(p) = absolute_if_file(c) {
      return Ok(p);
    }
  }

  if let Ok(exe) = std::env::current_exe() {
    if let Some(dir) = exe.parent() {
      for rel in [
        "resources/mcp/index.js",
        "mcp/index.js",
        "../../../mcp/dist/index.js",
        "../../../../mcp/dist/index.js",
      ] {
        if let Some(p) = absolute_if_file(dir.join(rel)) {
          return Ok(p);
        }
      }
    }
  }

  Err(
    "MCP script not found. Build mcp (`npm run build` in mcp/) or reinstall the app."
      .into(),
  )
}

fn cloudflared_path(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(data_dir(app)?.join("bin").join(CLOUDFLARED_EXE))
}

fn ensure_cloudflared(app: &AppHandle) -> Result<PathBuf, String> {
  let path = cloudflared_path(app)?;
  if path.is_file() {
    return Ok(path);
  }
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  }

  let path_display = path.display().to_string().replace('\'', "''");
  let script = format!(
    r#"
$ErrorActionPreference = 'Stop'
$out = '{path}'
$url = '{url}'
Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing
"#,
    path = path_display,
    url = CLOUDFLARED_URL,
  );

  let mut cmd = Command::new("powershell");
  cmd
    .args([
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      &script,
    ])
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
  hide_console(&mut cmd);

  let output = cmd
    .output()
    .map_err(|e| format!("Failed to download cloudflared: {e}"))?;

  if !output.status.success() || !path.is_file() {
    let err = String::from_utf8_lossy(&output.stderr);
    return Err(format!("cloudflared download failed: {}", err.trim()));
  }
  Ok(path)
}

fn kill_child(child: &mut Option<Child>) {
  if let Some(mut c) = child.take() {
    let _ = c.kill();
    let _ = c.wait();
  }
}

fn stop_locked(state: &mut RemoteMcpState) {
  if let Some(stop) = state.relay_stop.take() {
    stop.store(true, Ordering::SeqCst);
  }
  kill_child(&mut state.tunnel_child);
  kill_child(&mut state.mcp_child);
  // Keep stable branded URL in state when we have a token (does not rotate).
  if !state.token.is_empty() {
    state.public_url = Some(stable_public_url(&state.token));
  } else {
    state.public_url = None;
  }
  state.tunnel_mode = None;
  state.enabled = false;
  state.starting = false;
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RelayRegisterResponse {
  ok: Option<bool>,
  public_url: Option<String>,
  error: Option<String>,
}

#[derive(serde::Deserialize)]
struct RelayPollResponse {
  ok: Option<bool>,
  requests: Option<Vec<RelayPendingRequest>>,
}

#[derive(serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RelayPendingRequest {
  id: String,
  method: String,
  path: String,
  headers: Option<std::collections::HashMap<String, String>>,
  body_base64: Option<String>,
}

/// Register with mcp.screenbeaver.com and poll/forward MCP HTTP to localhost.
fn start_relay(
  token: &str,
  port: u16,
  public_slot: Arc<Mutex<Option<String>>>,
) -> Result<Arc<AtomicBool>, String> {
  let base = relay_base();
  let register_url = format!("{base}/v1/session/register");
  let resp = ureq::post(&register_url)
    .set("Content-Type", "application/json")
    .timeout(Duration::from_secs(12))
    .send_json(serde_json::json!({ "token": token, "localPort": port }))
    .map_err(|e| format!("relay register failed: {e}"))?;
  let parsed: RelayRegisterResponse = resp
    .into_json()
    .map_err(|e| format!("relay register json: {e}"))?;
  if parsed.ok == Some(false) {
    return Err(parsed.error.unwrap_or_else(|| "relay rejected session".into()));
  }
  // Always the stable branded URL (ignore any rotating host from the relay).
  let _ = parsed.public_url;
  let public_url = stable_public_url(token);
  *public_slot.lock() = Some(public_url);

  let stop = Arc::new(AtomicBool::new(false));
  let stop_bg = Arc::clone(&stop);
  let token = token.to_string();
  let base_bg = base;
  thread::spawn(move || {
    while !stop_bg.load(Ordering::SeqCst) {
      let poll_url = format!(
        "{base_bg}/v1/session/poll?token={}&wait=20000",
        urlencoding_token(&token)
      );
      let poll = ureq::get(&poll_url).timeout(Duration::from_secs(35)).call();
      let Ok(resp) = poll else {
        thread::sleep(Duration::from_secs(2));
        continue;
      };
      let parsed: RelayPollResponse = match resp.into_json() {
        Ok(p) => p,
        Err(_) => {
          thread::sleep(Duration::from_millis(500));
          continue;
        }
      };
      for req in parsed.requests.unwrap_or_default() {
        if stop_bg.load(Ordering::SeqCst) {
          break;
        }
        let local = forward_to_local_mcp(port, &req);
        let _ = ureq::post(&format!("{base_bg}/v1/session/respond"))
          .set("Content-Type", "application/json")
          .timeout(Duration::from_secs(30))
          .send_json(serde_json::json!({
            "token": token,
            "id": req.id,
            "status": local.0,
            "headers": local.1,
            "bodyBase64": local.2,
          }));
      }
    }
  });
  Ok(stop)
}

fn urlencoding_token(token: &str) -> String {
  token
    .bytes()
    .map(|b| match b {
      b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
        (b as char).to_string()
      }
      _ => format!("%{b:02X}"),
    })
    .collect()
}

/// If local MCP returned SSE (`event: message` / `data: {...}`), convert to plain JSON
/// so Anthropic's mcp-proxy doesn't surface a generic 502.
fn unwrap_sse_to_json(
  bytes: Vec<u8>,
  mut headers: std::collections::HashMap<String, String>,
) -> (Vec<u8>, std::collections::HashMap<String, String>) {
  let text = match std::str::from_utf8(&bytes) {
    Ok(t) => t,
    Err(_) => return (bytes, headers),
  };
  let trimmed = text.trim_start();
  let is_sse = trimmed.starts_with("event:")
    || trimmed.starts_with("data:")
    || headers
      .get("content-type")
      .map(|ct| ct.to_ascii_lowercase().contains("text/event-stream"))
      .unwrap_or(false);
  if !is_sse {
    return (bytes, headers);
  }
  for line in text.lines() {
    let line = line.trim();
    if let Some(data) = line.strip_prefix("data:") {
      let payload = data.trim();
      if payload.starts_with('{') {
        headers.insert("content-type".into(), "application/json".into());
        return (payload.as_bytes().to_vec(), headers);
      }
    }
  }
  (bytes, headers)
}

fn forward_to_local_mcp(
  port: u16,
  req: &RelayPendingRequest,
) -> (u16, std::collections::HashMap<String, String>, String) {
  let path = if req.path.starts_with('/') {
    req.path.clone()
  } else {
    format!("/{}", req.path)
  };
  let url = format!("http://127.0.0.1:{port}{path}");
  let body = req
    .body_base64
    .as_ref()
    .and_then(|b| {
      use base64::Engine;
      base64::engine::general_purpose::STANDARD.decode(b).ok()
    })
    .unwrap_or_default();

  let method = req.method.to_ascii_uppercase();
  if method != "POST" {
    use base64::Engine;
    let err = serde_json::json!({
      "jsonrpc": "2.0",
      "error": { "code": -32000, "message": format!("Relay only forwards POST (got {method})") },
      "id": null
    })
    .to_string();
    return (
      405,
      std::collections::HashMap::from([(
        "content-type".into(),
        "application/json".into(),
      )]),
      base64::engine::general_purpose::STANDARD.encode(err.as_bytes()),
    );
  }

  let mut agent = ureq::post(&url).timeout(Duration::from_secs(180));
  // Only forward headers the local MCP needs — Claude's full header set can break ureq.
  let mut saw_auth = false;
  let mut saw_accept = false;
  let mut saw_ct = false;
  if let Some(headers) = &req.headers {
    for (k, v) in headers {
      let lk = k.to_ascii_lowercase();
      match lk.as_str() {
        "authorization" => {
          saw_auth = true;
          agent = agent.set("Authorization", v);
        }
        "accept" => {
          saw_accept = true;
          agent = agent.set("Accept", v);
        }
        "content-type" => {
          saw_ct = true;
          agent = agent.set("Content-Type", v);
        }
        "mcp-session-id" => {
          agent = agent.set("mcp-session-id", v);
        }
        _ => {}
      }
    }
  }
  if !saw_accept {
    agent = agent.set("Accept", "application/json, text/event-stream");
  }
  if !saw_ct && !body.is_empty() {
    agent = agent.set("Content-Type", "application/json");
  }
  let _ = saw_auth;
  match agent.send(&body[..]) {
    Ok(resp) => {
      let status = resp.status();
      let mut out_headers = std::collections::HashMap::new();
      for name in ["content-type", "mcp-session-id"] {
        if let Some(v) = resp.header(name) {
          out_headers.insert(name.to_string(), v.to_string());
        }
      }
      let mut bytes = Vec::new();
      let _ = std::io::Read::read_to_end(&mut resp.into_reader(), &mut bytes);
      // Claude.ai's connector check chokes on text/event-stream → unwrap first SSE data JSON.
      let (bytes, out_headers) = unwrap_sse_to_json(bytes, out_headers);
      use base64::Engine;
      let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
      (status, out_headers, b64)
    }
    Err(e) => {
      use base64::Engine;
      let err = serde_json::json!({
        "jsonrpc": "2.0",
        "error": { "code": -32000, "message": format!("Local MCP forward failed: {e}") },
        "id": null
      })
      .to_string();
      (
        502,
        std::collections::HashMap::from([(
          "content-type".into(),
          "application/json".into(),
        )]),
        base64::engine::general_purpose::STANDARD.encode(err.as_bytes()),
      )
    }
  }
}

fn spawn_mcp_http(app: &AppHandle, token: &str, port: u16) -> Result<Child, String> {
  let node = ensure_node(app)?;
  let script = resolve_mcp_script(app)?;
  free_listen_port(port);

  {
    let mut state = STATE.lock();
    state.mcp_stderr.clear();
  }

  // Absolute path without `\\?\` (see strip_verbatim_prefix) so Node can realpath the script.
  let script_arg = script.to_string_lossy().to_string();
  let work_dir = script
    .parent()
    .map(|p| p.to_path_buf())
    .unwrap_or_else(|| PathBuf::from("."));

  let mut cmd = Command::new(&node);
  cmd
    .arg(&script_arg)
    .arg("--http")
    .arg("--port")
    .arg(port.to_string())
    .current_dir(&work_dir)
    .env("SCREEN_BEAVER_MCP_TOKEN", token)
    .env("SCREEN_BEAVER_MCP_TRANSPORT", "http")
    .env("SCREEN_BEAVER_MCP_PORT", port.to_string())
    .stdout(Stdio::null())
    .stderr(Stdio::piped());
  hide_console(&mut cmd);

  let mut child = cmd
    .spawn()
    .map_err(|e| format!("Failed to start MCP HTTP ({node} {}): {e}", script.display()))?;

  if let Some(stderr) = child.stderr.take() {
    thread::spawn(move || {
      let reader = BufReader::new(stderr);
      for line in reader.lines().flatten() {
        let mut state = STATE.lock();
        if state.mcp_stderr.len() > 8_000 {
          let trim = state.mcp_stderr.len() - 4_000;
          state.mcp_stderr.drain(..trim);
        }
        state.mcp_stderr.push_str(&line);
        state.mcp_stderr.push('\n');
      }
    });
  }

  Ok(child)
}

fn spawn_tunnel(
  cloudflared: &Path,
  port: u16,
  public_url_slot: Arc<Mutex<Option<String>>>,
) -> Result<Child, String> {
  let mut cmd = Command::new(cloudflared);
  cmd
    .arg("tunnel")
    .arg("--url")
    .arg(format!("http://127.0.0.1:{port}"))
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
  hide_console(&mut cmd);

  let mut child = cmd
    .spawn()
    .map_err(|e| format!("Failed to start cloudflared: {e}"))?;

  if let Some(stderr) = child.stderr.take() {
    let slot = Arc::clone(&public_url_slot);
    thread::spawn(move || {
      let reader = BufReader::new(stderr);
      for line in reader.lines().flatten() {
        if let Some(url) = extract_trycloudflare_url(&line) {
          let mcp_url = if url.ends_with("/mcp") {
            url
          } else {
            format!("{}/mcp", url.trim_end_matches('/'))
          };
          // Slot only — never publish trycloudflare to UI (stable mcp.screenbeaver.com URL).
          *slot.lock() = Some(mcp_url);
        }
      }
    });
  }

  Ok(child)
}

fn extract_trycloudflare_url(line: &str) -> Option<String> {
  // cloudflared prints: https://xxxx.trycloudflare.com
  let start = line.find("https://")?;
  let rest = &line[start..];
  let end = rest
    .find(|c: char| c.is_whitespace() || c == '|' || c == '"' || c == '\'')
    .unwrap_or(rest.len());
  let url = rest[..end].trim_end_matches('/').to_string();
  if url.contains("trycloudflare.com") {
    Some(url)
  } else {
    None
  }
}

fn wait_for_health(port: u16, timeout: Duration) -> Result<(), String> {
  let deadline = Instant::now() + timeout;
  let url = format!("http://127.0.0.1:{port}/health");
  while Instant::now() < deadline {
    if let Ok(resp) = ureq_get(&url) {
      if resp {
        return Ok(());
      }
    }
    thread::sleep(Duration::from_millis(200));
  }
  Err(format!(
    "MCP HTTP did not become healthy on 127.0.0.1:{port} within {}s",
    timeout.as_secs()
  ))
}

/// Tiny GET without adding a HTTP crate — use std + PowerShell, or raw TcpStream.
fn ureq_get(url: &str) -> Result<bool, String> {
  // In-process HTTP — never spawn PowerShell (was flashing CMDs on health polls).
  match ureq::get(url).timeout(Duration::from_secs(2)).call() {
    Ok(res) => Ok(res.status() == 200),
    Err(_) => Ok(false),
  }
}

fn build_status(state: &RemoteMcpState) -> RemoteMcpStatus {
  let mcp_alive = state.mcp_child.is_some();
  let relay_alive = state
    .relay_stop
    .as_ref()
    .map(|s| !s.load(Ordering::SeqCst))
    .unwrap_or(false);
  let running = state.enabled && mcp_alive && (relay_alive || state.tunnel_child.is_some());
  // Always expose the forever URL when a token exists — never a rotating trycloudflare host.
  let public_url = if state.token.is_empty() {
    None
  } else {
    Some(stable_public_url(&state.token))
  };
  RemoteMcpStatus {
    enabled: state.enabled,
    running,
    port: state.port,
    local_url: format!("http://127.0.0.1:{}/mcp", state.port),
    public_url,
    token: if state.token.is_empty() {
      None
    } else {
      Some(state.token.clone())
    },
    mcp_pid: state.mcp_child.as_ref().map(|c| c.id()),
    tunnel_pid: state.tunnel_child.as_ref().map(|c| c.id()),
    tunnel_mode: state.tunnel_mode.clone(),
    last_error: state.last_error.clone(),
    // True when a runtime is already on disk (portable or PATH). First start may download.
    node_found: true,
  }
}

pub fn status(app: &AppHandle) -> RemoteMcpStatus {
  let mut state = STATE.lock();
  reap_dead(&mut state);
  if state.token.is_empty() {
    if let Ok(t) = load_or_create_token(app) {
      state.token = t;
    }
  }
  let mut status = build_status(&state);
  // Reflect whether a runtime is already available (no download needed yet).
  status.node_found = resolve_node(app).is_some();
  status
}

fn reap_dead(state: &mut RemoteMcpState) {
  if let Some(child) = state.mcp_child.as_mut() {
    if let Ok(Some(status)) = child.try_wait() {
      state.mcp_child = None;
      state.enabled = false;
      state.starting = false;
      let detail = state.mcp_stderr.trim();
      let code = status.code().map(|c| format!("exit {c}")).unwrap_or_else(|| "killed".into());
      state.last_error = Some(if detail.is_empty() {
        format!("MCP HTTP process exited unexpectedly ({code}).")
      } else {
        format!("MCP HTTP exited ({code}): {detail}")
      });
    }
  }
  if let Some(child) = state.tunnel_child.as_mut() {
    if let Ok(Some(_)) = child.try_wait() {
      state.tunnel_child = None;
      if state.tunnel_mode.as_deref() == Some("quick") {
        state.tunnel_mode = None;
      }
    }
  }
}

pub fn sync(app: &AppHandle, enabled: bool) -> Result<RemoteMcpStatus, String> {
  if !enabled {
    let mut state = STATE.lock();
    stop_locked(&mut state);
    state.last_error = None;
    return Ok(build_status(&state));
  }

  // Already running or start in flight?
  {
    let mut state = STATE.lock();
    reap_dead(&mut state);
    if state.starting {
      return Ok(build_status(&state));
    }
    if state.enabled && state.mcp_child.is_some() {
      return Ok(build_status(&state));
    }
    stop_locked(&mut state);
    state.starting = true;
    state.enabled = true;
    state.last_error = None;
  }

  let token = load_or_create_token(app)?;
  let port = DEFAULT_PORT;
  {
    let mut state = STATE.lock();
    state.token = token.clone();
    state.port = port;
    state.public_url = Some(stable_public_url(&token));
  }

  let app_bg = app.clone();
  thread::spawn(move || {
    let result = start_stack_blocking(&app_bg, &token, port);
    let mut state = STATE.lock();
    state.starting = false;
    if let Err(e) = result {
      state.last_error = Some(e);
      state.enabled = state.mcp_child.is_some();
    }
    let status = build_status(&state);
    let _ = app_bg.emit("remote-mcp://status", &status);
  });

  Ok(status(app))
}

fn start_stack_blocking(app: &AppHandle, token: &str, port: u16) -> Result<(), String> {
  let mcp_child = spawn_mcp_http(app, token, port)?;
  let mcp_pid = mcp_child.id();

  {
    let mut state = STATE.lock();
    state.mcp_child = Some(mcp_child);
  }

  // Brief pause so a fast EADDRINUSE crash shows up before we probe health.
  thread::sleep(Duration::from_millis(400));
  {
    let mut state = STATE.lock();
    if let Some(child) = state.mcp_child.as_mut() {
      if let Ok(Some(status)) = child.try_wait() {
        state.mcp_child = None;
        let detail = state.mcp_stderr.trim().to_string();
        let code = status.code().unwrap_or(-1);
        return Err(if detail.is_empty() {
          format!(
            "MCP HTTP failed to stay up (exit {code}). Is port {port} already in use?"
          )
        } else {
          format!("MCP HTTP failed (exit {code}): {detail}")
        });
      }
    }
  }

  if let Err(e) = wait_for_health(port, Duration::from_secs(15)) {
    let mut state = STATE.lock();
    let detail = state.mcp_stderr.trim().to_string();
    kill_child(&mut state.mcp_child);
    state.enabled = false;
    return Err(if detail.is_empty() {
      e
    } else {
      format!("{e} — {detail}")
    });
  }

  // Ensure health is from *our* process, not an orphan.
  {
    let mut state = STATE.lock();
    if state.mcp_child.as_ref().map(|c| c.id()) != Some(mcp_pid) {
      return Err("MCP HTTP child was replaced unexpectedly.".into());
    }
    if let Some(child) = state.mcp_child.as_mut() {
      if let Ok(Some(_)) = child.try_wait() {
        state.mcp_child = None;
        state.enabled = false;
        let detail = state.mcp_stderr.trim().to_string();
        return Err(format!(
          "MCP HTTP died after becoming healthy. {detail}"
        ));
      }
    }
  }

  let public_slot: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(Some(stable_public_url(token))));
  let token_owned = token.to_string();

  // Stable mcp.screenbeaver.com only — no rotating trycloudflare URLs in the UI.
  match start_relay(&token_owned, port, Arc::clone(&public_slot)) {
    Ok(relay_stop) => {
      let mut state = STATE.lock();
      state.relay_stop = Some(relay_stop);
      state.tunnel_mode = Some("relay".into());
      state.public_url = Some(stable_public_url(&token_owned));
      state.last_error = None;
      let status = build_status(&state);
      let _ = app.emit("remote-mcp://status", &status);
      Ok(())
    }
    Err(relay_err) => {
      if allow_quick_tunnel_fallback() {
        match ensure_cloudflared(app)
          .and_then(|cf| spawn_tunnel(&cf, port, Arc::clone(&public_slot)))
        {
          Ok(tunnel_child) => {
            let deadline = Instant::now() + Duration::from_secs(25);
            while Instant::now() < deadline {
              if public_slot
                .lock()
                .as_ref()
                .is_some_and(|u| u.contains("trycloudflare.com"))
              {
                break;
              }
              thread::sleep(Duration::from_millis(250));
            }
            let mut state = STATE.lock();
            state.tunnel_child = Some(tunnel_child);
            state.tunnel_mode = Some("quick".into());
            // Still show the stable branded URL — quick tunnel is emergency-only.
            state.public_url = Some(stable_public_url(&token_owned));
            state.last_error = Some(format!(
              "Relay offline ({relay_err}). Stable URL kept; retry Refresh when mcp.screenbeaver.com is up. (Dev quick tunnel also running.)"
            ));
            let status = build_status(&state);
            let _ = app.emit("remote-mcp://status", &status);
            return Ok(());
          }
          Err(e) => {
            let mut state = STATE.lock();
            state.public_url = Some(stable_public_url(&token_owned));
            state.last_error = Some(format!("Relay failed ({relay_err}); quick tunnel failed: {e}"));
            let status = build_status(&state);
            let _ = app.emit("remote-mcp://status", &status);
            return Ok(());
          }
        }
      }

      let mut state = STATE.lock();
      state.public_url = Some(stable_public_url(&token_owned));
      state.last_error = Some(format!(
        "Could not connect to mcp.screenbeaver.com ({relay_err}). Your Claude URL stays the same — keep Screen Beaver open and click Retry start."
      ));
      let status = build_status(&state);
      let _ = app.emit("remote-mcp://status", &status);
      Ok(())
    }
  }
}

pub fn regenerate_token(app: &AppHandle) -> Result<RemoteMcpStatus, String> {
  let path = token_path(app)?;
  let token = generate_token();
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  }
  fs::write(&path, &token).map_err(|e| e.to_string())?;

  let was_enabled = STATE.lock().enabled;
  {
    let mut state = STATE.lock();
    stop_locked(&mut state);
    state.token = token;
  }
  if was_enabled {
    sync(app, true)
  } else {
    Ok(status(app))
  }
}

pub fn refresh_tunnel(app: &AppHandle) -> Result<RemoteMcpStatus, String> {
  let (enabled, token, port) = {
    let state = STATE.lock();
    (
      state.enabled && state.mcp_child.is_some(),
      state.token.clone(),
      state.port,
    )
  };
  if !enabled {
    return Err("Remote MCP is not running.".into());
  }

  {
    let mut state = STATE.lock();
    if let Some(stop) = state.relay_stop.take() {
      stop.store(true, Ordering::SeqCst);
    }
    kill_child(&mut state.tunnel_child);
    state.tunnel_mode = None;
    state.public_url = Some(stable_public_url(&token));
  }

  let public_slot: Arc<Mutex<Option<String>>> =
    Arc::new(Mutex::new(Some(stable_public_url(&token))));
  match start_relay(&token, port, Arc::clone(&public_slot)) {
    Ok(relay_stop) => {
      let mut state = STATE.lock();
      state.relay_stop = Some(relay_stop);
      state.tunnel_mode = Some("relay".into());
      state.public_url = Some(stable_public_url(&token));
      state.last_error = None;
      Ok(build_status(&state))
    }
    Err(relay_err) => {
      let mut state = STATE.lock();
      state.public_url = Some(stable_public_url(&token));
      state.last_error = Some(format!(
        "Relay reconnect failed ({relay_err}). Claude URL is unchanged — retry when online."
      ));
      Ok(build_status(&state))
    }
  }
}

pub fn shutdown() {
  let mut state = STATE.lock();
  stop_locked(&mut state);
}
