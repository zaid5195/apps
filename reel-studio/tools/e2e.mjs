// End-to-end test: starts the mock APIs + the server, creates a 10 s project, approves the script,
// waits for the render and checks every stage, then verifies caption ↔ voice sync on the final mp4.
// Usage: node tools/e2e.mjs [--length 10] [--upload] [--keep]
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock } from './mock-apis.mjs';
import { ffmpegPath } from '../lib/media.mjs';
import { buildTimeline } from '../public/core/timeline.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const LENGTH = +(args[args.indexOf('--length') + 1] || 0) || 10;
const UPLOAD = args.includes('--upload');
const LANG = args.includes('--lang') ? args[args.indexOf('--lang') + 1] : 'ar';
const KEEP = args.includes('--keep');
const PORT = 4311 + Math.floor(Math.random() * 50);
const MOCK = 4399;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(join(tmpdir(), 'reel-e2e-'));
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) failures++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const api = async (path, opts = {}) => {
  const r = await fetch(BASE + path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) }, body: opts.body && typeof opts.body !== 'string' && !(opts.body instanceof Uint8Array) ? JSON.stringify(opts.body) : opts.body });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(`${opts.method || 'GET'} ${path} → ${r.status} ${t.slice(0, 200)}`);
  return j;
};

const mock = await startMock(MOCK).catch(() => null); // may already be running
const server = spawn(process.execPath, [join(ROOT, 'server.mjs')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, LLM_BASE_URL: `http://127.0.0.1:${MOCK}/v1`, ELEVENLABS_BASE_URL: `http://127.0.0.1:${MOCK}`, DEEPGRAM_BASE_URL: `http://127.0.0.1:${MOCK}`, YOUTUBE_API_BASE: `http://127.0.0.1:${MOCK}/youtube/v3`, YOUTUBE_UPLOAD_BASE: `http://127.0.0.1:${MOCK}/upload/youtube/v3`, GOOGLE_TOKEN_URL: `http://127.0.0.1:${MOCK}/token`, GOOGLE_AUTH_URL: `http://127.0.0.1:${MOCK}/o/oauth2/v2/auth` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', d => process.env.VERBOSE && process.stdout.write('[server] ' + d));
server.stderr.on('data', d => process.stdout.write('[server:err] ' + d));
const cleanup = () => { server.kill(); mock?.close(); if (!KEEP) rmSync(DATA, { recursive: true, force: true }); };

try {
  for (let i = 0; i < 50; i++) { try { await api('/api/health'); break; } catch { await sleep(100); } }
  const health = await api('/api/health?probe=1');
  ok(health.ok && health.ffmpeg, `server up · ffmpeg ${health.ffmpeg} · browser ${health.browser}`);

  // settings: keys are saved and only come back masked
  const s = await api('/api/settings', { method: 'PUT', body: { llm: { apiKey: 'sk-llm-secret-1234', model: 'retired-model' }, eleven: { apiKey: 'xi-secret-abcd', voiceId: 'mock-voice-eg' }, deepgram: { apiKey: 'dg-secret-wxyz' }, approvals: { script: 'wait' } } });
  ok(s.llm.apiKey === '••••1234' && s.eleven.apiKey === '••••abcd' && !JSON.stringify(s).includes('secret'), 'keys masked to last 4 chars');
  const s2 = await api('/api/settings', { method: 'PUT', body: { eleven: { apiKey: '••••abcd' } } });
  ok(s2.has.eleven, 'masked key round-trip keeps the stored key');
  const voices = await api('/api/voices');
  ok(voices.voices.length >= 1, `load voices: ${voices.voices.map(v => v.name).join(', ')}`);
  // cross-origin POST is refused
  const xo = await fetch(BASE + '/api/settings', { method: 'PUT', headers: { origin: 'https://evil.example' }, body: '{}' });
  ok(xo.status === 403, 'cross-origin write blocked');

  // events stream
  const events = [];
  let p = await api('/api/projects', { method: 'POST', body: { topic: LANG === 'es' ? '¿Por qué late el corazón?' : 'القلب بيدق ليه؟', lang: LANG, length: LENGTH, start: !UPLOAD, approvals: { script: 'wait', voice: 'auto', timing: 'auto', storyboard: 'auto', render: 'auto' } } });
  const id = p.id;
  const ctl = new AbortController();
  (async () => {
    const r = await fetch(`${BASE}/api/projects/${id}/events`, { signal: ctl.signal });
    const rd = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
    for (;;) { const { value, done } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true }); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const blk = buf.slice(0, i); buf = buf.slice(i + 2); const line = blk.split('\n').find(l => l.startsWith('data:')); if (line) events.push(JSON.parse(line.slice(5))); } }
  })().catch(() => {});

  if (UPLOAD) {
    // make a voice file with the mock TTS, then upload it as "my own voice-over"
    p = await api(`/api/projects/${id}/start`, { method: 'POST' });
    for (let i = 0; i < 100 && (await api(`/api/projects/${id}`)).stages.script.status !== 'review'; i++) await sleep(100);
    const proj = await api(`/api/projects/${id}`);
    const tts = await fetch(`http://127.0.0.1:${MOCK}/v1/text-to-speech/x/with-timestamps`, { method: 'POST', headers: { 'xi-api-key': 'k', 'content-type': 'application/json' }, body: JSON.stringify({ text: proj.script.text.replace(/\n+/g, '\n') }) }).then(r => r.json());
    const bytes = Buffer.from(tts.audio_base64, 'base64');
    await api(`/api/projects/${id}/voice?name=my-voice.mp3`, { method: 'POST', headers: { 'content-type': 'audio/mpeg' }, body: new Uint8Array(bytes) });
    ok(true, `uploaded own voice-over (${bytes.length} bytes)`);
  }

  // wait for script review
  let t0 = Date.now();
  while (Date.now() - t0 < 30000) { p = await api(`/api/projects/${id}`); if (p.stages.script.status === 'review' || p.stages.script.status === 'error') break; await sleep(150); }
  ok(p.stages.script.status === 'review', `script waits for approval · "${p.script?.title}" · ${p.script?.words} words (target ${p.script?.target})`);
  ok(LANG === 'es' ? /¿Sabes por qué\?/.test(p.script.text) : /عارف ليه؟/.test(p.script.text), `script contains the series question (${LANG})`);
  ok(!/<think>|think>/i.test(p.script.text + p.script.title), '<think> stripped');
  ok((await api('/api/settings')).llm.model === 'mock-flash-latest' && p.stages.script.log.some(l => /mock-flash-latest/.test(l.msg)), 'retired model → switched to the suggested one and saved');
  const ml = await api('/api/models');
  ok(ml.models[0] === 'mock-flash-latest', `load models: ${ml.models.join(', ')}`);
  ok(p.script.sources.length >= 1, `sources: ${p.script.sources.length}`);
  ok(events.some(e => e.type === 'llm') && events.some(e => e.type === 'state'), 'SSE: state + streamed LLM text');

  // edit the script a little, then approve
  const edited = LANG === 'es' ? p.script.text.replace('hora punta', 'hora punta de la mañana') : p.script.text.replace('الصبح', 'الصبح بدري');
  await api(`/api/projects/${id}/stages/script/edit`, { method: 'POST', body: { text: edited, title: p.script.title, sources: p.script.sources } });
  p = await api(`/api/projects/${id}`);
  ok(p.stages.script.status === 'review' && p.script.text === edited, 'script edit kept in review');
  await api(`/api/projects/${id}/stages/script/approve`, { method: 'POST' });

  t0 = Date.now();
  let lastLog = '';
  while (Date.now() - t0 < 240000) {
    p = await api(`/api/projects/${id}`);
    const st = Object.values(p.stages).map(s => s.status);
    const msg = Object.entries(p.stages).map(([k, s]) => `${k}:${s.status}`).join(' ');
    if (msg !== lastLog) { console.log('  ' + msg); lastLog = msg; }
    if (st.includes('error') || (p.stages.render.status === 'done')) break;
    await sleep(400);
  }
  for (const [k, s] of Object.entries(p.stages)) ok(s.status === 'done', `stage ${k}: ${s.status}${s.error ? ' — ' + s.error : ''} · ${s.log.length} log lines`);
  if (p.stages.render.status !== 'done') throw new Error('pipeline did not finish');

  ok(p.voice.duration > 3, `voice ${p.voice.duration.toFixed(2)} s via ${p.voice.provider}`);
  ok(p.timing.stats.coverage > 0.8, `timing coverage ${(p.timing.stats.coverage * 100).toFixed(0)}% · weak ${p.timing.stats.weak} · via ${p.timing.provider}`);
  ok(p.timing.tokens.every((t, i, a) => !i || t.start >= a[i - 1].start), 'word onsets are monotonic');
  ok(p.timing.tokens.map(t => t.text).join(' ').replace(/\s+/g, ' ') === edited.replace(/\s+/g, ' ').trim(), 'captions use the script\'s own spelling');
  const sb = p.storyboard;
  ok(sb.scenes[0].type === 'intro' && sb.scenes[0].at === 0, 'storyboard: first scene intro at 0');
  ok(sb.scenes.every((s, i, a) => !i || s.at > a[i - 1].at), 'storyboard: sorted, valid indices');
  ok(sb.scenes.every((s, i, a) => i < 2 || !(s.template === a[i - 1].template && s.template === a[i - 2].template)), 'storyboard: no template 3× in a row');
  ok(sb.scenes.some(s => s.type === 'question'), 'storyboard: question scene present');
  ok(p.storyboard.scenes.length >= 3, `${sb.scenes.length} scenes: ${sb.scenes.map(s => s.template).join(', ')}`);
  ok(Object.keys(p.icons).length > 2 && Object.keys(p.icons).length < 60, `${Object.keys(p.icons).length} icons sent to the renderer (subset)`);
  ok(Math.abs(p.render.lufs + 14) < 0.6, `mix loudness ${p.render.lufs} LUFS`);
  ok(events.some(e => e.type === 'progress' && e.stage === 'render'), 'SSE: render progress');
  ok(events.some(e => e.type === 'frame'), 'SSE: live preview frame');

  // ---- inspect the mp4
  const mp4 = join(DATA, 'projects', id, 'reel.mp4');
  ok(existsSync(mp4), `reel.mp4 ${(p.render.size / 1e6).toFixed(2)} MB rendered by ${p.render.renderer} in ${p.render.seconds}s`);
  const ff = ffmpegPath();
  const probe = spawnSync(ff, ['-hide_banner', '-i', mp4], { encoding: 'utf8' }).stderr;
  ok(/h264/.test(probe) && /yuv420p/.test(probe) && /1080x1920/.test(probe) && /30 fps/.test(probe), 'H.264 · yuv420p · 1080×1920 · 30 fps');
  ok(/aac/.test(probe), 'AAC audio');
  const dur = +(probe.match(/Duration: (\d+):(\d+):([\d.]+)/) || []).slice(1).reduce((a, v, i) => a + v * [3600, 60, 1][i], 0);
  ok(Math.abs(dur - p.render.duration) < 0.2, `duration ${dur.toFixed(2)} s (expected ${p.render.duration.toFixed(2)})`);
  const lufs = spawnSync(ff, ['-hide_banner', '-nostats', '-i', mp4, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' }).stderr.match(/Integrated loudness:\s*\n\s*I:\s+(-?[\d.]+) LUFS/);
  ok(lufs && Math.abs(+lufs[1] + 14) < 1, `ffmpeg ebur128 integrated ${lufs?.[1]} LUFS`);

  // ---- caption ↔ voice sync: detect speech onsets in the final audio and compare with word onsets
  const pcm = spawnSync(ff, ['-v', 'error', '-i', mp4, '-f', 's16le', '-ac', '1', '-ar', '16000', 'pipe:1'], { maxBuffer: 1e9 }).stdout;
  const sm = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length >> 1);
  const win = 80; // 5 ms
  const env = [];
  for (let i = 0; i + win <= sm.length; i += win) { let e = 0; for (let j = i; j < i + win; j++) e += sm[j] * sm[j]; env.push(Math.sqrt(e / win)); }
  const thr = Math.max(...env) * 0.08;
  const onsets = [];
  for (let i = 3; i < env.length; i++) if (env[i] > thr && env.slice(i - 3, i).every(v => v < thr)) onsets.push(i * 0.005);
  const cues = buildTimeline({ tokens: p.timing.tokens, storyboard: p.storyboard, duration: p.render.duration }).sfx;
  const sfx = cues.map(e => e.t);
  const masked = w => cues.some(e => (e.kind === 'whoosh' ? w > e.t - 0.05 && w < e.t + 0.6 : Math.abs(w - e.t) < 0.15)); // onset hidden under an SFX
  const speech = onsets.filter(o => !sfx.some(s => Math.abs(s - o) < 0.12));
  const measurable = p.timing.tokens.filter(t => !masked(t.start) && !t.weak);
  const weakMeasurable = p.timing.tokens.filter(t => !masked(t.start) && t.weak);
  const wordOnsets = measurable.map(t => t.start);
  const errs = wordOnsets.map(w => Math.min(...speech.map(o => Math.abs(o - w))));
  const worst = errs.map((e, i) => [e, i]).sort((a, b) => b[0] - a[0]).slice(0, 5).map(([e, i]) => `${measurable[i].text}:${Math.round(e * 1000)}ms${measurable[i].weak ? '(weak)' : ''}`);
  console.log('  worst: ' + worst.join(' '));
  const median = errs.slice().sort((a, b) => a - b)[Math.floor(errs.length / 2)];
  const within = errs.filter(e => e <= 1 / 30 + 0.02).length / errs.length;
  ok(median <= 0.03 && within >= 0.95, `caption sync: median |onset − caption| = ${(median * 1000).toFixed(0)} ms · ${(within * 100).toFixed(0)}% of ${errs.length} measurable words within 1 frame + 20 ms (${p.timing.tokens.filter(t => masked(t.start)).length} hidden under an SFX)`);
  if (weakMeasurable.length) {
    const we = weakMeasurable.map(t => Math.min(...speech.map(o => Math.abs(o - t.start))));
    ok(Math.max(...we) < 0.15, `weak (flagged) words: ${weakMeasurable.length}, max error ${Math.round(Math.max(...we) * 1000)} ms (< 150 ms, shown for review)`);
  }

  // ---- frames: word lights up exactly at its onset (render-data + timeline agree)
  const rd = await api(`/api/projects/${id}/render-data`);
  ok(rd.data.tokens.length === p.timing.tokens.length && Object.keys(rd.data.icons).length === Object.keys(p.icons).length, 'render-data carries tokens + icon subset');

  // keep a copy for humans
  const outDir = join(ROOT, 'data', 'e2e');
  mkdirSync(outDir, { recursive: true });
  const keep = join(outDir, `reel-${LENGTH}s${LANG === 'es' ? '-es' : ''}${UPLOAD ? '-upload' : ''}.mp4`);
  copyFileSync(mp4, keep);
  console.log(`→ ${keep}`);

  // ---- new features: style / formats / cover / post caption
  ok(!!p.publish?.caption && p.publish.hashtags.every(h => /^#\S+$/.test(h)), `post caption + ${p.publish?.hashtags?.length} hashtags: ${p.publish?.hashtags?.slice(0, 4).join(' ')}`);
  ok(!!p.render.cover && existsSync(join(DATA, 'projects', id, 'cover.jpg')), 'cover.jpg rendered');
  await api(`/api/projects/${id}/style`, { method: 'POST', body: { formats: ['9:16', '1:1', '16:9'], captions: 'box', music: 'upbeat' } });
  await api(`/api/projects/${id}/stages/render/rerun`, { method: 'POST' });
  for (let i = 0; i < 600; i++) { p = await api(`/api/projects/${id}`); if (['done', 'error'].includes(p.stages.render.status) && !p.running) break; await sleep(400); }
  const dims = f => (spawnSync(ff, ['-hide_banner', '-i', join(DATA, 'projects', id, f)], { encoding: 'utf8' }).stderr.match(/, (\d+x\d+)/) || [])[1];
  ok(p.stages.render.status === 'done' && p.render.files.length === 3, `3 formats: ${p.render.files?.map(f => `${f.aspect}=${dims(f.file)}`).join(' · ')}`);
  ok(dims('reel-1x1.mp4') === '1080x1080' && dims('reel-16x9.mp4') === '1920x1080', '1:1 is 1080×1080, 16:9 is 1920×1080');
  for (const [f, name] of [['reel.mp4', '9x16'], ['reel-1x1.mp4', '1x1'], ['reel-16x9.mp4', '16x9'], ['cover.jpg', 'cover']]) copyFileSync(join(DATA, 'projects', id, f), join(ROOT, 'data', 'e2e', `styled-${name}.${f.split('.').pop()}`));
  // ideas
  const ideas = await api('/api/ideas', { method: 'POST', body: { lang: LANG, hint: 'الجسم' } });
  ok(ideas.ideas.length === 10 && ideas.ideas[0].topic, `ideas: ${ideas.ideas.length} (e.g. «${ideas.ideas[0].topic}»)`);
  // backup LLM providers: main key rejected → the backup answers; keys stay masked
  const sb1 = await api('/api/settings', { method: 'PUT', body: { llm: { apiKey: 'bad-key' }, llmBackups: [{ id: 'b1', preset: 'groq', name: 'Groq', baseUrl: `http://127.0.0.1:${MOCK}/v1`, model: 'mock-flash-latest', apiKey: 'gsk-backup-secret-7777', enabled: true }] } });
  ok(sb1.llmBackups[0].apiKey === '••••7777' && !JSON.stringify(sb1).includes('backup-secret'), 'backup provider key stored and shown masked');
  const sb2 = await api('/api/settings', { method: 'PUT', body: { llmBackups: sb1.llmBackups } });
  ok(sb2.llmBackups[0].hasKey, 'masked backup key round-trip keeps the key');
  const viaBackup = await api('/api/ideas', { method: 'POST', body: { lang: LANG } });
  ok(viaBackup.ideas.length === 10 && viaBackup.log.some(l => /Groq/.test(l)), `main provider failed → backup «Groq» answered (${viaBackup.log.filter(l => /Groq/.test(l)).length} log lines)`);
  const bm = await api('/api/models?backup=b1');
  ok(bm.models.includes('mock-flash-latest'), 'load models for a backup provider');
  await api('/api/settings', { method: 'PUT', body: { llm: { apiKey: 'sk-llm-secret-1234' }, llmBackups: [] } });
  // custom end-screen text
  await api(`/api/projects/${id}/style`, { method: 'POST', body: { handle: '@my_new_name', endFollow: 'اشترك عشان يوصلك الجديد', endComment: 'تحب نشرح إيه بعد كده؟' } });
  const rdS = await api(`/api/projects/${id}/render-data`);
  ok(rdS.data.style.handle === '@my_new_name' && rdS.data.style.followText === 'اشترك عشان يوصلك الجديد' && rdS.data.style.commentText === 'تحب نشرح إيه بعد كده؟', 'end screen name + texts are editable per project');

  // ---- YouTube: connect the channel (OAuth), upload with title/description/tags, cover as thumbnail
  await api('/api/settings', { method: 'PUT', body: { youtube: { clientId: 'mock-client.apps.googleusercontent.com', clientSecret: 'GOCSPX-mock-secret', privacy: 'public' } } });
  const yc = await api('/api/youtube/connect');
  const r1 = await fetch(yc.url, { redirect: 'manual' });                  // Google consent (mock) → back to our callback
  const r2 = await fetch(r1.headers.get('location'), { redirect: 'manual' }); // callback exchanges the code
  const yst = await api('/api/youtube');
  ok(/yt=ok/.test(r2.headers.get('location') || '') && yst.connected && yst.channel?.title === 'Mock Channel', `YouTube connected: ${yst.channel?.title}`);
  const sYt = await api('/api/settings');
  ok(!JSON.stringify(sYt).includes('1//mock-refresh') && !JSON.stringify(sYt).includes('GOCSPX-mock-secret'), 'YouTube secret + refresh token never sent to the browser');
  await api(`/api/projects/${id}/youtube`, { method: 'POST', body: {} });
  for (let i = 0; i < 100; i++) { p = await api(`/api/projects/${id}`); if (['done', 'error'].includes(p.youtube?.status)) break; await sleep(200); }
  const vids = await fetch(`http://127.0.0.1:${MOCK}/mock/youtube-videos`).then(r => r.json());
  const v = vids[p.youtube?.videoId];
  ok(p.youtube?.status === 'done' && /youtu\.be\/mockVid/.test(p.youtube.url), `uploaded to YouTube: ${p.youtube?.url} ${p.youtube?.error || ''}`);
  ok(v && v.bytes === p.render.size && v.snippet.title === p.publish.title && v.snippet.description.includes('#') && v.snippet.description.includes('#Shorts') && v.snippet.tags.length >= 3 && v.status.privacyStatus === 'public', `YouTube got the full file (${v?.bytes} bytes, chunked) + title «${v?.snippet?.title}» + description + ${v?.snippet?.tags?.length} tags`);
  ok(v?.thumbnailBytes > 1000 && p.youtube.thumbnail, 'cover set as the YouTube thumbnail');
  ok(/خاص|Studio/.test(p.youtube.note || ''), 'warns when YouTube kept the video private (unverified Google project)');
  await api('/api/settings', { method: 'PUT', body: { youtube: { autoUpload: true } } });

  // free Gemini voice + estimated timings, through a 2-topic batch (and a retired TTS model)
  await api('/api/settings', { method: 'PUT', body: { eleven: { apiKey: '' }, deepgram: { apiKey: '' }, gemini: { apiKey: 'g-test-key', baseUrl: `http://127.0.0.1:${MOCK}/v1beta`, ttsModel: 'retired-tts' } } });
  const bt = await api('/api/batch', { method: 'POST', body: { topics: [LANG === 'es' ? '¿Por qué soñamos?' : 'ليه بنحلم؟', LANG === 'es' ? '¿Por qué el cielo es azul?' : 'ليه السما زرقا؟'], options: { lang: LANG, length: 10, voiceSource: 'gemini', style: { captions: 'word', music: 'suspense' } } } });
  let bps = [];
  for (let i = 0; i < 900; i++) { bps = await Promise.all(bt.queued.map(q => api(`/api/projects/${q}`))); if (bps.every(b => ['done', 'error'].includes(b.stages.render.status) || Object.values(b.stages).some(s => s.status === 'error'))) break; await sleep(400); }
  ok(bps.every(b => b.stages.render.status === 'done'), `batch: ${bps.length} reels finished one after another (${bps.map(b => Object.values(b.stages).map(s => s.status[0]).join('')).join(' / ')})`);
  ok(bps.every(b => b.voice?.provider === 'gemini' && b.timing?.provider === 'estimate'), 'Gemini voice + estimated timings (no transcription key)');
  ok((await api('/api/settings')).gemini.ttsModel === 'mock-tts-2', 'retired Gemini TTS model → switched and saved');
  for (let i = 0; i < 100; i++) { bps = await Promise.all(bt.queued.map(q => api(`/api/projects/${q}`))); if (bps.every(b => ['done', 'error'].includes(b.youtube?.status))) break; await sleep(200); }
  ok(bps.every(b => b.youtube?.status === 'done'), `auto-publish: every batch reel uploaded by itself (${bps.map(b => b.youtube?.status).join(', ')})`);
  const gw = (await fetch(`http://127.0.0.1:${MOCK}/mock/last-gemini-words`).then(r => r.json())).words;
  const lastP = bps[bps.length - 1];
  if (gw && gw.length === lastP.timing.tokens.length) {
    const ge = lastP.timing.tokens.map((t, i) => Math.abs(t.start - gw[i].start)).sort((a, b) => a - b);
    ok(ge[Math.floor(ge.length / 2)] < 0.12, `estimated timing error: median ${Math.round(ge[Math.floor(ge.length / 2)] * 1000)} ms, 90% ≤ ${Math.round(ge[Math.floor(ge.length * 0.9)] * 1000)} ms`);
  } else ok(false, `gemini words ${gw?.length} vs tokens ${lastP.timing.tokens.length}`);
  copyFileSync(join(DATA, 'projects', lastP.id, 'reel.mp4'), join(ROOT, 'data', 'e2e', 'gemini-voice.mp4'));

  // ---- rerun + cancel
  await api(`/api/projects/${id}/stages/storyboard/rerun`, { method: 'POST' });
  await sleep(150);
  await api(`/api/projects/${id}/cancel`, { method: 'POST' });
  p = await api(`/api/projects/${id}`);
  ok(['idle', 'done', 'running'].includes(p.stages.storyboard.status) && p.stages.render.status !== 'done', `rerun resets downstream, cancel works (storyboard: ${p.stages.storyboard.status}, render: ${p.stages.render.status})`);
  ctl.abort();
} catch (e) {
  failures++;
  console.error('✗', e.message);
} finally {
  cleanup();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
}
void readFileSync;
