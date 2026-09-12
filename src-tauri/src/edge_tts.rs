//! Edge TTS via Microsoft Read Aloud (Rust client — avoids browser WebSocket limits).

use base64::Engine;
use msedge_tts::tts::client::connect;
use msedge_tts::tts::SpeechConfig;
use msedge_tts::voice::get_voices_list;
use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeVoiceDto {
  pub short_name: String,
  pub locale: String,
  pub gender: String,
  pub friendly_name: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeTtsResult {
  pub audio_base64: String,
  pub mime: String,
}

fn speech_config_for_voice(voice: &str) -> Result<SpeechConfig, String> {
  let voices = get_voices_list().map_err(|e| format!("Failed to list Edge voices: {e}"))?;
  let needle = voice.trim().to_lowercase();
  let found = voices.iter().find(|v| {
    v.short_name
      .as_deref()
      .map(|s| s.to_lowercase() == needle)
      .unwrap_or(false)
      || v.name.to_lowercase().contains(&needle)
  });
  if let Some(v) = found {
    return Ok(SpeechConfig::from(v));
  }

  // Build a config from the short name (en-US-JennyNeural → locale + Friendly).
  let parts: Vec<&str> = voice.split('-').collect();
  let (locale, friendly) = if parts.len() >= 3 {
    (format!("{}-{}", parts[0], parts[1]), parts[2..].join("-"))
  } else {
    ("en-US".into(), voice.to_string())
  };
  Ok(SpeechConfig {
    voice_name: format!("Microsoft Server Speech Text to Speech Voice ({locale}, {friendly})"),
    audio_format: "audio-24khz-48kbitrate-mono-mp3".into(),
    pitch: 0,
    rate: 0,
    volume: 0,
  })
}

pub fn list_edge_voices() -> Result<Vec<EdgeVoiceDto>, String> {
  let voices = get_voices_list().map_err(|e| format!("Failed to list Edge voices: {e}"))?;
  let mut out: Vec<EdgeVoiceDto> = voices
    .into_iter()
    .filter_map(|v| {
      let short_name = v.short_name?;
      if !short_name.to_lowercase().contains("neural") {
        return None;
      }
      Some(EdgeVoiceDto {
        short_name,
        locale: v.locale.unwrap_or_else(|| "und".into()),
        gender: v.gender.unwrap_or_default(),
        friendly_name: v.friendly_name.unwrap_or_else(|| v.name.clone()),
      })
    })
    .collect();
  out.sort_by(|a, b| {
    a.locale
      .cmp(&b.locale)
      .then_with(|| a.friendly_name.cmp(&b.friendly_name))
  });
  Ok(out)
}

pub fn synthesize_edge_tts(text: &str, voice: &str) -> Result<EdgeTtsResult, String> {
  let cleaned = text.trim();
  if cleaned.is_empty() {
    return Err("Empty text for TTS".into());
  }
  let chunk = if cleaned.chars().count() > 1800 {
    cleaned.chars().take(1800).collect::<String>()
  } else {
    cleaned.to_string()
  };

  let config = speech_config_for_voice(voice)?;
  let mut client = connect().map_err(|e| format!("Edge TTS connect failed: {e}"))?;
  let audio = client
    .synthesize(&chunk, &config)
    .map_err(|e| format!("Edge TTS synthesize failed: {e}"))?;

  let bytes = audio.audio_bytes;
  if bytes.is_empty() {
    return Err("No audio was received from Edge TTS".into());
  }

  Ok(EdgeTtsResult {
    audio_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
    mime: "audio/mpeg".into(),
  })
}
