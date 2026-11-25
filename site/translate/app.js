import { LANGS, FatalError, QuotaError, StopError, Gemini, pageParts, translateBatch, cleanPunct, usageToday } from './lib/translate.js';
import { typesetImage } from './lib/typeset.js';
import { makeZip } from './lib/zip.js';
import { makePdf } from './lib/pdf.js';
import { unzipImages, isImageName } from './lib/unzip.js';
import { dbGet, dbPut, dbDel, hashBytes } from './lib/db.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- التخزين ----------
const raw = {
  get(k, d = '') { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
const json = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const FONTS = {
  naskh: { label: 'نسخ — واضح ومريح', family: '"Noto Naskh Arabic"', weight: 700 },
  cairo: { label: 'Cairo — عصري', family: 'Cairo', weight: 700 },
  tajawal: { label: 'Tajawal — عريض', family: 'Tajawal', weight: 800 },
  lalezar: { label: 'Lalezar — كوميكس', family: 'Lalezar', weight: 400 },
  changa: { label: 'Changa — هندسي', family: 'Changa', weight: 600 },
};
const settings = Object.assign({ font: 'naskh', scale: 100, noPunct: true, autoNames: true, model: '', batch: 2 }, json.get('mt-settings', {}));
const BATCH = () => settings.batch || 2; // كم صفحة في الطلب الواحد
const saveSettings = () => json.set('mt-settings', settings);

const state = { pages: [], name: 'chapter', busy: false, stop: null, ctx: [], halt: null };
const lang = () => $('lang').value;
const fontSpec = () => {
  const f = FONTS[settings.font] || FONTS.naskh;
  return { family: `${f.family}, "Noto Naskh Arabic", Tahoma, Arial, sans-serif`, weight: f.weight };
};

// ---------- واجهة عامة ----------
const status = (msg, cls = '') => { $('status').textContent = msg; $('status').className = 'status ' + cls; };
const progress = (d, t) => { $('bar').style.width = t ? `${Math.round((d / t) * 100)}%` : '0'; };
const showUsage = () => { const n = usageToday(); $('usage').textContent = n ? `طلبات اليوم: ${n}` : ''; };
const log = (lines) => {
  if (!lines.length) { $('logBox').classList.add('hide'); return; }
  $('log').textContent = lines.join('\n');
  $('logBox').classList.remove('hide');
};
const sniff = (b) => {
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return 'image/webp';
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'image/avif';
  return 'image/jpeg';
};

// ---------- الإعداد ----------
for (const [code, l] of Object.entries(LANGS)) $('lang').add(new Option(l.name, code));
$('lang').value = raw.get('mt-lang', 'ar');
$('key').value = raw.get('mt-key', '');
$('keyHelp').open = !$('key').value;
$('key').addEventListener('change', () => raw.set('mt-key', $('key').value.trim()));
function fillModels() {
  const list = json.get('mt-models', null)?.list || [];
  const sel = $('model');
  while (sel.options.length > 1) sel.remove(1);
  list.forEach((m) => sel.add(new Option(m, m)));
  if (settings.model && !list.includes(settings.model)) sel.add(new Option(settings.model, settings.model));
  sel.value = settings.model || '';
}
fillModels();
$('model').addEventListener('change', () => { settings.model = $('model').value; saveSettings(); });
$('batch').value = String(settings.batch);
$('batch').addEventListener('change', () => { settings.batch = +$('batch').value; saveSettings(); });
$('lang').addEventListener('change', async () => {
  raw.set('mt-lang', lang());
  // لغة ثانية = ترجمة ثانية (نشوف إذا محفوظة)
  for (const p of state.pages) { p.tr = null; p.out = null; p.status = 'wait'; }
  state.ctx = [];
  await loadCached(state.pages);
  renderAll();
  rerenderAll();
});
showUsage();

// ---------- شكل الكتابة ----------
for (const [k, f] of Object.entries(FONTS)) $('font').add(new Option(f.label, k));
$('font').value = settings.font;
$('scale').value = settings.scale;
$('noPunct').checked = settings.noPunct;
$('autoNames').checked = settings.autoNames;
function styleNote() {
  $('scaleVal').textContent = settings.scale + '%';
  $('styleNote').textContent = `${FONTS[settings.font]?.label.split(' —')[0]} · ${settings.scale}%${settings.noPunct ? ' · بدون نقاط وفواصل' : ''}`;
  const f = fontSpec();
  $('fontPreview').style.font = `${f.weight} 22px ${f.family}`;
  $('fontPreview').textContent = settings.noPunct ? cleanPunct('لا أصدق... أنك عدت، أخيراً!', 'ar') : 'لا أصدق... أنك عدت، أخيراً!';
}
styleNote();
let rerenderTimer = 0;
const styleChanged = () => { saveSettings(); styleNote(); clearTimeout(rerenderTimer); rerenderTimer = setTimeout(rerenderAll, 500); };
$('font').addEventListener('change', () => { settings.font = $('font').value; styleChanged(); });
$('scale').addEventListener('input', () => { settings.scale = +$('scale').value; styleChanged(); });
$('noPunct').addEventListener('change', async () => {
  settings.noPunct = $('noPunct').checked;
  if (settings.noPunct) {
    // ننظّف الترجمات الموجودة
    for (const p of state.pages) {
      if (!p.tr?.length) continue;
      p.tr.forEach((b) => (b.tr = cleanPunct(b.tr, lang())));
      p.tr = p.tr.filter((b) => /[\p{L}\p{N}]/u.test(b.tr));
      saveTr(p);
    }
  }
  styleChanged();
});
$('autoNames').addEventListener('change', () => { settings.autoNames = $('autoNames').checked; saveSettings(); });

// ---------- السلسلة وقاموس الأسماء ----------
const allSeries = () => json.get('mt-series', {});
let series = raw.get('mt-current-series', '');
function seriesData() {
  const all = allSeries();
  return all[series] || { names: [], notes: '' };
}
function saveSeries(d) {
  if (!series) return;
  const all = allSeries();
  all[series] = { ...d, t: Date.now() };
  json.set('mt-series', all);
}
function guessSeries(name) {
  return String(name || '')
    .replace(/\.(zip|cbz)$/i, '')
    .replace(/\((العربية|English|Français|Español|مترجم)\)/g, '')
    .replace(/\b(episode|ep|chapter|ch|chap|vol|volume)\.?\s*\d+(\.\d+)?/gi, '')
    .replace(/(الفصل|فصل|الحلقة|حلقة)\s*\d+/g, '')
    .replace(/\bwebtoons?\b|\bread\b|\bmanhwa\b|\bmanga\b/gi, '')
    .replace(/[_|\-–—]+/g, ' ')
    .replace(/^\s*\d+\s+|\s+\d+\s*$/g, '')
    .replace(/\s+/g, ' ').trim();
}
function setSeries(name, { fromUpload } = {}) {
  name = String(name || '').trim();
  if (fromUpload && series && allSeries()[series] && !name) return;
  series = name;
  raw.set('mt-current-series', series);
  $('series').value = series;
  renderGlossary();
}
function renderGlossary() {
  const d = seriesData();
  const all = allSeries();
  const dl = $('seriesList');
  dl.textContent = '';
  Object.keys(all).sort().forEach((n) => dl.append(new Option(n)));
  $('notes').value = d.notes || '';
  $('seriesNote').textContent = series ? `${series} · ${d.names.length} اسم` : 'اكتب اسم المانهوا عشان تنحفظ الأسماء';
  const box = $('gl');
  box.textContent = '';
  if (!series) { box.innerHTML = '<div class="muted">اكتب اسم المانهوا فوق.</div>'; return; }
  if (!d.names.length) box.innerHTML = '<div class="muted">ما فيه أسماء بعد — تنضاف تلقائياً وقت الترجمة، أو أضفها بنفسك.</div>';
  d.names.forEach((e, i) => {
    const row = document.createElement('div');
    row.className = 'e' + (e.auto ? ' auto' : '');
    const o = Object.assign(document.createElement('input'), { className: 'o', value: e.o, placeholder: 'Original' });
    const t = Object.assign(document.createElement('input'), { className: 't', value: e.t, placeholder: 'الترجمة' });
    const del = Object.assign(document.createElement('button'), { textContent: '🗑️', title: 'حذف' });
    o.onchange = () => { const dd = seriesData(); dd.names[i].o = o.value.trim(); saveSeries(dd); };
    t.onchange = () => {
      const dd = seriesData();
      const old = dd.names[i].t;
      dd.names[i].t = t.value.trim();
      dd.names[i].auto = false;
      saveSeries(dd);
      row.classList.remove('auto');
      if (old && dd.names[i].t && old !== dd.names[i].t) replaceInPages(old, dd.names[i].t);
    };
    del.onclick = () => { const dd = seriesData(); dd.names.splice(i, 1); saveSeries(dd); renderGlossary(); };
    row.append(o, t, del);
    box.append(row);
  });
}
$('series').addEventListener('change', () => setSeries($('series').value));
$('notes').addEventListener('change', () => { const d = seriesData(); d.notes = $('notes').value; saveSeries(d); });
$('addName').onclick = () => {
  if (!series) { $('series').focus(); return; }
  const d = seriesData();
  d.names.unshift({ o: '', t: '' });
  saveSeries(d);
  renderGlossary();
  $('gl').querySelector('input')?.focus();
};
$('exportGl').onclick = () => save(new Blob([JSON.stringify(allSeries(), null, 2)], { type: 'application/json' }), 'manhwa-names.json');
$('importGl').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const all = allSeries();
    for (const [k, v] of Object.entries(data)) {
      if (!v || !Array.isArray(v.names)) continue;
      const cur = all[k] || { names: [], notes: '' };
      for (const n of v.names) if (n?.o && !cur.names.some((c) => c.o.toLowerCase() === String(n.o).toLowerCase())) cur.names.push({ o: String(n.o), t: String(n.t || '') });
      if (v.notes && !cur.notes) cur.notes = v.notes;
      all[k] = cur;
    }
    json.set('mt-series', all);
    renderGlossary();
    status('تم استرجاع الأسماء ✅', 'ok');
  } catch { status('الملف مو نسخة أسماء صالحة', 'err'); }
});

function addNames(names) {
  if (!settings.autoNames || !series || !names?.length) return 0;
  const d = seriesData();
  let added = 0;
  for (const n of names) {
    if (d.names.some((e) => e.o.toLowerCase() === n.o.toLowerCase())) continue;
    if (d.names.length >= 400) break;
    d.names.push({ o: n.o, t: n.t, auto: true });
    added++;
  }
  if (added) { saveSeries(d); renderGlossary(); }
  return added;
}

// تغيير ترجمة اسم ← نبدّله في كل الصفحات المترجمة
async function replaceInPages(oldT, newT) {
  const changed = [];
  for (const p of state.pages) {
    if (!p.tr?.length) continue;
    let hit = false;
    for (const b of p.tr) if (b.tr.includes(oldT)) { b.tr = b.tr.split(oldT).join(newT); hit = true; }
    if (hit) { changed.push(p); saveTr(p); }
  }
  if (!changed.length) return;
  status(`جاري تحديث «${newT}» في ${changed.length} صفحة…`);
  for (const p of changed) { await render(p); renderPage(p); }
  status(`تم تحديث الاسم في ${changed.length} صفحة ✅`, 'ok');
}

// ---------- رفع الملفات ----------
async function loadCached(pages) {
  for (const p of pages) {
    const c = await dbGet('cache', `${p.hash}|${lang()}`);
    if (c && Array.isArray(c.tr)) { p.tr = c.tr; p.status = c.tr.length ? 'ready' : 'empty'; }
  }
}
const saveTr = (p) => dbPut('cache', `${p.hash}|${lang()}`, { tr: p.tr, t: Date.now() });
const saveSession = () => Promise.all([
  dbPut('session', 'pages', state.pages.map(({ name, mime, data, hash }) => ({ name, mime, data, hash }))),
  dbPut('session', 'meta', { name: state.name, series }),
]);

async function makePage(name, data) {
  const mime = sniff(data);
  return { name, data, mime, hash: await hashBytes(data), url: URL.createObjectURL(new Blob([data], { type: mime })), status: 'wait' };
}

async function addFiles(fileList) {
  const files = [...fileList];
  if (!files.length || state.busy) return;
  status('جاري قراءة الملفات…');
  const incoming = [];
  let zipName = '';
  for (const f of files) {
    try {
      if (/\.(zip|cbz)$/i.test(f.name) || f.type === 'application/zip') {
        (await unzipImages(f)).forEach((i) => incoming.push({ name: i.path, data: i.data }));
        zipName = zipName || f.name.replace(/\.(zip|cbz)$/i, '');
      } else if (f.type.startsWith('image/') || isImageName(f.name)) {
        incoming.push({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) });
      }
    } catch (e) {
      status(`ما قدرت أقرأ ${f.name}: ${e.message}`, 'err');
      return;
    }
  }
  if (!incoming.length) { status('ما لقيت صور في الملفات اللي اخترتها', 'err'); return; }
  incoming.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  const fresh = !state.pages.length;
  for (const f of incoming) state.pages.push(await makePage(f.name, f.data));
  if (fresh) {
    state.name = zipName || incoming[0].name.split('/')[0].replace(/\.[a-z]+$/i, '') || 'chapter';
    $('chapter').value = state.name;
    const g = guessSeries(zipName || state.name);
    if (g && !allSeries()[series]?.names?.length) setSeries(g);
    else if (g && g !== series && allSeries()[g]) setSeries(g);
  }
  await loadCached(state.pages);
  saveSession();
  renderAll();
  const ready = state.pages.filter((p) => p.tr).length;
  const left = state.pages.length - ready;
  status(`جاهز: ${state.pages.length} صفحة` + (ready ? ` (${ready} مترجمة من قبل ✅)` : '') +
    (left ? `\nتحتاج تقريباً ${Math.ceil(left / BATCH())} طلب من Gemini. اضغط «🌐 ترجم».` : ''));
  rerenderAll();
}
$('files').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
const drop = $('drop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
$('chapter').addEventListener('change', () => { state.name = $('chapter').value.trim() || 'chapter'; saveSession(); });
$('clearBtn').onclick = () => {
  if (state.busy) return;
  state.pages.forEach((p) => { URL.revokeObjectURL(p.url); if (p.outUrl) URL.revokeObjectURL(p.outUrl); });
  state.pages = [];
  state.ctx = [];
  state.name = 'chapter';
  dbDel('session', 'pages');
  dbDel('session', 'meta');
  $('restored').classList.add('hide');
  renderAll();
  status('');
  log([]);
};

// ---------- عرض الصفحات ----------
const TAGS = {
  wait: ['', ''], ready: ['work', '⏳ تجهيز'], work: ['work', '⏳ جاري الترجمة'],
  done: ['done', '✅ مترجمة'], fail: ['fail', '⚠️ فشلت'], empty: ['done', 'ما فيها كلام'],
};

function renderPage(p) {
  const i = state.pages.indexOf(p);
  let el = p.el;
  if (!el) {
    el = p.el = document.createElement('div');
    el.className = 'page';
    el.innerHTML = '<div class="imgwrap"><img alt="" loading="lazy"></div><span class="tag"></span><span class="num"></span><div class="tools"></div>';
    el.querySelector('img').addEventListener('click', () => { if (p.outUrl && !p.editing) { p.showOrig = !p.showOrig; renderPage(p); } });
  }
  const img = el.querySelector('img');
  const src = p.outUrl && !p.showOrig && !p.editing ? p.outUrl : p.url;
  if (img.getAttribute('src') !== src) img.src = src;
  const [cls, txt] = TAGS[p.status] || TAGS.wait;
  const tag = el.querySelector('.tag');
  const label = p.outUrl && p.showOrig ? '👁️ الأصل — اضغط للترجمة' : txt;
  tag.className = 'tag ' + cls + (label ? '' : ' hide');
  tag.textContent = label;
  el.querySelector('.num').textContent = `${i + 1} / ${state.pages.length}`;

  const tools = el.querySelector('.tools');
  tools.textContent = '';
  const btn = (t, fn) => { const b = document.createElement('button'); b.textContent = t; b.onclick = fn; tools.append(b); };
  if (!state.busy) {
    if (p.tr?.length) btn(p.editing ? '✖️ إغلاق' : '✏️ تعديل', () => { p.editing = !p.editing; renderPage(p); });
    if (p.tr || p.status === 'fail') btn('🔁 أعد الترجمة', () => retranslate(p));
  }

  // علامات مرقّمة على الفقاعات وقت التعديل
  const wrap = el.querySelector('.imgwrap');
  wrap.querySelectorAll('.mark').forEach((m) => m.remove());
  el.querySelector('.editor')?.remove();
  if (p.editing && p.tr?.length) {
    p.tr.forEach((b, k) => {
      const m = document.createElement('div');
      m.className = 'mark';
      Object.assign(m.style, { left: b.x * 100 + '%', top: b.y * 100 + '%', width: b.w * 100 + '%', height: b.h * 100 + '%' });
      m.innerHTML = `<b>${k + 1}</b>`;
      wrap.append(m);
    });
    const ed = document.createElement('div');
    ed.className = 'editor';
    p.tr.forEach((b, k) => {
      const w = document.createElement('div');
      w.className = 'bub';
      w.innerHTML = '<div class="orig"><span></span><button class="small" title="حذف الفقاعة">🗑️</button></div><textarea></textarea>';
      w.querySelector('.orig span').innerHTML = `<b>${k + 1}.</b> `;
      w.querySelector('.orig span').append(document.createTextNode(b.text));
      const ta = w.querySelector('textarea');
      ta.value = b.tr;
      ta.dir = LANGS[lang()]?.rtl ? 'rtl' : 'ltr';
      ta.oninput = () => { b.tr = ta.value; };
      w.querySelector('.orig button').onclick = () => { p.tr.splice(k, 1); renderPage(p); };
      ed.append(w);
    });
    const saveB = document.createElement('button');
    saveB.className = 'primary';
    saveB.textContent = '💾 حدّث الصورة';
    saveB.onclick = async () => {
      saveB.disabled = true;
      p.tr = p.tr.filter((b) => b.tr.trim());
      saveTr(p);
      p.editing = false;
      await render(p);
      renderPage(p);
    };
    ed.append(saveB);
    el.append(ed);
  }
  return el;
}

function renderAll() {
  const box = $('pages');
  box.textContent = '';
  state.pages.forEach((p) => box.append(renderPage(p)));
  const n = state.pages.length;
  $('count').textContent = n ? `${n} صفحة — اضغط على أي صفحة مترجمة تشوف الأصل` : 'ما فيه صور بعد';
  $('clearBtn').classList.toggle('hide', !n);
  $('nameRow').classList.toggle('hide', !n);
  $('bottom').classList.toggle('hide', !n);
  updateButtons();
}

function updateButtons() {
  const done = state.pages.filter((p) => p.tr).length;
  const left = state.pages.length - done;
  $('trBtn').disabled = state.busy || !left;
  $('trBtn').textContent = done && left ? `🌐 كمّل (${left})` : '🌐 ترجم';
  $('stopBtn').classList.toggle('hide', !state.busy);
  $('zipBtn').disabled = $('pdfBtn').disabled = state.busy || !state.pages.length;
}

// ---------- الرسم ----------
let fontReady = '';
async function ensureFont() {
  const f = fontSpec();
  const k = `${f.weight} ${f.family}`;
  if (fontReady === k) return;
  try { await document.fonts.load(`${f.weight} 32px ${f.family}`, 'أبجد هوز abc'); } catch {}
  fontReady = k;
}

async function render(p) {
  if (!p.tr) return;
  if (!p.tr.length) { p.out = null; if (p.outUrl) URL.revokeObjectURL(p.outUrl); p.outUrl = null; p.status = 'empty'; return; }
  await ensureFont();
  const { bytes } = await typesetImage(p.data, p.mime, p.tr, {
    patches: false, font: fontSpec(), scale: settings.scale / 100, rtl: LANGS[lang()]?.rtl ?? true,
  });
  p.out = bytes;
  if (p.outUrl) URL.revokeObjectURL(p.outUrl);
  p.outUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
  p.status = 'done';
}

// إعادة رسم كل الصفحات المترجمة (بعد تغيير الخط أو الحجم) — بدون أي طلب لـ Gemini
let rerenderRun = 0;
async function rerenderAll() {
  const run = ++rerenderRun;
  const list = state.pages.filter((p) => p.tr);
  if (!list.length) return;
  for (let i = 0; i < list.length; i++) {
    if (run !== rerenderRun) return;
    const p = list[i];
    if (p.status === 'work') continue;
    await render(p);
    renderPage(p);
    if (!state.busy && list.length > 3) status(`جاري تجهيز الصفحات المترجمة… ${i + 1}/${list.length}`);
    await sleep(0);
  }
  if (!state.busy && list.length > 3) status(`جاهز ✅ ${list.length} صفحة مترجمة`, 'ok');
  updateButtons();
}

// ---------- الترجمة ----------
async function translateAll(only, { single = false } = {}) {
  const key = $('key').value.trim();
  if (!key) {
    status('حط مفتاح Gemini أولاً ☝️', 'err');
    $('keyHelp').open = true;
    $('key').focus();
    $('setup').scrollIntoView({ behavior: 'smooth' });
    return;
  }
  raw.set('mt-key', key);
  const todo = (only || state.pages).filter((p) => !p.tr);
  if (!todo.length) return;
  state.busy = true;
  state.halt = null;
  state.stop = { aborted: false };
  rerenderRun++;
  renderAll();
  const errs = [];
  let done = 0, ok = 0, note = '';
  const total = todo.length;
  const upd = () => { status(`جاري الترجمة… ${done}/${total}${note}`); progress(done, total); };
  upd();
  const gem = new Gemini(key, {
    preferred: settings.model || undefined,
    onEvent: (e) => {
      if (e.type === 'usage') showUsage();
      if (e.type === 'model') {
        fillModels();
        if (e.why === 'daily') note = `\nخلصت حصة اليوم لموديل، انتقلنا لـ ${e.model}`;
        else if (e.why === 'busy') note = `\n${e.model} (الموديل الأول مزحوم)`;
        upd();
      }
      if (e.type === 'wait') {
        note = e.why === 'minute' ? `\n⏳ وصلنا حد الطلبات بالدقيقة — نكمل بعد ${e.seconds} ث (ما يضيع شي)`
          : e.why === 'network' ? `\n📶 انقطع الاتصال — نعيد بعد ${e.seconds} ث` : `\n⏳ Gemini مزحوم — نعيد بعد ${e.seconds} ث`;
        upd();
      }
    },
  });
  const signal = { get aborted() { return state.stop.aborted || !!state.halt; } };
  const glossary = () => seriesData().names.filter((e) => e.o && e.t);

  const finish = (p, boxes) => {
    if (settings.noPunct) boxes.forEach((b) => (b.tr = cleanPunct(b.tr, lang())));
    // «...» أو فقاعة بدون كلام: نخليها مثل ما هي في الصورة
    boxes = boxes.filter((b) => /[\p{L}\p{N}]/u.test(b.tr) && /[\p{L}\p{N}]/u.test(b.text || 'x'));
    p.tr = boxes;
    saveTr(p);
    boxes.forEach((b) => state.ctx.push(`${b.text} → ${b.tr}`));
    state.ctx = state.ctx.slice(-15);
    ok++;
  };
  const fail = (p, msg) => { p.status = 'fail'; errs.push(`#${state.pages.indexOf(p) + 1}: ${msg}`); };

  async function runBatch(pages) {
    if (signal.aborted) return;
    pages.forEach((p) => { p.status = 'work'; renderPage(p); });
    try {
      for (const p of pages) p.parts = p.parts || await pageParts(p.data, p.mime);
      const items = pages.flatMap((p) => p.parts.map((part) => ({ data: p.data, mime: p.mime, part, p })));
      const { results, names } = await translateBatch(gem, items, {
        lang: lang(), glossary: glossary(), notes: seriesData().notes, noPunct: settings.noPunct, context: state.ctx, signal,
      });
      addNames(names);
      const missing = [];
      for (const p of pages) {
        const rs = items.map((it, k) => [it, results[k]]).filter(([it]) => it.p === p);
        if (rs.some(([, r]) => r === null)) missing.push(p);
        else finish(p, rs.flatMap(([, r]) => r));
      }
      for (const p of pages) if (p.tr) { await render(p); done++; upd(); renderPage(p); }
      if (missing.length) {
        if (pages.length > 1) for (const p of missing) await runBatch([p]);
        else { fail(missing[0], 'Gemini ما رجّع هالصفحة'); done++; upd(); renderPage(missing[0]); }
      }
    } catch (e) {
      if (e instanceof FatalError || e instanceof QuotaError || e instanceof StopError) {
        state.halt = state.halt || e;
        pages.forEach((p) => { if (!p.tr) { p.status = 'wait'; renderPage(p); } });
        return;
      }
      if (pages.length > 1) { for (const p of pages) await runBatch([p]); return; }
      fail(pages[0], e.message);
      done++;
      upd();
      renderPage(pages[0]);
    }
  }

  try {
    await gem.init();
    showUsage();
    // نجمع الصفحات في دفعات (كل دفعة = طلب واحد)
    const batches = [];
    if (single) todo.forEach((p) => batches.push([p]));
    else {
      let cur = [], n = 0;
      for (const p of todo) {
        p.parts = p.parts || await pageParts(p.data, p.mime);
        if (cur.length && n + p.parts.length > BATCH()) { batches.push(cur); cur = []; n = 0; }
        cur.push(p);
        n += p.parts.length;
      }
      if (cur.length) batches.push(cur);
    }
    // أول دفعة لحالها: تطلع منها الأسماء والسياق، وبعدها الباقي بالتوازي ويستفيد منها
    let next = 0;
    if (batches.length > 1) await runBatch(batches[next++]);
    const worker = async () => { while (next < batches.length && !signal.aborted) await runBatch(batches[next++]); };
    await Promise.all([worker(), worker()]);
    if (state.halt && !(state.halt instanceof StopError)) throw state.halt;

    const failed = todo.filter((p) => p.status === 'fail').length;
    const left = state.pages.filter((p) => !p.tr).length;
    if (state.stop.aborted) status(`توقفت ⏹️ — ترجمت ${ok} من ${total}. اضغط «كمّل» متى ما بغيت.`);
    else if (!ok && failed) status(`ما قدرت أترجم 😕\n${errs[0]?.replace(/^#\d+: /, '') || ''}\nجرّب مرة ثانية بعد شوي.`, 'err');
    else status(`تم ✅ ترجمت ${ok} صفحة` + (failed ? `\nفشلت ${failed} — اضغط «كمّل» أو «🔁 أعد الترجمة» على الصفحة` : '') +
      (!left ? '\nحمّل الفصل ZIP أو PDF من تحت.' : ''), failed ? 'warn' : 'ok');
  } catch (e) {
    const saved = state.pages.filter((p) => p.tr).length;
    if (e instanceof QuotaError) {
      status(`خلصت الحصة المجانية اليومية لـ Gemini 😴\nترجمت ${saved} من ${state.pages.length} صفحة وكلها محفوظة.\nالحصة تتجدد كل يوم — ارجع بكرة وافتح الموقع، تلقى الفصل مكانه واضغط «كمّل».`, 'warn');
    } else {
      status(e.message, 'err');
      if (e instanceof FatalError) { $('keyHelp').open = true; $('setup').scrollIntoView({ behavior: 'smooth' }); }
    }
  } finally {
    log([...new Set(errs)].slice(0, 10));
    state.busy = false;
    renderAll();
    showUsage();
    setTimeout(() => progress(0, 0), 1500);
  }
}

async function retranslate(p) {
  if (state.busy) return;
  await dbDel('cache', `${p.hash}|${lang()}`);
  p.tr = null; p.status = 'wait'; p.editing = false; p.showOrig = false;
  translateAll([p], { single: true });
}

$('trBtn').onclick = () => translateAll();
$('stopBtn').onclick = () => { if (state.stop) state.stop.aborted = true; status('جاري الإيقاف…'); };

// ---------- التحميل ----------
function exportFiles() {
  const pad = Math.max(3, String(state.pages.length).length);
  return state.pages.map((p, i) => {
    const data = p.out || p.data;
    const mime = p.out ? 'image/jpeg' : p.mime;
    const ext = mime.split('/')[1].replace('jpeg', 'jpg');
    return { name: `${String(i + 1).padStart(pad, '0')}.${ext}`, data, mime };
  });
}
function save(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
const outName = () => `${state.name} (${LANGS[lang()]?.name || 'مترجم'})`.replace(/[\\/:*?"<>|]/g, ' ');
$('zipBtn').onclick = () => save(makeZip(exportFiles()), outName() + '.zip');
$('pdfBtn').onclick = async () => {
  $('pdfBtn').disabled = true;
  try {
    const pdf = await makePdf(exportFiles(), (d, t) => { progress(d, t); status(`جاري إنشاء PDF… ${d}/${t}`); });
    save(pdf, outName() + '.pdf');
    status('تم إنشاء PDF ✅', 'ok');
  } catch (e) { status('ما قدرت أسوي PDF: ' + e.message, 'err'); }
  finally { $('pdfBtn').disabled = false; setTimeout(() => progress(0, 0), 1500); }
};

// ---------- البداية: نرجّع آخر فصل ----------
(async () => {
  setSeries(series);
  const pages = await dbGet('session', 'pages');
  if (!pages?.length) { renderAll(); return; }
  const meta = (await dbGet('session', 'meta')) || {};
  state.name = meta.name || 'chapter';
  $('chapter').value = state.name;
  if (meta.series && meta.series !== series) setSeries(meta.series);
  state.pages = pages.map((p) => ({ ...p, url: URL.createObjectURL(new Blob([p.data], { type: p.mime })), status: 'wait' }));
  await loadCached(state.pages);
  const ready = state.pages.filter((p) => p.tr).length;
  $('restored').textContent = `📌 رجّعنا آخر فصل كنت شغال عليه (${state.name}): ${ready} من ${state.pages.length} صفحة مترجمة.` +
    (ready < state.pages.length ? ' اضغط «كمّل» تحت.' : '');
  $('restored').classList.remove('hide');
  renderAll();
  rerenderAll();
})();
