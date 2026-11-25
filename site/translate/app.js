import { LANGS, FatalError, pickModels, translateImage } from './lib/translate.js';
import { typesetImage } from './lib/typeset.js';
import { makeZip } from './lib/zip.js';
import { makePdf } from './lib/pdf.js';
import { unzipImages, isImageName } from './lib/unzip.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
const state = { pages: [], name: 'chapter', busy: false, stop: null, models: null, ctx: [] };

// ---------- الإعداد ----------
for (const [code, l] of Object.entries(LANGS)) $('lang').add(new Option(l.name, code));
$('lang').value = store.get('mt-lang', 'ar');
$('key').value = store.get('mt-key', '');
if ($('key').value) $('keyHelp').open = false; else $('keyHelp').open = true;
$('key').addEventListener('change', () => { store.set('mt-key', $('key').value.trim()); state.models = null; });
$('lang').addEventListener('change', () => {
  store.set('mt-lang', $('lang').value);
  // تغيير اللغة = نترجم من جديد
  state.pages.forEach((p) => { p.tr = null; p.out = null; p.status = 'wait'; });
  state.ctx = [];
  renderAll();
});

const status = (msg, cls = '') => { $('status').textContent = msg; $('status').className = 'status ' + cls; };
const progress = (d, t) => { $('bar').style.width = t ? `${Math.round((d / t) * 100)}%` : '0'; };
const sniff = (b) => {
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return 'image/webp';
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'image/avif';
  return 'image/jpeg';
};
const log = (lines) => {
  if (!lines.length) { $('logBox').classList.add('hide'); return; }
  $('log').textContent = lines.join('\n');
  $('logBox').classList.remove('hide');
};

// ---------- رفع الملفات ----------
async function addFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  status('جاري قراءة الملفات…');
  const incoming = [];
  for (const f of files) {
    try {
      if (/\.(zip|cbz)$/i.test(f.name) || f.type === 'application/zip') {
        const imgs = await unzipImages(f);
        imgs.forEach((i) => incoming.push({ name: i.path, data: i.data }));
        if (!state.pages.length) state.name = f.name.replace(/\.(zip|cbz)$/i, '');
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
  for (const f of incoming) {
    const mime = sniff(f.data);
    state.pages.push({ name: f.name, data: f.data, mime, url: URL.createObjectURL(new Blob([f.data], { type: mime })), status: 'wait', showOrig: false });
  }
  renderAll();
  status(`جاهز: ${state.pages.length} صورة. اضغط «🌐 ترجم».`);
}
$('files').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
const drop = $('drop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
$('clearBtn').onclick = () => {
  if (state.busy) return;
  state.pages.forEach((p) => { URL.revokeObjectURL(p.url); if (p.outUrl) URL.revokeObjectURL(p.outUrl); });
  state.pages = [];
  state.ctx = [];
  state.name = 'chapter';
  renderAll();
  status('');
  log([]);
};

// ---------- العرض ----------
const TAGS = { wait: ['', ''], work: ['work', '⏳ جاري الترجمة'], done: ['done', '✅ مترجمة'], fail: ['fail', '⚠️ فشلت'], empty: ['done', 'ما فيها كلام'] };

function renderPage(p, i) {
  let el = p.el;
  if (!el) {
    el = p.el = document.createElement('div');
    el.className = 'page';
    el.innerHTML = '<img alt=""><span class="tag"></span><span class="num"></span><div class="tools"></div>';
    el.querySelector('img').addEventListener('click', () => { if (p.outUrl) { p.showOrig = !p.showOrig; renderPage(p, state.pages.indexOf(p)); } });
  }
  const img = el.querySelector('img');
  const src = p.outUrl && !p.showOrig ? p.outUrl : p.url;
  if (img.src !== src) img.src = src;
  const [cls, txt] = TAGS[p.status] || TAGS.wait;
  const tag = el.querySelector('.tag');
  tag.className = 'tag ' + cls + (txt ? '' : ' hide');
  tag.textContent = p.outUrl && p.showOrig ? '👁️ الأصل — اضغط للترجمة' : txt;
  el.querySelector('.num').textContent = `${i + 1} / ${state.pages.length}`;
  const tools = el.querySelector('.tools');
  tools.textContent = '';
  if (p.tr?.length && !state.busy) {
    const b = document.createElement('button');
    b.textContent = p.editing ? '✖️ إغلاق' : '✏️ تعديل الترجمة';
    b.onclick = () => { p.editing = !p.editing; renderPage(p, state.pages.indexOf(p)); };
    tools.append(b);
  }
  if (p.status === 'fail' && !state.busy) {
    const b = document.createElement('button');
    b.textContent = '🔁 أعد';
    b.onclick = () => { p.status = 'wait'; translateAll([p]); };
    tools.append(b);
  }
  // محرر الترجمة: تعدّل النص وتحدّث الصورة
  el.querySelector('.editor')?.remove();
  if (p.editing && p.tr?.length) {
    const ed = document.createElement('div');
    ed.className = 'editor';
    p.tr.forEach((b, k) => {
      const w = document.createElement('div');
      w.className = 'bub';
      w.innerHTML = `<div class="orig"></div><textarea></textarea>`;
      w.querySelector('.orig').textContent = `${k + 1}. ${b.text}`;
      const ta = w.querySelector('textarea');
      ta.value = b.tr;
      ta.dir = LANGS[$('lang').value]?.rtl ? 'rtl' : 'ltr';
      ta.oninput = () => { b.tr = ta.value; };
      ed.append(w);
    });
    const save = document.createElement('button');
    save.className = 'primary';
    save.textContent = '💾 حدّث الصورة';
    save.onclick = async () => {
      save.disabled = true;
      p.tr = p.tr.filter((b) => b.tr.trim());
      await render(p);
      p.editing = false;
      renderPage(p, state.pages.indexOf(p));
    };
    ed.append(save);
    el.append(ed);
  }
  return el;
}

function renderAll() {
  const box = $('pages');
  box.textContent = '';
  state.pages.forEach((p, i) => box.append(renderPage(p, i)));
  const n = state.pages.length;
  $('count').textContent = n ? `${n} صورة — اضغط على أي صورة مترجمة تشوف الأصل` : 'ما فيه صور بعد';
  $('clearBtn').classList.toggle('hide', !n);
  $('bottom').classList.toggle('hide', !n);
  updateButtons();
}

function updateButtons() {
  const done = state.pages.filter((p) => p.out).length;
  const left = state.pages.filter((p) => !p.out && p.status !== 'empty').length;
  $('trBtn').disabled = state.busy || !left;
  $('trBtn').textContent = done && left ? `🌐 كمّل الترجمة (${left})` : '🌐 ترجم';
  $('stopBtn').classList.toggle('hide', !state.busy);
  $('zipBtn').disabled = $('pdfBtn').disabled = state.busy || !state.pages.length;
}

// ---------- الترجمة ----------
async function getModels(key) {
  if (state.models) return state.models;
  let list = null;
  try {
    const c = JSON.parse(store.get('mt-models', 'null'));
    if (c && c.k === key.slice(-6) && Date.now() - c.t < 86400000) list = c.list;
  } catch {}
  if (!list) {
    try { list = await pickModels(key); } catch (e) { if (e instanceof FatalError) throw e; list = ['gemini-2.5-flash', 'gemini-2.5-flash-lite']; }
    store.set('mt-models', JSON.stringify({ k: key.slice(-6), t: Date.now(), list }));
  }
  return (state.models = { list, i: 0 });
}

async function render(p) {
  const lang = $('lang').value;
  if (!p.tr.length) { p.out = null; p.status = 'empty'; return; }
  const { bytes } = await typesetImage(p.data, p.mime, p.tr, lang, { patches: false });
  p.out = bytes;
  if (p.outUrl) URL.revokeObjectURL(p.outUrl);
  p.outUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
  p.status = 'done';
}

async function translateAll(only) {
  const key = $('key').value.trim();
  if (!key) {
    status('حط مفتاح Gemini أولاً ☝️', 'err');
    $('keyHelp').open = true;
    $('key').focus();
    $('setup').scrollIntoView({ behavior: 'smooth' });
    return;
  }
  store.set('mt-key', key);
  const lang = $('lang').value;
  const todo = (only || state.pages).filter((p) => !p.out && p.status !== 'empty');
  if (!todo.length) return;
  state.busy = true;
  state.stop = { aborted: false };
  renderAll();
  const errs = [];
  let done = 0, ok = 0, waiting = '';
  const total = todo.length;
  const upd = () => { status(`جاري الترجمة… ${done}/${total}${waiting}`); progress(done, total); };
  upd();
  let fatal = null;
  try {
    const models = await getModels(key);
    $('modelName').textContent = models.list[models.i];
    const signal = {
      get aborted() { return state.stop.aborted || !!fatal; },
      onWait: (s, why) => { waiting = why === 'اتصال' ? ` — انقطع الاتصال، نعيد بعد ${s} ث` : ` — Gemini مزحوم، ننتظر ${s} ث`; upd(); },
      onModel: (m) => { $('modelName').textContent = m; waiting = ` — انتقلنا لموديل ${m}`; upd(); },
    };
    let next = 0;
    const worker = async () => {
      while (next < todo.length && !signal.aborted) {
        const p = todo[next++];
        p.status = 'work';
        renderPage(p, state.pages.indexOf(p));
        try {
          p.tr = await translateImage(p.data, p.mime, { key, models, lang, context: state.ctx.slice(-12), signal });
          p.tr.forEach((b) => state.ctx.push(`${b.text} → ${b.tr}`));
          await render(p);
          ok++;
          waiting = '';
        } catch (e) {
          if (e instanceof FatalError) { fatal = fatal || e; p.status = 'wait'; }
          else { p.status = 'fail'; errs.push(`${p.name}: ${e.message}`); }
        }
        done++;
        upd();
        renderPage(p, state.pages.indexOf(p));
      }
    };
    await Promise.all([worker(), worker()]);
    if (fatal && !/توقفت/.test(fatal.message)) throw fatal;
    const failed = todo.filter((p) => p.status === 'fail').length;
    if (state.stop.aborted) status(`توقفت ⏹️ — ترجمت ${ok} من ${total}. اضغط «كمّل الترجمة» متى ما بغيت.`);
    else if (!ok && failed) status(`ما قدرت أترجم أي صورة 😕\n${errs[0]?.split(': ').slice(1).join(': ') || ''}\nجرّب مرة ثانية بعد شوي.`, 'err');
    else status(`تم ✅ ترجمت ${ok} صورة` + (failed ? `\nفشلت ${failed} — اضغط «كمّل الترجمة» أو «🔁 أعد» على الصورة` : '') + '\nتقدر تحمّل ZIP أو PDF من تحت.', failed ? 'err' : 'ok');
  } catch (e) {
    status(e.message, 'err');
    if (e instanceof FatalError) { $('keyHelp').open = true; $('setup').scrollIntoView({ behavior: 'smooth' }); }
  } finally {
    log([...new Set(errs)].slice(0, 8));
    state.busy = false;
    renderAll();
    setTimeout(() => progress(0, 0), 1500);
  }
}
$('trBtn').onclick = () => translateAll();
$('stopBtn').onclick = () => { if (state.stop) state.stop.aborted = true; status('جاري الإيقاف…'); };

// ---------- التحميل ----------
function files() {
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
const outName = () => `${state.name} (${LANGS[$('lang').value]?.name || 'مترجم'})`.replace(/[\\/:*?"<>|]/g, ' ');
$('zipBtn').onclick = () => { save(makeZip(files()), outName() + '.zip'); };
$('pdfBtn').onclick = async () => {
  $('pdfBtn').disabled = true;
  try {
    const pdf = await makePdf(files(), (d, t) => { progress(d, t); status(`جاري إنشاء PDF… ${d}/${t}`); });
    save(pdf, outName() + '.pdf');
    status('تم إنشاء PDF ✅', 'ok');
  } catch (e) { status('ما قدرت أسوي PDF: ' + e.message, 'err'); }
  finally { $('pdfBtn').disabled = false; setTimeout(() => progress(0, 0), 1500); }
};
renderAll();
