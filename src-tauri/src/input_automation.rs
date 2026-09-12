//! Synthetic mouse + keyboard input for agent product demos.

#![cfg(windows)]

use std::thread;
use std::time::Duration;
use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::UI::Input::KeyboardAndMouse::{
  SendInput, VkKeyScanW, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_KEYUP,
  KEYEVENTF_UNICODE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_RIGHTDOWN,
  MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL, MOUSEINPUT, VIRTUAL_KEY, VK_BACK, VK_RETURN, VK_SHIFT,
  VK_TAB,
};
use windows::Win32::Graphics::Gdi::ClientToScreen;
use windows::Win32::UI::WindowsAndMessaging::{
  GetClientRect, GetCursorPos, GetWindowRect, SetCursorPos, SetForegroundWindow,
};

fn send_mouse(flags: windows::Win32::UI::Input::KeyboardAndMouse::MOUSE_EVENT_FLAGS, data: i32) {
  let input = INPUT {
    r#type: INPUT_MOUSE,
    Anonymous: INPUT_0 {
      mi: MOUSEINPUT {
        dx: 0,
        dy: 0,
        mouseData: data as u32,
        dwFlags: flags,
        time: 0,
        dwExtraInfo: 0,
      },
    },
  };
  unsafe {
    let _ = SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
  }
}

pub fn cursor_pos() -> (i32, i32) {
  let mut pt = POINT::default();
  unsafe {
    let _ = GetCursorPos(&mut pt);
  }
  (pt.x, pt.y)
}

/// Smoothly move the OS cursor to normalized virtual-desktop coords (0..1).
pub fn smooth_move_norm(nx: f64, ny: f64, duration_ms: u64) -> Result<(), String> {
  let (ox, oy, vw, vh) = crate::virtual_screen();
  let tx = ox + ((nx.clamp(0.0, 1.0) * vw as f64).round() as i32);
  let ty = oy + ((ny.clamp(0.0, 1.0) * vh as f64).round() as i32);
  smooth_move_px(tx, ty, duration_ms)
}

pub fn smooth_move_px(tx: i32, ty: i32, duration_ms: u64) -> Result<(), String> {
  let (sx, sy) = cursor_pos();
  let steps = ((duration_ms / 8).max(1) as usize).min(120);
  let dur = Duration::from_millis((duration_ms / steps as u64).max(1));
  for i in 1..=steps {
    let t = i as f64 / steps as f64;
    // ease-in-out cubic
    let e = if t < 0.5 {
      4.0 * t * t * t
    } else {
      1.0 - (-2.0 * t + 2.0).powi(3) / 2.0
    };
    let x = sx + ((tx - sx) as f64 * e).round() as i32;
    let y = sy + ((ty - sy) as f64 * e).round() as i32;
    unsafe {
      let _ = SetCursorPos(x, y);
    }
    thread::sleep(dur);
  }
  Ok(())
}

pub fn click_left() -> Result<(), String> {
  send_mouse(MOUSEEVENTF_LEFTDOWN, 0);
  thread::sleep(Duration::from_millis(45));
  send_mouse(MOUSEEVENTF_LEFTUP, 0);
  Ok(())
}

pub fn click_right() -> Result<(), String> {
  send_mouse(MOUSEEVENTF_RIGHTDOWN, 0);
  thread::sleep(Duration::from_millis(45));
  send_mouse(MOUSEEVENTF_RIGHTUP, 0);
  Ok(())
}

pub fn scroll(delta: i32) -> Result<(), String> {
  // WHEEL_DELTA = 120
  send_mouse(MOUSEEVENTF_WHEEL, delta.saturating_mul(120));
  Ok(())
}

pub fn focus_hwnd(hwnd: isize) -> Result<(), String> {
  unsafe {
    let _ = SetForegroundWindow(HWND(hwnd as *mut _));
  }
  Ok(())
}

fn send_key_vk(vk: VIRTUAL_KEY, down: bool) {
  let flags = if down {
    windows::Win32::UI::Input::KeyboardAndMouse::KEYBD_EVENT_FLAGS(0)
  } else {
    KEYEVENTF_KEYUP
  };
  let input = INPUT {
    r#type: INPUT_KEYBOARD,
    Anonymous: INPUT_0 {
      ki: KEYBDINPUT {
        wVk: vk,
        wScan: 0,
        dwFlags: flags,
        time: 0,
        dwExtraInfo: 0,
      },
    },
  };
  unsafe {
    let _ = SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
  }
}

fn send_unicode_char(ch: u16, down: bool) {
  let flags = if down {
    KEYEVENTF_UNICODE
  } else {
    KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
  };
  let input = INPUT {
    r#type: INPUT_KEYBOARD,
    Anonymous: INPUT_0 {
      ki: KEYBDINPUT {
        wVk: VIRTUAL_KEY(0),
        wScan: ch,
        dwFlags: flags,
        time: 0,
        dwExtraInfo: 0,
      },
    },
  };
  unsafe {
    let _ = SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
  }
}

/// Prefer real VKs so the capture keyboard poll records typing SFX (Unicode alone is invisible).
fn type_one_char(ch: char) {
  match ch {
    '\n' | '\r' => {
      send_key_vk(VK_RETURN, true);
      thread::sleep(Duration::from_millis(20));
      send_key_vk(VK_RETURN, false);
      return;
    }
    '\t' => {
      send_key_vk(VK_TAB, true);
      thread::sleep(Duration::from_millis(20));
      send_key_vk(VK_TAB, false);
      return;
    }
    '\u{8}' => {
      send_key_vk(VK_BACK, true);
      thread::sleep(Duration::from_millis(20));
      send_key_vk(VK_BACK, false);
      return;
    }
    _ => {}
  }

  if (ch as u32) <= 0x7F {
    let scan = unsafe { VkKeyScanW(ch as u16) };
    if scan != -1 {
      let vk = VIRTUAL_KEY((scan & 0xff) as u16);
      let need_shift = (scan & 0x100) != 0;
      if need_shift {
        send_key_vk(VK_SHIFT, true);
        thread::sleep(Duration::from_millis(6));
      }
      send_key_vk(vk, true);
      thread::sleep(Duration::from_millis(12));
      send_key_vk(vk, false);
      if need_shift {
        thread::sleep(Duration::from_millis(6));
        send_key_vk(VK_SHIFT, false);
      }
      return;
    }
  }

  let s = ch.to_string();
  for unit in s.encode_utf16() {
    send_unicode_char(unit, true);
    thread::sleep(Duration::from_millis(8));
    send_unicode_char(unit, false);
  }
}

/// Type text key-by-key (not clipboard paste) so demos look human.
/// `on_key` fires once per character so the bridge can emit typing SFX for Unicode fallbacks.
pub fn type_text(text: &str, delay_ms: u64, on_key: &mut dyn FnMut()) -> Result<(), String> {
  let delay = Duration::from_millis(delay_ms.clamp(12, 180));
  for ch in text.chars() {
    type_one_char(ch);
    on_key();
    thread::sleep(delay);
  }
  Ok(())
}

/// Window outer / client / estimated browser-content layout for resolution-aware clicks.
#[derive(Debug, Clone, serde::Serialize)]
pub struct WindowLayout {
  pub hwnd: isize,
  pub screen: ScreenSize,
  pub window: RectPx,
  pub client: RectPx,
  /// Estimated webpage / document area inside the window (below browser chrome).
  pub content: RectPx,
  pub chrome_top_px: i32,
  pub notes: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ScreenSize {
  pub width: i32,
  pub height: i32,
  pub origin_x: i32,
  pub origin_y: i32,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct RectPx {
  pub left: i32,
  pub top: i32,
  pub width: i32,
  pub height: i32,
}

fn virtual_screen_size() -> ScreenSize {
  let (ox, oy, vw, vh) = crate::virtual_screen();
  ScreenSize {
    width: vw,
    height: vh,
    origin_x: ox,
    origin_y: oy,
  }
}

/// Map 0..1 coords in the *content* (page) rect into 0..1 of the outer window rect.
pub fn content_to_window_norm(layout: &WindowLayout, cnx: f64, cny: f64) -> (f64, f64) {
  let abs_x = layout.content.left as f64 + cnx.clamp(0.0, 1.0) * layout.content.width as f64;
  let abs_y = layout.content.top as f64 + cny.clamp(0.0, 1.0) * layout.content.height as f64;
  let nx = (abs_x - layout.window.left as f64) / layout.window.width.max(1) as f64;
  let ny = (abs_y - layout.window.top as f64) / layout.window.height.max(1) as f64;
  (nx.clamp(0.04, 0.96), ny.clamp(0.08, 0.96))
}

pub fn window_layout(hwnd: isize) -> Result<WindowLayout, String> {
  let mut wr = windows::Win32::Foundation::RECT::default();
  let mut cr = windows::Win32::Foundation::RECT::default();
  unsafe {
    GetWindowRect(HWND(hwnd as *mut _), &mut wr).map_err(|e| e.to_string())?;
    GetClientRect(HWND(hwnd as *mut _), &mut cr).map_err(|e| e.to_string())?;
  }
  let mut origin = POINT { x: 0, y: 0 };
  unsafe {
    let _ = ClientToScreen(HWND(hwnd as *mut _), &mut origin);
  }
  let ww = (wr.right - wr.left).max(1);
  let wh = (wr.bottom - wr.top).max(1);
  let cw = (cr.right - cr.left).max(1);
  let ch = (cr.bottom - cr.top).max(1);

  // Chromium / Edge / Chrome: tabs + toolbar live inside the client area (~90–110px).
  // Heuristic scales gently with height so laptop vs 4K stay usable.
  let chrome_top = ((ch as f64 * 0.095).round() as i32).clamp(72, 120);
  let content_h = (ch - chrome_top).max(1);
  let content_top = origin.y + chrome_top;

  Ok(WindowLayout {
    hwnd,
    screen: virtual_screen_size(),
    window: RectPx {
      left: wr.left,
      top: wr.top,
      width: ww,
      height: wh,
    },
    client: RectPx {
      left: origin.x,
      top: origin.y,
      width: cw,
      height: ch,
    },
    content: RectPx {
      left: origin.x,
      top: content_top,
      width: cw,
      height: content_h,
    },
    chrome_top_px: chrome_top,
    notes: "Pass contentNx/contentNy from page layout (0..1 of the webpage). Clicks map through content→window automatically.".into(),
  })
}

/// Move to normalized point inside a window (0..1 of outer rect), then optional click.
pub fn move_in_window(
  hwnd: isize,
  nx: f64,
  ny: f64,
  duration_ms: u64,
  click: bool,
) -> Result<(), String> {
  move_in_window_mapped(hwnd, nx, ny, duration_ms, click, false)
}

pub fn move_in_window_mapped(
  hwnd: isize,
  nx: f64,
  ny: f64,
  duration_ms: u64,
  click: bool,
  content_space: bool,
) -> Result<(), String> {
  let (nx, ny) = if content_space {
    let layout = window_layout(hwnd)?;
    content_to_window_norm(&layout, nx, ny)
  } else {
    (nx, ny)
  };
  let mut rect = windows::Win32::Foundation::RECT::default();
  unsafe {
    GetWindowRect(HWND(hwnd as *mut _), &mut rect).map_err(|e| e.to_string())?;
  }
  let w = (rect.right - rect.left).max(1);
  let h = (rect.bottom - rect.top).max(1);
  let x = rect.left + ((nx.clamp(0.04, 0.96) * w as f64).round() as i32);
  let y = rect.top + ((ny.clamp(0.08, 0.96) * h as f64).round() as i32);
  let _ = focus_hwnd(hwnd);
  thread::sleep(Duration::from_millis(90));
  smooth_move_px(x, y, duration_ms)?;
  if click {
    thread::sleep(Duration::from_millis(70));
    click_left()?;
  }
  Ok(())
}

/// Run a JSON demo script (array of step objects).
/// `on_type_key` is invoked once per typed character (for native typing SFX).
pub fn run_script<F>(
  steps: &[serde_json::Value],
  default_hwnd: Option<isize>,
  mut on_type_key: F,
) -> Result<usize, String>
where
  F: FnMut(),
{
  let mut ran = 0usize;
  for step in steps {
    let op = step
      .get("op")
      .and_then(|v| v.as_str())
      .unwrap_or("wait")
      .to_lowercase();
    match op.as_str() {
      "wait" => {
        let ms = step.get("ms").and_then(|v| v.as_u64()).unwrap_or(400);
        thread::sleep(Duration::from_millis(ms.min(30_000)));
      }
      "move" | "click" => {
        let content_space = step.get("contentNx").and_then(|v| v.as_f64()).is_some()
          || step.get("space").and_then(|v| v.as_str()) == Some("content");
        let nx = step
          .get("contentNx")
          .or_else(|| step.get("nx"))
          .and_then(|v| v.as_f64())
          .unwrap_or(0.5);
        let ny = step
          .get("contentNy")
          .or_else(|| step.get("ny"))
          .and_then(|v| v.as_f64())
          .unwrap_or(0.5);
        let duration_ms = step.get("durationMs").and_then(|v| v.as_u64()).unwrap_or(550);
        let do_click = op == "click"
          || step.get("click").and_then(|v| v.as_bool()).unwrap_or(false);
        let in_window = step.get("inWindow").and_then(|v| v.as_bool()).unwrap_or(true);
        let hwnd = step
          .get("hwnd")
          .and_then(|v| v.as_i64())
          .map(|v| v as isize)
          .or(default_hwnd);
        if in_window {
          let hwnd = hwnd.ok_or_else(|| "No window hwnd for in-window move".to_string())?;
          move_in_window_mapped(hwnd, nx, ny, duration_ms, do_click, content_space)?;
        } else {
          smooth_move_norm(nx, ny, duration_ms)?;
          if do_click {
            thread::sleep(Duration::from_millis(60));
            click_left()?;
          }
        }
      }
      "scroll" => {
        let delta = step.get("delta").and_then(|v| v.as_i64()).unwrap_or(-2) as i32;
        scroll(delta)?;
      }
      "right_click" => {
        click_right()?;
      }
      "focus" => {
        if let Some(hwnd) = default_hwnd {
          focus_hwnd(hwnd)?;
        }
      }
      "type" | "type_text" | "typeText" => {
        let text = step
          .get("text")
          .and_then(|v| v.as_str())
          .ok_or_else(|| "type step requires text".to_string())?;
        if text.chars().count() > 500 {
          return Err("type text too long (max 500 chars)".to_string());
        }
        let delay_ms = step.get("delayMs").and_then(|v| v.as_u64()).unwrap_or(45);
        if let Some(hwnd) = default_hwnd {
          focus_hwnd(hwnd)?;
          thread::sleep(Duration::from_millis(80));
        }
        type_text(text, delay_ms, &mut on_type_key)?;
      }
      other => return Err(format!("Unknown demo op: {other}")),
    }
    ran += 1;
  }
  Ok(ran)
}
