// UI test on a phone-sized viewport: server mode and phone (in-browser) mode, both against the mock APIs.
// Usage: node tools/ui-test.mjs [--local-only|--server-only]   → screenshots in data/ui/
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock } from './mock-apis.mjs';
import { getBrowser, closeBrowser } from '../lib/render-node.mjs';
import { ffmpegPath } from '../lib/media.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4380, MOCK = 4399, BASE = `http://127.0.0.1:${PORT}`, M = `http://127.0.0.1:${MOCK}`;
const DATA = mkdtempSync(join(tmpdir(), 'reel-ui-'));
const OUT = join(ROOT, 'data', 'ui'); mkdirSync(OUT, { recursive: true });
const args = process.argv.slice(2);
let fails = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const mock = await startMock(MOCK).catch(() => null);
const server = spawn(process.execPath, [join(ROOT, 'server.mjs')], { env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA }, stdio: 'ignore' });
const browser = await getBrowser();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, locale: 'ar-EG' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('dialog', d => d.accept());
const shot = name => page.screenshot({ path: join(OUT, name + '.png'), fullPage: false });

async function fillSettings() {
  await page.goto(`${BASE}/#/settings`);
  await page.waitForSelector('text=الإعدادات');
  const set = async (label, value) => { const el = page.locator(`label:has-text("${label}") + *`).first(); await el.fill(value); };
  const inputs = page.locator('input.ltr');
  // Base URL fields: llm, eleven, deepgram (in order)
  await page.locator('label:text-is("Base URL") + input').first().fill(`${M}/v1`);
  await page.locator('label:text-is("Base URL") + input').nth(1).fill(M);
  await page.locator('label:text-is("Base URL") + input').nth(2).fill(M);
  const keys = page.locator('input[type=password]');
  await keys.nth(0).fill('sk-test-llm-9876');
  await keys.nth(1).fill('xi-test-key-5555');
  await keys.nth(2).fill('dg-test-key-4444');
  void set; void inputs;
  await page.click('text=⟳ تحميل الأصوات');
  await page.waitForSelector('select option[value="mock-voice-eg"]', { state: 'attached' });
  await page.selectOption('select:has(option[value="mock-voice-eg"])', 'mock-voice-eg');
  await page.click('text=حفظ الإعدادات');
  await sleep(400);
  const masked = await keys.nth(1).inputValue();
  ok(masked === '••••5555', `settings saved, key shown masked (${masked})`);
  await shot('settings');
}

async function runProject(tag, timeoutMs, es = false) {
  await page.goto(`${BASE}/#/`);
  await page.waitForSelector('textarea');
  await page.fill('textarea', 'ليه بنتاوب لما نشوف حد بيتاوب؟');
  if (es) { await page.click('text=Español'); await page.fill('textarea', '¿Por qué bostezamos?'); } else await page.click('text=العربية (مصري)');
  await page.click('.chip:has-text("10 ث")');
  await shot(tag + '-home');
  await page.click('text=✦ ابدأ الريل');
  await page.waitForSelector('.badge.review', { timeout: 30000 });
  ok(await page.locator(`#st-script >> text=${es ? '¿Sabes por qué?' : 'عارف ليه؟'}`).count() > 0, `${tag}: ${es ? 'Spanish' : 'Arabic'} script ready for review`);
  await shot(tag + '-script-review');
  await page.click('.sticky-actions button.ok');
  const t0 = Date.now();
  let sawFrame = false;
  while (Date.now() - t0 < timeoutMs) {
    if (await page.locator('#live-frame[src^="data:"]').count()) { if (!sawFrame) await shot(tag + '-rendering'); sawFrame = true; }
    if (await page.locator('#st-render video').count()) break;
    if (await page.locator('.badge.error').count()) break;
    await sleep(300);
  }
  ok(sawFrame, `${tag}: live preview frame shown while rendering`);
  ok(await page.locator('#st-render video').count() === 1, `${tag}: finished video shown`);
  const err = await page.locator('.badge.error').count();
  if (err) console.log(await page.locator('.stage .err').allTextContents());
  await page.locator('#st-render').scrollIntoViewIfNeeded();
  await sleep(500);
  await shot(tag + '-done');
  await page.locator('#st-storyboard').scrollIntoViewIfNeeded();
  await sleep(800);
  await shot(tag + '-storyboard');
  return page.url().split('/p/')[1];
}

try {
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/health'); break; } catch { await sleep(100); } }
  if (!args.includes('--local-only')) {
    await fillSettings();
    const id = await runProject('server', 120000);
    ok(!!id, 'server mode end to end');
  }
  if (!args.includes('--server-only')) {
    // Phone mode: same page, everything in the browser (IndexedDB + WebCodecs), APIs called directly.
    await page.goto(`${BASE}/?mode=local#/`);
    await page.evaluate(() => localStorage.setItem('reel.mode', 'local'));
    await page.reload();
    await page.waitForSelector('#mode:has-text("هاتف")');
    ok(true, 'phone mode active');
    await fillSettings();
    await runProject('phone', 240000, true);
    // pull the mp4 out of the page and check it
    const b64 = await page.evaluate(async () => { const v = document.querySelector('#st-render video'); const b = await (await fetch(v.src)).arrayBuffer(); let s = ''; const u = new Uint8Array(b); for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode(...u.subarray(i, i + 32768)); return btoa(s); });
    const f = join(OUT, 'phone-reel.mp4');
    writeFileSync(f, Buffer.from(b64, 'base64'));
    const probe = spawnSync(ffmpegPath(), ['-hide_banner', '-i', f], { encoding: 'utf8' }).stderr;
    ok(/h264/.test(probe) && /1080x1920/.test(probe), 'phone mode mp4: H.264 1080×1920');
    ok(/Audio: (aac|opus)/.test(probe), 'phone mode mp4 has audio: ' + (probe.match(/Audio: (\w+)/) || [])[1]);
    const lufs = spawnSync(ffmpegPath(), ['-hide_banner', '-nostats', '-i', f, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' }).stderr.match(/Integrated loudness:\s*\n\s*I:\s+(-?[\d.]+) LUFS/);
    ok(lufs && Math.abs(+lufs[1] + 14) < 1.2, `phone mode loudness ${lufs?.[1]} LUFS`);
    await page.evaluate(() => localStorage.removeItem('reel.mode'));
  }
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal overflow on a 390 px phone');
  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.slice(0, 5).join(' | ') : ''}`);
} catch (e) { fails++; console.error('✗', e.message); await shot('failure').catch(() => {}); }
finally { await closeBrowser(); server.kill(); mock?.close(); rmSync(DATA, { recursive: true, force: true }); console.log(fails ? `${fails} FAILED` : 'UI OK'); process.exit(fails ? 1 : 0); }
