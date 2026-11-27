// Audio: synthesized SFX, mixing, BS.1770 loudness (LUFS), limiter, WAV encoding. Pure JS, deterministic.
import { prng } from './text.js';

export const MIX_RATE = 48000;

function resample(data, from, to) {
  if (from === to) return Float32Array.from(data);
  const n = Math.floor((data.length * to) / from);
  const out = new Float32Array(n);
  const r = from / to;
  for (let i = 0; i < n; i++) {
    const x = i * r, i0 = Math.floor(x), f = x - i0;
    const a = data[i0] || 0, b = data[i0 + 1] ?? a;
    out[i] = a + (b - a) * f;
  }
  return out;
}

/** Mono mixdown of a decoded buffer {sampleRate, channels:[Float32Array]} resampled to MIX_RATE. */
export function toMonoMixRate(buf) {
  const ch = buf.channels;
  let mono = ch[0];
  if (ch.length > 1) { mono = new Float32Array(ch[0].length); for (const c of ch) for (let i = 0; i < mono.length; i++) mono[i] += c[i] / ch.length; }
  return resample(mono, buf.sampleRate, MIX_RATE);
}

// --- SFX -------------------------------------------------------------------------------------------
export function synthWhoosh(seed = 1, sr = MIX_RATE, dur = 0.55) {
  const n = Math.floor(sr * dur);
  const L = new Float32Array(n), R = new Float32Array(n);
  const rnd = prng(seed);
  let low = 0, band = 0; // state-variable filter
  for (let i = 0; i < n; i++) {
    const p = i / n;
    const env = Math.pow(Math.sin(Math.PI * Math.min(1, p * 1.25)), 2) * (p < 0.8 ? 1 : (1 - p) / 0.2);
    const fc = 350 + 2600 * Math.sin(Math.PI * Math.min(1, p * 1.1)) ** 1.5;
    const f = 2 * Math.sin((Math.PI * fc) / sr);
    const q = 0.55;
    const x = rnd() * 2 - 1;
    low += f * band;
    const high = x - low - q * band;
    band += f * high;
    const y = band * env * 0.32;
    const pan = 0.2 + 0.6 * p;
    L[i] = y * Math.cos(pan * Math.PI / 2) * 1.2;
    R[i] = y * Math.sin(pan * Math.PI / 2) * 1.2;
  }
  return [L, R];
}

export function synthTick(sr = MIX_RATE) {
  const n = Math.floor(sr * 0.07);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    out[i] = (Math.sin(2 * Math.PI * 2300 * t) * 0.6 + Math.sin(2 * Math.PI * 3450 * t) * 0.3) * Math.exp(-t / 0.011) * 0.16;
  }
  return [out, out];
}

export function synthPop(sr = MIX_RATE) {
  const n = Math.floor(sr * 0.16);
  const out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = 620 * Math.exp(-t / 0.05) + 180;
    ph += (2 * Math.PI * f) / sr;
    out[i] = Math.sin(ph) * Math.exp(-t / 0.045) * Math.min(1, t / 0.003) * 0.22;
  }
  return [out, out];
}

// --- Background music (original, synthesized — no licensing issues) --------------------------------
export const MUSIC_MOODS = ['calm', 'suspense', 'upbeat', 'none'];
const NOTE = n => 440 * Math.pow(2, (n - 69) / 12); // MIDI → Hz
const MOOD = {
  calm: { bpm: 78, chords: [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]], bass: [45, 41, 36, 43], arp: true, drums: false, pad: 0.9 },
  suspense: { bpm: 92, chords: [[50, 53, 57], [50, 53, 58], [46, 50, 53], [49, 52, 57]], bass: [38, 38, 34, 37], arp: 'pulse', drums: 'tick', pad: 1 },
  upbeat: { bpm: 112, chords: [[60, 64, 67], [55, 59, 62], [57, 60, 64], [53, 57, 60]], bass: [48, 43, 45, 41], arp: true, drums: 'beat', pad: 0.7 },
};
/** Deterministic music bed: pads + arpeggio + bass (+ light drums), stereo, at MIX_RATE. */
export function synthMusic(mood, duration, seed = 3) {
  const m = MOOD[mood];
  const n = Math.ceil(duration * MIX_RATE);
  const L = new Float32Array(n), R = new Float32Array(n);
  if (!m) return [L, R];
  const rnd = prng(seed);
  const beat = 60 / m.bpm, bar = beat * 4;
  const add = (t0, dur, f, amp, { attack = 0.01, release = 0.2, pan = 0, partials = [1], detune = 0 } = {}) => {
    const s0 = Math.floor(t0 * MIX_RATE), len = Math.floor((dur + release) * MIX_RATE);
    const gl = Math.cos((pan + 1) * Math.PI / 4), gr = Math.sin((pan + 1) * Math.PI / 4);
    for (let i = 0; i < len && s0 + i < n; i++) {
      const tt = i / MIX_RATE;
      const env = Math.min(1, tt / attack) * (tt > dur ? Math.max(0, 1 - (tt - dur) / release) : 1);
      if (env <= 0) continue;
      let v = 0;
      partials.forEach((a, h) => { v += a * Math.sin(2 * Math.PI * f * (h + 1) * tt + h); });
      const v2 = detune ? Math.sin(2 * Math.PI * f * (1 + detune) * tt) : 0;
      const o = (v + v2 * 0.6) * amp * env;
      L[s0 + i] += o * gl; R[s0 + i] += o * gr;
    }
  };
  const bars = Math.ceil(duration / bar);
  for (let b = 0; b < bars; b++) {
    const t0 = b * bar, ci = b % m.chords.length, chord = m.chords[ci];
    // pad
    chord.forEach((nn, j) => add(t0, bar, NOTE(nn), 0.05 * m.pad, { attack: bar * 0.35, release: bar * 0.4, pan: (j - 1) * 0.5, partials: [1, 0.35, 0.12], detune: 0.003 }));
    // bass
    add(t0, bar * 0.9, NOTE(m.bass[ci]), 0.09, { attack: 0.02, release: 0.3, partials: [1, 0.4] });
    // arpeggio
    if (m.arp) {
      const steps = m.arp === 'pulse' ? 8 : 8;
      for (let s = 0; s < steps; s++) {
        const nn = m.arp === 'pulse' ? chord[0] + 12 : chord[s % 3] + 12 + (s >= 4 ? 12 : 0);
        add(t0 + (s * bar) / steps, (bar / steps) * 0.5, NOTE(nn), m.arp === 'pulse' ? 0.025 : 0.035, { attack: 0.005, release: 0.18, pan: (s % 2 ? 0.4 : -0.4), partials: [1, 0.2, 0.08] });
      }
    }
    // drums
    for (let q = 0; q < 4 && m.drums; q++) {
      const tq = t0 + q * beat;
      if (m.drums === 'beat') {
        // soft kick on every beat
        const s0 = Math.floor(tq * MIX_RATE);
        for (let i = 0; i < MIX_RATE * 0.22 && s0 + i < n; i++) { const tt = i / MIX_RATE; const v = Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-tt / 0.03)) * tt) * Math.exp(-tt / 0.09) * 0.16; L[s0 + i] += v; R[s0 + i] += v; }
      }
      // off-beat hat / tick
      const s1 = Math.floor((tq + beat / 2) * MIX_RATE);
      let lp = 0;
      for (let i = 0; i < MIX_RATE * 0.04 && s1 + i < n; i++) { const x = rnd() * 2 - 1; lp += 0.6 * (x - lp); const v = (x - lp) * Math.exp(-i / (MIX_RATE * 0.008)) * (m.drums === 'tick' ? 0.03 : 0.045); L[s1 + i] += v; R[s1 + i] += v * 0.8; }
    }
  }
  // fade in / out
  const fi = Math.floor(0.6 * MIX_RATE), fo = Math.floor(1.6 * MIX_RATE);
  for (let i = 0; i < n; i++) { const g = Math.min(1, i / fi, (n - i) / fo); L[i] *= g; R[i] *= g; }
  return [L, R];
}

/** Gain curve that lowers the music while the voice is speaking (sidechain-style ducking). */
export function duckCurve(voice, n, depth = 0.7) {
  const win = Math.floor(0.03 * MIX_RATE);
  const g = new Float32Array(n).fill(1);
  let level = 0;
  const att = Math.exp(-1 / (0.04 * MIX_RATE / win)), rel = Math.exp(-1 / (0.35 * MIX_RATE / win));
  for (let s = 0; s < n; s += win) {
    let e = 0;
    for (let i = s; i < s + win && i < voice.length; i++) e += voice[i] * voice[i];
    const active = Math.sqrt(e / win) > 0.02 ? 1 : 0;
    level = active > level ? active + (level - active) * att : active + (level - active) * rel;
    const v = 1 - depth * level;
    for (let i = s; i < s + win && i < n; i++) g[i] = v;
  }
  return g;
}

// --- Loudness (ITU-R BS.1770-4 / EBU R128 integrated) -----------------------------------------------
function biquad(x, b0, b1, b2, a1, a2) {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}
function kWeight(x, fs) {
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / fs);
  const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const s1 = biquad(x, (Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0);
  f0 = 38.13547087602444; Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / fs);
  a0 = 1 + K / Q + K * K;
  return biquad(s1, 1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0);
}

export function integratedLoudness(channels, fs) {
  const w = channels.map(c => kWeight(c, fs));
  const block = Math.round(0.4 * fs), step = Math.round(0.1 * fs);
  const z = [];
  for (let s = 0; s + block <= w[0].length; s += step) {
    let sum = 0;
    for (const c of w) { let a = 0; for (let i = s; i < s + block; i++) a += c[i] * c[i]; sum += a / block; }
    z.push(sum);
  }
  if (!z.length) return -70;
  const L = v => -0.691 + 10 * Math.log10(v);
  const abs = z.filter(v => L(v) > -70);
  if (!abs.length) return -70;
  const rel = L(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const gated = abs.filter(v => L(v) > rel);
  return L(gated.reduce((a, b) => a + b, 0) / gated.length);
}

/** Look-ahead peak limiter (sample peak). */
function limit(channels, fs, ceilingDb = -1.5) {
  const ceil = Math.pow(10, ceilingDb / 20);
  const n = channels[0].length, look = Math.round(0.004 * fs), rel = Math.exp(-1 / (0.08 * fs));
  const peak = new Float32Array(n);
  for (let i = 0; i < n; i++) { let p = 0; for (const c of channels) p = Math.max(p, Math.abs(c[i])); peak[i] = p; }
  // required gain at each sample = min over the look-ahead window
  const need = new Float32Array(n);
  const dq = []; // monotonic deque of indices with max peak
  for (let i = n - 1; i >= 0; i--) {
    while (dq.length && peak[dq[dq.length - 1]] <= peak[i]) dq.pop();
    dq.push(i);
    while (dq[0] > i + look) dq.shift();
    const p = peak[dq[0]];
    need[i] = p > ceil ? ceil / p : 1;
  }
  let g = 1;
  for (let i = 0; i < n; i++) {
    g = need[i] < g ? need[i] : need[i] + (g - need[i]) * rel;
    for (const c of channels) c[i] *= g;
  }
}

/**
 * Mix the voice with SFX cues and normalise to the target loudness.
 * @param voice  decoded {sampleRate, channels}
 * @param sfx    [{t, kind, gain}]
 */
export function mixAudio(voice, sfx, duration, { targetLufs = -14, sfxLevel = 1, seed = 7, music = 'none', musicLevel = 1 } = {}) {
  const fs = MIX_RATE;
  const n = Math.ceil(duration * fs);
  const v = toMonoMixRate(voice);
  // pre-level the voice to about -16 LUFS so SFX sit at a consistent depth
  const vl = integratedLoudness([v], fs);
  const vg = vl > -69 ? Math.pow(10, (-16 - vl) / 20) : 1;
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < Math.min(n, v.length); i++) { L[i] = v[i] * vg; R[i] = v[i] * vg; }
  const tick = synthTick(fs), pop = synthPop(fs);
  sfx.forEach((e, k) => {
    const [a, b] = e.kind === 'whoosh' ? synthWhoosh(seed + k, fs) : e.kind === 'pop' ? pop : tick;
    const s0 = Math.round(e.t * fs), g = (e.gain ?? 1) * sfxLevel;
    for (let i = 0; i < a.length && s0 + i < n; i++) { if (s0 + i < 0) continue; L[s0 + i] += a[i] * g; R[s0 + i] += b[i] * g; }
  });
  // music bed: about 14 dB under the voice, ducked a further ~10 dB while someone speaks
  if (music && music !== 'none' && musicLevel > 0) {
    const [mL, mR] = synthMusic(music, duration, seed);
    const ml = integratedLoudness([mL, mR], fs);
    const mg = ml > -69 ? Math.pow(10, (-30 - ml) / 20) * musicLevel : 0;
    const duck = duckCurve(v.length >= n ? v : Float32Array.from({ length: n }, (_, i) => v[i] || 0), n);
    for (let i = 0; i < n; i++) { const g = mg * duck[i]; L[i] += mL[i] * g; R[i] += mR[i] * g; }
  }
  // fade edges
  const fade = Math.round(0.01 * fs);
  for (let i = 0; i < fade && i < n; i++) { const f = i / fade; L[i] *= f; R[i] *= f; L[n - 1 - i] *= f; R[n - 1 - i] *= f; }
  const ch = [L, R];
  for (let pass = 0; pass < 2; pass++) {
    const lufs = integratedLoudness(ch, fs);
    if (lufs <= -69) break;
    const g = Math.pow(10, (targetLufs - lufs) / 20);
    for (const c of ch) for (let i = 0; i < n; i++) c[i] *= g;
    limit(ch, fs);
  }
  return { sampleRate: fs, channels: ch, lufs: integratedLoudness(ch, fs) };
}

export function encodeWav({ sampleRate, channels }) {
  const nch = channels.length, n = channels[0].length;
  const buf = new ArrayBuffer(44 + n * nch * 2);
  const dv = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + n * nch * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, nch, true); dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * nch * 2, true); dv.setUint16(32, nch * 2, true); dv.setUint16(34, 16, true); str(36, 'data'); dv.setUint32(40, n * nch * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++) { const s = Math.max(-1, Math.min(1, channels[c][i])); dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
  return new Uint8Array(buf);
}

export function decodeWav(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 12, fmt = null;
  while (o + 8 <= dv.byteLength) {
    const id = String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
    const size = dv.getUint32(o + 4, true);
    if (id === 'fmt ') fmt = { format: dv.getUint16(o + 8, true), nch: dv.getUint16(o + 10, true), sr: dv.getUint32(o + 12, true), bits: dv.getUint16(o + 22, true) };
    if (id === 'data' && fmt) {
      const n = Math.floor(size / (fmt.nch * (fmt.bits / 8)));
      const channels = Array.from({ length: fmt.nch }, () => new Float32Array(n));
      let p = o + 8;
      for (let i = 0; i < n; i++) for (let c = 0; c < fmt.nch; c++) {
        if (fmt.bits === 16) { channels[c][i] = dv.getInt16(p, true) / 32768; p += 2; }
        else if (fmt.bits === 32 && fmt.format === 3) { channels[c][i] = dv.getFloat32(p, true); p += 4; }
        else if (fmt.bits === 24) { const v = dv.getUint8(p) | (dv.getUint8(p + 1) << 8) | (dv.getInt8(p + 2) << 16); channels[c][i] = v / 8388608; p += 3; }
        else throw new Error('Unsupported WAV format');
      }
      return { sampleRate: fmt.sr, channels };
    }
    o += 8 + size + (size & 1);
  }
  throw new Error('Invalid WAV');
}
