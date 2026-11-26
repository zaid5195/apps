// One test project per template: runs script→timing on the mock APIs, swaps in a storyboard that
// exercises a single template, then grabs frames through render.html and tiles them into a contact sheet.
// Usage: node tools/template-sheets.mjs [template ...]   → data/sheets/<template>.jpg
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock } from './mock-apis.mjs';
import { ffmpegPath } from '../lib/media.mjs';
import { getBrowser, closeBrowser } from '../lib/render-node.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ALL = ['hero', 'ask', 'body', 'zoom', 'flow', 'cycle', 'timeline', 'chart', 'layers', 'cards', 'meter', 'checklist'];
const want = process.argv.slice(2).filter(a => !a.startsWith('-'));
const templates = want.length ? want : ALL;
const PORT = 4370, MOCK = 4399, BASE = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(join(tmpdir(), 'reel-sheets-'));
const OUT = join(ROOT, 'data', 'sheets');
mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const api = async (path, opts = {}) => {
  const r = await fetch(BASE + path, { ...opts, headers: { 'content-type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const j = await r.json(); if (!r.ok) throw new Error(path + ' ' + JSON.stringify(j)); return j;
};
const ITEMS = {
  hero: { type: 'intro', icon: 'heart', title: 'القلب بيدق ليه؟', items: [{ label: '', icon: 'blood' }, { label: '', icon: 'lungs' }, { label: '', icon: 'brain' }] },
  ask: { type: 'question' },
  body: { type: 'concept', organ: 'heart', items: [{ label: 'القلب مضخة', icon: 'heart' }, { label: 'بيضخ الدم', icon: 'blood' }] },
  zoom: { type: 'concept', items: [{ label: 'الجسم', icon: 'person' }, { label: 'الخلية', icon: 'cell' }, { label: 'DNA', icon: 'dna' }] },
  flow: { type: 'process', title: 'إزاي بيحصل؟', items: [{ label: 'oxygen يدخل', icon: 'lungs' }, { label: 'الدم يشيله', icon: 'blood' }, { label: 'cells تاخد طاقة', icon: 'battery' }] },
  cycle: { type: 'process', title: 'دورة الدم', items: [{ label: 'القلب', icon: 'heart' }, { label: 'الرئة', icon: 'lungs' }, { label: 'الجسم', icon: 'person' }, { label: 'رجوع', icon: 'arrow' }] },
  timeline: { type: 'process', title: 'الحكاية', items: [{ label: 'أول ميكروسكوب', icon: 'microscope', value: 1665 }, { label: 'اكتشاف الخلية', icon: 'cell', value: 1838 }, { label: 'DNA', icon: 'dna', value: 1953 }] },
  chart: { type: 'stat', title: 'دقات القلب', unit: 'bpm', items: [{ label: 'طفل', value: 120 }, { label: 'شخص بالغ', value: 72 }, { label: 'رياضي', value: 50 }] },
  layers: { type: 'concept', title: 'طبقات الجلد', items: [{ label: 'دهون', icon: 'drop' }, { label: 'الأدمة', icon: 'cell' }, { label: 'البشرة', icon: 'shield' }] },
  cards: { type: 'compare', items: [{ label: 'وقت الراحة', icon: 'sleep', value: 60 }, { label: 'وقت الجري', icon: 'person', value: 160 }] },
  meter: { type: 'stat', value: 72, max: 200, unit: 'bpm', icon: 'heart', items: [{ label: 'دقة في الدقيقة' }] },
  checklist: { type: 'recap', title: 'الخلاصة', items: [{ label: 'القلب عضلة', icon: 'muscle' }, { label: 'بيشتغل لوحده', icon: 'bolt' }, { label: 'كهربا جواه', icon: 'heart' }] },
};

const mock = await startMock(MOCK).catch(() => null);
const server = spawn(process.execPath, [join(ROOT, 'server.mjs')], { env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, LLM_BASE_URL: `http://127.0.0.1:${MOCK}/v1`, ELEVENLABS_BASE_URL: `http://127.0.0.1:${MOCK}`, DEEPGRAM_BASE_URL: `http://127.0.0.1:${MOCK}` }, stdio: 'ignore' });
try {
  for (let i = 0; i < 50; i++) { try { await api('/api/health'); break; } catch { await sleep(100); } }
  await api('/api/settings', { method: 'PUT', body: { eleven: { apiKey: 'k', voiceId: 'v' }, llm: { apiKey: 'k' } } });
  const browser = await getBrowser();
  const page = await (await browser.newContext({ viewport: { width: 1080, height: 1920 } })).newPage();
  for (const tpl of templates) {
    const p0 = await api('/api/projects', { method: 'POST', body: { topic: 'القلب', length: 20, approvals: { script: 'auto', voice: 'auto', timing: 'auto', storyboard: 'wait', render: 'auto' } } });
    let p;
    for (let i = 0; i < 300; i++) { p = await api(`/api/projects/${p0.id}`); if (['review', 'error'].includes(p.stages.storyboard.status)) break; await sleep(100); }
    if (p.stages.storyboard.status !== 'review') throw new Error(tpl + ': pipeline failed ' + JSON.stringify(Object.values(p.stages).map(s => s.error)));
    const n = p.timing.tokens.length;
    const qi = p.timing.tokens.findIndex(t => t.text.startsWith('عارف'));
    const at = p.timing.tokens.findIndex(t => t.start >= p.timing.tokens[qi].start + 1.0), spec = ITEMS[tpl];
    const span = n - at;
    const scene = { ...spec, at, template: tpl, items: (spec.items || []).map((it, j) => ({ ...it, at: at + 1 + Math.floor((j * (span - 4)) / Math.max(1, spec.items.length)) })) };
    const q = { type: 'question', at: qi, template: 'ask' };
    const scenes = tpl === 'hero' ? [{ ...scene, at: 0 }, q] : tpl === 'ask' ? [{ type: 'intro', at: 0, template: 'hero', icon: 'heart' }, q] : [{ type: 'intro', at: 0, template: 'hero', icon: 'heart', title: 'القلب' }, q, scene];
    p = await api(`/api/projects/${p0.id}/stages/storyboard/edit`, { method: 'POST', body: { storyboard: { scenes, accents: [[at + 1, 'accent', true], [at + 3, 'accent2']] } } });
    const got = p.storyboard.scenes.map(s => s.template).join(',');
    await page.goto(`${BASE}/render.html?project=${p0.id}`);
    await page.waitForFunction(() => window.ready === true);
    const s0 = tpl === 'hero' ? 0 : p.timing.tokens[tpl === 'ask' ? qi : at].start - 0.12;
    const dur = p.timing.tokens[n - 1].end + 0.7;
    const times = [0.15, 0.35, 0.6, 1, 1.6, 2.4, 3.4, 4.6, 6, 7.5, 9.5, 12].map(d => Math.min(dur - 0.05, s0 + d));
    const dir = join(DATA, 'frames-' + tpl); mkdirSync(dir, { recursive: true });
    for (const [i, t] of times.entries()) {
      const url = await page.evaluate(t => window.grab(t, 0.9), t);
      writeFileSync(join(dir, `f${String(i).padStart(2, '0')}.jpg`), Buffer.from(url.split(',')[1], 'base64'));
    }
    spawnSync(ffmpegPath(), ['-v', 'error', '-y', '-framerate', '1', '-i', join(dir, 'f%02d.jpg'), '-vf', 'scale=360:640,tile=6x2', '-frames:v', '1', join(OUT, `${tpl}.jpg`)]);
    console.log(`${tpl}: storyboard [${got}] → data/sheets/${tpl}.jpg`);
  }
} finally { await closeBrowser(); server.kill(); mock?.close(); rmSync(DATA, { recursive: true, force: true }); }
