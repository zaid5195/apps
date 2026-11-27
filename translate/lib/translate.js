// الترجمة عبر Gemini: عدة صفحات في طلب واحد + قاموس أسماء + تعامل ذكي مع حدود الحصة المجانية
const API = 'https://generativelanguage.googleapis.com/v1beta';

export const LANGS = {
  ar: { name: 'العربية', prompt: 'Modern Standard Arabic (الفصحى) — simple, natural and smooth, like professional Arabic manhwa scanlations', rtl: true },
  en: { name: 'English', prompt: 'English', rtl: false },
  fr: { name: 'Français', prompt: 'French', rtl: false },
  es: { name: 'Español', prompt: 'Spanish', rtl: false },
};

export class FatalError extends Error {}   // مفتاح غلط… نوقف كل شي
export class QuotaError extends Error {}   // الحصة اليومية خلصت لكل الموديلات
export class StopError extends Error {}    // المستخدم وقّف

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// زر الإيقاف يوقف فوراً بدون ما ينتظر رد الطلب الحالي
function untilStop(promise, signal) {
  if (!signal) return promise;
  return new Promise((ok, bad) => {
    const t = setInterval(() => { if (signal.aborted) { clearInterval(t); bad(new StopError('توقفت')); } }, 250);
    promise.then((v) => { clearInterval(t); ok(v); }, (e) => { clearInterval(t); bad(e); });
  });
}
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
// حصة Gemini تتجدد منتصف الليل بتوقيت المحيط الهادئ
export const quotaDay = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

export function usageToday(provider = 'gemini') {
  const u = ls.get(provider === 'gemini' ? 'mt-usage' : `mt-usage-${provider}`, null);
  return u?.day === quotaDay() ? u.n : 0;
}
function countUsage(provider = 'gemini') {
  ls.set(provider === 'gemini' ? 'mt-usage' : `mt-usage-${provider}`, { day: quotaDay(), n: usageToday(provider) + 1 });
}

function exhausted() {
  const e = ls.get('mt-exhausted', null);
  return e?.day === quotaDay() ? e.models : [];
}
function markExhausted(m) { ls.set('mt-exhausted', { day: quotaDay(), models: [...new Set([...exhausted(), m])] }); }

// قائمة موديلات بالترتيب: الأحدث المستقر أولاً، بعده التجريبي، وآخر شي «lite»
export async function pickModels(key) {
  const res = await fetch(`${API}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    if (res.status === 400 || res.status === 401 || res.status === 403) throw new FatalError('مفتاح Gemini غير صحيح أو مرفوض — تأكد إنك نسخته كامل');
    throw new Error(msg);
  }
  const names = (data.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
    .filter((n) => /^gemini-[\d.]+-flash/.test(n) && !/image|tts|live|audio|thinking|8b|embedding|exp/.test(n));
  const ver = (n) => parseFloat(n.match(/^gemini-([\d.]+)/)[1]);
  const score = (n) => ver(n) * 10 - (/preview/.test(n) ? 12 : 0) - (/lite/.test(n) ? 20 : 0) - (/-\d{3}$|\d{2}-\d{2}/.test(n) ? 1 : 0);
  names.sort((a, b) => score(b) - score(a));
  const list = [...new Set(names)];
  for (const f of ['gemini-2.5-flash', 'gemini-2.5-flash-lite']) if (!list.includes(f)) list.push(f);
  return list.slice(0, 6);
}

// هل الرفض بسبب الحصة اليومية ولا حد الدقيقة؟
function quotaInfo(data) {
  const details = data?.error?.details || [];
  const retry = details.find((d) => d.retryDelay)?.retryDelay;
  const viol = details.flatMap((d) => d.violations || []);
  const msg = data?.error?.message || '';
  const daily = viol.some((v) => /PerDay/i.test(v.quotaId || '') || /per.?day/i.test(v.quotaMetric || '')) ||
    /per.?day|limit: 0\b/i.test(msg);
  return { daily, retryMs: retry ? parseFloat(retry) * 1000 + 800 : 30000 };
}

export class Gemini {
  name = 'Gemini';
  id = 'gemini';
  maxImages = 8;
  constructor(key, { preferred, onEvent } = {}) {
    this.key = key;
    this.preferred = preferred;
    this.onEvent = onEvent || (() => {});
    this.list = null;
    this.i = 0;
    this.cool = 0;     // انتظار مشترك لكل الطلبات (حد الدقيقة)
    this.active = 0;
    this.limit = 2;    // طلبين في نفس الوقت، ينزل لواحد لو وصلنا الحد
  }

  async init() {
    if (this.list) return;
    let cached = ls.get('mt-models', null);
    let list = cached?.k === this.key.slice(-6) && Date.now() - cached.t < 86400000 ? cached.list : null;
    if (!list) {
      try { list = await pickModels(this.key); } catch (e) { if (e instanceof FatalError) throw e; list = ['gemini-2.5-flash', 'gemini-2.5-flash-lite']; }
      ls.set('mt-models', { k: this.key.slice(-6), t: Date.now(), list });
    }
    this.all = list;
    if (this.preferred) list = [this.preferred, ...list.filter((m) => m !== this.preferred)];
    const ex = exhausted();
    this.list = list.filter((m) => !ex.includes(m));
    if (!this.list.length) throw new QuotaError('الحصة اليومية المجانية خلصت لكل موديلات Gemini');
    this.i = 0;
    this.onEvent({ type: 'model', model: this.model });
  }

  get model() { return this.list[this.i]; }

  drop(model, why) {
    const k = this.list.indexOf(model);
    if (k < 0) return;
    this.list.splice(k, 1);
    if (why === 'daily') markExhausted(model);
    if (!this.list.length) throw new QuotaError('الحصة اليومية المجانية خلصت لكل موديلات Gemini');
    if (this.i >= this.list.length) this.i = 0;
    this.onEvent({ type: 'model', model: this.model, why });
  }

  async request(body, signal) {
    await this.init();
    let net = 0, busy = 0, minute = 0;
    for (;;) {
      if (signal?.aborted) throw new StopError('توقفت');
      while (Date.now() < this.cool) {
        if (signal?.aborted) throw new StopError('توقفت');
        this.onEvent({ type: 'wait', seconds: Math.ceil((this.cool - Date.now()) / 1000), why: 'minute' });
        await sleep(Math.min(1000, this.cool - Date.now()));
      }
      while (this.active >= this.limit) await sleep(150);
      const model = this.model;
      this.active++;
      let res, data;
      try {
        [res, data] = await untilStop((async () => {
          const r = await fetch(`${API}/models/${model}:generateContent`, {
            method: 'POST',
            headers: { 'x-goog-api-key': this.key, 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          return [r, await r.json().catch(() => null)];
        })(), signal);
      } catch (e) {
        this.active--;
        if (e instanceof StopError) throw e;
        if (++net > 5) throw new Error('الاتصال بـ Gemini ينقطع — تأكد من الإنترنت');
        this.onEvent({ type: 'wait', seconds: 2 * net, why: 'network' });
        await sleep(2000 * net);
        continue;
      }
      this.active--;
      if (res.ok) { countUsage('gemini'); this.onEvent({ type: 'usage' }); return data; }

      const msg = data?.error?.message || `HTTP ${res.status}`;
      if (res.status === 429) {
        const q = quotaInfo(data);
        if (q.daily) { this.drop(model, 'daily'); continue; }
        // حد الدقيقة: ننتظر كلنا مع بعض ونخفف السرعة
        this.limit = 1;
        if (++minute > 12) throw new Error('Gemini يرفض الطلبات من فترة — جرّب بعد شوي');
        this.cool = Math.max(this.cool, Date.now() + Math.min(q.retryMs, 90000));
        continue;
      }
      if (res.status >= 500) {
        // الموديل مزحوم: نجرّب موديل ثاني
        if (++busy > 10) throw new Error('Gemini مزحوم جداً الحين — جرّب بعد شوي');
        if (busy % 2 === 0 && this.list.length > 1) {
          this.i = (this.i + 1) % this.list.length;
          this.onEvent({ type: 'model', model: this.model, why: 'busy' });
        }
        this.onEvent({ type: 'wait', seconds: 4, why: 'busy' });
        await sleep(4000);
        continue;
      }
      if (res.status === 404 || /not found|not supported|is not available/i.test(msg)) { this.drop(model, 'missing'); continue; }
      if ((res.status === 400 && /api key/i.test(msg)) || res.status === 401 || res.status === 403) {
        throw new FatalError('مفتاح Gemini غير صحيح أو مرفوض — تأكد إنك نسخته كامل');
      }
      throw new Error(msg);
    }
  }

  // طلب موحّد: { system, parts: [{text} | {image: base64}] } ← يرجع نص JSON
  async generate(req, signal) {
    const parts = req.parts.map((p) => (p.image ? { inline_data: { mime_type: 'image/jpeg', data: p.image } } : { text: p.text }));
    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0.3, responseMimeType: 'application/json', responseSchema: SCHEMA },
    };
    const res = await this.request(body, signal);
    const cand = res?.candidates?.[0];
    if (!cand?.content) {
      const why = cand?.finishReason || res?.promptFeedback?.blockReason || 'empty';
      throw new Error(`Gemini ما رجّع نتيجة (${why})`);
    }
    return (cand.content.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
  }
}

// ---------- Groq (Llama 4 وغيره من موديلات الصور) ----------
const GROQ = 'https://api.groq.com/openai/v1';
const GROQ_DEFAULTS = ['meta-llama/llama-4-maverick-17b-128e-instruct', 'meta-llama/llama-4-scout-17b-16e-instruct'];

export async function pickGroqModels(key) {
  const res = await fetch(`${GROQ}/models`, { headers: { authorization: `Bearer ${key}` } });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) throw new FatalError('مفتاح Groq غير صحيح أو مرفوض — تأكد إنك نسخته كامل (يبدأ بـ gsk_)');
  if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
  // الموديلات اللي تفهم الصور
  const ids = (data.data || []).filter((m) => m.active !== false).map((m) => m.id)
    .filter((id) => /llama-4|vision|scout|maverick|-vl|gemma-3|kimi.*vl/i.test(id) && !/guard|whisper|tts|prompt/i.test(id));
  const score = (id) => (/maverick/i.test(id) ? 30 : 0) + (/llama-4/i.test(id) ? 20 : 0) + (/scout/i.test(id) ? 10 : 0) - (/preview/i.test(id) ? 1 : 0);
  ids.sort((a, b) => score(b) - score(a));
  const list = [...new Set(ids)];
  for (const f of GROQ_DEFAULTS) if (!list.includes(f) && !ids.length) list.push(f);
  return list.slice(0, 5);
}

// «حاول بعد 7.5s» / «try again in 1m20s»
function groqWait(msg) {
  const m = String(msg).match(/try again in\s+((?:[\d.]+(?:ms|s|m|h))+)/i);
  if (!m) return 20000;
  let ms = 0;
  for (const [, v, u] of m[1].matchAll(/([\d.]+)(ms|s|m|h)/g)) ms += parseFloat(v) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[u];
  return ms + 800;
}

export class Groq {
  name = 'Groq';
  id = 'groq';
  maxImages = 5; // حد Groq للصور في الطلب الواحد
  constructor(key, { preferred, onEvent } = {}) {
    this.key = key;
    this.preferred = preferred;
    this.onEvent = onEvent || (() => {});
    this.list = null;
    this.i = 0;
    this.cool = 0;
    this.active = 0;
    this.limit = 2;
    this.jsonMode = true;
  }

  async init() {
    if (this.list) return;
    const cached = ls.get('mt-groq-models', null);
    let list = cached?.k === this.key.slice(-6) && Date.now() - cached.t < 86400000 ? cached.list : null;
    if (!list) {
      try { list = await pickGroqModels(this.key); } catch (e) { if (e instanceof FatalError) throw e; list = GROQ_DEFAULTS; }
      if (!list.length) list = GROQ_DEFAULTS;
      ls.set('mt-groq-models', { k: this.key.slice(-6), t: Date.now(), list });
    }
    if (this.preferred) list = [this.preferred, ...list.filter((m) => m !== this.preferred)];
    const ex = exhausted();
    this.list = list.filter((m) => !ex.includes(m));
    if (!this.list.length) throw new QuotaError('الحصة اليومية المجانية خلصت لكل موديلات Groq');
    this.i = 0;
    this.onEvent({ type: 'model', model: this.model, provider: this.name });
  }

  get model() { return this.list[this.i]; }

  drop(model, why) {
    const k = this.list.indexOf(model);
    if (k < 0) return;
    this.list.splice(k, 1);
    if (why === 'daily') markExhausted(model);
    if (!this.list.length) throw new QuotaError('الحصة اليومية المجانية خلصت لكل موديلات Groq');
    if (this.i >= this.list.length) this.i = 0;
    this.onEvent({ type: 'model', model: this.model, why, provider: this.name });
  }

  async generate(req, signal) {
    await this.init();
    // التعليمات مع الصور في رسالة المستخدم (أضمن مع موديلات الصور)
    const content = [{ type: 'text', text: req.system + '\n\n' + JSON_SPEC }];
    for (const p of req.parts) {
      if (p.image) content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${p.image}` } });
      else content.push({ type: 'text', text: p.text });
    }
    let net = 0, busy = 0, minute = 0;
    for (;;) {
      if (signal?.aborted) throw new StopError('توقفت');
      while (Date.now() < this.cool) {
        if (signal?.aborted) throw new StopError('توقفت');
        this.onEvent({ type: 'wait', seconds: Math.ceil((this.cool - Date.now()) / 1000), why: 'minute' });
        await sleep(Math.min(1000, this.cool - Date.now()));
      }
      while (this.active >= this.limit) await sleep(150);
      const model = this.model;
      const body = {
        model, temperature: 0.3, max_completion_tokens: 8192,
        messages: [{ role: 'user', content }],
        ...(this.jsonMode ? { response_format: { type: 'json_object' } } : {}),
      };
      this.active++;
      let res, data;
      try {
        [res, data] = await untilStop((async () => {
          const r = await fetch(`${GROQ}/chat/completions`, {
            method: 'POST',
            headers: { authorization: `Bearer ${this.key}`, 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          return [r, await r.json().catch(() => null)];
        })(), signal);
      } catch (e) {
        this.active--;
        if (e instanceof StopError) throw e;
        if (++net > 5) throw new Error('الاتصال بـ Groq ينقطع — تأكد من الإنترنت');
        this.onEvent({ type: 'wait', seconds: 2 * net, why: 'network' });
        await sleep(2000 * net);
        continue;
      }
      this.active--;
      if (res.ok) {
        countUsage('groq');
        this.onEvent({ type: 'usage' });
        const txt = data?.choices?.[0]?.message?.content;
        if (!txt) throw new Error('Groq ما رجّع نتيجة');
        return txt;
      }
      const msg = data?.error?.message || `HTTP ${res.status}`;
      const code = data?.error?.code || '';
      if (res.status === 401 || res.status === 403) throw new FatalError('مفتاح Groq غير صحيح أو مرفوض — تأكد إنك نسخته كامل (يبدأ بـ gsk_)');
      if (res.status === 429) {
        if (/per day|\(RPD\)|\(TPD\)|daily/i.test(msg)) { this.drop(model, 'daily'); continue; }
        this.limit = 1;
        if (++minute > 12) throw new Error('Groq يرفض الطلبات من فترة — جرّب بعد شوي');
        this.cool = Math.max(this.cool, Date.now() + Math.min(groqWait(msg), 90000));
        continue;
      }
      if (res.status >= 500) {
        if (++busy > 10) throw new Error('Groq مزحوم جداً الحين — جرّب بعد شوي');
        if (busy % 2 === 0 && this.list.length > 1) {
          this.i = (this.i + 1) % this.list.length;
          this.onEvent({ type: 'model', model: this.model, why: 'busy', provider: this.name });
        }
        this.onEvent({ type: 'wait', seconds: 4, why: 'busy' });
        await sleep(4000);
        continue;
      }
      if (res.status === 404 || code === 'model_not_found' || /does not exist|decommissioned|not supported/i.test(msg)) { this.drop(model, 'missing'); continue; }
      // بعض الموديلات ما تقبل وضع JSON مع الصور: نعيد بدونه
      if (res.status === 400 && this.jsonMode && (/response_format|json/i.test(msg) || code === 'json_validate_failed')) {
        if (code === 'json_validate_failed' && data?.error?.failed_generation) return data.error.failed_generation;
        this.jsonMode = false;
        continue;
      }
      if (res.status === 413) throw new Error('الطلب كبير على Groq');
      throw new Error(msg);
    }
  }
}

// يجرّب المزوّد الأول، ولو خلصت حصته اليومية ينتقل للثاني ويكمل
export class Providers {
  constructor(clients, onEvent) { this.clients = clients; this.i = 0; this.onEvent = onEvent || (() => {}); }
  get cur() { return this.clients[this.i]; }
  get maxImages() { return this.cur.maxImages; }
  async init() {
    for (;;) {
      try { await this.cur.init(); return; } catch (e) {
        if (e instanceof QuotaError && this.i < this.clients.length - 1) { this.i++; this.onEvent({ type: 'provider', provider: this.cur.name }); continue; }
        throw e;
      }
    }
  }
  async generate(req, signal) {
    for (;;) {
      try { return await this.cur.generate(req, signal); } catch (e) {
        if (e instanceof QuotaError && this.i < this.clients.length - 1) {
          this.i++;
          this.onEvent({ type: 'provider', provider: this.cur.name });
          await this.cur.init();
          continue;
        }
        throw e;
      }
    }
  }
}

const JSON_SPEC = `Return ONLY a JSON object exactly in this shape (no markdown):
{"pages":[{"image":1,"bubbles":[{"box_2d":[ymin,xmin,ymax,xmax],"text":"original text","translation":"translated text","bg":"#ffffff"}]}],"names":[{"original":"Name","translation":"الاسم"}]}
box_2d values are integers normalized 0-1000 relative to that image (0,0 = top-left).`;

// ---------- تجهيز الصور ----------

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

// أجزاء الصفحة (بدون ترميز) — نرمّزها وقت الإرسال بس
export async function pageParts(data, mime) {
  const bmp = await createImageBitmap(new Blob([data], { type: mime }));
  const W = bmp.width, H = bmp.height;
  bmp.close();
  return chunks(W, H).map((c) => ({ ...c, W, H }));
}

async function encodePart(data, mime, part) {
  const bmp = await createImageBitmap(new Blob([data], { type: mime }));
  const scale = Math.min(1, 1280 / part.W);
  const cw = Math.round(part.W * scale), ch = Math.round(part.h * scale);
  const canvas = new OffscreenCanvas(cw, ch);
  canvas.getContext('2d').drawImage(bmp, 0, part.y, part.W, part.h, 0, 0, cw, ch);
  bmp.close();
  return { b64: await toB64(await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.88 })), w: cw, h: ch };
}

// ---------- الطلب ----------

const BUBBLE = {
  type: 'OBJECT',
  properties: {
    box_2d: { type: 'ARRAY', items: { type: 'INTEGER' } },
    text: { type: 'STRING' },
    translation: { type: 'STRING' },
    bg: { type: 'STRING' },
  },
  required: ['box_2d', 'text', 'translation'],
};
const SCHEMA = {
  type: 'OBJECT',
  properties: {
    pages: {
      type: 'ARRAY',
      items: { type: 'OBJECT', properties: { image: { type: 'INTEGER' }, bubbles: { type: 'ARRAY', items: BUBBLE } }, required: ['image', 'bubbles'] },
    },
    names: {
      type: 'ARRAY',
      items: { type: 'OBJECT', properties: { original: { type: 'STRING' }, translation: { type: 'STRING' } }, required: ['original', 'translation'] },
    },
  },
  required: ['pages'],
};

function systemPrompt({ lang, glossary, notes, noPunct }) {
  const L = LANGS[lang]?.prompt || lang;
  const g = (glossary || []).filter((e) => e.o && e.t).slice(0, 200);
  return `You are an expert manhwa / manga / webtoon translator and letterer. Translate into ${L}.
You receive consecutive images of the same chapter, labeled "Image 1", "Image 2", ... in reading order (top to bottom).

For EACH image, find every speech bubble, thought bubble, narration box and story-relevant caption or sign.
Ignore sound effects (SFX / onomatopoeia), watermarks, scanlation credits, website logos and ads.

Rules:
- One entry per bubble: join all lines of the same bubble into one text.
- box_2d = [ymin, xmin, ymax, xmax], normalized 0-1000 relative to THAT image only, tightly around the text inside the bubble.
- translation: natural and fluent, short enough to fit the bubble, keep the emotion and tone of each character. Translate meaning, not word by word.
- Keep "!" and "?" when they carry emotion.${noPunct ? '\n- Do NOT use periods, ellipses or commas in translations (no "." "..." "…" "," "،"). Use line breaks of meaning instead.' : ''}
- Proper nouns (characters, places, organizations, skills, items, ranks): transliterate them consistently. ${g.length ? 'Use the glossary below EXACTLY.' : ''}
- In "names", list every proper noun that appears in these images with the translation you used (including ones already in the glossary).
- bg = the background color of the bubble as hex (e.g. #ffffff).
- Return one entry in "pages" for EVERY image (use "bubbles": [] only when it truly has no text). Look at each image separately and carefully — do not skip any bubble.` +
    (g.length ? `\n\nGlossary (original → translation):\n${g.map((e) => `${e.o} → ${e.t}`).join('\n')}` : '') +
    (notes?.trim() ? `\n\nNotes from the reader about this series (follow them):\n${notes.trim()}` : '');
}

// items: [{ data, mime, part }]  ← أجزاء متتالية (من صفحة وحدة أو أكثر)
// يرجع: { results: [boxes[] | null لكل جزء], names: [...] }
export async function translateBatch(client, items, { lang, glossary, notes, noPunct, context, signal }) {
  const parts = [];
  if (context?.length) parts.push({ text: `Previous lines of this chapter (for context and consistent names):\n${context.join('\n')}` });
  const dims = [];
  for (let i = 0; i < items.length; i++) {
    const enc = await encodePart(items[i].data, items[i].mime, items[i].part);
    dims.push(enc);
    parts.push({ text: `Image ${i + 1}:` });
    parts.push({ image: enc.b64 });
  }
  parts.push({ text: `Translate all ${items.length} image(s). Return JSON.` });
  const txt = await client.generate({ system: systemPrompt({ lang, glossary, notes, noPunct }), parts }, signal);
  let obj;
  try {
    const clean = txt.replace(/^\s*```(json)?|```\s*$/g, '').trim();
    obj = JSON.parse(clean.slice(clean.indexOf('{'), clean.lastIndexOf('}') + 1));
  } catch { throw new Error('رد الموديل ناقص أو مو JSON'); }
  const results = items.map(() => null);
  const pages = Array.isArray(obj?.pages) ? obj.pages : [];
  pages.forEach((p, k) => {
    const idx = Number.isInteger(p.image) && p.image >= 1 && p.image <= items.length ? p.image - 1 : k;
    if (idx >= items.length) return;
    const { part } = items[idx];
    const boxes = results[idx] || [];
    const list = Array.isArray(p.bubbles) ? p.bubbles : [];
    // بعض الموديلات ترجع بكسلات بدل 0-1000: لو أي رقم في الصورة فوق 1000 فكلها بكسلات
    const pixels = list.some((b) => (b.box_2d || []).some((v) => Number(v) > 1000));
    for (const b of list) {
      let [y0, x0, y1, x1] = (b.box_2d || []).map(Number);
      if (![y0, x0, y1, x1].every(Number.isFinite) || !b.translation?.trim()) continue;
      // بعض الموديلات ترجع بكسلات بدل 0-1000
      if (pixels) {
        const { w, h } = dims[idx];
        [y0, y1] = [y0, y1].map((v) => (v / h) * 1000);
        [x0, x1] = [x0, x1].map((v) => (v / w) * 1000);
      }
      [y0, y1, x0, x1] = [y0, y1, x0, x1].map((v) => Math.max(0, Math.min(1000, v)));
      const top = part.y + (Math.min(y0, y1) / 1000) * part.h, bottom = part.y + (Math.max(y0, y1) / 1000) * part.h;
      const mid = (top + bottom) / 2;
      if (mid < part.own[0] || mid >= part.own[1]) continue; // مكررة في منطقة التداخل
      boxes.push({
        x: Math.max(0, Math.min(x0, x1) / 1000), w: Math.min(1, Math.abs(x1 - x0) / 1000),
        y: top / part.H, h: (bottom - top) / part.H,
        text: (b.text || '').trim(), tr: b.translation.trim(),
        bg: /^#[0-9a-f]{3,8}$/i.test(b.bg || '') ? b.bg : '#ffffff',
      });
    }
    results[idx] = boxes;
  });
  const names = (Array.isArray(obj?.names) ? obj.names : [])
    .map((n) => ({ o: String(n.original || '').trim(), t: String(n.translation || '').trim() }))
    .filter((n) => n.o && n.t && n.o.length < 60 && n.t.length < 60);
  return { results, names };
}

// حذف النقاط والفواصل (مع الإبقاء على ! و ؟)
export function cleanPunct(s, lang) {
  let t = String(s)
    .replace(/\s*(\.{2,}|…)\s*/g, ' ')
    .replace(/(\D)[.,،](?!\d)/g, '$1 ')
    .replace(/^[.,،]+/, '')
    .replace(/\s+([!?؟])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (lang === 'ar') t = t.replace(/\?/g, '؟');
  return t;
}
