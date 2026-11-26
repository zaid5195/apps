// Reel Studio v1 — local server. Plain node:http on 127.0.0.1 only.
import http from 'node:http';
import { readFile, stat, readdir } from 'node:fs/promises';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { join, extname, dirname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Settings, loadDotEnv } from './lib/settings.mjs';
import { FileStore, safeName } from './lib/store.mjs';
import { decodeAudio, ffmpegPath } from './lib/media.mjs';
import { renderVideo, getBrowser, getBrowserKind, closeBrowser } from './lib/render-node.mjs';
import { Pipeline, STAGES, renderData } from './public/core/pipeline.js';
import { elevenVoices } from './public/core/providers.js';
import { licenseSummary } from './public/core/icons.js';
import { lang } from './public/core/lang.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
loadDotEnv(ROOT);
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 4301);
const DATA = resolve(process.env.DATA_DIR || join(ROOT, 'data'));
const PUBLIC = join(ROOT, 'public');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

const settings = new Settings(DATA);
const store = new FileStore(DATA);
let iconLib = null;
const loadIcons = async () => (iconLib ??= JSON.parse(await readFile(join(PUBLIC, 'assets/icons/icons.json'), 'utf8')));

// ---- SSE bus ----------------------------------------------------------------------------------------
const clients = new Map(); // id → Set<res>
function emit(id, ev) {
  const set = clients.get(id);
  if (!set) return;
  const msg = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of set) res.write(msg);
}

// Browser-side render fallback (no Chromium on this machine, or renderer = "browser").
const pendingClientRender = new Map(); // id → {resolve, reject}

async function customFont() {
  const dir = settings.get().fontFolder;
  if (!dir) return null;
  try {
    const files = (await readdir(dir)).filter(f => /\.(ttf|otf|woff2?)$/i.test(f)).sort((a, b) => (/bold/i.test(b) ? 1 : 0) - (/bold/i.test(a) ? 1 : 0));
    if (!files.length) return null;
    return { url: `/fonts/custom/${encodeURIComponent(files[0])}`, name: files[0] };
  } catch { return null; }
}

const pipeline = new Pipeline({
  store,
  fetch: (...a) => fetch(...a),
  getSettings: async () => settings.get(),
  loadStyleGuide: lg => readFile(join(ROOT, 'references', lang(lg).styleFile), 'utf8'),
  loadIcons,
  decodeAudio: bytes => decodeAudio(bytes),
  emit,
  async render({ project, data, wav, settings: s, signal, onProgress, onFrame, log, emit: send }) {
    const dir = store.path(project.id);
    const font = await customFont();
    let useClient = s.renderer === 'browser';
    if (!useClient) {
      try { await getBrowser(); } catch (e) { log(`${e.message}`); log('→ falling back to rendering in your browser tab'); useClient = true; }
    }
    if (!useClient) {
      const out = await renderVideo({ data, wavPath: join(dir, 'mix.wav'), outPath: join(dir, 'reel.mp4'), baseUrl: `http://${HOST}:${PORT}`, font, signal, onProgress, onFrame, log });
      return { file: 'reel.mp4', ...out };
    }
    // Ask the open browser tab to render with WebCodecs and upload the mp4.
    void wav;
    log('Waiting for the browser tab to render (keep the project open)…');
    const done = new Promise((resolve, reject) => {
      pendingClientRender.set(project.id, { resolve, reject });
      signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')));
    });
    send({ type: 'render-request' });
    try { const r = await done; return { file: 'reel.mp4', size: r.size, renderer: 'browser(WebCodecs)' }; }
    finally { pendingClientRender.delete(project.id); }
  },
});

// ---- helpers ------------------------------------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json', '.ogg': 'audio/ogg' };
const send = (res, code, body, headers = {}) => {
  const isObj = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(code, { 'content-type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
};
async function readBody(req, limit = 80e6) {
  const chunks = [];
  let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw Object.assign(new Error('Body too large'), { status: 413 }); chunks.push(c); }
  return Buffer.concat(chunks);
}
const readJson = async req => { const b = await readBody(req, 5e6); return b.length ? JSON.parse(b.toString('utf8')) : {}; };

async function serveFile(req, res, file, { cache = false } = {}) {
  let st;
  try { st = await stat(file); } catch { return send(res, 404, 'Not found'); }
  if (!st.isFile()) return send(res, 404, 'Not found');
  const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  const base = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': cache ? 'max-age=3600' : 'no-cache' };
  if (range) {
    let start = range[1] ? +range[1] : st.size - +range[2], end = range[1] && range[2] ? +range[2] : st.size - 1;
    if (!range[1]) end = st.size - 1;
    if (start > end || end >= st.size) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...base, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...base, 'content-length': st.size });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}
function inside(base, rel) {
  const p = normalize(join(base, rel));
  return p.startsWith(base + sep) || p === base ? p : null;
}

// ---- routes -------------------------------------------------------------------------------------------
async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // after "api"
  const m = req.method;

  if (parts[0] === 'health') {
    let browser = getBrowserKind();
    if (!browser && url.searchParams.get('probe') === '1') { try { await getBrowser(); browser = getBrowserKind(); } catch { browser = null; } }
    return send(res, 200, { ok: true, mode: 'server', version: VERSION, ffmpeg: !!ffmpegPath(), browser, data: DATA });
  }
  if (parts[0] === 'settings') {
    if (m === 'GET') return send(res, 200, settings.public());
    if (m === 'PUT' || m === 'POST') { const r = settings.update(await readJson(req)); return send(res, 200, r); }
  }
  if (parts[0] === 'voices' && m === 'GET') {
    const s = settings.get();
    return send(res, 200, { voices: await elevenVoices({ ...s.eleven }) });
  }
  if (parts[0] === 'fonts' && m === 'GET') return send(res, 200, { custom: await customFont(), folder: settings.get().fontFolder });
  if (parts[0] === 'icons' && m === 'GET') return send(res, 200, { sets: licenseSummary(await loadIcons()) });
  if (parts[0] !== 'projects') return send(res, 404, { error: 'Unknown API' });

  // /api/projects
  if (parts.length === 1) {
    if (m === 'GET') return send(res, 200, { projects: (await store.list()).map(p => ({ id: p.id, topic: p.topic, lang: p.lang || 'ar', title: p.title, length: p.length, updatedAt: p.updatedAt, stages: Object.fromEntries(STAGES.map(s => [s, p.stages[s].status])), render: p.render ? { file: p.render.file, duration: p.render.duration } : null, running: pipeline.isRunning(p.id) })) });
    if (m === 'POST') {
      const b = await readJson(req);
      const p = await pipeline.create(b);
      if (b.start !== false && p.voiceSource !== 'upload') pipeline.start(p.id).catch(() => {});
      return send(res, 201, p);
    }
  }
  const id = parts[1];
  const sub = parts[2];
  if (!sub) {
    if (m === 'GET') { const p = await pipeline.get(id); return send(res, 200, { ...p, running: pipeline.isRunning(id) }); }
    if (m === 'DELETE') { await pipeline.cancel(id).catch(() => {}); await store.remove(id); return send(res, 200, { ok: true }); }
  }
  if (sub === 'events' && m === 'GET') {
    const p = await pipeline.get(id);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`retry: 1500\ndata: ${JSON.stringify({ type: 'state', project: { ...p, running: pipeline.isRunning(id) } })}\n\n`);
    if (pendingClientRender.has(id)) res.write(`data: ${JSON.stringify({ type: 'render-request' })}\n\n`);
    if (!clients.has(id)) clients.set(id, new Set());
    clients.get(id).add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(ping); clients.get(id)?.delete(res); });
    return;
  }
  if (sub === 'start' && m === 'POST') { const p = await pipeline.get(id); pipeline.start(id).catch(() => {}); return send(res, 202, p); }
  if (sub === 'cancel' && m === 'POST') return send(res, 200, await pipeline.cancel(id));
  if (sub === 'approvals' && m === 'POST') return send(res, 200, await pipeline.setApprovals(id, await readJson(req)));
  if (sub === 'stages' && STAGES.includes(parts[3])) {
    const stage = parts[3], action = parts[4];
    if (action === 'approve' && m === 'POST') return send(res, 200, await pipeline.approve(id, stage));
    if (action === 'rerun' && m === 'POST') return send(res, 202, await pipeline.rerun(id, stage));
    if (action === 'edit' && m === 'POST') return send(res, 200, await pipeline.edit(id, stage, await readJson(req)));
  }
  if (sub === 'voice' && m === 'POST') {
    if (pipeline.isRunning(id)) return send(res, 409, { error: 'Pipeline is running' });
    const p = await pipeline.get(id);
    const name = String(url.searchParams.get('name') || 'voice.mp3');
    const ext = (extname(name).toLowerCase() || '.mp3').replace(/[^.a-z0-9]/g, '');
    if (!['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.webm', '.flac', '.mp4'].includes(ext)) return send(res, 400, { error: 'Unsupported audio type' });
    const body = await readBody(req);
    const file = 'upload' + ext;
    await store.writeFile(id, file, body);
    p.upload = { file, name: name.slice(0, 120), mime: req.headers['content-type'] || MIME[ext] || 'audio/mpeg', size: body.length };
    p.voiceSource = 'upload';
    pipeline.resetFrom(p, 'voice');
    await pipeline.save(p);
    return send(res, 200, p);
  }
  if (sub === 'voice-source' && m === 'POST') {
    const b = await readJson(req);
    const p = await pipeline.get(id);
    p.voiceSource = b.source === 'upload' ? 'upload' : 'tts';
    if (b.voiceId !== undefined) p.voiceId = String(b.voiceId);
    if (p.stages.voice.status !== 'idle') pipeline.resetFrom(p, 'voice');
    await pipeline.save(p);
    return send(res, 200, p);
  }
  if (sub === 'render-data' && m === 'GET') {
    const p = await pipeline.get(id);
    return send(res, 200, { data: renderData(p, settings.get()), font: await customFont(), audio: p.voice ? `/api/projects/${id}/files/${p.voice.file}` : null, mix: (await store.fileStat(id, 'mix.wav')) ? `/api/projects/${id}/files/mix.wav` : null });
  }
  if (sub === 'render-upload' && m === 'POST') {
    const pend = pendingClientRender.get(id);
    if (!pend) return send(res, 409, { error: 'No render is waiting for the browser' });
    const body = await readBody(req, 1.5e9);
    await store.writeFile(id, 'reel.mp4', body);
    pend.resolve({ size: body.length });
    return send(res, 200, { ok: true, size: body.length });
  }
  if (sub === 'render-failed' && m === 'POST') {
    const pend = pendingClientRender.get(id);
    const b = await readJson(req);
    pend?.reject(new Error('Browser render failed: ' + (b.error || 'unknown')));
    return send(res, 200, { ok: true });
  }
  if (sub === 'files' && parts[3] && (m === 'GET' || m === 'HEAD')) {
    const name = safeName(decodeURIComponent(parts[3]));
    const headers = url.searchParams.get('download') ? { 'content-disposition': `attachment; filename="${name}"` } : {};
    if (headers['content-disposition']) res.setHeader('content-disposition', headers['content-disposition']);
    return serveFile(req, res, store.path(id, name));
  }
  return send(res, 404, { error: 'Unknown route' });
}

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const server = http.createServer(async (req, res) => {
  try {
    // DNS-rebinding / CSRF guard: only this origin may talk to the server.
    if (!ALLOWED_HOSTS.has(String(req.headers.host))) return send(res, 403, 'Forbidden host');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin && !ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, ''))) return send(res, 403, { error: 'Cross-origin request blocked' });
    }
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname.startsWith('/references/')) {
      const f = inside(join(ROOT, 'references'), decodeURIComponent(url.pathname.slice('/references/'.length)));
      return f ? serveFile(req, res, f) : send(res, 404, 'Not found');
    }
    if (url.pathname.startsWith('/fonts/custom/')) {
      const dir = settings.get().fontFolder;
      const f = dir && inside(resolve(dir), decodeURIComponent(url.pathname.slice('/fonts/custom/'.length)));
      return f ? serveFile(req, res, f) : send(res, 404, 'Not found');
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const f = inside(PUBLIC, rel);
    if (!f) return send(res, 404, 'Not found');
    return serveFile(req, res, f, { cache: rel.startsWith('/assets/') });
  } catch (e) {
    const code = e.status || 500;
    if (code === 500) console.error(e);
    if (!res.headersSent) send(res, code, { error: e.message });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Reel Studio v${VERSION} → http://${HOST}:${PORT}  (data: ${DATA})`);
  console.log(`ffmpeg: ${ffmpegPath() || 'NOT FOUND'}`);
});
const shutdown = async () => { await closeBrowser(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
export { server };
void existsSync;
