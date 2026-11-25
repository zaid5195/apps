import { makeZip } from './lib/zip.js';
import { makePdf } from './lib/pdf.js';

// الفكرة: ما نطلب أي شي من الموقع. نأخذ الصور اللي المتصفح عرضها:
// 1) الملف الأصلي من ذاكرة المتصفح (CDP: Page.getResourceContent)
// 2) وإذا ما توفر: لقطة للصورة نفسها بدقتها الأصلية (CDP: Page.captureScreenshot)

const $ = (id) => document.getElementById(id);
let state = { tabId: null, pageUrl: '', items: [], busy: false };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- دوال تنحقن في صفحة القارئ ----------

function scanPage() {
  const LAZY = ['data-src', 'data-lazy-src', 'data-original', 'data-url', 'data-lazy', 'data-echo',
    'data-cfsrc', 'data-full', 'data-image', 'data-img', 'data-pagespeed-lazy-src'];
  const items = [];
  const seen = new Set();
  document.querySelectorAll('img, canvas').forEach((el, idx) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    el.setAttribute('data-mhd-idx', idx);
    if (el.tagName === 'CANVAS') {
      if (el.width < 200 || el.height < 200 || r.width < 150) return;
      items.push({ idx, tag: 'canvas', url: '', w: el.width, h: el.height, rw: r.width, loaded: true });
      return;
    }
    const lazy = LAZY.map((a) => el.getAttribute(a)).find((v) => v && v.trim() && !v.startsWith('data:'));
    const cur = el.currentSrc || el.src || '';
    const placeholder = !cur || /^data:image\/(gif|svg)/.test(cur) ||
      /placeholder|loading|blank|spinner|pixel\.(gif|png)/i.test(cur) || (el.complete && el.naturalWidth > 0 && el.naturalWidth < 40);
    const loaded = el.complete && el.naturalWidth > 0 && !placeholder;
    if (/\.svg(\?|$)/i.test(cur)) return;
    if (loaded && (el.naturalWidth < 120 || el.naturalHeight < 120)) return;
    if (!loaded && !lazy && r.width < 150) return;
    const key = loaded ? cur : (lazy || cur) + '#' + idx;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({
      idx, tag: 'img', url: loaded ? cur : '', loaded, rw: Math.round(r.width),
      w: loaded ? el.naturalWidth : Math.round(r.width), h: loaded ? el.naturalHeight : Math.round(r.height),
    });
  });
  return { title: document.title, items };
}

async function autoScroll() {
  const el = document.scrollingElement || document.documentElement;
  let target = el;
  if (el.scrollHeight <= innerHeight + 50) {
    let best = null;
    document.querySelectorAll('div, main, section').forEach((d) => {
      const s = getComputedStyle(d);
      if (/(auto|scroll)/.test(s.overflowY) && d.scrollHeight > d.clientHeight + 200 &&
        (!best || d.scrollHeight > best.scrollHeight)) best = d;
    });
    if (best) target = best;
  }
  const start = target.scrollTop;
  const view = target === el ? innerHeight : target.clientHeight;
  const t0 = Date.now();
  let stable = 0, last = -1;
  while (Date.now() - t0 < 90000 && stable < 4) {
    target.scrollTop += view * 0.85;
    await new Promise((r) => setTimeout(r, 350));
    const atEnd = target.scrollTop + view >= target.scrollHeight - 5;
    if (atEnd && target.scrollHeight === last) stable++; else stable = 0;
    last = target.scrollHeight;
  }
  await new Promise((r) => setTimeout(r, 800));
  target.scrollTop = start;
  return true;
}

// يجيب الصورة قدام الشاشة، ينتظرها تنعرض كاملة، ويرجع مكانها بالضبط
async function prepareEl(idx) {
  const el = document.querySelector(`[data-mhd-idx="${idx}"]`);
  if (!el) return null;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const tall = el.getBoundingClientRect().height > innerHeight;
  el.scrollIntoView({ block: tall ? 'start' : 'center', behavior: 'instant' });
  const isImg = el.tagName === 'IMG';
  const ready = () => {
    if (!isImg) return true;
    const cur = el.currentSrc || el.src || '';
    return el.complete && el.naturalWidth > 40 && !/^data:image\/(gif|svg)/.test(cur) &&
      !/placeholder|loading|blank|spinner/i.test(cur);
  };
  const t0 = Date.now();
  while (!ready() && Date.now() - t0 < 12000) await wait(150);
  if (isImg) { try { await el.decode(); } catch {} }
  await wait(250);
  const r = el.getBoundingClientRect();
  return {
    ok: ready(), tag: el.tagName.toLowerCase(), url: isImg ? (el.currentSrc || el.src) : '',
    nw: isImg ? el.naturalWidth : el.width, nh: isImg ? el.naturalHeight : el.height,
    x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height,
  };
}

function canvasData(idx) {
  const el = document.querySelector(`[data-mhd-idx="${idx}"]`);
  try { return el.toDataURL('image/png'); } catch { return null; }
}

// ---------- أدوات ----------

const status = (msg, cls = '') => { $('status').textContent = msg; $('status').className = 'status ' + cls; };
const progress = (done, total) => {
  $('progress').hidden = !total;
  $('bar').style.width = total ? `${Math.round((done / total) * 100)}%` : '0';
};
const setBusy = (b) => { state.busy = b; $('downloadBtn').disabled = b || !state.items.some((i) => i.on); $('scanBtn').disabled = $('scrollBtn').disabled = b; };

function cleanName(s) {
  return (s || 'chapter')
    .replace(/\s*[|–—-]\s*(read|اقرأ|manga|manhwa|مانهوا|مانجا).*$/i, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 120) || 'chapter';
}

async function activeTab() {
  const forced = +new URLSearchParams(location.search).get('tabId');
  if (forced) return chrome.tabs.get(forced);
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
async function dataUrlToBytes(u) { return new Uint8Array(await (await fetch(u)).arrayBuffer()); }

function sniffType(b) {
  if (b[0] === 0xff && b[1] === 0xd8) return ['image/jpeg', 'jpg'];
  if (b[0] === 0x89 && b[1] === 0x50) return ['image/png', 'png'];
  if (b[0] === 0x47 && b[1] === 0x49) return ['image/gif', 'gif'];
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return ['image/webp', 'webp'];
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return ['image/avif', 'avif'];
  return [null, null];
}

// ---------- أداة المتصفح (CDP) ----------

const cdp = {
  async attach(tabId) {
    try { await chrome.debugger.attach({ tabId }, '1.3'); }
    catch (e) { if (!/already attached/i.test(e.message)) throw new Error('ما قدرت أتصل بالتبويب (سكّر أدوات المطوّر DevTools لو مفتوحة)'); }
    await this.send(tabId, 'Page.enable');
  },
  detach(tabId) { return chrome.debugger.detach({ tabId }).catch(() => {}); },
  send(tabId, method, params = {}) { return chrome.debugger.sendCommand({ tabId }, method, params); },
  // خريطة: رابط الصورة ← الإطار اللي حمّلها
  async resourceMap(tabId) {
    const { frameTree } = await this.send(tabId, 'Page.getResourceTree');
    const map = new Map();
    const walk = (node) => {
      map.set(node.frame.url, node.frame.id);
      for (const r of node.resources || []) map.set(r.url, node.frame.id);
      (node.childFrames || []).forEach(walk);
    };
    walk(frameTree);
    return { map, top: frameTree.frame.id };
  },
  // الملف الأصلي من ذاكرة المتصفح بدون أي طلب للموقع
  async original(tabId, url, res) {
    if (!url) return null;
    if (url.startsWith('data:')) return dataUrlToBytes(url);
    let frameId = res.map.get(url);
    if (!frameId) { Object.assign(res, await this.resourceMap(tabId)); frameId = res.map.get(url) || res.top; }
    try {
      const { content, base64Encoded } = await this.send(tabId, 'Page.getResourceContent', { frameId, url });
      const bytes = base64Encoded ? b64ToBytes(content) : new TextEncoder().encode(content);
      return sniffType(bytes)[0] ? bytes : null;
    } catch { return null; }
  },
  // لقطة للعنصر بدقته الأصلية
  async shot(tabId, info) {
    const scale = Math.min(Math.max(info.nw / info.w || 1, 1), 4);
    const { data } = await this.send(tabId, 'Page.captureScreenshot', {
      format: 'jpeg', quality: 95, captureBeyondViewport: true, fromSurface: true,
      clip: { x: info.x, y: info.y, width: info.w, height: info.h, scale },
    });
    return b64ToBytes(data);
  },
};

// ---------- الفحص ----------

function pickDefaults(items) {
  // صفحات الفصل تنعرض بنفس العرض تقريباً — الإعلانات والشعارات تختلف
  const counts = new Map();
  items.filter((i) => i.rw >= 200).forEach((i) => { const k = Math.round(i.rw / 10); counts.set(k, (counts.get(k) || 0) + 1); });
  let main = 0, max = 0;
  counts.forEach((c, k) => { if (c > max) { max = c; main = k * 10; } });
  items.forEach((i) => {
    if (max >= 2) i.on = Math.abs(i.rw - main) <= Math.max(main * 0.08, 12) && (i.h >= 100 || !i.loaded);
    else i.on = i.w >= 300 && i.h >= 300;
  });
  if (!items.some((i) => i.on)) items.forEach((i) => (i.on = true));
}

async function scan(withScroll = false) {
  const tab = await activeTab();
  if (!tab || !/^https?:/.test(tab.url || '')) { status('افتح صفحة الفصل في المتصفح أولاً', 'err'); return; }
  state.tabId = tab.id;
  state.pageUrl = tab.url;
  setBusy(true);
  try {
    if (withScroll) {
      status('جاري تمرير الصفحة عشان تبان كل الصور… لا تغيّر التبويب');
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: autoScroll });
    }
    status('جاري الفحص…');
    const results = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: scanPage });
    const main = results.find((r) => r.frameId === 0)?.result;
    const items = [];
    for (const r of results.sort((a, b) => a.frameId - b.frameId)) {
      for (const it of r.result?.items || []) items.push({ ...it, frameId: r.frameId });
    }
    pickDefaults(items);
    state.items.forEach((i) => i.thumb && URL.revokeObjectURL(i.thumb));
    state.items = items;
    $('pageTitle').textContent = main?.title || tab.title || '';
    $('nameInput').value = cleanName(main?.title || tab.title);
    render();
    status(items.length
      ? `لقيت ${items.length} صورة (المحدد منها صور الفصل). اضغط «تحميل الفصل» وبتنلقط صورة صورة.`
      : 'ما لقيت صور. جرّب «تمرير + فحص» أو تأكد إنك في صفحة الفصل.', items.length ? 'ok' : 'err');
  } catch (e) {
    status('ما قدرت أفحص هذي الصفحة: ' + e.message, 'err');
  } finally {
    setBusy(false);
  }
}

function render() {
  const grid = $('grid');
  grid.textContent = '';
  if (!state.items.length) grid.innerHTML = '<div class="empty">لا توجد صور بعد</div>';
  state.items.forEach((it, n) => {
    const d = document.createElement('div');
    it.el = d;
    d.className = 'thumb' + (it.on ? ' on' : '') + (it.thumb ? ' done' : '') + (it.failed ? ' fail' : '');
    if (it.thumb) {
      const img = document.createElement('img');
      img.src = it.thumb;
      d.append(img);
    } else {
      const ph = document.createElement('div');
      ph.className = 'ph';
      ph.textContent = it.tag === 'canvas' ? '🎨' : '🖼️';
      d.append(ph);
    }
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = n + 1;
    const dim = document.createElement('span');
    dim.className = 'dim';
    dim.textContent = it.loaded ? `${it.w}×${it.h}` : 'لسا ما ظهرت';
    d.append(num, dim);
    d.onclick = () => { if (state.busy) return; it.on = !it.on; d.classList.toggle('on', it.on); updateCount(); };
    grid.append(d);
  });
  updateCount();
}

function updateCount() {
  const n = state.items.filter((i) => i.on).length;
  $('count').textContent = `${n} من ${state.items.length} صورة محددة`;
  if (!state.busy) $('downloadBtn').disabled = n === 0;
}

// ---------- الالتقاط والتحميل ----------

async function captureItem(it, res, shotOnly) {
  const target = { tabId: state.tabId, frameIds: [it.frameId] };
  const [{ result: info }] = await chrome.scripting.executeScript({ target, func: prepareEl, args: [it.idx] });
  if (!info) throw new Error('الصورة اختفت من الصفحة');
  if (info.tag === 'img' && !info.ok) throw new Error('الصورة ما ظهرت');
  it.w = info.nw; it.h = info.nh; it.loaded = true;

  if (!shotOnly) {
    if (info.tag === 'img') {
      const bytes = await cdp.original(state.tabId, info.url, res);
      if (bytes) return { bytes, how: 'original' };
    } else {
      const [{ result: du }] = await chrome.scripting.executeScript({ target, func: canvasData, args: [it.idx] });
      if (du) return { bytes: await dataUrlToBytes(du), how: 'original' };
    }
  }
  // اللقطة تحتاج إحداثيات الصفحة الرئيسية
  if (it.frameId !== 0) throw new Error('صورة داخل إطار ولم تتوفر في الذاكرة');
  return { bytes: await cdp.shot(state.tabId, info), how: 'shot' };
}

async function saveBlob(blob, filename, saveAs) {
  const url = URL.createObjectURL(blob);
  try { await chrome.downloads.download({ url, filename, saveAs, conflictAction: 'uniquify' }); }
  finally { setTimeout(() => URL.revokeObjectURL(url), 120000); }
}

async function download() {
  const chosen = state.items.filter((i) => i.on);
  if (!chosen.length) return;
  const fmt = document.querySelector('input[name=fmt]:checked').value;
  const saveAs = $('saveAs').checked;
  const shotOnly = $('shotOnly').checked;
  const name = cleanName($('nameInput').value);
  const pad = Math.max(3, String(chosen.length).length);
  setBusy(true);
  const files = [];
  const failed = [];
  let originals = 0, shots = 0;
  try {
    await cdp.attach(state.tabId);
    const res = await cdp.resourceMap(state.tabId);
    // نحفظ مكان القراءة ونرجع له بعد ما نخلص
    const [{ result: pos }] = await chrome.scripting.executeScript({ target: { tabId: state.tabId }, func: () => [scrollX, scrollY] });
    progress(0, chosen.length);
    for (let i = 0; i < chosen.length; i++) {
      const it = chosen[i];
      status(`جاري التقاط الصورة ${i + 1} من ${chosen.length}…`);
      try {
        const { bytes, how } = await captureItem(it, res, shotOnly);
        how === 'shot' ? shots++ : originals++;
        const [mime, ext] = sniffType(bytes);
        files.push({ name: `${String(i + 1).padStart(pad, '0')}.${ext}`, data: bytes, mime });
        if (it.thumb) URL.revokeObjectURL(it.thumb);
        it.thumb = URL.createObjectURL(new Blob([bytes], { type: mime }));
        it.failed = false;
      } catch (e) {
        it.failed = true;
        failed.push(i + 1);
        console.warn('فشل', i + 1, e);
      }
      progress(i + 1, chosen.length);
      if (i % 5 === 4 || i === chosen.length - 1) render();
    }
    await chrome.scripting.executeScript({ target: { tabId: state.tabId }, func: (x, y) => scrollTo(x, y), args: pos }).catch(() => {});
    await cdp.detach(state.tabId);
    if (!files.length) throw new Error('ما قدرت ألتقط أي صورة');

    if (fmt === 'zip') {
      status('جاري إنشاء ملف ZIP…');
      await saveBlob(makeZip(files), `Manhwa/${name}.zip`, saveAs);
    } else if (fmt === 'pdf') {
      progress(0, files.length);
      const pdf = await makePdf(files, (d, t) => { progress(d, t); status(`جاري إنشاء PDF… ${d}/${t}`); });
      await saveBlob(pdf, `Manhwa/${name}.pdf`, saveAs);
    } else {
      for (const f of files) await saveBlob(new Blob([f.data], { type: f.mime }), `Manhwa/${name}/${f.name}`, false);
    }
    const how = [originals && `${originals} بالملف الأصلي`, shots && `${shots} بلقطة`].filter(Boolean).join(' و ');
    status(`تم ✅ ${files.length} صورة (${how})` + (failed.length ? `\nما قدرت ألتقط الصور رقم: ${failed.join('، ')}` : ''), failed.length ? 'err' : 'ok');
  } catch (e) {
    status('صار خطأ: ' + e.message, 'err');
  } finally {
    await cdp.detach(state.tabId);
    setBusy(false);
    render();
    setTimeout(() => progress(0, 0), 1500);
  }
}

// ---------- الإعدادات والأحداث ----------

chrome.storage.local.get({ fmt: 'zip', saveAs: false, shotOnly: false }).then(({ fmt, saveAs, shotOnly }) => {
  const r = document.querySelector(`input[name=fmt][value=${fmt}]`);
  if (r) r.checked = true;
  $('saveAs').checked = saveAs;
  $('shotOnly').checked = shotOnly;
});
document.querySelectorAll('input[name=fmt]').forEach((r) => r.addEventListener('change', () => chrome.storage.local.set({ fmt: r.value })));
$('saveAs').addEventListener('change', () => chrome.storage.local.set({ saveAs: $('saveAs').checked }));
$('shotOnly').addEventListener('change', () => chrome.storage.local.set({ shotOnly: $('shotOnly').checked }));
$('scanBtn').onclick = () => scan(false);
$('scrollBtn').onclick = () => scan(true);
$('downloadBtn').onclick = download;
$('selAll').onclick = () => { if (state.busy) return; state.items.forEach((i) => (i.on = true)); render(); };
$('selNone').onclick = () => { if (state.busy) return; state.items.forEach((i) => (i.on = false)); render(); };

chrome.tabs.onUpdated.addListener((id, info) => {
  if (!state.busy && id === state.tabId && info.url && info.url !== state.pageUrl) {
    state.items = [];
    render();
    $('pageTitle').textContent = 'تغيّرت الصفحة — اضغط «فحص الصفحة»';
    status('');
  }
});
chrome.tabs.onActivated.addListener(() => {
  if (state.items.length && !state.busy) status('غيّرت التبويب — اضغط «فحص الصفحة» للتبويب الحالي');
});
render();
activeTab().then((t) => { if (/^https?:/.test(t?.url || '')) scan(false); }).catch(() => {});
