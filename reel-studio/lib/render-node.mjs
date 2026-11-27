// Server-side render: Playwright headless Chromium draws each frame via window.drawFrame(t),
// frames are captured as JPEG and piped into ffmpeg (H.264 yuv420p + AAC).
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { stat, writeFile } from 'node:fs/promises';
import { ffmpegPath } from './media.mjs';

let browserPromise = null;
let browserKind = null;

export async function getBrowser() {
  if (browserPromise) return browserPromise;
  browserPromise = (async () => {
    const { chromium } = await import('playwright');
    const attempts = [
      ['chromium', {}],
      ['chromium (/opt/pw-browsers)', { executablePath: '/opt/pw-browsers/chromium' }],
      ['chrome', { channel: 'chrome' }],
      ['msedge', { channel: 'msedge' }],
    ];
    const errors = [];
    for (const [name, opts] of attempts) {
      try {
        const b = await chromium.launch({ headless: true, args: ['--disable-gpu', '--font-render-hinting=none'], ...opts });
        browserKind = name;
        b.on('disconnected', () => { browserPromise = null; });
        return b;
      } catch (e) { errors.push(`${name}: ${String(e.message).split('\n')[0]}`); }
    }
    browserPromise = null;
    throw Object.assign(new Error('No Chromium available: ' + errors.join(' | ')), { code: 'NO_BROWSER' });
  })();
  return browserPromise;
}
export const getBrowserKind = () => browserKind;

export async function closeBrowser() {
  if (!browserPromise) return;
  try { (await browserPromise).close(); } catch {}
  browserPromise = null;
}

/**
 * @param o.data     render payload (see renderData)
 * @param o.wavPath  mixed audio
 * @param o.outPath  output mp4
 * @param o.baseUrl  http://127.0.0.1:4301
 */
export async function renderVideo({ data, wavPath, outPath, coverPath, baseUrl, font, signal, onProgress, onFrame, log = () => {} }) {
  const ff = ffmpegPath();
  if (!ff) throw new Error('ffmpeg not found — run "npm run setup"');
  const browser = await getBrowser();
  const nPages = Math.max(1, Math.min(4, Math.floor(cpus().length / 2) || 1));
  const [VW, VH] = { '1:1': [1080, 1080], '16:9': [1920, 1080] }[data.aspect] || [1080, 1920];
  const context = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1 });
  const pages = [];
  let ffp;
  try {
    for (let i = 0; i < nPages; i++) {
      const page = await context.newPage();
      page.on('pageerror', e => log('render page error: ' + e.message));
      await page.goto(`${baseUrl}/render.html`, { waitUntil: 'load' });
      await page.waitForFunction(() => window.ready === true);
      await page.evaluate(([d, f]) => window.loadProject(d, { font: f }), [data, font]);
      pages.push(page);
    }
    const fps = data.fps || 30;
    const frames = Math.ceil(data.duration * fps);
    log(`${browserKind} · ${nPages} page(s) · ffmpeg ${ff === 'ffmpeg' ? '(PATH)' : ff.split(/[\\/]/).slice(-2).join('/')}`);
    ffp = spawn(ff, ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', 'pipe:0', '-i', wavPath,
      '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
      '-r', String(fps), '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-t', data.duration.toFixed(3), '-movflags', '+faststart', outPath], { stdio: ['pipe', 'ignore', 'pipe'] });
    const errs = [];
    ffp.stderr.on('data', d => errs.push(d));
    const closed = new Promise((res, rej) => ffp.on('close', code => (code === 0 ? res() : rej(new Error('ffmpeg: ' + Buffer.concat(errs).toString().slice(-400))))));
    ffp.stdin.on('error', () => {});
    const write = buf => new Promise(res => (ffp.stdin.write(buf) ? res() : ffp.stdin.once('drain', res)));
    const t0 = Date.now();
    for (let i = 0; i < frames; i += nPages) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const batch = pages.map((pg, j) => (i + j < frames ? pg.evaluate(t => window.grab(t, 0.94), (i + j) / fps) : null)).filter(Boolean);
      const urls = await Promise.all(batch);
      for (let j = 0; j < urls.length; j++) {
        await write(Buffer.from(urls[j].slice(urls[j].indexOf(',') + 1), 'base64'));
        const n = i + j + 1;
        if (n % 20 === 1 || n === frames) onFrame?.(urls[j], (n - 1) / fps);
      }
      const n = Math.min(frames, i + nPages);
      const el = (Date.now() - t0) / 1000;
      onProgress?.(n / frames, `frame ${n}/${frames} · ${(n / el).toFixed(1)} fps`);
    }
    ffp.stdin.end();
    await closed;
    const st = await stat(outPath);
    const cover = coverPath ? await pages[0].evaluate(() => window.grabCover(0.92)) : null;
    if (cover) await writeFile(coverPath, Buffer.from(cover.split(',')[1], 'base64'));
    return { size: st.size, renderer: `playwright(${browserKind})+ffmpeg` };
  } catch (e) {
    try { ffp?.kill('SIGKILL'); } catch {}
    throw e;
  } finally {
    await context.close().catch(() => {});
  }
}

export const outPathFor = (dir, id) => join(dir, 'projects', id, 'reel.mp4');
