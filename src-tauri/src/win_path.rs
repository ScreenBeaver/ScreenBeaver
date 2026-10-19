//! Resolve executables on PATH without spawning `where` / `which` (no CMD flashes).

use std::path::{Path, PathBuf};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
pub fn hide_console(cmd: &mut std::process::Command) {
  use std::os::windows::process::CommandExt;
  cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub fn hide_console(_cmd: &mut std::process::Command) {}

/// Find `name` or `name.exe` on PATH by walking directories (no console process).
pub fn find_on_path(name: &str) -> Option<String> {
  let candidates = candidate_names(name);
  if let Some(p) = scan_path_dirs(&candidates) {
    return Some(p);
  }
  #[cfg(windows)]
  {
    // Common install locations when PATH isn't refreshed yet.
    let extras = [
      r"C:\Program Files\nodejs",
      r"C:\Program Files (x86)\nodejs",
    ];
    for dir in extras {
      for cand in &candidates {
        let p = Path::new(dir).join(cand);
        if p.is_file() {
          return Some(p.to_string_lossy().to_string());
        }
      }
    }
  }
  None
}

fn candidate_names(name: &str) -> Vec<String> {
  let mut out = vec![name.to_string()];
  #[cfg(windows)]
  {
    let lower = name.to_ascii_lowercase();
    if !lower.ends_with(".exe") && !lower.ends_with(".cmd") && !lower.ends_with(".bat") {
      out.push(format!("{name}.exe"));
      out.push(format!("{name}.cmd"));
    }
  }
  out
}

fn scan_path_dirs(candidates: &[String]) -> Option<String> {
  let path = std::env::var_os("PATH")?;
  for dir in std::env::split_paths(&path) {
    for cand in candidates {
      let p = dir.join(cand);
      if p.is_file() {
        return Some(normalize_path(p));
      }
    }
  }
  None
}

fn normalize_path(p: PathBuf) -> String {
  p.canonicalize()
    .unwrap_or(p)
    .to_string_lossy()
    .trim_start_matches(r"\\?\")
    .to_string()
}
