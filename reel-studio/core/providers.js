// ElevenLabs (TTS with timestamps, voices, Scribe STT) and Deepgram (STT) clients.
import { missingKey } from './errors.js';
const EL = 'https://elevenlabs.io/app/developers/', DG = 'https://console.deepgram.com/';

const b64ToBytes = b64 => {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const trimBase = u => String(u || '').trim().replace(/\/+$/, '');

async function httpError(res, what) {
  let txt = await res.text().catch(() => '');
  try { const j = JSON.parse(txt); txt = j.detail?.message || j.detail?.status || j.err_msg || j.message || txt; } catch {}
  const e = new Error(`${what} HTTP ${res.status}: ${String(txt).slice(0, 300)}`);
  e.status = res.status;
  return e;
}

export async function elevenVoices({ apiKey, baseUrl = 'https://api.elevenlabs.io', fetchImpl = fetch, signal }) {
  if (!apiKey) throw missingKey('ElevenLabs', EL);
  const res = await fetchImpl(`${trimBase(baseUrl)}/v1/voices`, { headers: { 'xi-api-key': apiKey }, signal });
  if (!res.ok) throw await httpError(res, 'ElevenLabs voices');
  const j = await res.json();
  return (j.voices || []).map(v => ({ id: v.voice_id, name: v.name, category: v.category, labels: v.labels || {}, preview: v.preview_url }));
}

export async function elevenTTS({ apiKey, voiceId, text, modelId = 'eleven_multilingual_v2', languageCode, baseUrl = 'https://api.elevenlabs.io', fetchImpl = fetch, signal }) {
  if (!apiKey) throw missingKey('ElevenLabs', EL);
  if (!voiceId) throw Object.assign(new Error('ما اخترتش صوت. افتح الإعدادات ← «تحميل الأصوات» واختار صوت.'), { friendly: true, code: 'key' });
  const body = { text, model_id: modelId, voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true } };
  if (languageCode) body.language_code = languageCode;
  const url = `${trimBase(baseUrl)}/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=mp3_44100_128`;
  const res = await fetchImpl(url, { method: 'POST', headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!res.ok) throw await httpError(res, 'ElevenLabs TTS');
  const j = await res.json();
  if (!j.audio_base64) throw new Error('ElevenLabs returned no audio');
  return { audio: b64ToBytes(j.audio_base64), alignment: j.alignment || j.normalized_alignment, normalizedAlignment: j.normalized_alignment };
}

/** ElevenLabs per-character alignment → words with per-character times. */
export function alignmentToWords(al) {
  if (!al || !Array.isArray(al.characters)) return [];
  const words = [];
  let cur = null;
  al.characters.forEach((c, i) => {
    const start = al.character_start_times_seconds[i], end = al.character_end_times_seconds[i];
    if (/\s/.test(c)) { if (cur) { words.push(cur); cur = null; } return; }
    if (!cur) cur = { text: '', start, end, chars: [] };
    cur.text += c; cur.end = end; cur.chars.push({ c, start, end });
  });
  if (cur) words.push(cur);
  return words;
}

export async function deepgramListen({ apiKey, audio, mime = 'audio/mpeg', model = 'nova-3', language = 'ar', baseUrl = 'https://api.deepgram.com', fetchImpl = fetch, signal }) {
  if (!apiKey) throw missingKey('Deepgram', DG);
  const q = new URLSearchParams({ model, language, punctuate: 'true', smart_format: 'false' });
  const res = await fetchImpl(`${trimBase(baseUrl)}/v1/listen?${q}`, { method: 'POST', headers: { authorization: `Token ${apiKey}`, 'content-type': mime }, body: audio, signal });
  if (!res.ok) throw await httpError(res, 'Deepgram');
  const j = await res.json();
  const alt = j.results?.channels?.[0]?.alternatives?.[0];
  if (!alt) throw new Error('Deepgram returned no transcript');
  return { transcript: alt.transcript, words: (alt.words || []).map(w => ({ text: w.punctuated_word || w.word, start: w.start, end: w.end, confidence: w.confidence })) };
}

/** ElevenLabs Scribe speech-to-text (word timestamps). Works straight from a phone browser. */
export async function elevenSTT({ apiKey, audio, mime = 'audio/mpeg', fileName = 'voice.mp3', languageCode = 'ara', baseUrl = 'https://api.elevenlabs.io', fetchImpl = fetch, signal }) {
  if (!apiKey) throw missingKey('ElevenLabs', EL);
  const form = new FormData();
  form.append('model_id', 'scribe_v1');
  form.append('language_code', languageCode);
  form.append('timestamps_granularity', 'word');
  form.append('file', new Blob([audio], { type: mime }), fileName);
  const res = await fetchImpl(`${trimBase(baseUrl)}/v1/speech-to-text`, { method: 'POST', headers: { 'xi-api-key': apiKey }, body: form, signal });
  if (!res.ok) throw await httpError(res, 'ElevenLabs STT');
  const j = await res.json();
  return { transcript: j.text, words: (j.words || []).filter(w => w.type !== 'spacing' && w.text?.trim()).map(w => ({ text: w.text.trim(), start: w.start, end: w.end })) };
}

// ---- Gemini TTS (free tier, same key as the Gemini LLM) -------------------------------------------
export const GEMINI_VOICES = ['Kore', 'Puck', 'Charon', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr', 'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat'];
const GEM = 'https://aistudio.google.com/apikey';

/** Native Gemini API: list models that can speak (name contains "tts"). */
export async function geminiTtsModels({ apiKey, baseUrl = 'https://generativelanguage.googleapis.com/v1beta', fetchImpl = fetch, signal }) {
  const res = await fetchImpl(`${trimBase(baseUrl)}/models?pageSize=200`, { headers: { 'x-goog-api-key': apiKey }, signal });
  if (!res.ok) throw await httpError(res, 'Gemini models');
  const j = await res.json();
  return (j.models || []).map(m => String(m.name).replace(/^models\//, '')).filter(n => /tts/i.test(n)).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
}

/** Returns {sampleRate, channels:[Float32Array]} (Gemini sends 16-bit PCM, 24 kHz mono). */
export async function geminiTTS({ apiKey, text, voice = 'Kore', model = 'gemini-2.5-flash-preview-tts', style = '', baseUrl = 'https://generativelanguage.googleapis.com/v1beta', fetchImpl = fetch, signal }) {
  if (!apiKey) throw missingKey('Gemini', GEM);
  const body = {
    contents: [{ parts: [{ text: (style ? style + '\n' : '') + text }] }],
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
  };
  const res = await fetchImpl(`${trimBase(baseUrl)}/models/${encodeURIComponent(model)}:generateContent`, { method: 'POST', headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!res.ok) throw await httpError(res, 'Gemini TTS');
  const j = await res.json();
  const part = j.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.data);
  if (!part) throw new Error('Gemini TTS returned no audio' + (j.candidates?.[0]?.finishReason ? ` (${j.candidates[0].finishReason})` : ''));
  const bytes = b64ToBytes(part.inlineData.data);
  const mime = part.inlineData.mimeType || '';
  const rate = +(mime.match(/rate=(\d+)/) || [, 24000])[1];
  if (/L16|pcm/i.test(mime) || !mime) {
    const n = bytes.length >> 1, out = new Float32Array(n);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true) / 32768;
    return { pcm: { sampleRate: rate, channels: [out] } };
  }
  return { bytes, mime };
}
