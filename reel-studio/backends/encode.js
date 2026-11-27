// In-browser export: draws every frame with the same renderer, encodes H.264 with WebCodecs
// (hardware on phones) + AAC/Opus audio, and muxes an MP4. Used in phone mode and as a server fallback.
import { createRenderer, loadFonts } from '../render/engine.js';
import { Muxer, ArrayBufferTarget } from '../vendor/mp4-muxer.mjs';

export function webCodecsSupported() {
  return typeof window !== 'undefined' && 'VideoEncoder' in window && 'VideoFrame' in window;
}

async function pickVideoConfig(w, h, fps) {
  for (const codec of ['avc1.640028', 'avc1.4d0028', 'avc1.42e028', 'avc1.640033', 'avc1.42003e']) {
    for (const hardwareAcceleration of ['prefer-hardware', 'no-preference', 'prefer-software']) {
      const cfg = { codec, width: w, height: h, bitrate: 9_000_000, framerate: fps, hardwareAcceleration, avc: { format: 'avc' }, latencyMode: 'quality' };
      try { const r = await VideoEncoder.isConfigSupported(cfg); if (r.supported) return r.config; } catch {}
    }
  }
  throw new Error('This browser cannot encode H.264 video (try Chrome on Android, or the PC server)');
}
async function pickAudioConfig() {
  if (!('AudioEncoder' in window)) return null;
  for (const [codec, mux] of [['mp4a.40.2', 'aac'], ['opus', 'opus']]) {
    const cfg = { codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 };
    try { const r = await AudioEncoder.isConfigSupported(cfg); if (r.supported) return { cfg: r.config, mux }; } catch {}
  }
  return null;
}
const tick = () => new Promise(r => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0); });

/**
 * @param data  render payload
 * @param mix   {sampleRate, channels:[Float32Array, Float32Array]} mixed audio
 * @returns Blob (video/mp4)
 */
export async function encodeReel({ data, mix, font, signal, onProgress, onFrame, log = () => {}, cover = false }) {
  if (!webCodecsSupported()) throw new Error('WebCodecs is not available in this browser — use Chrome/Edge (Android or desktop)');
  await loadFonts(document, new URL('../assets/fonts/', import.meta.url).href, font);
  const [W, H] = { '1:1': [1080, 1080], '16:9': [1920, 1080] }[data.aspect] || [1080, 1920];
  const fps = data.fps || 30;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const r = createRenderer(canvas, data);
  const frames = Math.ceil(r.duration * fps);
  const vcfg = await pickVideoConfig(W, H, fps);
  const acfg = mix ? await pickAudioConfig() : null;
  log(`WebCodecs ${vcfg.codec} (${vcfg.hardwareAcceleration || 'auto'}) · audio ${acfg ? acfg.mux : 'none'}`);
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: W, height: H, frameRate: fps },
    audio: acfg ? { codec: acfg.mux, sampleRate: 48000, numberOfChannels: 2 } : undefined,
    fastStart: 'in-memory', firstTimestampBehavior: 'offset',
  });
  let err = null;
  const venc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: e => (err = e) });
  venc.configure(vcfg);

  // audio first (fast), video frames after
  if (acfg) {
    const aenc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: e => (err = e) });
    aenc.configure(acfg.cfg);
    const [L, R] = mix.channels.length > 1 ? mix.channels : [mix.channels[0], mix.channels[0]];
    const n = Math.min(L.length, Math.ceil(r.duration * 48000));
    const block = 4800;
    for (let i = 0; i < n; i += block) {
      const len = Math.min(block, n - i);
      const buf = new Float32Array(len * 2);
      buf.set(L.subarray(i, i + len), 0); buf.set(R.subarray(i, i + len), len);
      const ad = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: len, numberOfChannels: 2, timestamp: Math.round((i / 48000) * 1e6), data: buf });
      aenc.encode(ad); ad.close();
    }
    await aenc.flush(); aenc.close();
  }

  const t0 = performance.now();
  for (let i = 0; i < frames; i++) {
    if (signal?.aborted) { try { venc.close(); } catch {} throw new DOMException('Cancelled', 'AbortError'); }
    if (err) throw err;
    r.drawFrame(i / fps);
    const vf = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
    venc.encode(vf, { keyFrame: i % (fps * 2) === 0 });
    vf.close();
    while (venc.encodeQueueSize > 6) await new Promise(res => setTimeout(res, 4));
    if (i % 4 === 0) await tick();
    if (i % 15 === 0 || i === frames - 1) {
      const el = (performance.now() - t0) / 1000;
      onProgress?.((i + 1) / frames, `frame ${i + 1}/${frames} · ${((i + 1) / el).toFixed(1)} fps`);
    }
    if (onFrame && (i % 30 === 0 || i === frames - 1)) onFrame(canvas.toDataURL('image/jpeg', 0.6), i / fps);
  }
  await venc.flush(); venc.close();
  if (err) throw err;
  muxer.finalize();
  const video = new Blob([muxer.target.buffer], { type: 'video/mp4' });
  if (!cover) return video;
  r.drawCover();
  const coverBlob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.92));
  return { video, cover: coverBlob };
}

/** Decode audio bytes with Web Audio (48 kHz). */
export async function decodeAudioBrowser(bytes) {
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new Ctx(1, 48000, 48000);
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const buf = await ctx.decodeAudioData(ab);
  return { sampleRate: buf.sampleRate, channels: Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c)) };
}
