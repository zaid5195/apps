// ترجمة صور الفصل عبر Gemini + رسم الترجمة على الصورة
const API = 'https://generativelanguage.googleapis.com/v1beta';

export const LANGS = {
  ar: { name: 'العربية', prompt: 'Arabic (Modern Standard Arabic / الفصحى)', rtl: true },
  en: { name: 'English', prompt: 'English', rtl: false },
  fr: { name: 'Français', prompt: 'French', rtl: false },
  es: { name: 'Español', prompt: 'Spanish', rtl: false },
};

export class FatalError extends Error {}

async function apiFetch(path, key, body) {
  const res = await fetch(`${API}/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-goog-api-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    if (res.status === 429 || res.status >= 500) {
      const retry = data?.error?.details?.find((d) => d.retryDelay)?.retryDelay;
      const err = new Error(msg);
      err.retryMs = retry ? parseFloat(retry) * 1000 + 500 : 15000;
      throw err;
    }
    if (res.status === 400 && /api key/i.test(msg)) throw new FatalError('مفتاح Gemini غير صحيح');
    if (res.status === 401 || res.status === 403) throw new FatalError('مفتاح Gemini مرفوض: ' + msg);
    throw new Error(msg);
  }
  return data;
}

// نختار أحدث موديل «flash» متاح للمفتاح
export async function pickModel(key) {
  const data = await apiFetch('models?pageSize=200', key);
  const ok = (data.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
    .filter((n) => /^gemini-[\d.]+-flash/.test(n) && !/lite|image|tts|live|audio|thinking|8b|embedding|exp/.test(n));
  const ver = (n) => parseFloat(n.match(/^gemini-([\d.]+)/)[1]);
  const score = (n) => ver(n) * 10 - (/preview/.test(n) ? 5 : 0) - (/\d{2,}$|-\d{3}$/.test(n) ? 1 : 0);
  ok.sort((a, b) => score(b) - score(a));
  return ok[0] || 'gemini-2.5-flash';
}

const SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      box_2d: { type: 'ARRAY', items: { type: 'INTEGER' } },
      text: { type: 'STRING' },
      translation: { type: 'STRING' },
      bg: { type: 'STRING' },
    },
    required: ['box_2d', 'text', 'translation'],
  },
};

function prompt(lang, context) {
  return `You are a professional manhwa/manga/webtoon translator and letterer.
Find every speech bubble, thought bubble, narration box and story-relevant caption or sign in this comic image.
Ignore sound effects (SFX/onomatopoeia), watermarks, scanlation credits and website logos.
For each one return:
- box_2d: [ymin, xmin, ymax, xmax] normalized to 0-1000, covering the text area inside the bubble (the part that will be painted over).
- text: the original text.
- translation: a natural, fluent ${LANGS[lang]?.prompt || lang} translation that fits a comic bubble (short and conversational, keep character names consistent, keep emotion and punctuation like ! and ...).
- bg: the bubble background color as hex (e.g. #ffffff).
Return them in reading order. If there is no text, return [].` +
    (context?.length ? `\n\nPrevious lines of this chapter (for consistent names and tone):\n${context.join('\n')}` : '');
}

const toB64 = async (blob) => {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(s);
};

// الصور الطويلة (ويبتون) نقسمها لقطع مع تداخل عشان دقة المواقع
function chunks(w, h) {
  const maxH = Math.round(w * 2), overlap = Math.round(w * 0.35);
  if (h <= maxH * 1.2) return [{ y: 0, h, own: [0, h] }];
  const out = [];
  for (let y = 0; ; y += maxH - overlap) {
    const ch = Math.min(maxH, h - y);
    const first = y === 0, last = y + ch >= h;
    out.push({ y, h: ch, own: [first ? 0 : y + overlap / 2, last ? h : y + ch - overlap / 2] });
    if (last) break;
  }
  return out;
}

export async function translateImage(bytes, mime, { key, model, lang, context, signal }) {
  const bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
  const W = bmp.width, H = bmp.height;
  const scale = Math.min(1, 1600 / W);
  const boxes = [];
  try {
    for (const c of chunks(W, H)) {
      const cw = Math.round(W * scale), chh = Math.round(c.h * scale);
      const canvas = new OffscreenCanvas(cw, chh);
      canvas.getContext('2d').drawImage(bmp, 0, c.y, W, c.h, 0, 0, cw, chh);
      const data = await toB64(await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 }));
      const body = {
        contents: [{ parts: [{ inline_data: { mime_type: 'image/jpeg', data } }, { text: prompt(lang, context) }] }],
        generationConfig: { temperature: 0.3, responseMimeType: 'application/json', responseSchema: SCHEMA },
      };
      let res;
      for (let attempt = 0; ; attempt++) {
        if (signal?.aborted) throw new FatalError('توقفت الترجمة');
        try { res = await apiFetch(`models/${model}:generateContent`, key, body); break; }
        catch (e) {
          if (e instanceof FatalError || !e.retryMs || attempt >= 4) throw e;
          signal?.onWait?.(Math.round(e.retryMs / 1000));
          await new Promise((r) => setTimeout(r, e.retryMs));
        }
      }
      const cand = res.candidates?.[0];
      const txt = (cand?.content?.parts || []).map((p) => p.text || '').join('');
      let list = [];
      try { list = JSON.parse(txt.replace(/^```(json)?|```$/g, '').trim()); } catch { list = []; }
      for (const b of Array.isArray(list) ? list : []) {
        const [y0, x0, y1, x1] = (b.box_2d || []).map(Number);
        if (![y0, x0, y1, x1].every(Number.isFinite) || !b.translation?.trim()) continue;
        const top = c.y + (Math.min(y0, y1) / 1000) * c.h, bottom = c.y + (Math.max(y0, y1) / 1000) * c.h;
        const mid = (top + bottom) / 2;
        if (mid < c.own[0] || mid >= c.own[1]) continue; // مكررة في منطقة التداخل
        boxes.push({
          x: Math.min(x0, x1) / 1000, w: Math.abs(x1 - x0) / 1000,
          y: top / H, h: (bottom - top) / H,
          text: b.text || '', tr: b.translation.trim(), bg: /^#[0-9a-f]{3,8}$/i.test(b.bg || '') ? b.bg : '#ffffff',
        });
      }
    }
  } finally {
    bmp.close();
  }
  return boxes;
}

// ---------- الرسم ----------

export function textColor(bg) {
  let h = bg.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) || 0);
  return 0.299 * r + 0.587 * g + 0.114 * b > 140 ? '#111' : '#fff';
}

export const FONT = '"Noto Naskh Arabic", "Segoe UI", Tahoma, "Noto Sans", Arial, sans-serif';

// يلف النص على أسطر ويختار أكبر خط يدخل في المربع
export function fitText(measure, text, w, h, maxSize) {
  const words = text.split(/\s+/).filter(Boolean);
  for (let size = Math.floor(maxSize); size >= 7; size -= size > 24 ? 2 : 1) {
    const lh = size * 1.2;
    const lines = [];
    let line = '';
    let ok = true;
    for (const word of words) {
      const t = line ? line + ' ' + word : word;
      if (measure(t, size) <= w) { line = t; continue; }
      if (line) lines.push(line);
      if (measure(word, size) > w) { ok = false; break; }
      line = word;
    }
    if (!ok) continue;
    if (line) lines.push(line);
    if (lines.length * lh <= h) return { size, lines, lh };
  }
  // آخر حل: خط صغير ونكسر الكلمات
  const size = 7, lh = 8.4, lines = [];
  let line = '';
  for (const ch of text) { if (measure(line + ch, size) > w && line) { lines.push(line); line = ch; } else line += ch; }
  if (line) lines.push(line);
  return { size, lines, lh };
}

export function expand(b) {
  const px = b.w * 0.06, py = b.h * 0.08;
  const x = Math.max(0, b.x - px), y = Math.max(0, b.y - py);
  return { x, y, w: Math.min(1, b.x + b.w + px) - x, h: Math.min(1, b.y + b.h + py) - y };
}

export async function renderTranslated(bytes, mime, boxes, lang) {
  const bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
  const W = bmp.width, H = bmp.height;
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const rtl = LANGS[lang]?.rtl ?? true;
  const measure = (t, s) => { ctx.font = `600 ${s}px ${FONT}`; return ctx.measureText(t).width; };
  for (const b of boxes) {
    const e = expand(b);
    const x = e.x * W, y = e.y * H, w = e.w * W, h = e.h * H;
    const r = Math.min(w, h) * 0.25;
    ctx.fillStyle = b.bg;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fill();
    const pad = Math.min(w, h) * 0.08;
    const fit = fitText(measure, b.tr, w - pad * 2, h - pad * 2, Math.min(h * 0.45, W * 0.06));
    ctx.font = `600 ${fit.size}px ${FONT}`;
    ctx.fillStyle = textColor(b.bg);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.direction = rtl ? 'rtl' : 'ltr';
    const top = y + h / 2 - (fit.lines.length * fit.lh) / 2 + fit.lh / 2;
    fit.lines.forEach((ln, i) => ctx.fillText(ln, x + w / 2, top + i * fit.lh));
  }
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.93 });
  return new Uint8Array(await blob.arrayBuffer());
}
