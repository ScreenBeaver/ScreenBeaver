//! Host coding-agent CLIs in a PTY (Claude Code, Codex, Cursor Agent, …).
//! Screen Beaver injects a demo-building task; the agent researches and drives MCP.

use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const OUTPUT_TAIL_MAX: usize = 48_000;
const EMIT_CHUNK_MAX: usize = 4096;

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

struct ActiveSession {
  id: String,
  provider_id: String,
  url: String,
  started_at: Instant,
  output_tail: Arc<Mutex<String>>,
  child: Arc<Mutex<Option<Box<dyn portable_pty::Child + Send + Sync>>>>,
  _master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
}

static SESSION: Mutex<Option<ActiveSession>> = Mutex::new(None);

const PROVIDERS: [(&str, &str, &[&str]); 3] = [
  ("claude", "Claude Code", &["claude"]),
  ("codex", "OpenAI Codex", &["codex"]),
  ("cursor", "Cursor Agent", &["agent", "cursor-agent"]),
];

fn find_executable(candidates: &[&str]) -> Option<String> {
  // Walk PATH only — never spawn `where` (multiple CMD flashes on Start page).
  for name in candidates {
    if let Some(p) = crate::win_path::find_on_path(name) {
      return Some(p);
    }
  }
  None
}

static CAPS_CACHE: std::sync::OnceLock<AgentCliCapabilities> = std::sync::OnceLock::new();

fn pty_available() -> bool {
  native_pty_system()
    .openpty(PtySize {
      rows: 24,
      cols: 120,
      pixel_width: 0,
      pixel_height: 0,
    })
    .is_ok()
}

pub fn detect_capabilities() -> AgentCliCapabilities {
  CAPS_CACHE
    .get_or_init(|| {
      let mut providers = Vec::new();
      for (id, label, cmds) in PROVIDERS {
        let path = find_executable(cmds);
        providers.push(AgentCliProvider {
          id: id.to_string(),
          label: label.to_string(),
          command: cmds[0].to_string(),
          detected: path.is_some(),
          path,
        });
      }
      AgentCliCapabilities {
        pty_available: pty_available(),
        providers,
      }
    })
    .clone()
}

pub fn current_status() -> AgentCliStatus {
  let guard = SESSION.lock();
  if let Some(s) = guard.as_ref() {
    return AgentCliStatus {
      running: true,
      session_id: Some(s.id.clone()),
      provider_id: Some(s.provider_id.clone()),
      url: Some(s.url.clone()),
      started_at: Some(s.started_at.elapsed().as_millis() as u64),
      output_tail: s.output_tail.lock().clone(),
    };
  }
  AgentCliStatus {
    running: false,
    session_id: None,
    provider_id: None,
    url: None,
    started_at: None,
    output_tail: String::new(),
  }
}

fn resolve_provider(provider_id: &str) -> Result<(String, PathBuf), String> {
  let caps = detect_capabilities();
  let provider = caps
    .providers
    .into_iter()
    .find(|p| p.id == provider_id)
    .ok_or_else(|| format!("Unknown agent provider: {provider_id}"))?;
  if !provider.detected {
    return Err(format!(
      "{} is not installed or not on PATH. Install the CLI and try again.",
      provider.label
    ));
  }
  let path = provider
    .path
    .ok_or_else(|| format!("{} path not found", provider.label))?;
  Ok((provider.command, PathBuf::from(path)))
}

fn build_demo_task(url: &str, product_name: Option<&str>) -> String {
  let name = product_name
    .filter(|s| !s.trim().is_empty())
    .unwrap_or("this product");
  format!(
    r#"SCREEN BEAVER DEMO TASK

Product URL: {url}
Product name (if known): {name}

You are building a short product demo video in Screen Beaver on this machine.

1. Research {name} at the URL above (browse, fetch, or use your tools).
2. Plan a ~10–12 second walkthrough: sign-in or hero, one key feature click, optional typing.
3. Use the **screen-beaver** MCP tools only (no shell scripts, no curl to 127.0.0.1):
   - ping_studio
   - record_and_build with productUrl, demoSteps (contentNx/contentNy clicks + type), introCaption, features
   - voiceover: true, backgroundMusic: true unless the user said otherwise
4. Keep the take short. Do NOT call export_mp4 — the user clicks Export.
5. Prefer contentNx/contentNy (0..1) from get_window_layout when clicking in the browser.

Start now: research the product, then run record_and_build.
"#,
  )
}

fn append_tail(tail: &Arc<Mutex<String>>, chunk: &str) {
  let mut buf = tail.lock();
  buf.push_str(chunk);
  if buf.len() > OUTPUT_TAIL_MAX {
    let drop = buf.len() - OUTPUT_TAIL_MAX;
    buf.replace_range(..drop, "");
  }
}

fn spawn_reader(
  app: AppHandle,
  session_id: String,
  mut reader: Box<dyn Read + Send>,
  tail: Arc<Mutex<String>>,
) {
  thread::spawn(move || {
    let mut buf = [0u8; EMIT_CHUNK_MAX];
    loop {
      match reader.read(&mut buf) {
        Ok(0) => break,
        Ok(n) => {
          let text = String::from_utf8_lossy(&buf[..n]).into_owned();
          append_tail(&tail, &text);
          let _ = app.emit(
            "agent-cli-output",
            serde_json::json!({
              "sessionId": session_id,
              "chunk": text,
            }),
          );
        }
        Err(_) => break,
      }
    }
  });
}

fn wait_child(
  app: AppHandle,
  session_id: String,
  child_slot: Arc<Mutex<Option<Box<dyn portable_pty::Child + Send + Sync>>>>,
  tail: Arc<Mutex<String>>,
) {
  thread::spawn(move || {
    loop {
      let status = {
        let mut guard = child_slot.lock();
        let Some(child) = guard.as_mut() else {
          break;
        };
        child.try_wait()
      };
      match status {
        Ok(Some(status)) => {
          let code = status.exit_code();
          let _ = app.emit(
            "agent-cli-exit",
            serde_json::json!({
              "sessionId": session_id,
              "exitCode": code,
              "outputTail": tail.lock().clone(),
            }),
          );
          let mut guard = SESSION.lock();
          if guard.as_ref().is_some_and(|s| s.id == session_id) {
            *guard = None;
          }
          break;
        }
        Ok(None) => thread::sleep(Duration::from_millis(250)),
        Err(err) => {
          let msg = format!("\n[agent exited with error: {err}]\n");
          append_tail(&tail, &msg);
          let _ = app.emit(
            "agent-cli-exit",
            serde_json::json!({
              "sessionId": session_id,
              "exitCode": -1,
              "error": err.to_string(),
              "outputTail": tail.lock().clone(),
            }),
          );
          let mut guard = SESSION.lock();
          if guard.as_ref().is_some_and(|s| s.id == session_id) {
            *guard = None;
          }
          break;
        }
      }
    }
  });
}

pub fn start_session(
  app: AppHandle,
  provider_id: String,
  url: String,
  product_name: Option<String>,
  cwd: Option<String>,
) -> Result<AgentCliStatus, String> {
  if !pty_available() {
    return Err("Pseudo-terminal (PTY) is not available on this system.".into());
  }
  {
    let guard = SESSION.lock();
    if guard.is_some() {
      return Err("An agent session is already running. Stop it first.".into());
    }
  }

  let url = url.trim().to_string();
  if url.is_empty() || (!url.starts_with("http://") && !url.starts_with("https://")) {
    return Err("Enter a valid http(s) product URL.".into());
  }

  let (_cmd_name, exe_path) = resolve_provider(&provider_id)?;
  let work_dir = cwd
    .map(PathBuf::from)
    .or_else(|| std::env::current_dir().ok())
    .unwrap_or_else(|| PathBuf::from("."));

  let pty_system = native_pty_system();
  let pair = pty_system
    .openpty(PtySize {
      rows: 32,
      cols: 120,
      pixel_width: 0,
      pixel_height: 0,
    })
    .map_err(|e| format!("Could not open PTY: {e}"))?;

  let mut cmd = CommandBuilder::new(&exe_path);
  cmd.cwd(&work_dir);
  cmd.env("TERM", "xterm-256color");
  cmd.env("COLORTERM", "truecolor");

  let child = pair
    .slave
    .spawn_command(cmd)
    .map_err(|e| format!("Could not start agent CLI: {e}"))?;
  drop(pair.slave);

  let reader = pair
    .master
    .try_clone_reader()
    .map_err(|e| format!("PTY reader error: {e}"))?;
  let mut writer = pair
    .master
    .take_writer()
    .map_err(|e| format!("PTY writer error: {e}"))?;

  let task = build_demo_task(&url, product_name.as_deref());
  thread::spawn(move || {
    thread::sleep(Duration::from_millis(1800));
    let _ = writer.write_all(task.as_bytes());
    let _ = writer.write_all(b"\r\n");
    let _ = writer.flush();
  });

  let session_id = format!("agent-{}", chrono_lite_now());
  let tail = Arc::new(Mutex::new(String::new()));

  spawn_reader(app.clone(), session_id.clone(), reader, tail.clone());

  let child_slot: Arc<Mutex<Option<Box<dyn portable_pty::Child + Send + Sync>>>> =
    Arc::new(Mutex::new(Some(child)));
  wait_child(
    app.clone(),
    session_id.clone(),
    child_slot.clone(),
    tail.clone(),
  );

  let master_slot: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>> =
    Arc::new(Mutex::new(Some(pair.master)));

  let started = Instant::now();
  let session = ActiveSession {
    id: session_id.clone(),
    provider_id: provider_id.clone(),
    url: url.clone(),
    started_at: started,
    output_tail: tail,
    child: child_slot,
    _master: master_slot,
  };
  *SESSION.lock() = Some(session);

  let _ = app.emit(
    "agent-cli-started",
    serde_json::json!({
      "sessionId": session_id,
      "providerId": provider_id,
      "url": url,
    }),
  );

  Ok(current_status())
}

pub fn stop_session() -> Result<AgentCliStatus, String> {
  let session = SESSION.lock().take();
  if let Some(s) = session {
    if let Some(mut child) = s.child.lock().take() {
      let _ = child.kill();
    }
    s._master.lock().take();
    Ok(AgentCliStatus {
      running: false,
      session_id: Some(s.id),
      provider_id: Some(s.provider_id),
      url: Some(s.url),
      started_at: None,
      output_tail: s.output_tail.lock().clone(),
    })
  } else {
    Ok(current_status())
  }
}

/// Millisecond timestamp without pulling in chrono.
fn chrono_lite_now() -> u128 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_millis())
    .unwrap_or(0)
}
