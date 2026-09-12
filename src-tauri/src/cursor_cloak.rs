//! Hide the real OS cursor during capture and show a click-through overlay
//! that is excluded from Windows Graphics Capture / screenshots.
//! Chromium ignores `getDisplayMedia({ cursor: "never" })`, so without this
//! the OS pointer is baked into the recording next to our smooth cursor.
//!
//! Standard system cursors are replaced with blanks, but each OCR slot keeps a
//! distinct handle — `read_cursor_shape` / the overlay map those blanks back to
//! arrow / I-beam / resize / etc. Custom app cursors (Excel cell, games) are
//! left alone so `GetCursorInfo` can still capture their bitmaps.

#![cfg(windows)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::LazyLock;
use std::thread;
use std::time::Duration;

use parking_lot::Mutex;
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::Graphics::Gdi::{
  CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC, SelectObject,
  AC_SRC_ALPHA, AC_SRC_OVER, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, BLENDFUNCTION, DIB_RGB_COLORS,
  HGDIOBJ,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
  CopyIcon, CreateCursor, CreateWindowExW, DefWindowProcW, DestroyCursor, DestroyWindow,
  DrawIconEx, GetCursorInfo, GetCursorPos, GetIconInfo, LoadCursorW, RegisterClassExW,
  SetSystemCursor, SetWindowDisplayAffinity, SetWindowPos, ShowWindow, SystemParametersInfoW,
  UpdateLayeredWindow, CS_HREDRAW, CS_VREDRAW, CURSORINFO, CURSOR_SHOWING, CW_USEDEFAULT,
  DI_NORMAL, HCURSOR, HWND_TOPMOST, ICONINFO, IDC_APPSTARTING, IDC_ARROW, IDC_CROSS, IDC_HAND,
  IDC_IBEAM, IDC_NO, IDC_SIZEALL, IDC_SIZENESW, IDC_SIZENS, IDC_SIZENWSE, IDC_SIZEWE, IDC_WAIT,
  OCR_APPSTARTING, OCR_CROSS, OCR_HAND, OCR_IBEAM, OCR_NO, OCR_NORMAL, OCR_SIZEALL, OCR_SIZENESW,
  OCR_SIZENS, OCR_SIZENWSE, OCR_SIZEWE, OCR_WAIT, SPI_SETCURSORS, SWP_NOACTIVATE, SWP_NOSIZE,
  SWP_SHOWWINDOW, SW_HIDE, SW_SHOWNA, SYSTEM_CURSOR_ID, ULW_ALPHA, WDA_EXCLUDEFROMCAPTURE,
  WINDOW_DISPLAY_AFFINITY, WM_DESTROY, WNDCLASSEXW, WS_EX_LAYERED, WS_EX_NOACTIVATE,
  WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP,
};

const OVERLAY_SIZE: i32 = 64;
const HOTSPOT_X: i32 = 10;
const HOTSPOT_Y: i32 = 8;

static RUNNING: AtomicBool = AtomicBool::new(false);
static SESSION: Mutex<()> = Mutex::new(());
/// Blank system-cursor handles → shape name (populated while cloak is active).
static BLANK_SHAPES: LazyLock<Mutex<HashMap<isize, &'static str>>> =
  LazyLock::new(|| Mutex::new(HashMap::new()));
/// Pre-cloak standard handles — apps often cache these and keep using them after blanking.
static PRE_BLANK_SHAPES: LazyLock<Mutex<HashMap<isize, &'static str>>> =
  LazyLock::new(|| Mutex::new(HashMap::new()));

fn hicon_as_cursor(icon: windows::Win32::UI::WindowsAndMessaging::HICON) -> HCURSOR {
  HCURSOR(icon.0)
}

unsafe extern "system" fn overlay_wnd_proc(
  hwnd: HWND,
  msg: u32,
  wparam: WPARAM,
  lparam: LPARAM,
) -> LRESULT {
  if msg == WM_DESTROY {
    return LRESULT(0);
  }
  DefWindowProcW(hwnd, msg, wparam, lparam)
}

fn create_blank_cursor() -> windows::core::Result<HCURSOR> {
  let and = [0xFFu8; 128];
  let xor = [0u8; 128];
  unsafe {
    CreateCursor(
      None,
      0,
      0,
      32,
      32,
      and.as_ptr() as *const _,
      xor.as_ptr() as *const _,
    )
  }
}

/// OCR ids we blank + the IDC_* / shape name used to re-identify them afterward.
fn standard_cursor_slots() -> &'static [(&'static str, SYSTEM_CURSOR_ID, PCWSTR)] {
  &[
    ("arrow", OCR_NORMAL, IDC_ARROW),
    ("ibeam", OCR_IBEAM, IDC_IBEAM),
    ("wait", OCR_WAIT, IDC_WAIT),
    ("cross", OCR_CROSS, IDC_CROSS),
    ("move", OCR_SIZEALL, IDC_SIZEALL),
    ("resize-nwse", OCR_SIZENWSE, IDC_SIZENWSE),
    ("resize-nesw", OCR_SIZENESW, IDC_SIZENESW),
    ("resize-ew", OCR_SIZEWE, IDC_SIZEWE),
    ("resize-ns", OCR_SIZENS, IDC_SIZENS),
    ("not-allowed", OCR_NO, IDC_NO),
    ("hand", OCR_HAND, IDC_HAND),
    ("wait", OCR_APPSTARTING, IDC_APPSTARTING),
  ]
}

fn snapshot_pre_blank_shapes() -> HashMap<isize, &'static str> {
  let mut map = HashMap::new();
  unsafe {
    for &(name, _ocr, idc) in standard_cursor_slots() {
      if let Ok(h) = LoadCursorW(None, idc) {
        map.insert(h.0 as isize, name);
      }
    }
  }
  map
}

fn blank_system_cursors(blank: HCURSOR) -> HashMap<isize, &'static str> {
  unsafe {
    for &(_name, id, _) in standard_cursor_slots() {
      if let Ok(copy) = CopyIcon(blank) {
        let _ = SetSystemCursor(hicon_as_cursor(copy), id);
      }
    }
    // After SetSystemCursor, LoadCursorW returns the installed blank for each slot.
    let mut map = HashMap::new();
    for &(name, _id, idc) in standard_cursor_slots() {
      if let Ok(h) = LoadCursorW(None, idc) {
        map.insert(h.0 as isize, name);
      }
    }
    map
  }
}

fn restore_system_cursors() {
  unsafe {
    let _ = SystemParametersInfoW(SPI_SETCURSORS, 0, None, Default::default());
  }
}

fn copy_standard_cursors() -> HashMap<&'static str, HCURSOR> {
  let mut out = HashMap::new();
  unsafe {
    for &(name, _ocr, idc) in standard_cursor_slots() {
      if out.contains_key(name) {
        continue;
      }
      if let Ok(c) = LoadCursorW(None, idc) {
        if let Ok(copy) = CopyIcon(c) {
          out.insert(name, hicon_as_cursor(copy));
        }
      }
    }
  }
  out
}

fn destroy_cursor_map(map: HashMap<&'static str, HCURSOR>) {
  unsafe {
    for (_, h) in map {
      let _ = DestroyCursor(h);
    }
  }
}

/// If `handle` is one of the blanked system cursors, return its logical shape name.
pub fn cloaked_shape(handle: isize) -> Option<&'static str> {
  BLANK_SHAPES
    .lock()
    .get(&handle)
    .copied()
    .or_else(|| PRE_BLANK_SHAPES.lock().get(&handle).copied())
}

fn paint_overlay_cursor(hwnd: HWND, cursor: HCURSOR, force_white: bool) -> (i32, i32) {
  let mut hotspot = (HOTSPOT_X, HOTSPOT_Y);
  unsafe {
    let mut ii = ICONINFO::default();
    if GetIconInfo(cursor, &mut ii).is_ok() {
      hotspot = (ii.xHotspot as i32, ii.yHotspot as i32);
      if !ii.hbmColor.is_invalid() {
        let _ = DeleteObject(ii.hbmColor);
      }
      if !ii.hbmMask.is_invalid() {
        let _ = DeleteObject(ii.hbmMask);
      }
    }

    let bmi = BITMAPINFO {
      bmiHeader: BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: OVERLAY_SIZE,
        biHeight: -OVERLAY_SIZE,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0 as u32,
        ..Default::default()
      },
      ..Default::default()
    };
    let screen_dc = GetDC(None);
    let mem_dc = CreateCompatibleDC(screen_dc);
    if mem_dc.is_invalid() {
      let _ = ReleaseDC(None, screen_dc);
      return hotspot;
    }
    let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
    let Ok(dib) = CreateDIBSection(mem_dc, &bmi, DIB_RGB_COLORS, &mut bits, None, 0) else {
      let _ = DeleteDC(mem_dc);
      let _ = ReleaseDC(None, screen_dc);
      return hotspot;
    };
    if bits.is_null() {
      let _ = DeleteObject(dib);
      let _ = DeleteDC(mem_dc);
      let _ = ReleaseDC(None, screen_dc);
      return hotspot;
    }
    let len = (OVERLAY_SIZE * OVERLAY_SIZE * 4) as usize;
    std::ptr::write_bytes(bits as *mut u8, 0, len);
    let old = SelectObject(mem_dc, HGDIOBJ(dib.0));
    let draw_size = OVERLAY_SIZE - 8;
    let _ = DrawIconEx(
      mem_dc,
      0,
      0,
      cursor,
      draw_size,
      draw_size,
      0,
      None,
      DI_NORMAL,
    );
    let slice = std::slice::from_raw_parts_mut(bits as *mut u8, len);
    if force_white {
      for px in slice.chunks_exact_mut(4) {
        if px[3] > 8 {
          px[0] = 255;
          px[1] = 255;
          px[2] = 255;
          px[3] = 255;
        }
      }
    }

    let mut size = windows::Win32::Foundation::SIZE {
      cx: OVERLAY_SIZE,
      cy: OVERLAY_SIZE,
    };
    let mut src = POINT { x: 0, y: 0 };
    let blend = BLENDFUNCTION {
      BlendOp: AC_SRC_OVER as u8,
      BlendFlags: 0,
      SourceConstantAlpha: 255,
      AlphaFormat: AC_SRC_ALPHA as u8,
    };
    let _ = UpdateLayeredWindow(
      hwnd,
      screen_dc,
      None,
      Some(&mut size),
      mem_dc,
      Some(&mut src),
      windows::Win32::Foundation::COLORREF(0),
      Some(&blend),
      ULW_ALPHA,
    );

    SelectObject(mem_dc, old);
    let _ = DeleteObject(dib);
    let _ = DeleteDC(mem_dc);
    let _ = ReleaseDC(None, screen_dc);
  }
  // Scale hotspot from typical 32px icon into our oversized overlay draw.
  let scale = (OVERLAY_SIZE - 8) as f32 / 32.0;
  (
    (hotspot.0 as f32 * scale).round() as i32,
    (hotspot.1 as f32 * scale).round() as i32,
  )
}

fn create_overlay_window() -> Option<HWND> {
  unsafe {
    let hinst = GetModuleHandleW(None).ok()?;
    let class = w!("ScreenWeaverCursorOverlay");
    let wc = WNDCLASSEXW {
      cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
      style: CS_HREDRAW | CS_VREDRAW,
      lpfnWndProc: Some(overlay_wnd_proc),
      hInstance: hinst.into(),
      lpszClassName: class,
      ..Default::default()
    };
    let _ = RegisterClassExW(&wc);

    let hwnd = CreateWindowExW(
      WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
      class,
      w!(""),
      WS_POPUP,
      CW_USEDEFAULT,
      CW_USEDEFAULT,
      OVERLAY_SIZE,
      OVERLAY_SIZE,
      None,
      None,
      hinst,
      None,
    )
    .ok()?;

    let _ = SetWindowDisplayAffinity(hwnd, WINDOW_DISPLAY_AFFINITY(WDA_EXCLUDEFROMCAPTURE.0));
    Some(hwnd)
  }
}

fn clear_overlay(hwnd: HWND) {
  unsafe {
    let bmi = BITMAPINFO {
      bmiHeader: BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: OVERLAY_SIZE,
        biHeight: -OVERLAY_SIZE,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0 as u32,
        ..Default::default()
      },
      ..Default::default()
    };
    let screen_dc = GetDC(None);
    let mem_dc = CreateCompatibleDC(screen_dc);
    if mem_dc.is_invalid() {
      let _ = ReleaseDC(None, screen_dc);
      return;
    }
    let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
    if let Ok(dib) = CreateDIBSection(mem_dc, &bmi, DIB_RGB_COLORS, &mut bits, None, 0) {
      if !bits.is_null() {
        let len = (OVERLAY_SIZE * OVERLAY_SIZE * 4) as usize;
        std::ptr::write_bytes(bits as *mut u8, 0, len);
        let old = SelectObject(mem_dc, HGDIOBJ(dib.0));
        let mut size = windows::Win32::Foundation::SIZE {
          cx: OVERLAY_SIZE,
          cy: OVERLAY_SIZE,
        };
        let mut src = POINT { x: 0, y: 0 };
        let blend = BLENDFUNCTION {
          BlendOp: AC_SRC_OVER as u8,
          BlendFlags: 0,
          SourceConstantAlpha: 255,
          AlphaFormat: AC_SRC_ALPHA as u8,
        };
        let _ = UpdateLayeredWindow(
          hwnd,
          screen_dc,
          None,
          Some(&mut size),
          mem_dc,
          Some(&mut src),
          windows::Win32::Foundation::COLORREF(0),
          Some(&blend),
          ULW_ALPHA,
        );
        SelectObject(mem_dc, old);
      }
      let _ = DeleteObject(dib);
    }
    let _ = DeleteDC(mem_dc);
    let _ = ReleaseDC(None, screen_dc);
  }
}

/// Blank the OS cursor (so capture stays clean) and show an exclude-from-capture overlay.
pub fn start() {
  if RUNNING.swap(true, Ordering::SeqCst) {
    return;
  }

  thread::spawn(move || {
    let _session = SESSION.lock();
    if !RUNNING.load(Ordering::SeqCst) {
      return;
    }

    let blank = match create_blank_cursor() {
      Ok(c) => c,
      Err(e) => {
        eprintln!("cursor cloak: blank cursor failed: {e}");
        RUNNING.store(false, Ordering::SeqCst);
        return;
      }
    };

    // Real glyphs for the overlay (copied before we blank the system slots).
    let pre_blank = snapshot_pre_blank_shapes();
    *PRE_BLANK_SHAPES.lock() = pre_blank;
    let originals = copy_standard_cursors();
    let shape_map = blank_system_cursors(blank);
    *BLANK_SHAPES.lock() = shape_map.clone();

    let hwnd = create_overlay_window();
    if let Some(hwnd) = hwnd {
      let mut last_paint_key: isize = 0;
      let mut hotspot = (HOTSPOT_X, HOTSPOT_Y);
      let mut overlay_visible = true;

      while RUNNING.load(Ordering::SeqCst) {
        let mut pt = POINT::default();
        unsafe {
          let _ = GetCursorPos(&mut pt);

          let mut info = CURSORINFO {
            cbSize: std::mem::size_of::<CURSORINFO>() as u32,
            flags: Default::default(),
            hCursor: Default::default(),
            ptScreenPos: POINT::default(),
          };
          let showing =
            GetCursorInfo(&mut info).is_ok() && (info.flags.0 & CURSOR_SHOWING.0) != 0;
          let handle = info.hCursor.0 as isize;

          if !showing {
            if overlay_visible {
              clear_overlay(hwnd);
              let _ = ShowWindow(hwnd, SW_HIDE);
              overlay_visible = false;
              last_paint_key = 0;
            }
          } else {
            if !overlay_visible {
              let _ = ShowWindow(hwnd, SW_SHOWNA);
              overlay_visible = true;
              last_paint_key = 0;
            }

            if handle != last_paint_key {
              last_paint_key = handle;
              if let Some(shape) = shape_map.get(&handle).copied() {
                if let Some(&glyph) = originals.get(shape) {
                  hotspot = paint_overlay_cursor(hwnd, glyph, true);
                }
              } else {
                // Custom app cursor is still visible on-desktop; skip overlay
                // so we don't draw a second pointer on top of Excel/game cursors.
                clear_overlay(hwnd);
                hotspot = (0, 0);
              }
            }

            let _ = SetWindowPos(
              hwnd,
              HWND_TOPMOST,
              pt.x - hotspot.0,
              pt.y - hotspot.1,
              0,
              0,
              SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
            );
          }
        }
        thread::sleep(Duration::from_millis(8));
      }
      unsafe {
        let _ = DestroyWindow(hwnd);
      }
    } else {
      while RUNNING.load(Ordering::SeqCst) {
        thread::sleep(Duration::from_millis(50));
      }
    }

    BLANK_SHAPES.lock().clear();
    PRE_BLANK_SHAPES.lock().clear();
    destroy_cursor_map(originals);
    restore_system_cursors();
    unsafe {
      let _ = DestroyCursor(blank);
    }
    RUNNING.store(false, Ordering::SeqCst);
  });
}

pub fn is_active() -> bool {
  RUNNING.load(Ordering::SeqCst)
}

pub fn stop() {
  RUNNING.store(false, Ordering::SeqCst);
  // Wait until the cloak thread has fully restored system cursors
  let _session = SESSION.lock();
  BLANK_SHAPES.lock().clear();
  PRE_BLANK_SHAPES.lock().clear();
  restore_system_cursors();
}
