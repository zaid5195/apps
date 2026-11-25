// تنظيف الفقاعات من النص الأصلي + كتابة الترجمة داخل شكل الفقاعة
export const DEFAULT_FONT = { family: '"Noto Naskh Arabic", "Segoe UI", Tahoma, Arial, sans-serif', weight: 700 };

export function textColor(bg) {
  let h = String(bg || '#fff').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) || 0);
  return 0.299 * r + 0.587 * g + 0.114 * b > 140 ? '#111' : '#fff';
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const hex = ([r, g, b]) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
const parseHex = (h) => {
  h = (h || '#ffffff').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) || 0);
};

// لون خلفية الفقاعة: اللون الأكثر تكراراً حول النص
function bgColor(d, W, H, x0, y0, x1, y1) {
  const counts = new Map();
  const sums = new Map();
  let total = 0;
  const add = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    const k = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
    counts.set(k, (counts.get(k) || 0) + 1);
    const s = sums.get(k) || [0, 0, 0];
    s[0] += d[i]; s[1] += d[i + 1]; s[2] += d[i + 2];
    sums.set(k, s);
    total++;
  };
  for (let pad = 2; pad <= 8; pad += 3) {
    for (let x = x0 - pad; x <= x1 + pad; x++) { add(x, y0 - pad); add(x, y1 + pad); }
    for (let y = y0 - pad; y <= y1 + pad; y++) { add(x0 - pad, y); add(x1 + pad, y); }
  }
  // داخل مربع النص كمان (المسافات بين الحروف)
  const step = Math.max(1, Math.floor(Math.min(x1 - x0, y1 - y0) / 12));
  for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) add(x, y);
  let best = 0, bk = 0;
  counts.forEach((c, k) => { if (c > best) { best = c; bk = k; } });
  const s = sums.get(bk);
  return { color: s ? s.map((v) => Math.round(v / best)) : [255, 255, 255], frac: total ? best / total : 0 };
}

const dist = (d, i, c) => Math.abs(d[i] - c[0]) + Math.abs(d[i + 1] - c[1]) + Math.abs(d[i + 2] - c[2]);
const toPx = (b, W, H) => {
  const x0 = clamp(Math.floor(b.x * W), 0, W - 1), y0 = clamp(Math.floor(b.y * H), 0, H - 1);
  return [x0, y0, clamp(Math.ceil((b.x + b.w) * W), x0 + 1, W), clamp(Math.ceil((b.y + b.h) * H), y0 + 1, H)];
};

// نسبة «الحبر» (حروف) داخل المربع: لو صفر تقريباً فالمكان اللي أعطاه Gemini فاضي
function inkRatio(d, W, x0, y0, x1, y1, color) {
  let ink = 0, n = 0;
  const step = Math.max(1, Math.floor(Math.min(x1 - x0, y1 - y0) / 40));
  for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) { n++; if (dist(d, (y * W + x) * 4, color) > 90) ink++; }
  return n ? ink / n : 0;
}

// لو مكان النص غلط (ما فيه حروف)، ندوّر على النص قريب منه
function snapBox(d, W, H, b, others) {
  const [x0, y0, x1, y1] = toPx(b, W, H);
  const here = bgColor(d, W, H, x0, y0, x1, y1);
  if (inkRatio(d, W, x0, y0, x1, y1, here.color) >= 0.02) return b;
  const cands = [];
  for (const dy of [0.6, -0.6, 1.2, -1.2, 2, -2, 3, -3]) for (const dx of [0, 0.5, -0.5]) cands.push([dx, dy]);
  cands.sort((p, q) => Math.hypot(p[0], p[1]) - Math.hypot(q[0], q[1]));
  const iou = (a, c) => {
    const ix = Math.max(0, Math.min(a.x + a.w, c.x + c.w) - Math.max(a.x, c.x));
    const iy = Math.max(0, Math.min(a.y + a.h, c.y + c.h) - Math.max(a.y, c.y));
    return (ix * iy) / Math.min(a.w * a.h, c.w * c.h || 1);
  };
  for (const [dx, dy] of cands) {
    const nb = { ...b, x: b.x + dx * b.w, y: b.y + dy * b.h };
    if (nb.x < 0 || nb.y < 0 || nb.x + nb.w > 1 || nb.y + nb.h > 1) continue;
    if (others.some((o) => o !== b && iou(nb, o) > 0.3)) continue; // هذا نص فقاعة ثانية
    const [a0, b0, a1, b1] = toPx(nb, W, H);
    const c = bgColor(d, W, H, a0, b0, a1, b1);
    if (c.frac >= 0.3 && inkRatio(d, W, a0, b0, a1, b1, c.color) >= 0.05) return { ...nb, snapped: true };
  }
  return b;
}

function dilate(mask, rw, rh, times, within) {
  let E = mask;
  for (let it = 0; it < times; it++) {
    const N = E.slice();
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
      const p = y * rw + x;
      if (E[p] || (within && !within[p])) continue;
      if ((x > 0 && E[p - 1]) || (x < rw - 1 && E[p + 1]) || (y > 0 && E[p - rw]) || (y < rh - 1 && E[p + rw])) N[p] = 1;
    }
    E = N;
  }
  return E;
}

// نعبّي مكان الحروف من الألوان اللي حولها (من الأطراف للداخل) — يحافظ على التدرج بدل مربع لون واحد
function inpaint(d, W, rx0, ry0, rw, rh, ink, allowed) {
  const known = new Uint8Array(rw * rh);
  let todo = [];
  for (let p = 0; p < known.length; p++) {
    if (ink[p]) todo.push(p);
    else if (!allowed || allowed[p]) known[p] = 1;
  }
  for (let pass = 0; pass < 400 && todo.length; pass++) {
    const next = [], upd = [];
    for (const p of todo) {
      const x = p % rw, y = (p / rw) | 0;
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= rw || yy >= rh) continue;
        const q = yy * rw + xx;
        if (!known[q]) continue;
        const i = ((ry0 + yy) * W + rx0 + xx) * 4;
        r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
      }
      if (n) upd.push(p, r / n, g / n, b / n); else next.push(p);
    }
    if (!upd.length) break;
    for (let k = 0; k < upd.length; k += 4) {
      const p = upd[k], x = p % rw, y = (p / rw) | 0;
      const i = ((ry0 + y) * W + rx0 + x) * 4;
      d[i] = upd[k + 1]; d[i + 1] = upd[k + 2]; d[i + 2] = upd[k + 3];
      known[p] = 1;
    }
    todo = next;
  }
}

// المستطيل اللي تنكتب فيه الترجمة لما ما فيه فقاعة مقفلة
function rectOf(a, W, H) {
  if (a.rect) return a.rect;
  const [tx0, ty0, tx1, ty1] = a.tbox;
  const px = (tx1 - tx0) * 0.08 + 2, py = (ty1 - ty0) * 0.1 + 2;
  a.rect = [Math.max(0, tx0 - px), Math.max(0, ty0 - py), Math.min(W, tx1 + px), Math.min(H, ty1 + py)];
  return a.rect;
}

// نص على خلفية فاتحة/متدرجة بدون فقاعة: نقدّر لون الخلفية في كل نقطة من حواف المستطيل
// (يمين/يسار وفوق/تحت) ونمسح بس اللي يختلف عنها = الحروف، ونعبّي مكانها من حولها
function eraseSoft(d, W, H, a) {
  // منطقة المسح أوسع شوي من النص (بقايا الضغط حول الحروف)
  const [tx0, ty0, tx1, ty1] = a.tbox;
  const pad = Math.max(6, Math.round((ty1 - ty0) * 0.25));
  const x0 = Math.max(0, tx0 - pad), y0 = Math.max(0, ty0 - pad), x1 = Math.min(W, tx1 + pad), y1 = Math.min(H, ty1 + pad);
  const rw = x1 - x0, rh = y1 - y0;
  if (rw < 4 || rh < 4) return;
  const px = (x, y) => (clamp(y, 0, H - 1) * W + clamp(x, 0, W - 1)) * 4;
  // حواف المستطيل (بكسلين برا) — نأخذ الأفتح/الأقرب للخلفية لكل نقطة حافة
  const edge = (x, y, dx, dy) => {
    let best = null, bd = 1e9;
    for (let k = 1; k <= 3; k++) {
      const i = px(x + dx * k, y + dy * k);
      const dd = dist(d, i, a.color);
      if (dd < bd) { bd = dd; best = [d[i], d[i + 1], d[i + 2]]; }
    }
    return best;
  };
  const L = [], R = [], T = [], B = [];
  for (let y = 0; y < rh; y++) { L.push(edge(x0, y0 + y, -1, 0)); R.push(edge(x1 - 1, y0 + y, 1, 0)); }
  for (let x = 0; x < rw; x++) { T.push(edge(x0 + x, y0, 0, -1)); B.push(edge(x0 + x, y1 - 1, 0, 1)); }
  let ink = new Uint8Array(rw * rh), n = 0;
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
    const u = x / (rw - 1), v = y / (rh - 1);
    const est = [0, 1, 2].map((c) => ((1 - u) * L[y][c] + u * R[y][c] + (1 - v) * T[x][c] + v * B[x][c]) / 2);
    if (dist(d, px(x0 + x, y0 + y), est) > 36) { ink[y * rw + x] = 1; n++; }
  }
  if (n > rw * rh * 0.45) { a.busy = true; return; } // رسم مزدحم: نطمس بدل ما نمسح
  ink = dilate(ink, rw, rh, 3);
  inpaint(d, W, x0, y0, rw, rh, ink, null);
}

// يحدد شكل الفقاعة: المنطقة المتصلة بنفس لون الخلفية حول النص + الثقوب (الحروف) داخلها
function analyze(d, W, H, b) {
  // نجرب منطقة بحث أكبر لو النص صغير والفقاعة كبيرة
  let r;
  for (const k of [0.7, 1.6, 3.2]) {
    r = analyzeOnce(d, W, H, b, k);
    if (r.mode === 'mask' || !r.leaked) return r;
  }
  return r;
}

function analyzeOnce(d, W, H, b, k) {
  const tx0 = clamp(Math.floor(b.x * W), 0, W - 1), ty0 = clamp(Math.floor(b.y * H), 0, H - 1);
  const tx1 = clamp(Math.ceil((b.x + b.w) * W), tx0 + 1, W), ty1 = clamp(Math.ceil((b.y + b.h) * H), ty0 + 1, H);
  const tw = tx1 - tx0, th = ty1 - ty0;
  const { color, frac } = bgColor(d, W, H, tx0, ty0, tx1, ty1);
  const res = { tbox: [tx0, ty0, tx1, ty1], color, mode: 'rect', busy: false };
  if (frac < 0.3) return res; // خلفية معقدة (نص على الرسم)

  const ex = Math.round(Math.max(tw, th) * k + 12);
  const rx0 = clamp(tx0 - ex, 0, W), ry0 = clamp(ty0 - ex, 0, H), rx1 = clamp(tx1 + ex, 0, W), ry1 = clamp(ty1 + ex, 0, H);
  const rw = rx1 - rx0, rh = ry1 - ry0;
  const [br, bgc, bb] = color;
  const isBg = (x, y) => {
    const i = ((ry0 + y) * W + rx0 + x) * 4;
    return Math.abs(d[i] - br) + Math.abs(d[i + 1] - bgc) + Math.abs(d[i + 2] - bb) < 75;
  };
  const F = new Uint8Array(rw * rh);
  const q = new Int32Array(rw * rh);
  let qh = 0, qt = 0;
  const push = (x, y) => { const p = y * rw + x; if (!F[p] && isBg(x, y)) { F[p] = 1; q[qt++] = p; } };
  for (let y = ty0 - ry0; y < ty1 - ry0; y++) for (let x = tx0 - rx0; x < tx1 - rx0; x++) push(x, y);
  while (qh < qt) {
    const p = q[qh++], x = p % rw, y = (p / rw) | 0;
    if (x > 0) push(x - 1, y);
    if (x < rw - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < rh - 1) push(x, y + 1);
  }
  // تسرّب: الخلفية مفتوحة (مو فقاعة مقفلة) — حواف الصورة نفسها ما تنحسب
  let leak = 0, per = 0;
  const edge = (x, y) => { per++; if (F[y * rw + x]) leak++; };
  if (ry0 > 0) for (let x = 0; x < rw; x++) edge(x, 0);
  if (ry1 < H) for (let x = 0; x < rw; x++) edge(x, rh - 1);
  if (rx0 > 0) for (let y = 0; y < rh; y++) edge(0, y);
  if (rx1 < W) for (let y = 0; y < rh; y++) edge(rw - 1, y);
  if (qt < tw * th * 0.25) return res;
  if (per && leak / per > 0.12) { res.leaked = true; return res; }

  // الخارج = كل اللي يوصل له من حدود المنطقة بدون ما يمر بالفقاعة
  const O = new Uint8Array(rw * rh);
  qh = qt = 0;
  const pushO = (x, y) => { const p = y * rw + x; if (!O[p] && !F[p]) { O[p] = 1; q[qt++] = p; } };
  for (let x = 0; x < rw; x++) { pushO(x, 0); pushO(x, rh - 1); }
  for (let y = 0; y < rh; y++) { pushO(0, y); pushO(rw - 1, y); }
  while (qh < qt) {
    const p = q[qh++], x = p % rw, y = (p / rw) | 0;
    if (x > 0) pushO(x - 1, y);
    if (x < rw - 1) pushO(x + 1, y);
    if (y > 0) pushO(x, y - 1);
    if (y < rh - 1) pushO(x, y + 1);
  }
  const M = new Uint8Array(rw * rh);
  let mx0 = rw, my0 = rh, mx1 = 0, my1 = 0;
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
    const p = y * rw + x;
    if (!O[p]) { M[p] = 1; if (x < mx0) mx0 = x; if (x > mx1) mx1 = x; if (y < my0) my0 = y; if (y > my1) my1 = y; }
  }
  // تأكد إنها فقاعة فعلاً: مو منطقة كبيرة من الرسم، والثقوب (الحروف) مو أكبر من النص نفسه
  let area = 0, holes = 0;
  for (let p = 0; p < M.length; p++) if (M[p]) { area++; if (!F[p]) holes++; }
  if (area > tw * th * 16 || holes > tw * th * 1.3) return res;
  // مربع النص لازم يكون داخل الفقاعة (مو شريط من الرسم يقطع النص)
  let inside = 0, tot = 0;
  const st = Math.max(1, Math.floor(Math.min(tw, th) / 20));
  for (let y = ty0; y < ty1; y += st) for (let x = tx0; x < tx1; x += st) { tot++; if (M[(y - ry0) * rw + (x - rx0)]) inside++; }
  if (tot && inside / tot < 0.85) return res;
  return Object.assign(res, { mode: 'mask', F, M, rx0, ry0, rw, rh, bbox: [rx0 + mx0, ry0 + my0, rx0 + mx1 + 1, ry0 + my1 + 1] });
}

const inMask = (a, x, y) => a.mode === 'mask' && x >= a.rx0 && y >= a.ry0 && x < a.rx0 + a.rw && y < a.ry0 + a.rh && a.M[(y - a.ry0) * a.rw + (x - a.rx0)];

// نمسح الحروف: الثقوب داخل الفقاعة + بقايا حولها، ونعبّيها من لون الفقاعة المحيط
function erase(d, W, a) {
  const { F, M, rw, rh, rx0, ry0 } = a;
  const [tx0, ty0, tx1, ty1] = a.tbox;
  const px = (tx1 - tx0) * 0.12 + 3, py = (ty1 - ty0) * 0.12 + 3;
  let ink = new Uint8Array(rw * rh);
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
    const p = y * rw + x;
    if (!M[p]) continue;
    const X = rx0 + x, Y = ry0 + y;
    const inT = X >= tx0 - px && X < tx1 + px && Y >= ty0 - py && Y < ty1 + py;
    if (!F[p] || (inT && dist(d, (Y * W + X) * 4, a.color) > 14)) ink[p] = 1;
  }
  ink = dilate(ink, rw, rh, 2, M);
  inpaint(d, W, rx0, ry0, rw, rh, ink, M);
}

// المساحة المتاحة لكل سطر: عرض الفقاعة عند هذا الارتفاع
function rowsFor(a, W) {
  let x0, y0, x1, y1;
  const left = new Map(), right = new Map();
  if (a.mode === 'mask') {
    [x0, y0, x1, y1] = a.bbox;
    const cx = Math.round((a.tbox[0] + a.tbox[2]) / 2);
    const m = Math.max(2, Math.round(Math.min(x1 - x0, y1 - y0) * 0.09));
    for (let y = y0; y < y1; y++) {
      let c = cx;
      if (!inMask(a, c, y)) {
        // نبحث عن أقرب نقطة داخل الفقاعة في هذا السطر
        let found = false;
        for (let k = 1; k < (x1 - x0) / 2 && !found; k++) {
          if (inMask(a, cx - k, y)) { c = cx - k; found = true; } else if (inMask(a, cx + k, y)) { c = cx + k; found = true; }
        }
        if (!found) continue;
      }
      let l = c, r = c;
      while (l > x0 && inMask(a, l - 1, y)) l--;
      while (r < x1 - 1 && inMask(a, r + 1, y)) r++;
      if (r - l > 2 * m) { left.set(y, l + m); right.set(y, r - m); }
    }
    return { left, right, y0: y0 + m, y1: y1 - m };
  }
  [x0, y0, x1, y1] = rectOf(a, W, Infinity);
  const m = Math.max(2, Math.min(x1 - x0, y1 - y0) * 0.08);
  for (let y = Math.floor(y0); y < y1; y++) { left.set(y, x0 + m); right.set(y, x1 - m); }
  return { left, right, y0: y0 + m, y1: y1 - m };
}

function layout(ctx, text, rows, W, origH, font, scale) {
  const words = text.split(/\s+/).filter(Boolean);
  const H = rows.y1 - rows.y0;
  if (H <= 4 || !words.length) return null;
  // ما نكبّر الخط أكثر من حجم النص الأصلي
  const maxSize = Math.min(H / 1.22, origH * 0.95 * scale, W * 0.075 * scale, 90 * scale);
  const minSize = Math.max(8, W * 0.014);
  const span = (ya, yb) => {
    let L = -Infinity, R = Infinity;
    for (let y = Math.ceil(ya); y <= Math.floor(yb); y++) {
      if (!rows.left.has(y)) return null;
      L = Math.max(L, rows.left.get(y)); R = Math.min(R, rows.right.get(y));
    }
    return R > L ? [L, R] : null;
  };
  for (let size = Math.floor(maxSize); size >= minSize; size -= size > 30 ? 2 : 1) {
    ctx.font = `${font.weight} ${size}px ${font.family}`;
    const lh = size * 1.22;
    const maxLines = Math.floor(H / lh);
    for (let n = 1; n <= maxLines; n++) {
      const top = (rows.y0 + rows.y1) / 2 - (n * lh) / 2;
      const lines = [];
      let wi = 0, ok = true;
      for (let i = 0; i < n && wi < words.length; i++) {
        const sp = span(top + i * lh, top + (i + 1) * lh);
        if (!sp) { ok = false; break; }
        const w = sp[1] - sp[0];
        let line = '';
        while (wi < words.length) {
          const t = line ? line + ' ' + words[wi] : words[wi];
          if (ctx.measureText(t).width <= w) { line = t; wi++; } else break;
        }
        if (!line) { ok = false; break; }
        lines.push({ t: line, x: (sp[0] + sp[1]) / 2, y: top + i * lh + lh / 2 });
      }
      if (ok && wi >= words.length) {
        // نوسّط الأسطر عمودياً حسب عددها الفعلي
        const shift = ((n - lines.length) * lh) / 2;
        lines.forEach((l) => (l.y += shift));
        return { size, lines };
      }
    }
  }
  return null;
}

async function toDataUrl(blob) {
  return await new Promise((ok, bad) => {
    const fr = new FileReader();
    fr.onload = () => ok(fr.result);
    fr.onerror = () => bad(fr.error);
    fr.readAsDataURL(blob);
  });
}

// يرجع: الصورة المترجمة كاملة + قطع صغيرة (patches) تنحط فوق الفقاعات في الصفحة
export async function typesetImage(bytes, mime, boxes, { patches: wantPatches = true, font = DEFAULT_FONT, scale = 1, rtl = true } = {}) {
  const bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
  const W = bmp.width, H = bmp.height;
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;

  // فقاعات «...» أو ترجمة فاضية: نخليها مثل ما هي بدون مسح
  boxes = boxes.filter((b) => /[\p{L}\p{N}]/u.test(b.tr || ''));
  // نصحّح المواقع اللي ما فيها حروف
  boxes = boxes.map((b) => snapBox(d, W, H, b, boxes));
  // 1) نحلل كل الفقاعات على الصورة الأصلية، ونجمع النصوص اللي في نفس الفقاعة
  const an = boxes.map((b) => analyze(d, W, H, b));
  const groups = [];
  const byA = new Map();
  boxes.forEach((b, i) => {
    const cx = Math.round((b.x + b.w / 2) * W), cy = Math.round((b.y + b.h / 2) * H);
    // نصوص داخل نفس الفقاعة = نص واحد
    const host = an.find((a) => a.mode === 'mask' && inMask(a, cx, cy)) || an[i];
    let g = byA.get(host);
    if (!g) { g = { a: host, texts: [] }; byA.set(host, g); groups.push(g); }
    g.texts.push(b.tr);
    if (host !== an[i]) {
      const t = an[i].tbox;
      host.tbox = [Math.min(host.tbox[0], t[0]), Math.min(host.tbox[1], t[1]), Math.max(host.tbox[2], t[2]), Math.max(host.tbox[3], t[3])];
    }
  });
  // 2) نمسح النص الأصلي
  for (const g of groups) {
    if (g.a.mode === 'mask') erase(d, W, g.a);
    else if (!g.a.busy) eraseSoft(d, W, H, g.a);
  }
  ctx.putImageData(img, 0, 0);

  // 3) نكتب الترجمة
  const patches = [];
  for (const g of groups) {
    const a = g.a;
    const rows = rowsFor(a, W);
    const col = hex(a.color);
    let outline = false, halo = false;
    if (a.mode === 'rect' && !a.busy) halo = true;
    if (a.mode === 'rect' && a.busy) {
      const [x0, y0, x1, y1] = rectOf(a, W, H);
      const rr = Math.min(x1 - x0, y1 - y0) * 0.3;
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x0, y0, x1 - x0, y1 - y0, rr);
      {
        // نص على الرسم: نطمس النص الأصلي بدل ما نغطيه بلون
        ctx.clip();
        const snap = new OffscreenCanvas(W, H);
        snap.getContext('2d').drawImage(canvas, 0, 0);
        ctx.filter = `blur(${Math.max(4, Math.round(Math.min(x1 - x0, y1 - y0) * 0.18))}px)`;
        for (let k = 0; k < 2; k++) ctx.drawImage(snap, 0, 0);
        ctx.filter = 'none';
        outline = true;
      }
      ctx.restore();
    }
    const text = g.texts.join(' ');
    let lay = layout(ctx, text, rows, W, a.tbox[3] - a.tbox[1], font, scale);
    for (const k of [0.35, 0.8]) {
      if (lay) break;
      // ما دخل: نوسّع المساحة شوي حول النص الأصلي بدل ما نصغّر الخط لدرجة ما ينقرا
      const [tx0, ty0, tx1, ty1] = a.tbox;
      const ex = (tx1 - tx0) * k, ey = (ty1 - ty0) * k;
      const big = { mode: 'rect', tbox: [Math.max(0, tx0 - ex), Math.max(0, ty0 - ey), Math.min(W, tx1 + ex), Math.min(H, ty1 + ey)] };
      lay = layout(ctx, text, rowsFor(big, W), W, a.tbox[3] - a.tbox[1], font, scale);
    }
    if (!lay) {
      // ما دخل حتى بأصغر خط: نصغّر أكثر ونكسر الكلمات
      const size = Math.max(7, W * 0.011);
      ctx.font = `${font.weight} ${size}px ${font.family}`;
      const cx = (a.tbox[0] + a.tbox[2]) / 2, cy = (rows.y0 + rows.y1) / 2;
      lay = { size, lines: [{ t: text, x: cx, y: cy }] };
    }
    ctx.font = `${font.weight} ${lay.size}px ${font.family}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.direction = rtl ? 'rtl' : 'ltr';
    if (outline) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(2, lay.size * 0.18);
      ctx.strokeStyle = '#000';
      lay.lines.forEach((l) => ctx.strokeText(l.t, l.x, l.y));
      ctx.fillStyle = '#fff';
    } else if (halo) {
      // نص بدون فقاعة: حدّ خفيف بلون الخلفية عشان يبان فوق التدرج
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(2, lay.size * 0.16);
      ctx.strokeStyle = col;
      lay.lines.forEach((l) => ctx.strokeText(l.t, l.x, l.y));
      ctx.fillStyle = textColor(col);
    } else ctx.fillStyle = textColor(col);
    lay.lines.forEach((l) => ctx.fillText(l.t, l.x, l.y));

    if (!wantPatches) continue;
    // قطعة للصفحة: منطقة الفقاعة فقط (الباقي شفاف عشان يبان إطار الفقاعة الأصلي)
    const [px0, py0, px1, py1] = (a.mode === 'mask' ? a.bbox : rectOf(a, W, H)).map(Math.round);
    const pw = Math.max(1, Math.min(W, px1) - Math.max(0, px0)), ph = Math.max(1, Math.min(H, py1) - Math.max(0, py0));
    const sx = Math.max(0, px0), sy = Math.max(0, py0);
    const part = ctx.getImageData(sx, sy, pw, ph);
    if (a.mode === 'mask') {
      for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
        if (!inMask(a, sx + x, sy + y)) part.data[(y * pw + x) * 4 + 3] = 0;
      }
    }
    const pc = new OffscreenCanvas(pw, ph);
    pc.getContext('2d').putImageData(part, 0, 0);
    patches.push({ x: sx / W, y: sy / H, w: pw / W, h: ph / H, url: await toDataUrl(await pc.convertToBlob({ type: 'image/png' })), text: g.texts.join(' ') });
  }
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.93 });
  return { bytes: new Uint8Array(await out.arrayBuffer()), patches };
}
