// "npm run setup" step 2: download Playwright's Chromium; if that fails, fall back to the system Chrome/Edge.
import { spawnSync } from 'node:child_process';

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
console.log('→ npx playwright install chromium');
const r = spawnSync(npx, ['playwright', 'install', 'chromium'], { stdio: 'inherit', shell: process.platform === 'win32' });
if (r.status === 0) { console.log('✓ Chromium ready'); process.exit(0); }

console.log('⚠ Chromium download failed — checking for an installed Chrome / Edge…');
const { chromium } = await import('playwright');
for (const channel of ['chrome', 'msedge']) {
  try { const b = await chromium.launch({ channel, headless: true }); await b.close(); console.log(`✓ Using the system ${channel} for rendering`); process.exit(0); } catch {}
}
console.log('⚠ No Chromium/Chrome found. The studio still works: videos will be rendered inside your browser tab (WebCodecs).');
process.exit(0);
