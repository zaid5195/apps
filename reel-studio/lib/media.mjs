// ffmpeg helpers (decode audio, encode video). Uses FFMPEG_PATH, then ffmpeg-static, then ffmpeg on PATH.
import { spawn, spawnSync } from 'node:child_process';
import { writeFile, rm, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

let cached;
export function ffmpegPath() {
  if (cached !== undefined) return cached;
  const cands = [];
  if (process.env.FFMPEG_PATH) cands.push(process.env.FFMPEG_PATH);
  try { const p = createRequire(import.meta.url)('ffmpeg-static'); if (p) cands.push(p); } catch {}
  cands.push('ffmpeg');
  for (const c of cands) {
    if (c !== 'ffmpeg' && !existsSync(c)) continue;
    const r = spawnSync(c, ['-version'], { encoding: 'utf8' });
    if (r.status === 0) return (cached = c);
  }
  return (cached = null);
}

export function run(args, { input, signal } = {}) {
  return new Promise((resolve, reject) => {
    const ff = ffmpegPath();
    if (!ff) return reject(new Error('ffmpeg not found — run "npm run setup" or install ffmpeg'));
    const p = spawn(ff, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [], err = [];
    p.stdout.on('data', d => out.push(d));
    p.stderr.on('data', d => { err.push(d); if (err.length > 200) err.shift(); });
    const onAbort = () => p.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort);
    p.on('error', reject);
    p.on('close', code => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new DOMException('Cancelled', 'AbortError'));
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error('ffmpeg failed: ' + Buffer.concat(err).toString().split('\n').slice(-6).join(' ')));
    });
    if (input) p.stdin.end(input); else p.stdin.end();
  });
}

/** Decode any audio file to mono 48 kHz float. */
export async function decodeAudio(bytes) {
  const dir = await mkdtemp(join(tmpdir(), 'reel-'));
  const f = join(dir, 'in');
  try {
    await writeFile(f, bytes);
    const pcm = await run(['-v', 'error', '-i', f, '-f', 'f32le', '-ac', '1', '-ar', '48000', 'pipe:1']);
    const data = new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 4));
    return { sampleRate: 48000, channels: [Float32Array.from(data)] };
  } finally { rm(dir, { recursive: true, force: true }).catch(() => {}); }
}
