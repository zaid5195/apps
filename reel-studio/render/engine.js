// Reel renderer: draws frame t of a project on a canvas. Deterministic — the image depends only on t.
// Design canvas 720×1280, scaled to the real canvas (×1.5 → 1080×1920 for export).
import { buildTimeline, sceneAt } from '../core/timeline.js';
import { prng, clamp, hashString } from '../core/text.js';
import { lang as langOf } from '../core/lang.js';

export const C = {
  bg: '#0C1014', card: '#161C22', elev: '#202830', text: '#F4F3EE', sec: '#9AA5AE',
  accent: '#27B8C7', accent2: '#5978FF', success: '#36C98F', warning: '#F28A30',
};
const TONE = { accent: C.accent, accent2: C.accent2, success: C.success, warning: C.warning };
const W = 720, H = 1280;
const CARD = { x: 36, y: 128, w: 648, h: 800, r: 38 };
const CX = 360, CY = 548;
const TYPE_LABEL_AR = { intro: 'البداية', question: 'السؤال', concept: 'الفكرة', process: 'الخطوات', compare: 'مقارنة', stat: 'بالأرقام', recap: 'الخلاصة' };
const TR = 0.42; // scene transition seconds

// ---- easing ------------------------------------------------------------------------------------
const ramp = (t, t0, d) => clamp((t - t0) / d, 0, 1);
const eo = x => 1 - Math.pow(1 - x, 3);
const eio = x => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const back = x => { const c1 = 2.1, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
const lerp = (a, b, x) => a + (b - a) * x;
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${clamp(a, 0, 1).toFixed(3)})`;
}
function mix(h1, h2, x) {
  const a = parseInt(h1.slice(1), 16), b = parseInt(h2.slice(1), 16);
  const c = s => Math.round(lerp((a >> s) & 255, (b >> s) & 255, x));
  return '#' + ((1 << 24) | (c(16) << 16) | (c(8) << 8) | c(0)).toString(16).slice(1);
}
/** Element reveal: faint "ghost" before its word, eased pop with overshoot at its word. */
function reveal(t, tShow, sceneT0, dur = 0.5) {
  const ghost = 0.16 * eo(ramp(t, sceneT0, 0.35));
  const x = ramp(t, tShow - 0.04, dur);
  return { a: x > 0 ? lerp(ghost, 1, eo(Math.min(1, x * 1.6))) : ghost, s: x > 0 ? lerp(0.86, 1, back(x)) : 0.9, x, on: x > 0 };
}

export function createRenderer(canvas, data, { fontFamily = 'Reel' } = {}) {
  const ctx = canvas.getContext('2d', { alpha: false });
  const LG = langOf(data.lang);
  const rtl = LG.rtl, DIR = rtl ? 'rtl' : 'ltr';
  const TYPE_LABEL = LG.typeLabel || TYPE_LABEL_AR;
  const mx = x => (rtl ? x : W - x); // mirror horizontal positions for left-to-right languages
  const A = a => (rtl || a === 'center' ? a : a === 'right' ? 'left' : 'right');
  const style = { captions: 'classic', endScreen: false, hook: true, handle: '', ...(data.style || {}) };
  const ASPECTS = {
    '9:16': { DW: 720, DH: 1280, card: { x: CARD.x, y: CARD.y, s: 1 }, cap: { cx: 360, cy: 1062, s: 1 }, tagY: 70, bar: { x0: 60, x1: 660, y: 1222 } },
    '1:1': { DW: 720, DH: 720, card: { x: 178, y: 92, s: 0.56 }, cap: { cx: 360, cy: 616, s: 0.78 }, tagY: 46, bar: { x0: 60, x1: 660, y: 700 } },
    '16:9': { DW: 1280, DH: 720, card: rtl ? { x: 700, y: 60, s: 0.78 } : { x: 75, y: 60, s: 0.78 }, cap: rtl ? { cx: 372, cy: 390, s: 1.12 } : { cx: 908, cy: 390, s: 1.12 }, tagY: 46, bar: { x0: 60, x1: 1220, y: 690 } },
  };
  const LAY = ASPECTS[data.aspect] || ASPECTS['9:16'];
  const DW = LAY.DW, DH = LAY.DH;
  const k = canvas.width / DW;
  let curT = 0;
  const FONT = `"${fontFamily}", "IBM Plex Sans Arabic", "Noto Sans Arabic", Tahoma, sans-serif`;
  const timeline = buildTimeline({ tokens: data.tokens, storyboard: data.storyboard, duration: data.duration, endAt: style.endScreen ? data.endAt : null });
  const useHook = style.hook !== false && timeline.hook.length >= 2 && (timeline.scenes[1]?.t0 ?? 1e9) >= timeline.hookEnd - 0.25;
  const iconMap = data.iconMap || {};
  const pathCache = new Map();
  const measureCache = new Map();
  const seed = hashString(data.id || data.title || 'reel');
  const particles = (() => { const r = prng(seed); return Array.from({ length: 26 }, () => ({ x: r() * DW, y: r() * DH, s: 0.6 + r() * 1.8, v: 4 + r() * 10, p: r() * 6.28 })); })();
  const mainIcon = timeline.scenes.find(s => s.icon)?.icon || '';

  const font = (size, weight = 700) => `${weight} ${size}px ${FONT}`;
  function measure(text, f) {
    const key = f + '|' + text;
    let v = measureCache.get(key);
    if (v == null) { ctx.font = f; v = ctx.measureText(text).width; measureCache.set(key, v); }
    return v;
  }

  // ---- primitives ------------------------------------------------------------------------------
  function rr(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function glow(x, y, r, color, a) {
    if (a <= 0.003) return;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, hexA(color, a)); g.addColorStop(1, hexA(color, 0));
    ctx.fillStyle = g; ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
  function iconKey(noun) { return iconMap[noun] || (data.icons[noun] ? noun : 'hand:spark'); }
  function drawIcon(noun, x, y, size, color = C.text, alpha = 1, keyOverride) {
    const key = keyOverride || iconKey(noun);
    const ic = data.icons[key] || data.icons['hand:spark'];
    if (!ic || alpha <= 0.01) return;
    let paths = pathCache.get(key);
    if (!paths) { paths = ic.d.map(d => new Path2D(d)); pathCache.set(key, paths); }
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.translate(x - size / 2, y - size / 2);
    ctx.scale(size / ic.v, size / ic.v);
    if (ic.m === 'f') { ctx.fillStyle = color; for (const p of paths) ctx.fill(p, 'evenodd'); }
    else { ctx.strokeStyle = color; ctx.lineWidth = 1.75; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; for (const p of paths) ctx.stroke(p); }
    ctx.restore();
  }
  function badge(x, y, r, noun, rv, { color = C.accent, fill = C.elev, keyOverride, ring = true, iconScale = 1.05 } = {}) {
    ctx.save();
    ctx.globalAlpha *= rv.a;
    ctx.translate(x, y); ctx.scale(rv.s, rv.s);
    if (rv.on) glow(0, 0, r * 1.9, color, 0.22 * rv.a);
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill();
    if (ring) {
      ctx.lineWidth = 3; ctx.strokeStyle = hexA(color, 0.35); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * eo(clamp(rv.x * 1.4, 0, 1))); ctx.strokeStyle = color; ctx.lineWidth = 3.5; ctx.lineCap = 'round'; ctx.stroke();
    }
    const br = rv.on ? 1 + 0.03 * Math.sin(curT * 2.4 + x * 0.013 + y * 0.007) : 1; // icons breathe
    drawIcon(noun, 0, 0, r * iconScale * br, rv.on ? C.text : C.sec, 1, keyOverride);
    ctx.restore();
  }
  function wrap(text, f, maxW, maxLines = 2) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    for (const w of words) {
      const test = cur ? cur + ' ' + w : w;
      if (measure(test, f) > maxW && cur) { lines.push(cur); cur = w; } else cur = test;
    }
    if (cur) lines.push(cur);
    if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] += '…'; }
    return lines;
  }
  function label(text, x, y, { size = 26, weight = 700, color = C.text, align = 'center', maxW = 300, lines = 2, alpha = 1, lh = 1.3, valign = 'middle', dir } = {}) {
    if (!text || alpha <= 0.01) return 0;
    const f = font(size, weight);
    const ls = wrap(text, f, maxW, lines);
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.font = f; ctx.fillStyle = color; ctx.textAlign = align; ctx.direction = dir || (/^[\x00-\x7F]+$/.test(String(text)) ? 'ltr' : DIR); ctx.textBaseline = 'middle';
    const total = (ls.length - 1) * size * lh;
    const y0 = valign === 'middle' ? y - total / 2 : valign === 'top' ? y + size * 0.5 : y - total - size * 0.5;
    ls.forEach((l, i) => ctx.fillText(l, x, y0 + i * size * lh));
    ctx.restore();
    return ls.length * size * lh;
  }
  /** Polyline that draws on with progress p (0..1); arrowhead once complete. */
  function drawOn(pts, p, color, width = 4, arrow = true, dash) {
    if (p <= 0) return;
    const seg = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); seg.push(l); total += l; }
    let rem = total * clamp(p, 0, 1);
    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
    let end = pts[0], dir = [1, 0];
    for (let i = 1; i < pts.length && rem > 0; i++) {
      const l = seg[i - 1], f = Math.min(1, rem / l);
      end = [lerp(pts[i - 1][0], pts[i][0], f), lerp(pts[i - 1][1], pts[i][1], f)];
      dir = [(pts[i][0] - pts[i - 1][0]) / l, (pts[i][1] - pts[i - 1][1]) / l];
      ctx.lineTo(end[0], end[1]);
      rem -= l;
    }
    ctx.stroke();
    ctx.setLineDash([]);
    if (arrow && p > 0.92) arrowHead(end, dir, color, width, (p - 0.92) / 0.08);
    ctx.restore();
  }
  function arrowHead([x, y], [dx, dy], color, width, a = 1) {
    const s = 9 + width * 1.6;
    ctx.save(); ctx.globalAlpha *= a; ctx.fillStyle = color;
    ctx.beginPath(); ctx.moveTo(x + dx * s * 0.5, y + dy * s * 0.5);
    ctx.lineTo(x - dx * s * 0.7 - dy * s * 0.6, y - dy * s * 0.7 + dx * s * 0.6);
    ctx.lineTo(x - dx * s * 0.7 + dy * s * 0.6, y - dy * s * 0.7 - dx * s * 0.6);
    ctx.closePath(); ctx.fill(); ctx.restore();
  }
  function arcOn(cx, cy, r, a0, a1, p, color, width = 4, arrow = true) {
    if (p <= 0) return;
    const a = lerp(a0, a1, clamp(p, 0, 1));
    ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(cx, cy, r, a0, a, a1 < a0); ctx.stroke();
    if (arrow && p > 0.92) { const s = a1 > a0 ? 1 : -1; arrowHead([cx + r * Math.cos(a), cy + r * Math.sin(a)], [-Math.sin(a) * s, Math.cos(a) * s], color, width, (p - 0.92) / 0.08); }
    ctx.restore();
  }
  const fmtNum = v => { const a = Math.abs(v); return a >= 100 || Number.isInteger(v) ? Math.round(v).toLocaleString('en-US') : v.toFixed(1); };

  // ---- background, frame, captions -------------------------------------------------------------
  function background(t) {
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, DW, DH);
    const off = (t * 6) % 40;
    ctx.strokeStyle = 'rgba(244,243,238,0.035)'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = (off % 40) - 40; x < DW + 40; x += 40) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, DH); }
    for (let y = off - 40; y < DH + 40; y += 40) { ctx.moveTo(0, y + 0.5); ctx.lineTo(DW, y + 0.5); }
    ctx.stroke();
    glow(LAY.card.x + CARD.w * LAY.card.s / 2, LAY.card.y + CARD.h * LAY.card.s * 0.45, 520 * LAY.card.s, C.accent, 0.07);
    glow(DW * 0.85, DH * 0.9, 420, C.accent2, 0.06);
    for (const p of particles) {
      const y = (((p.y - t * p.v) % DH) + DH) % DH;
      ctx.fillStyle = hexA(C.sec, 0.18 + 0.12 * Math.sin(t * 1.3 + p.p));
      ctx.fillRect(p.x, y, p.s, p.s);
    }
  }
  function chrome(t, k, scene) {
    // series tag (top right)
    const f = font(22, 700);
    const tw = measure(data.series, f);
    const px = DW - 36, py = LAY.tagY, ph = 42;
    ctx.save();
    rr(px - tw - 58, py - ph / 2, tw + 58, ph, ph / 2); ctx.fillStyle = C.card; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.beginPath(); ctx.arc(px - 24, py, 6, 0, Math.PI * 2); ctx.fillStyle = C.accent; ctx.fill();
    glow(px - 24, py, 18, C.accent, 0.35 + 0.15 * Math.sin(t * 4));
    ctx.font = f; ctx.fillStyle = C.text; ctx.textAlign = 'right'; ctx.direction = DIR; ctx.textBaseline = 'middle';
    ctx.fillText(data.series, px - 40, py + 1);
    // scene counter (top left)
    ctx.font = font(20, 500); ctx.fillStyle = C.sec; ctx.textAlign = 'left'; ctx.direction = 'ltr';
    ctx.fillText(`${String(k + 1).padStart(2, '0')} / ${String(timeline.scenes.length).padStart(2, '0')}`, 40, py + 1);
    ctx.restore();
    // progress
    const { y, x0, x1 } = LAY.bar;
    ctx.fillStyle = 'rgba(244,243,238,0.08)'; rr(x0, y - 2, x1 - x0, 4, 2); ctx.fill();
    const p = clamp(t / timeline.duration, 0, 1);
    ctx.fillStyle = C.accent; rr(x1 - (x1 - x0) * p, y - 2, (x1 - x0) * p, 4, 2); ctx.fill();
    for (const s of timeline.scenes.slice(1)) { const sx = x1 - (x1 - x0) * (s.t0 / timeline.duration); ctx.fillStyle = s.t0 <= t ? C.text : 'rgba(244,243,238,0.25)'; ctx.fillRect(sx - 1, y - 5, 2, 10); }
    void scene;
  }
  function cardShell() {
    ctx.save();
    rr(CARD.x, CARD.y, CARD.w, CARD.h, CARD.r);
    const g = ctx.createLinearGradient(0, CARD.y, 0, CARD.y + CARD.h);
    g.addColorStop(0, '#182027'); g.addColorStop(1, C.card);
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 2; ctx.stroke();
    ctx.restore();
  }
  function cardFrame(t, scene, k) {
    // film perforations + corner marks + scene chip
    ctx.save();
    ctx.fillStyle = 'rgba(244,243,238,0.05)';
    for (let x = CARD.x + 60; x < CARD.x + CARD.w - 50; x += 34) { rr(x, CARD.y + 12, 16, 8, 3); ctx.fill(); rr(x, CARD.y + CARD.h - 20, 16, 8, 3); ctx.fill(); }
    ctx.strokeStyle = hexA(C.accent, 0.5); ctx.lineWidth = 2.5; ctx.lineCap = 'round';
    const m = 26, L = 22;
    for (const [x, y, sx, sy] of [[CARD.x + m, CARD.y + m + 14, 1, 1], [CARD.x + CARD.w - m, CARD.y + m + 14, -1, 1], [CARD.x + m, CARD.y + CARD.h - m - 14, 1, -1], [CARD.x + CARD.w - m, CARD.y + CARD.h - m - 14, -1, -1]]) {
      ctx.beginPath(); ctx.moveTo(x, y + sy * L); ctx.lineTo(x, y); ctx.lineTo(x + sx * L, y); ctx.stroke();
    }
    const lab = TYPE_LABEL[scene.type] || '';
    const a = eo(ramp(t, scene.t0, 0.3));
    const f = font(19, 700), tw = measure(lab, f);
    const x = CARD.x + CARD.w - 46, y = CARD.y + 58;
    ctx.globalAlpha = a;
    rr(x - tw - 28, y - 16, tw + 28, 32, 16); ctx.fillStyle = hexA(C.accent, 0.14); ctx.fill();
    ctx.font = f; ctx.fillStyle = C.accent; ctx.textAlign = 'right'; ctx.direction = DIR; ctx.textBaseline = 'middle'; ctx.fillText(lab, x - 14, y + 1);
    ctx.restore();
    void k;
  }

  // Caption layout: words in RTL order; consecutive LTR words (English loanwords) keep LTR order.
  const capFont = font(50, 700);
  const capLayout = new Map();
  function layoutCaption(c) {
    if (capLayout.has(c)) return capLayout.get(c);
    const space = measure(' ', capFont) * 1.05, maxW = 600;
    const lines = [[]];
    let w = 0;
    for (const word of c.words) {
      const ww = measure(word.text, capFont);
      if (lines[lines.length - 1].length && w + space + ww > maxW) { lines.push([]); w = 0; }
      const line = lines[lines.length - 1];
      w += (line.length ? space : 0) + ww;
      line.push({ ...word, w: ww });
    }
    const out = lines.map(line => {
      // group into visual runs
      const runs = [];
      for (const wd of line) { const last = runs[runs.length - 1]; if (last && last.ltr && wd.ltr) last.words.push(wd); else runs.push({ ltr: wd.ltr, words: [wd] }); }
      const width = line.reduce((s, wd) => s + wd.w, 0) + space * (line.length - 1);
      if (!rtl) { let lx = W / 2 - width / 2; return line.map(wd => { const o = { ...wd, x: lx, ltr: true }; lx += wd.w + space; return o; }); }
      let x = W / 2 + width / 2; // right edge
      const placed = [];
      for (const r of runs) {
        const rw = r.words.reduce((s, wd) => s + wd.w, 0) + space * (r.words.length - 1);
        let lx = x - rw; // left edge of the run
        if (r.ltr) for (const wd of r.words) { placed.push({ ...wd, x: lx }); lx += wd.w + space; }
        else { let rx = x; for (const wd of r.words) { placed.push({ ...wd, x: rx - wd.w }); rx -= wd.w + space; } }
        x -= rw + space;
      }
      return placed;
    });
    capLayout.set(c, out);
    return out;
  }
  function captions(t) {
    if (useHook && t < timeline.hookEnd + 0.15) return; // the hook is already on screen as kinetic type
    if (style.endScreen && data.endAt != null && t >= data.endAt) return;
    const c = timeline.captions.find(c => t >= c.t0 && t < c.t1);
    if (!c) return;
    if (style.captions === 'word') return wordCaption(c, t);
    const lines = layoutCaption(c);
    const aIn = eo(ramp(t, c.t0, 0.14)), aOut = 1 - ramp(t, c.t1 - 0.1, 0.1);
    const lh = 72, y0 = 1062 - ((lines.length - 1) * lh) / 2 + (1 - aIn) * 14;
    ctx.save();
    ctx.globalAlpha = aIn * aOut;
    ctx.font = capFont; ctx.textBaseline = 'middle';
    lines.forEach((line, li) => {
      const y = y0 + li * lh;
      for (const wd of line) {
        const on = t >= wd.start;
        const active = on && style.captions === 'box' && t < (line.find(n => n.start > wd.start)?.start ?? nextStart(c, wd)) ;
        let color = on ? (wd.tone ? TONE[wd.tone] : C.text) : hexA(C.sec, 0.55);
        const pop = (on ? 1 + 0.1 * (1 - eo(ramp(t, wd.start, 0.2))) : 1) * (wd.num ? 1.12 : 1);
        ctx.save();
        ctx.translate(wd.x + wd.w / 2, y); ctx.scale(pop, pop);
        if (active) { const bg = wd.tone ? TONE[wd.tone] : C.accent; ctx.fillStyle = bg; rr(-wd.w / 2 - 12, -34, wd.w + 24, 66, 16); ctx.fill(); color = C.bg; }
        else if (on && wd.tone) glow(0, 0, wd.w * 0.7, TONE[wd.tone], 0.12);
        ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.direction = wd.ltr ? 'ltr' : 'rtl';
        ctx.fillText(wd.text, 0, 0);
        ctx.restore();
        if (on && wd.underline) {
          const p = eo(ramp(t, wd.start, 0.28));
          ctx.fillStyle = TONE[wd.tone] || C.accent;
          rr(wd.x + wd.w * (1 - p), y + 32, wd.w * p, 6, 3); ctx.fill();
        }
      }
    });
    ctx.restore();
  }

  function nextStart(c, wd) {
    const all = c.words; const i = all.indexOf(all.find(w => w.i === wd.i));
    return all[i + 1]?.start ?? c.t1;
  }
  /** "Word" style: one big word at a time, centred. */
  function wordCaption(c, t) {
    let w = null;
    for (const x of c.words) if (t >= x.start - 0.02) w = x;
    if (!w) return;
    const nxt = nextStart(c, w);
    if (t > w.end + 0.6 && t < nxt) return;
    let size = w.num ? 96 : 86;
    let f = font(size, 700);
    const tw = measure(w.text, f);
    if (tw > 620) { size = Math.floor(size * 620 / tw); f = font(size, 700); }
    const p = eo(ramp(t, w.start, 0.18));
    const s = lerp(1.25, 1, p);
    ctx.save();
    ctx.translate(360, 1062); ctx.scale(s, s);
    ctx.globalAlpha = 0.25 + 0.75 * p;
    const col = w.tone ? TONE[w.tone] : C.text;
    glow(0, 0, Math.max(120, tw * 0.7), w.tone ? TONE[w.tone] : C.accent, 0.12);
    ctx.font = f; ctx.fillStyle = col; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.direction = w.ltr ? 'ltr' : DIR;
    ctx.fillText(w.text, 0, 0);
    if (w.underline) { ctx.fillStyle = col; const uw = Math.min(tw, 620) * eo(ramp(t, w.start, 0.3)); rr(-uw / 2, size * 0.62, uw, 7, 3.5); ctx.fill(); }
    ctx.restore();
  }

  /** Kinetic hook: the first sentence typed big on the intro, each word popping at its onset. */
  const hookFont = font(62, 700);
  let hookLines = null;
  function hookLayout() {
    if (hookLines) return hookLines;
    const space = measure(' ', hookFont) * 1.1, maxW = 560;
    const lines = [[]]; let w = 0;
    for (const wd of timeline.hook) {
      const ww = measure(wd.text, hookFont);
      if (lines[lines.length - 1].length && w + space + ww > maxW) { lines.push([]); w = 0; }
      w += (lines[lines.length - 1].length ? space : 0) + ww;
      lines[lines.length - 1].push({ ...wd, w: ww });
    }
    hookLines = lines.map(line => {
      const width = line.reduce((s, x) => s + x.w, 0) + space * (line.length - 1);
      let x = rtl ? CX + width / 2 : CX - width / 2;
      return line.map(wd => { const o = { ...wd, x: rtl ? x - wd.w : x }; x += rtl ? -(wd.w + space) : wd.w + space; return o; });
    });
    return hookLines;
  }
  function kineticHook(t, top) {
    const lines = hookLayout();
    const lh = 84, y0 = top - ((lines.length - 1) * lh) / 2;
    const longest = timeline.hook.reduce((a, b) => (b.text.length > a.text.length ? b : a), timeline.hook[0]);
    lines.forEach((line, li) => line.forEach(wd => {
      const on = t >= wd.start;
      const p = on ? eo(ramp(t, wd.start, 0.22)) : 0;
      const key = wd.tone || wd.num || wd === longest || wd.i === longest.i;
      const color = on ? (wd.tone ? TONE[wd.tone] : key ? C.accent : C.text) : hexA(C.sec, 0.14);
      ctx.save();
      ctx.translate(wd.x + wd.w / 2, y0 + li * lh + (1 - p) * 18 * (on ? 1 : 0));
      const s = on ? lerp(1.35, 1, back(Math.min(1, p))) : 0.96;
      ctx.scale(s, s);
      if (on && key) glow(0, 0, wd.w * 0.75, wd.tone ? TONE[wd.tone] : C.accent, 0.16 * p);
      ctx.font = hookFont; ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.direction = wd.ltr ? 'ltr' : DIR;
      ctx.fillText(wd.text, 0, 0);
      ctx.restore();
    }));
  }

  /** End screen: follow + comment prompt. */
  function endScreen(t) {
    const t0 = data.endAt;
    const a = eo(ramp(t, t0, 0.45));
    if (a <= 0) return;
    ctx.save();
    ctx.globalAlpha = a * 0.95; ctx.fillStyle = C.bg; ctx.fillRect(0, 0, DW, DH); ctx.globalAlpha = a;
    const cx = DW / 2, cy = DH * (DH > DW ? 0.42 : 0.4), sc = DH > DW ? 1 : 0.8;
    ctx.translate(cx, cy); ctx.scale(sc, sc);
    glow(0, 0, 320, C.accent, 0.18);
    const pr = back(clamp((t - t0 - 0.2) / 0.5, 0, 1));
    ctx.save(); ctx.scale(pr, pr);
    ctx.beginPath(); ctx.arc(0, -120, 92, 0, Math.PI * 2); ctx.fillStyle = C.card; ctx.fill(); ctx.lineWidth = 4; ctx.strokeStyle = C.accent; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-26, -158); ctx.lineTo(36, -120); ctx.lineTo(-26, -82); ctx.closePath(); ctx.fillStyle = C.accent; ctx.fill();
    ctx.restore();
    const L1 = style.followText || LG.follow, L2 = style.commentText || LG.comment;
    label(style.handle || data.series, 0, 30, { size: 54, alpha: eo(ramp(t, t0 + 0.35, 0.4)), maxW: 600, lines: 1 });
    label(L1, 0, 100, { size: 32, color: C.sec, alpha: eo(ramp(t, t0 + 0.5, 0.4)), maxW: 600 });
    // follow button
    const bp = eo(ramp(t, t0 + 0.7, 0.4)), pulse = 1 + 0.04 * Math.sin((t - t0) * 6);
    ctx.save(); ctx.globalAlpha *= bp; ctx.translate(0, 196); ctx.scale(pulse, pulse);
    const bf = font(34, 700), bw = measure(LG.followBtn, bf) + 110;
    rr(-bw / 2, -38, bw, 76, 38); ctx.fillStyle = C.accent; ctx.fill();
    ctx.font = bf; ctx.fillStyle = C.bg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.direction = DIR;
    ctx.fillText('+  ' + LG.followBtn, 0, 2);
    ctx.restore();
    // comment prompt with a bouncing arrow
    const cp = eo(ramp(t, t0 + 1.0, 0.4));
    ctx.save(); ctx.globalAlpha *= cp; ctx.translate(0, 320);
    rr(-300, -50, 600, 100, 24); ctx.fillStyle = C.elev; ctx.fill(); ctx.strokeStyle = hexA(C.accent2, 0.6); ctx.lineWidth = 2; ctx.stroke();
    ctx.restore();
    label(L2, 0, 320, { size: 28, maxW: 540, alpha: cp, lines: 2 });
    const by = 400 + 10 * Math.abs(Math.sin((t - t0) * 4));
    ctx.save(); ctx.globalAlpha *= cp; ctx.strokeStyle = C.accent2; ctx.lineWidth = 5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-18, by); ctx.lineTo(0, by + 18); ctx.lineTo(18, by); ctx.stroke(); ctx.restore();
    ctx.restore();
  }

  /** Cover image (thumbnail): big title + main icon. */
  function drawCover() {
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.globalAlpha = 1;
    background(0);
    const vertical = DH > DW;
    const cx = DW / 2;
    const icy = vertical ? 470 : DH * 0.5, tx = vertical ? cx : (rtl ? DW * 0.33 : DW * 0.67), ix = vertical ? cx : (rtl ? DW * 0.75 : DW * 0.25);
    glow(ix, icy, 340, C.accent, 0.22);
    ctx.save(); ctx.translate(ix, icy);
    ctx.setLineDash([3, 15]); ctx.strokeStyle = hexA(C.sec, 0.35); ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, 230, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(0, 0, 170, 0, Math.PI * 2); ctx.fillStyle = C.card; ctx.fill(); ctx.lineWidth = 6; ctx.strokeStyle = C.accent; ctx.stroke();
    ctx.restore();
    drawIcon(mainIcon, ix, icy, 190, C.text, 1);
    const title = data.title || '';
    const size = vertical ? 78 : 64;
    label(title, tx, vertical ? 860 : DH * 0.42, { size, maxW: vertical ? 620 : DW * 0.44, lines: 3, lh: 1.25 });
    // series chip
    const f = font(30, 700), tw = measure(data.series, f);
    const sy = vertical ? 1060 : DH * 0.72;
    ctx.save(); rr(tx - tw / 2 - 30, sy - 30, tw + 60, 60, 30); ctx.fillStyle = C.accent; ctx.fill();
    ctx.font = f; ctx.fillStyle = C.bg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.direction = DIR; ctx.fillText(data.series, tx, sy + 2); ctx.restore();
    if (style.handle) label(style.handle, tx, sy + 80, { size: 28, color: C.sec, maxW: 600, lines: 1 });
  }

  // ---- templates -------------------------------------------------------------------------------
  const T = {};
  const items = s => s.items;
  const topY = s => (s.title && !['hero', 'ask', 'checklist'].includes(s.template) ? 290 : 250);

  T.hero = (s, t) => {
    if (useHook && s.k === 0) {
      const cy = 330, rv = reveal(t, s.t0 + 0.05, s.t0, 0.5);
      glow(CX, cy, 220, C.accent, 0.14 * rv.a);
      ctx.save(); ctx.translate(CX, cy); ctx.rotate(t * 0.22);
      ctx.setLineDash([3, 13]); ctx.strokeStyle = hexA(C.sec, 0.3); ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, 112, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      ctx.restore();
      badge(CX, cy, 74, s.icon || mainIcon, rv, { iconScale: 1.1 });
      kineticHook(t, 640);
      return;
    }
    const cy = 470;
    const rv = reveal(t, s.t0 + 0.12, s.t0, 0.6);
    glow(CX, cy, 300, C.accent, 0.16 * rv.a);
    ctx.save();
    ctx.translate(CX, cy); ctx.rotate(t * 0.22);
    ctx.setLineDash([3, 15]); ctx.strokeStyle = hexA(C.sec, 0.35); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, 200, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    ctx.restore();
    arcOn(CX, cy, 160, -Math.PI / 2, Math.PI * 1.5, eio(ramp(t, s.t0 + 0.1, 1.2)), C.accent2, 3, false);
    badge(CX, cy, 116, s.icon || mainIcon, rv, { iconScale: 1.1 });
    items(s).forEach((it, j) => {
      const r = reveal(t, it.t, s.t0);
      const ang = -Math.PI / 2 + (j * Math.PI * 2) / Math.max(3, s.items.length) + t * 0.3;
      badge(CX + 200 * Math.cos(ang), cy + 200 * Math.sin(ang), 36, it.icon, r, { color: C.accent2 });
    });
    const ta = eo(ramp(t, s.t0 + 0.25, 0.5));
    const h = label(s.title || data.title, CX, 760 + (1 - ta) * 16, { size: 46, maxW: 560, alpha: ta, lines: 2 });
    ctx.fillStyle = C.accent; const bw = 120 * eo(ramp(t, s.t0 + 0.5, 0.5)); rr(CX - bw / 2, 760 + h / 2 + 10, bw, 6, 3); ctx.fill();
  };

  T.ask = (s, t) => {
    const cy = 450;
    drawIcon(mainIcon, CX, cy, 420, C.text, 0.05);
    for (let i = 0; i < 3; i++) {
      const ph = ((t - s.t0) / 1.6 + i / 3) % 1;
      ctx.beginPath(); ctx.arc(CX, cy, 90 + ph * 220, 0, Math.PI * 2); ctx.strokeStyle = hexA(C.accent, 0.35 * (1 - ph) * eo(ramp(t, s.t0, 0.3))); ctx.lineWidth = 3; ctx.stroke();
    }
    const rv = reveal(t, s.t0 + 0.05, s.t0, 0.55);
    ctx.save();
    ctx.translate(CX, cy); const pulse = 1 + 0.03 * Math.sin((t - s.t0) * 5); ctx.scale(rv.s * pulse, rv.s * pulse);
    glow(0, 0, 220, C.accent, 0.25 * rv.a);
    ctx.globalAlpha *= rv.a; ctx.font = font(300, 700); ctx.fillStyle = C.accent; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.direction = DIR;
    ctx.fillText(LG.qmark, 0, 10);
    ctx.restore();
    const w0 = data.tokens[s.at]?.start ?? s.t0;
    const ta = eo(ramp(t, w0, 0.35));
    label(LG.question, CX, 740 + (1 - ta) * 20, { size: rtl ? 66 : 58, alpha: 0.2 + 0.8 * ta });
  };

  function levelPos(n) {
    if (n <= 2) return [[CX, 340, 100], [CX, 650, 150]];
    return [[230, 320, 82], [470, 470, 100], [CX, 735, 128]];
  }
  T.zoom = (s, t) => {
    const its = items(s);
    const pos = levelPos(its.length);
    // camera pans toward the newest level
    let cur = 0; its.forEach((it, j) => { if (t >= it.t) cur = j; });
    its.forEach((it, j) => {
      const [x, y, r] = pos[j];
      const rv = reveal(t, it.t, s.t0);
      if (j > 0) {
        const [px, py, pr] = pos[j - 1];
        const lx = px + pr * 0.5, ly = py + pr * 0.45, lr = pr * 0.3;
        const p = eio(ramp(t, it.t - 0.35, 0.5));
        ctx.save(); ctx.globalAlpha *= Math.max(0.15, p);
        ctx.beginPath(); ctx.arc(lx, ly, lr, 0, Math.PI * 2); ctx.strokeStyle = C.accent; ctx.lineWidth = 3; ctx.stroke(); ctx.restore();
        const ang = Math.atan2(y - ly, x - lx), pa = ang + Math.PI / 2;
        drawOn([[lx + lr * Math.cos(pa), ly + lr * Math.sin(pa)], [x + r * Math.cos(pa), y + r * Math.sin(pa)]], p, hexA(C.accent, 0.6), 2.5, false, [6, 8]);
        drawOn([[lx - lr * Math.cos(pa), ly - lr * Math.sin(pa)], [x - r * Math.cos(pa), y - r * Math.sin(pa)]], p, hexA(C.accent, 0.6), 2.5, false, [6, 8]);
      }
      badge(x, y, r, it.icon || s.icon, rv, { color: j === cur ? C.accent : C.accent2, iconScale: 1.0 });
      const side = x > CX + 40 ? -1 : x < CX - 40 ? 1 : 1;
      const lx = x + side * (r + 24);
      label(it.label, lx, y, { size: 28, align: side > 0 ? 'left' : 'right', maxW: 220, alpha: rv.a });
    });
  };
  T.zoom.focus = (s, t) => {
    const its = items(s); const pos = levelPos(its.length);
    let f = [CX, CY], z = 1;
    its.forEach((it, j) => { const p = eio(ramp(t, it.t, 0.8)); if (p > 0 && j > 0) { f = [lerp(f[0], (pos[j][0] + 5 * CX) / 6, p), lerp(f[1], (pos[j][1] + 5 * CY) / 6, p)]; z = lerp(z, 1.03, p); } });
    return { f, z };
  };

  T.flow = (s, t) => {
    const its = items(s), n = its.length;
    const h = n > 3 ? 104 : 118, gap = n > 3 ? 46 : 62;
    const total = n * h + (n - 1) * gap, y0 = topY(s) + (640 - total) / 2;
    let active = -1; its.forEach((it, j) => { if (t >= it.t) active = j; });
    its.forEach((it, j) => {
      const y = y0 + j * (h + gap), rv = reveal(t, it.t, s.t0);
      if (j > 0) {
        const p = eio(ramp(t, it.t - 0.4, 0.42));
        drawOn([[CX, y - gap + 6], [CX, y - 8]], p, C.accent, 4);
        if (p >= 1) for (let d = 0; d < 3; d++) { const q = ((t - it.t) * 0.9 + d / 3) % 1; ctx.beginPath(); ctx.arc(CX, lerp(y - gap + 6, y - 8, q), 4.5, 0, Math.PI * 2); ctx.fillStyle = hexA(d ? C.accent : C.text, 1 - Math.abs(q - 0.5)); ctx.fill(); }
      }
      ctx.save();
      ctx.globalAlpha *= rv.a; ctx.translate(CX, y + h / 2); ctx.scale(rv.s, rv.s);
      rr(-245, -h / 2, 490, h, 26); ctx.fillStyle = C.elev; ctx.fill();
      ctx.lineWidth = 2.5; ctx.strokeStyle = j === active ? C.accent : 'rgba(255,255,255,0.06)'; ctx.stroke();
      if (j === active) glow(0, 0, 260, C.accent, 0.08);
      ctx.restore();
      badge(mx(CX + 245 - 62), y + h / 2, 38, it.icon || s.icon, rv, { fill: C.card, color: j === active ? C.accent : C.accent2 });
      label(it.label, mx(CX + 245 - 120), y + h / 2, { size: 30, align: A('right'), maxW: 330, alpha: rv.a });
      label(String(j + 1), mx(CX - 245 + 40), y + h / 2, { size: 26, color: C.sec, alpha: rv.a * 0.8 });
    });
  };

  T.cycle = (s, t) => {
    const its = items(s), n = its.length, R = 205, cy = CY + 20;
    const ang = j => -Math.PI / 2 + (j * 2 * Math.PI) / n;
    const nr = n > 4 ? 50 : 58, gapA = (nr + 16) / R;
    ctx.beginPath(); ctx.arc(CX, cy, R, 0, Math.PI * 2); ctx.strokeStyle = hexA(C.sec, 0.12); ctx.lineWidth = 2; ctx.stroke();
    its.forEach((it, j) => {
      const nx = (j + 1) % n;
      const tArc = nx === 0 ? its[n - 1].t + 0.55 : its[nx].t - 0.4;
      arcOn(CX, cy, R, ang(j) + gapA, ang(j + 1) - gapA, eio(ramp(t, tArc, 0.45)), C.accent, 4);
    });
    const all = its[n - 1].t + 1;
    if (t > all) { const a = ang(0) + ((t - all) * 1.4) % (Math.PI * 2); glow(CX + R * Math.cos(a), cy + R * Math.sin(a), 30, C.text, 0.5); }
    its.forEach((it, j) => {
      const a = ang(j), x = CX + R * Math.cos(a), y = cy + R * Math.sin(a), rv = reveal(t, it.t, s.t0);
      badge(x, y, nr, it.icon || s.icon, rv, { color: j % 2 ? C.accent2 : C.accent });
      const ly = y + (Math.sin(a) > 0.3 ? nr + 30 : Math.sin(a) < -0.3 ? -nr - 30 : 0);
      const lx = Math.abs(Math.sin(a)) <= 0.3 ? x + (Math.cos(a) > 0 ? -1 : 1) * 0 : x;
      const off = Math.abs(Math.sin(a)) <= 0.3 ? (Math.cos(a) > 0 ? nr + 70 : -(nr + 70)) : 0;
      label(it.label, Math.max(110, Math.min(610, lx + off)), Math.abs(Math.sin(a)) <= 0.3 ? y + nr + 28 : ly, { size: 25, maxW: 200, alpha: rv.a });
    });
    drawIcon(s.icon || mainIcon, CX, cy, 120, C.sec, 0.25 * eo(ramp(t, s.t0, 0.4)));
  };

  T.timeline = (s, t) => {
    const its = items(s), n = its.length;
    const y0 = topY(s) + 20, y1 = 870, step = (y1 - y0) / Math.max(1, n);
    let reach = y0;
    its.forEach((it, j) => { const p = eio(ramp(t, it.t - 0.3, 0.45)); if (p > 0) reach = lerp(y0 + Math.max(0, j - 0.5) * step, y0 + (j + 0.5) * step, p); });
    ctx.fillStyle = hexA(C.sec, 0.15); rr(CX - 2, y0, 4, y1 - y0, 2); ctx.fill();
    ctx.fillStyle = C.accent; rr(CX - 2, y0, 4, reach - y0, 2); ctx.fill();
    its.forEach((it, j) => {
      const y = y0 + (j + 0.5) * step, rv = reveal(t, it.t, s.t0), right = j % 2 === 0;
      ctx.save(); ctx.globalAlpha *= rv.a; ctx.translate(CX, y); ctx.scale(rv.s, rv.s);
      ctx.beginPath(); ctx.arc(0, 0, 13, 0, Math.PI * 2); ctx.fillStyle = rv.on ? C.accent : C.elev; ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = C.bg; ctx.stroke(); ctx.restore();
      if (rv.on) glow(CX, y, 40, C.accent, 0.3 * rv.a);
      const cxs = right ? CX + 40 : CX - 40, w = 250;
      ctx.save(); ctx.globalAlpha *= rv.a;
      rr(right ? cxs : cxs - w, y - 46, w, 92, 22); ctx.fillStyle = C.elev; ctx.fill(); ctx.restore();
      if (it.icon) drawIcon(it.icon, rtl ? (right ? cxs + w - 40 : cxs - 40) : (right ? cxs + w - 40 : cxs - 40), y, 44, rv.on ? C.accent : C.sec, rv.a);
      label(it.label, rtl ? (right ? cxs + w - (it.icon ? 76 : 22) : cxs - (it.icon ? 76 : 22)) : (right ? cxs + 22 : cxs - w + 22), y, { size: 25, align: rtl ? 'right' : 'left', maxW: it.icon ? 160 : 210, alpha: rv.a });
      if (it.value != null) label(String(it.value), right ? CX - 30 : CX + 30, y, { size: 30, color: C.accent, align: right ? 'right' : 'left', alpha: rv.a, maxW: 260 });
    });
  };

  T.chart = (s, t) => {
    const its = items(s), n = its.length;
    const base = 790, top = topY(s) + 70, x0 = 80, x1 = 640;
    const max = Math.max(...its.map(i => i.value || 0), 1) * 1.08;
    const bw = Math.min(110, ((x1 - x0) / n) * 0.62);
    for (let g = 1; g <= 4; g++) { const y = base - ((base - top) * g) / 4; drawOn([[x1, y], [x0, y]], eio(ramp(t, s.t0 + 0.05 * g, 0.6)), hexA(C.sec, 0.12), 1.5, false); }
    drawOn([[x1 + 10, base], [x0 - 10, base]], eio(ramp(t, s.t0, 0.5)), hexA(C.sec, 0.6), 3, false);
    if (s.unit) label(s.unit, x0, top - 30, { size: 22, color: C.sec, align: 'left', alpha: eo(ramp(t, s.t0, 0.4)) });
    const best = its.reduce((b, it, j) => ((it.value || 0) > (its[b].value || 0) ? j : b), 0);
    its.forEach((it, j) => {
      const cx = rtl ? x1 - ((j + 0.5) * (x1 - x0)) / n : x0 + ((j + 0.5) * (x1 - x0)) / n; // reading order
      const p = eio(ramp(t, it.t, 0.7));
      const hFull = ((it.value || 0) / max) * (base - top), hh = Math.max(4, hFull * p);
      const ghostA = 0.12 * eo(ramp(t, s.t0, 0.35));
      ctx.save();
      const baseA = ctx.globalAlpha;
      ctx.globalAlpha = baseA * ghostA; rr(cx - bw / 2, base - hFull, bw, hFull, 14); ctx.fillStyle = C.sec; ctx.fill();
      ctx.globalAlpha = p > 0 ? baseA : 0;
      const g = ctx.createLinearGradient(0, base - hh, 0, base);
      const col = j === best ? C.accent : C.accent2;
      g.addColorStop(0, col); g.addColorStop(1, hexA(col, 0.35));
      rr(cx - bw / 2, base - hh, bw, hh, 14); ctx.fillStyle = g; ctx.fill();
      ctx.restore();
      if (p > 0) glow(cx, base - hh, 70, col, 0.25 * p);
      label(fmtNum(Number.isInteger(it.value || 0) ? Math.round((it.value || 0) * p) : (it.value || 0) * p), cx, base - hh - 30, { size: 30, alpha: p > 0 ? 1 : 0, color: C.text, maxW: 200 });
      label(it.label, cx, base + 44, { size: 23, maxW: Math.max(110, ((x1 - x0) / n) * 0.95), alpha: 0.3 + 0.7 * (p > 0 ? 1 : 0), color: p > 0 ? C.text : C.sec, valign: 'top' });
    });
  };

  T.layers = (s, t) => {
    const its = items(s), n = its.length;
    const h = n > 4 ? 76 : 88, depth = 26, gap = 16, w = 470;
    const bottom = CY - 10 + (n * (h + gap)) / 2;
    its.forEach((it, j) => {
      const y = bottom - (j + 1) * (h + gap) + gap;
      const rv = reveal(t, it.t, s.t0, 0.55);
      const dy = rv.on ? (1 - back(rv.x)) * -50 : -10;
      const col = mix(C.accent2, C.accent, n > 1 ? j / (n - 1) : 1);
      ctx.save(); ctx.globalAlpha *= rv.a; ctx.translate(0, dy);
      // top face
      ctx.beginPath(); ctx.moveTo(CX - w / 2, y); ctx.lineTo(CX - w / 2 + depth, y - depth); ctx.lineTo(CX + w / 2 + depth, y - depth); ctx.lineTo(CX + w / 2, y); ctx.closePath();
      ctx.fillStyle = hexA(col, rv.on ? 0.55 : 0.25); ctx.fill();
      // side face
      ctx.beginPath(); ctx.moveTo(CX + w / 2, y); ctx.lineTo(CX + w / 2 + depth, y - depth); ctx.lineTo(CX + w / 2 + depth, y + h - depth); ctx.lineTo(CX + w / 2, y + h); ctx.closePath();
      ctx.fillStyle = hexA(col, rv.on ? 0.35 : 0.15); ctx.fill();
      // front
      ctx.fillStyle = rv.on ? hexA(col, 0.22) : 'rgba(255,255,255,0.03)'; ctx.fillRect(CX - w / 2, y, w, h);
      ctx.strokeStyle = hexA(col, 0.9); ctx.lineWidth = 2; ctx.strokeRect(CX - w / 2, y, w, h);
      ctx.restore();
      drawIcon(it.icon || s.icon, mx(CX + w / 2 - 44), y + h / 2 + dy, 46, rv.on ? C.text : C.sec, rv.a);
      label(it.label, mx(CX + w / 2 - 86), y + h / 2 + dy, { size: 28, align: A('right'), maxW: 330, alpha: rv.a, lines: 1 });
    });
  };

  T.cards = (s, t) => {
    const its = items(s), n = its.length;
    const vs = s.type === 'compare' && n === 2;
    const top = topY(s);
    let cells;
    if (n === 1) cells = [[CX, CY + 10, 440, 470]];
    else if (n === 2) cells = [[mx(CX + 156), CY + 10, 284, 420], [mx(CX - 156), CY + 10, 284, 420]];
    else { const cw = 284, ch = n === 3 ? 270 : 280, y0 = top + 40 + ch / 2; cells = [[mx(CX + 156), y0, cw, ch], [mx(CX - 156), y0, cw, ch], [n === 3 ? CX : mx(CX + 156), y0 + ch + 30, cw, ch], [mx(CX - 156), y0 + ch + 30, cw, ch]].slice(0, n); }
    its.forEach((it, j) => {
      const [x, y, w, h] = cells[j], rv = reveal(t, it.t, s.t0);
      const col = vs ? (j ? C.accent2 : C.accent) : j % 2 ? C.accent2 : C.accent;
      ctx.save(); ctx.globalAlpha *= rv.a; ctx.translate(x, y); ctx.scale(rv.s, rv.s);
      rr(-w / 2, -h / 2, w, h, 30); ctx.fillStyle = C.elev; ctx.fill();
      ctx.strokeStyle = rv.on ? hexA(col, 0.6) : 'rgba(255,255,255,0.05)'; ctx.lineWidth = 2.5; ctx.stroke();
      ctx.fillStyle = col; rr(-w / 2 + 30, -h / 2, w - 60, 6, 3); ctx.fill();
      ctx.restore();
      const iconS = n === 1 ? 190 : n === 2 ? 130 : 96;
      const iy = y - h * 0.14;
      if (rv.on) glow(x, iy, iconS, col, 0.18 * rv.a);
      ctx.save(); ctx.translate(x, iy); ctx.scale(rv.s, rv.s); drawIcon(it.icon || s.icon, 0, 0, iconS, rv.on ? C.text : C.sec, rv.a); ctx.restore();
      const ly = y + h * 0.3;
      if (it.value != null) { label(fmtNum(it.value), x, ly - 22, { size: 40, color: col, alpha: rv.a, maxW: w - 30 }); label(it.label, x, ly + 26, { size: 24, maxW: w - 40, alpha: rv.a, lines: 1 }); }
      else label(it.label, x, ly, { size: n === 1 ? 38 : 30, maxW: w - 40, alpha: rv.a });
    });
    if (vs) {
      const a = eo(ramp(t, its[1].t - 0.1, 0.4));
      ctx.save(); ctx.globalAlpha *= Math.max(0.15, a); ctx.translate(CX, CY + 10); ctx.scale(lerp(0.6, 1, back(a)), lerp(0.6, 1, back(a)));
      ctx.beginPath(); ctx.arc(0, 0, 40, 0, Math.PI * 2); ctx.fillStyle = C.bg; ctx.fill(); ctx.strokeStyle = C.text; ctx.lineWidth = 3; ctx.stroke();
      ctx.font = font(30, 700); ctx.fillStyle = C.text; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.direction = 'ltr'; ctx.fillText('VS', 0, 2);
      ctx.restore();
    }
  };

  T.meter = (s, t) => {
    const cy = 560, R = 225, th = 30;
    const frac = clamp((s.value ?? 0) / (s.max || 100), 0, 1);
    const p = eio(ramp(t, s.tv, 1.2));
    const a0 = Math.PI, a1 = Math.PI * 2;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(CX, cy, R, a0, a1); ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = th; ctx.stroke();
    for (let i = 0; i <= 10; i++) {
      const a = a0 + (Math.PI * i) / 10, r1 = R - th - 10, r2 = r1 - (i % 5 ? 10 : 20);
      ctx.beginPath(); ctx.moveTo(CX + r1 * Math.cos(a), cy + r1 * Math.sin(a)); ctx.lineTo(CX + r2 * Math.cos(a), cy + r2 * Math.sin(a));
      ctx.strokeStyle = hexA(C.sec, 0.4 * eo(ramp(t, s.t0 + i * 0.03, 0.3))); ctx.lineWidth = 3; ctx.stroke();
    }
    const warn = (data.storyboard.accents || []).some(a => a[1] === 'warning' && a[0] >= s.at && a[0] <= (s.items[0]?.at ?? s.at) + 6);
    const col = warn ? C.warning : C.accent;
    if (p > 0) {
      const g = ctx.createLinearGradient(CX - R, 0, CX + R, 0); g.addColorStop(0, C.accent2); g.addColorStop(1, col);
      ctx.beginPath(); ctx.arc(CX, cy, R, a0, a0 + Math.PI * frac * p); ctx.strokeStyle = g; ctx.lineWidth = th; ctx.stroke();
      const ea = a0 + Math.PI * frac * p; glow(CX + R * Math.cos(ea), cy + R * Math.sin(ea), 60, col, 0.45);
    }
    const na = a0 + Math.PI * frac * p;
    ctx.beginPath(); ctx.moveTo(CX, cy); ctx.lineTo(CX + (R - 70) * Math.cos(na), cy + (R - 70) * Math.sin(na)); ctx.strokeStyle = C.text; ctx.lineWidth = 5; ctx.stroke();
    ctx.beginPath(); ctx.arc(CX, cy, 14, 0, Math.PI * 2); ctx.fillStyle = C.text; ctx.fill();
    ctx.restore();
    const ta = 0.25 + 0.75 * (p > 0 ? 1 : 0);
    ctx.save(); ctx.globalAlpha *= ta; ctx.font = font(96, 700); ctx.fillStyle = C.text; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.direction = 'ltr';
    const num = fmtNum(Number.isInteger(s.value ?? 0) ? Math.round((s.value ?? 0) * p) : (s.value ?? 0) * p), nw = measure(num, font(96, 700));
    ctx.fillText(num, CX - (s.unit ? 20 : 0), cy + 110);
    if (s.unit) { ctx.font = font(36, 700); ctx.fillStyle = col; ctx.textAlign = 'left'; ctx.fillText(s.unit, CX - 20 + nw / 2 + 8, cy + 110); }
    ctx.restore();
    label(s.items[0]?.label || s.title, CX, cy + 170, { size: 32, maxW: 520, alpha: ta, color: C.text });
    label('0', CX - R, cy + 40, { size: 20, color: C.sec, alpha: 0.7 });
    label(fmtNum(s.max || 100), CX + R, cy + 40, { size: 20, color: C.sec, alpha: 0.7 });
    if (s.icon) drawIcon(s.icon, CX, cy - R - 62, 56, col, 0.9 * eo(ramp(t, s.t0, 0.4)));
  };

  // Body outline (design coords, centred at x=360).
  const BODY = new Path2D('M360 250c26 0 46 21 46 48s-20 50-46 50-46-23-46-50 20-48 46-48z M336 344v22c-26 6-52 12-74 20-20 7-30 22-34 44l-26 150c-3 16 18 22 24 6l30-118 10 2-4 146c-1 12 0 24 2 36l14 196c1 18 32 18 34 0l14-180h14l14 180c2 18 33 18 34 0l14-196c2-12 3-24 2-36l-4-146 10-2 30 118c6 16 27 10 24-6l-26-150c-4-22-14-37-34-44-22-8-48-14-74-20v-22');
  const ORGAN_POS = { brain: [360, 280], eyes: [360, 292], nose: [360, 306], mouth: [360, 322], throat: [360, 362], lungs: [360, 440], heart: [374, 448], stomach: [382, 508], liver: [338, 502], kidneys: [360, 540], intestines: [360, 590], bladder: [360, 646], muscles: [262, 470], bones: [330, 780], skin: [446, 560], blood: [360, 470], nerves: [360, 500] };
  T.body = (s, t) => {
    const [ox, oy] = ORGAN_POS[s.organ] || ORGAN_POS.heart;
    const rv = reveal(t, s.items[0]?.t ?? s.t0 + 0.3, s.t0, 0.6);
    ctx.save();
    ctx.translate(0, 20);
    ctx.fillStyle = 'rgba(39,184,199,0.05)'; ctx.fill(BODY);
    ctx.strokeStyle = hexA(C.sec, 0.55); ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.stroke(BODY);
    // scanner line
    const sy = 250 + ((t - s.t0) * 260) % 680;
    ctx.save(); ctx.clip(BODY);
    const g = ctx.createLinearGradient(0, sy - 40, 0, sy + 4); g.addColorStop(0, hexA(C.accent, 0)); g.addColorStop(1, hexA(C.accent, 0.35));
    ctx.fillStyle = g; ctx.fillRect(180, sy - 40, 360, 44);
    for (let y = 260; y < 940; y += 22) { ctx.fillStyle = 'rgba(244,243,238,0.03)'; ctx.fillRect(180, y, 360, 1); }
    ctx.restore();
    ctx.restore();
    const y = oy + 20;
    const pulse = 1 + 0.06 * Math.sin((t - s.t0) * 6);
    for (let i = 0; i < 2; i++) { const ph = ((t - s.t0) / 1.4 + i / 2) % 1; ctx.beginPath(); ctx.arc(ox, y, 40 + ph * 70, 0, Math.PI * 2); ctx.strokeStyle = hexA(C.accent, 0.4 * (1 - ph) * rv.a); ctx.lineWidth = 2; ctx.stroke(); }
    glow(ox, y, 120, C.accent, 0.35 * rv.a);
    ctx.save(); ctx.translate(ox, y); ctx.scale(rv.s * pulse, rv.s * pulse);
    drawIcon(s.icon, 0, 0, 92, rv.on ? C.accent : C.sec, Math.max(rv.a, 0.35), iconMap['organ:' + s.organ]);
    ctx.restore();
    // callouts
    const labels = s.items.length ? s.items : [{ label: s.title, t: s.t0 + 0.4 }];
    labels.forEach((it, j) => {
      const r = reveal(t, it.t, s.t0);
      const right = j % 2 === 0;
      const lx = right ? 530 : 190, ly = 300 + j * 150 + (j ? 60 : 0);
      drawOn([[ox + (right ? 30 : -30), y - 10], [lx + (right ? -50 : 50), ly], [lx + (right ? -10 : 10), ly]], eio(ramp(t, it.t - 0.1, 0.45)), hexA(C.accent, 0.8), 2.5, false);
      if (r.on) { ctx.beginPath(); ctx.arc(ox + (right ? 30 : -30), y - 10, 5, 0, Math.PI * 2); ctx.fillStyle = C.accent; ctx.fill(); }
      ctx.save(); ctx.globalAlpha *= r.a;
      const f = font(26, 700), tw = Math.min(220, measure(it.label || '', f)) + 32;
      const bx = right ? Math.min(lx - 10, 650 - tw) : Math.max(70, lx + 10 - tw);
      rr(bx, ly - 28, tw, 56, 18); ctx.fillStyle = C.elev; ctx.fill(); ctx.strokeStyle = hexA(C.accent, 0.5); ctx.lineWidth = 2; ctx.stroke();
      ctx.restore();
      label(it.label, bx + tw / 2, ly, { size: 26, maxW: 220, alpha: r.a, lines: 1 });
    });
  };
  T.body.focus = (s, t) => {
    const [ox, oy] = ORGAN_POS[s.organ] || ORGAN_POS.heart;
    const p = eio(ramp(t, s.items[0]?.t ?? s.t0 + 0.3, 1.4));
    return { f: [lerp(CX, (ox + 3 * CX) / 4, p), lerp(CY, (oy + 20 + 3 * CY) / 4, p)], z: 1 + 0.06 * p };
  };

  T.checklist = (s, t) => {
    const its = items(s), n = its.length;
    label(s.title || LG.recap, CX, 238, { size: 40, alpha: eo(ramp(t, s.t0, 0.4)) });
    ctx.fillStyle = C.accent; const bw = 80 * eo(ramp(t, s.t0 + 0.2, 0.4)); rr(CX - bw / 2, 272, bw, 5, 2.5); ctx.fill();
    const h = 104, gap = 26, y0 = 330 + (4 - n) * 50;
    its.forEach((it, j) => {
      const y = y0 + j * (h + gap), rv = reveal(t, it.t, s.t0);
      ctx.save(); ctx.globalAlpha *= rv.a; ctx.translate(CX, y + h / 2); ctx.scale(rv.s, rv.s);
      rr(-275, -h / 2, 550, h, 26); ctx.fillStyle = C.elev; ctx.fill(); ctx.restore();
      const cx = mx(CX + 275 - 56), cy = y + h / 2;
      ctx.save(); ctx.globalAlpha *= rv.a;
      ctx.beginPath(); ctx.arc(cx, cy, 26, 0, Math.PI * 2); ctx.fillStyle = rv.on ? C.success : 'rgba(255,255,255,0.06)'; ctx.fill(); ctx.restore();
      drawOn([[cx - 11, cy + 1], [cx - 3, cy + 9], [cx + 12, cy - 8]], eo(ramp(t, it.t + 0.1, 0.3)), C.bg, 5, false);
      if (rv.on) glow(cx, cy, 60, C.success, 0.25 * rv.a);
      label(it.label, rtl ? cx - 50 : cx + 50, cy, { size: 30, align: A('right'), maxW: 400, alpha: rv.a, lines: 1 });
      if (it.icon) drawIcon(it.icon, mx(CX - 275 + 50), cy, 44, rv.on ? C.accent : C.sec, rv.a * 0.9);
    });
  };

  function sceneTitle(s, t) {
    if (!s.title || ['hero', 'ask', 'checklist', 'meter'].includes(s.template)) return;
    const a = eo(ramp(t, s.t0 + 0.05, 0.4));
    label(s.title, CX, 214 + (1 - a) * 10, { size: 34, alpha: a, maxW: 470, lines: 1 });
  }

  function drawScene(s, t, alpha, extraScale) {
    const fn = T[s.template] || T.cards;
    const dur = Math.max(0.5, s.t1 - s.t0);
    const push = 1 + 0.045 * eio(clamp((t - s.t0) / (dur + TR), 0, 1));
    const cam = fn.focus ? fn.focus(s, t) : { f: [CX, CY], z: 1 };
    const z = push * cam.z * extraScale;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(CX, CY); ctx.scale(z, z); ctx.translate(-cam.f[0], -cam.f[1]);
    fn(s, t);
    ctx.restore();
    ctx.save(); ctx.globalAlpha = alpha; sceneTitle(s, t); ctx.restore();
  }

  function drawFrame(t) {
    t = clamp(t, 0, timeline.duration);
    curT = t;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.globalAlpha = 1;
    background(t);
    const kk = sceneAt(timeline, t);
    const s = timeline.scenes[kk];
    ctx.save();
    const cs = LAY.card.s;
    ctx.translate(LAY.card.x - CARD.x * cs, LAY.card.y - CARD.y * cs); ctx.scale(cs, cs);
    cardShell();
    if (s) {
      ctx.save();
      rr(CARD.x, CARD.y, CARD.w, CARD.h, CARD.r); ctx.clip();
      const tin = kk > 0 ? eio(ramp(t, s.t0, TR)) : 1;
      const dir = rtl ? -1 : 1;
      if (kk > 0 && tin < 1) { ctx.save(); ctx.translate(-dir * 70 * tin, 0); drawScene(timeline.scenes[kk - 1], t, 1 - tin, 1 + 0.08 * tin); ctx.restore(); }
      ctx.save(); ctx.translate(dir * 70 * (1 - tin), 0); drawScene(s, t, tin, lerp(0.94, 1, tin)); ctx.restore();
      // light sweep across the card on the cut
      if (kk > 0 && tin < 1) {
        const sx = CARD.x + (rtl ? 1 - tin : tin) * (CARD.w + 300) - 150;
        const g = ctx.createLinearGradient(sx - 120, 0, sx + 120, 0);
        g.addColorStop(0, hexA(C.accent, 0)); g.addColorStop(0.5, hexA(C.accent, 0.12 * Math.sin(Math.PI * tin))); g.addColorStop(1, hexA(C.accent, 0));
        ctx.fillStyle = g; ctx.fillRect(CARD.x, CARD.y, CARD.w, CARD.h);
      }
      ctx.restore();
      cardFrame(t, s, kk);
    }
    ctx.restore();
    if (s) chrome(t, kk, s);
    ctx.save();
    ctx.translate(LAY.cap.cx - 360 * LAY.cap.s, LAY.cap.cy - 1062 * LAY.cap.s); ctx.scale(LAY.cap.s, LAY.cap.s);
    captions(t);
    ctx.restore();
    if (style.endScreen && data.endAt != null && t >= data.endAt) endScreen(t);
  }

  return { drawFrame, drawCover, timeline, duration: timeline.duration, fps: data.fps || 30, width: DW, height: DH };
}

/** Load the reel fonts (default IBM Plex Sans Arabic, or a custom one) into a document. */
export async function loadFonts(doc, base = './assets/fonts/', custom) {
  const fonts = [];
  if (custom?.url) {
    fonts.push(new FontFace('Reel', `url(${custom.url})`, { weight: '100 900' }));
  } else {
    for (const w of [400, 500, 700]) {
      fonts.push(new FontFace('Reel', `url(${base}IBMPlexSansArabic-arabic-${w}.woff2)`, { weight: String(w), unicodeRange: 'U+0600-06FF,U+0750-077F,U+0870-08FF,U+200C-200E,U+2010-2011,U+204F,U+2E41,U+FB50-FDFF,U+FE70-FEFC' }));
      fonts.push(new FontFace('Reel', `url(${base}IBMPlexSansArabic-latin-${w}.woff2)`, { weight: String(w), unicodeRange: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD' }));
    }
  }
  for (const f of fonts) { doc.fonts.add(f); }
  await Promise.all(fonts.map(f => f.load().catch(e => console.warn('font', e))));
  await doc.fonts.ready;
}
