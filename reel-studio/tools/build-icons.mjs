// Builds public/assets/icons/icons.json from the hand-drawn set + Health Icons (CC0) + Tabler Icons (MIT).
// Usage: node tools/build-icons.mjs   (needs the devDependencies: healthicons, @tabler/icons)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HAND } from './hand-icons.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = p => join(root, 'node_modules', p);
const round = d => d.replace(/-?\d*\.\d+(?:e-?\d+)?/g, m => { const v = +(+m).toFixed(1); return String(v).replace(/^0\./, '.').replace(/^-0\./, '-.'); });

function elToPath(tag, a) {
  const n = k => +a[k] || 0;
  switch (tag) {
    case 'path': return a.d;
    case 'circle': { const cx = n('cx'), cy = n('cy'), r = n('r'); return `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`; }
    case 'ellipse': { const cx = n('cx'), cy = n('cy'), rx = n('rx'), ry = n('ry'); return `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0`; }
    case 'line': return `M${n('x1')} ${n('y1')}L${n('x2')} ${n('y2')}`;
    case 'polyline': case 'polygon': {
      const p = String(a.points).trim().split(/[\s,]+/).map(Number);
      let d = `M${p[0]} ${p[1]}`;
      for (let i = 2; i < p.length; i += 2) d += `L${p[i]} ${p[i + 1]}`;
      return tag === 'polygon' ? d + 'Z' : d;
    }
    case 'rect': {
      const x = n('x'), y = n('y'), w = n('width'), h = n('height');
      const r = Math.min(+a.rx || +a.ry || 0, w / 2, h / 2);
      if (!r) return `M${x} ${y}h${w}v${h}h${-w}Z`;
      return `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${-(w - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${-r}v${-(h - 2 * r)}a${r} ${r} 0 0 1 ${r} ${-r}Z`;
    }
  }
  return null;
}

const icons = {};
// 1. Hand-drawn set.
for (const [name, [d, tags]] of Object.entries(HAND)) icons['hand:' + name] = { v: 24, m: 's', d, t: tags };

// 2. Health Icons (outline, 48 px grid, filled shapes).
let healthCount = 0;
if (existsSync(nm('healthicons'))) {
  const meta = JSON.parse(readFileSync(nm('healthicons/public/icons/meta-data.json'), 'utf8'));
  for (const m of meta) {
    const file = nm(`healthicons/public/icons/svg/outline/${m.path}.svg`);
    if (!existsSync(file)) continue;
    const svg = readFileSync(file, 'utf8');
    const d = [...svg.matchAll(/<path[^>]*?\sd="([^"]+)"/g)].map(x => round(x[1]));
    if (!d.length) continue;
    const tags = [...new Set([m.title, m.category, ...(m.tags || [])].filter(t => t && !/^dhis2:/.test(t)).map(t => String(t).toLowerCase()))];
    icons['health:' + m.id] = { v: 48, m: 'f', d, t: tags };
    healthCount++;
  }
}

// 3. Tabler Icons (outline, 24 px grid, strokes).
let tablerCount = 0;
if (existsSync(nm('@tabler/icons'))) {
  const nodes = JSON.parse(readFileSync(nm('@tabler/icons/tabler-nodes-outline.json'), 'utf8'));
  const meta = JSON.parse(readFileSync(nm('@tabler/icons/icons.json'), 'utf8'));
  for (const [name, els] of Object.entries(nodes)) {
    const d = els.map(([tag, a]) => (a.stroke === 'none' ? null : elToPath(tag, a))).filter(Boolean).map(round);
    if (!d.length) continue;
    const mt = meta[name] || {};
    icons['tabler:' + name] = { v: 24, m: 's', d, t: [...new Set([mt.category, ...(mt.tags || [])].filter(Boolean).map(t => String(t).toLowerCase()))].slice(0, 12) };
    tablerCount++;
  }
}

const readLic = p => (existsSync(nm(p)) ? readFileSync(nm(p), 'utf8') : '');
const out = {
  version: 1,
  generated: new Date().toISOString().slice(0, 10),
  sets: {
    hand: { name: 'Reel Studio hand-drawn set', license: 'CC0-1.0', url: '', count: Object.keys(HAND).length, text: 'Authored for Reel Studio; dedicated to the public domain (CC0 1.0).' },
    health: { name: 'Health Icons', license: 'CC0-1.0', url: 'https://healthicons.org', count: healthCount, text: readLic('healthicons/LICENSE').split('====')[0].trim() + '\nIcons are CC0 1.0 Universal (public domain).' },
    tabler: { name: 'Tabler Icons', license: 'MIT', url: 'https://tabler.io/icons', count: tablerCount, text: readLic('@tabler/icons/LICENSE').trim() },
  },
  icons,
};
const json = JSON.stringify(out);
writeFileSync(join(root, 'public/assets/icons/icons.json'), json);
console.log(`icons.json: hand ${Object.keys(HAND).length}, health ${healthCount}, tabler ${tablerCount} — ${(json.length / 1e6).toFixed(2)} MB`);
