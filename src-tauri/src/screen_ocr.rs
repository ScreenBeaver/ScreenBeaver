//! Built-in Windows OCR (Windows.Media.Ocr) over a PNG — gives text-only AI clients
//! (ChatGPT ignores MCP image blocks) the words on screen plus where to click them.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrLine {
  pub text: String,
  /// Normalized 0..1 box inside the image (same space as window nx/ny).
  pub x: f32,
  pub y: f32,
  pub w: f32,
  pub h: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrResult {
  pub width: u32,
  pub height: u32,
  pub lines: Vec<OcrLine>,
}

#[cfg(windows)]
pub fn ocr_png(png: &[u8]) -> Result<OcrResult, String> {
  use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapDecoder, BitmapPixelFormat, SoftwareBitmap};
  use windows::Media::Ocr::OcrEngine;
  use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};

  thread_local! {
    static COM_READY: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
  }
  COM_READY.with(|ready| {
    if !ready.get() {
      unsafe {
        let _ = windows::Win32::System::Com::CoInitializeEx(
          None,
          windows::Win32::System::Com::COINIT_MULTITHREADED,
        );
      }
      ready.set(true);
    }
  });

  let run = || -> windows::core::Result<OcrResult> {
    let stream = InMemoryRandomAccessStream::new()?;
    let writer = DataWriter::CreateDataWriter(&stream)?;
    writer.WriteBytes(png)?;
    writer.StoreAsync()?.get()?;
    writer.FlushAsync()?.get()?;
    writer.DetachStream()?;
    stream.Seek(0)?;

    let decoder = BitmapDecoder::CreateAsync(&stream)?.get()?;
    let raw = decoder.GetSoftwareBitmapAsync()?.get()?;
    let bmp = SoftwareBitmap::ConvertWithAlpha(&raw, BitmapPixelFormat::Bgra8, BitmapAlphaMode::Premultiplied)?;
    let width = bmp.PixelWidth()?.max(1) as u32;
    let height = bmp.PixelHeight()?.max(1) as u32;

    let engine = OcrEngine::TryCreateFromUserProfileLanguages()?;
    let result = engine.RecognizeAsync(&bmp)?.get()?;

    let (fw, fh) = (width as f32, height as f32);
    let mut lines = Vec::new();
    for line in result.Lines()? {
      let text = line.Text()?.to_string_lossy();
      let text = text.trim().to_string();
      if text.is_empty() {
        continue;
      }
      let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
      for word in line.Words()? {
        let r = word.BoundingRect()?;
        x0 = x0.min(r.X);
        y0 = y0.min(r.Y);
        x1 = x1.max(r.X + r.Width);
        y1 = y1.max(r.Y + r.Height);
      }
      if x1 <= x0 || y1 <= y0 {
        continue;
      }
      lines.push(OcrLine {
        text,
        x: x0 / fw,
        y: y0 / fh,
        w: (x1 - x0) / fw,
        h: (y1 - y0) / fh,
      });
    }
    Ok(OcrResult { width, height, lines })
  };
  run().map_err(|e| format!("OCR failed: {e}"))
}

#[cfg(not(windows))]
pub fn ocr_png(_png: &[u8]) -> Result<OcrResult, String> {
  Err("OCR is only available on Windows".into())
}
