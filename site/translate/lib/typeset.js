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
  const res = { tbox: [tx0, ty0, tx1, ty1], color, mode: 'rect', busy: frac < 0.55 };
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
  return Object.assign(res, { mode: 'mask', F, M, rx0, ry0, rw, rh, bbox: [rx0 + mx0, ry0 + my0, rx0 + mx1 + 1, ry0 + my1 + 1] });
}

const inMask = (a, x, y) => a.mode === 'mask' && x >= a.rx0 && y >= a.ry0 && x < a.rx0 + a.rw && y < a.ry0 + a.rh && a.M[(y - a.ry0) * a.rw + (x - a.rx0)];

// نمسح الحروف: الثقوب داخل الفقاعة + حافتين بكسل حولها
function erase(d, W, a) {
  const { F, M, rw, rh, rx0, ry0 } = a;
  let E = new Uint8Array(rw * rh);
  for (let p = 0; p < E.length; p++) E[p] = M[p] && !F[p] ? 1 : 0;
  for (let it = 0; it < 2; it++) {
    const N = E.slice();
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
      const p = y * rw + x;
      if (E[p] || !M[p]) continue;
      if ((x > 0 && E[p - 1]) || (x < rw - 1 && E[p + 1]) || (y > 0 && E[p - rw]) || (y < rh - 1 && E[p + rw])) N[p] = 1;
    }
    E = N;
  }
  // منطقة النص نفسها نمسحها كاملة بلون الفقاعة (تشيل بقايا الضغط حول الحروف)
  const [tx0, ty0, tx1, ty1] = a.tbox;
  const px = (tx1 - tx0) * 0.12 + 3, py = (ty1 - ty0) * 0.12 + 3;
  const inT = (x, y) => x >= tx0 - px - rx0 && x < tx1 + px - rx0 && y >= ty0 - py - ry0 && y < ty1 + py - ry0;
  const [r, g, b] = a.color;
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
    if (!E[y * rw + x] && !(M[y * rw + x] && inT(x, y))) continue;
    const i = ((ry0 + y) * W + rx0 + x) * 4;
    d[i] = r; d[i + 1] = g; d[i + 2] = b;
  }
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
  const [tx0, ty0, tx1, ty1] = a.tbox;
  const px = (tx1 - tx0) * 0.08, py = (ty1 - ty0) * 0.1;
  x0 = Math.max(0, tx0 - px); x1 = Math.min(W, tx1 + px); y0 = ty0 - py; y1 = ty1 + py;
  a.rect = [x0, y0, x1, y1];
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
  for (const g of groups) if (g.a.mode === 'mask') erase(d, W, g.a);
  ctx.putImageData(img, 0, 0);

  // 3) نكتب الترجمة
  const patches = [];
  for (const g of groups) {
    const a = g.a;
    const rows = rowsFor(a, W);
    const col = hex(a.color);
    let outline = false;
    if (a.mode === 'rect') {
      const [x0, y0, x1, y1] = a.rect;
      const rr = Math.min(x1 - x0, y1 - y0) * 0.3;
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x0, y0, x1 - x0, y1 - y0, rr);
      if (a.busy) {
        // نص على الرسم: نطمس النص الأصلي بدل ما نغطيه بلون
        ctx.clip();
        const snap = new OffscreenCanvas(W, H);
        snap.getContext('2d').drawImage(canvas, 0, 0);
        ctx.filter = `blur(${Math.max(4, Math.round(Math.min(x1 - x0, y1 - y0) * 0.18))}px)`;
        for (let k = 0; k < 2; k++) ctx.drawImage(snap, 0, 0);
        ctx.filter = 'none';
        outline = true;
      } else {
        ctx.fillStyle = col;
        ctx.fill();
      }
      ctx.restore();
    }
    const text = g.texts.join(' ');
    let lay = layout(ctx, text, rows, W, a.tbox[3] - a.tbox[1], font, scale);
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
    } else ctx.fillStyle = textColor(col);
    lay.lines.forEach((l) => ctx.fillText(l.t, l.x, l.y));

    if (!wantPatches) continue;
    // قطعة للصفحة: منطقة الفقاعة فقط (الباقي شفاف عشان يبان إطار الفقاعة الأصلي)
    const [px0, py0, px1, py1] = (a.mode === 'mask' ? a.bbox : a.rect).map(Math.round);
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
