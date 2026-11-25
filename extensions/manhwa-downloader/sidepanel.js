import { makeZip } from './lib/zip.js';
import { makePdf } from './lib/pdf.js';

const $ = (id) => document.getElementById(id);
const RULE_ID = 1;
let state = { tabId: null, pageUrl: '', items: [] };

// ---------- دوال تنحقن في صفحة القارئ ----------

function scanPage() {
  const LAZY = ['data-src', 'data-lazy-src', 'data-original', 'data-url', 'data-lazy', 'data-echo',
    'data-cfsrc', 'data-full', 'data-image', 'data-img', 'data-pagespeed-lazy-src', 'data-srcset', 'data-lazy-srcset'];
  const abs = (u) => { try { return new URL(u.trim(), document.baseURI).href; } catch { return null; } };
  const bestSrcset = (v) => {
    let best = null, bw = -1;
    for (const part of v.split(',')) {
      const [u, d] = part.trim().split(/\s+/);
      const w = parseFloat(d) || 1;
      if (u && w > bw) { best = u; bw = w; }
    }
    return best;
  };
  const items = [];
  const seen = new Set();
  const nodes = document.querySelectorAll('img, canvas');
  nodes.forEach((el, order) => {
    const r = el.getBoundingClientRect();
    if (el.tagName === 'CANVAS') {
      if (el.width < 300 || el.height < 300) return;
      try {
        const url = el.toDataURL('image/png');
        items.push({ url, w: el.width, h: el.height, order, top: r.top + scrollY, loaded: true });
      } catch { /* لوحة محمية */ }
      return;
    }
    let lazy = null;
    for (const a of LAZY) {
      const v = el.getAttribute(a);
      if (v && v.trim() && !v.trim().startsWith('data:')) { lazy = a.includes('srcset') ? bestSrcset(v) : v; break; }
    }
    const cur = el.currentSrc || el.src || '';
    const placeholder = !cur || /^data:image\/(gif|svg)/.test(cur) ||
      /placeholder|loading|lazy|blank|spinner|pixel\.(gif|png)/i.test(cur) || (el.complete && el.naturalWidth > 0 && el.naturalWidth < 40);
    const raw = placeholder && lazy ? lazy : (cur || lazy);
    if (!raw) return;
    const url = raw.startsWith('data:') || raw.startsWith('blob:') ? raw : abs(raw);
    if (!url || seen.has(url)) return;
    const loaded = el.complete && el.naturalWidth > 0 && !placeholder;
    const w = loaded ? el.naturalWidth : Math.round(r.width) || +el.getAttribute('width') || 0;
    const h = loaded ? el.naturalHeight : Math.round(r.height) || +el.getAttribute('height') || 0;
    if (loaded && (w < 120 || h < 120)) return;
    if (!loaded && !lazy && r.width < 150) return;
    if (/\.svg(\?|$)/i.test(url)) return;
    seen.add(url);
    items.push({ url, w, h, order, top: r.top + scrollY, loaded });
  });
  return { title: document.title, url: location.href, items };
}

async function autoScroll() {
  const el = document.scrollingElement || document.documentElement;
  // بعض القرّاء يمرّرون داخل عنصر وليس الصفحة كلها
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
    await new Promise((r) => setTimeout(r, 300));
    const atEnd = target.scrollTop + view >= target.scrollHeight - 5;
    if (atEnd && target.scrollHeight === last) stable++; else stable = 0;
    last = target.scrollHeight;
  }
  await new Promise((r) => setTimeout(r, 800));
  target.scrollTop = start;
  return true;
}

async function fetchInPage(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const blob = await res.blob();
  return await new Promise((ok, bad) => {
    const fr = new FileReader();
    fr.onload = () => ok(fr.result);
    fr.onerror = () => bad(fr.error);
    fr.readAsDataURL(blob);
  });
}

// ---------- أدوات ----------

const status = (msg, cls = '') => { $('status').textContent = msg; $('status').className = 'status ' + cls; };
const progress = (done, total) => {
  $('progress').hidden = !total;
  $('bar').style.width = total ? `${Math.round((done / total) * 100)}%` : '0';
};

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

// نرسل Referer الصفحة مع طلبات الإضافة عشان المواقع اللي تمنع التحميل من خارجها
async function setReferer(pageUrl) {
  let origin = '';
  try { origin = new URL(pageUrl).origin; } catch {}
  const headers = [{ header: 'referer', operation: 'set', value: pageUrl }];
  if (origin) headers.push({ header: 'origin', operation: 'set', value: origin });
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [RULE_ID],
    addRules: [{
      id: RULE_ID, priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: headers },
      condition: { initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest', 'image', 'other'] },
    }],
  }).catch(() => {});
}

function pickDefaults(items) {
  // العرض الأكثر تكرارًا بين الصور الكبيرة = صور الفصل
  const big = items.filter((i) => i.loaded && i.w >= 300);
  const counts = new Map();
  big.forEach((i) => { const k = Math.round(i.w / 20); counts.set(k, (counts.get(k) || 0) + 1); });
  let main = 0, max = 0;
  counts.forEach((c, k) => { if (c > max) { max = c; main = k * 20; } });
  items.forEach((i) => {
    if (!i.loaded) i.on = true;
    else if (max >= 2) i.on = Math.abs(i.w - main) <= main * 0.15 && i.h >= 100;
    else i.on = i.w >= 300 && i.h >= 300;
  });
  if (!items.some((i) => i.on)) items.forEach((i) => (i.on = true));
}

// ---------- الفحص ----------

async function scan(withScroll = false) {
  const tab = await activeTab();
  if (!tab || !/^https?:/.test(tab.url || '')) { status('افتح صفحة الفصل في المتصفح أولاً', 'err'); return; }
  state.tabId = tab.id;
  state.pageUrl = tab.url;
  await setReferer(tab.url);
  $('scanBtn').disabled = $('scrollBtn').disabled = true;
  try {
    if (withScroll) {
      status('جاري تمرير الصفحة لتحميل كل الصور… لا تغيّر التبويب');
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: autoScroll });
    }
    status('جاري الفحص…');
    const results = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: scanPage });
    const main = results.find((r) => r.frameId === 0)?.result;
    const items = [];
    const seen = new Set();
    for (const r of results.sort((a, b) => a.frameId - b.frameId)) {
      for (const it of r.result?.items || []) {
        if (seen.has(it.url)) continue;
        seen.add(it.url);
        items.push({ ...it, frameId: r.frameId });
      }
    }
    items.sort((a, b) => a.frameId - b.frameId || a.order - b.order);
    pickDefaults(items);
    state.items = items;
    $('pageTitle').textContent = main?.title || tab.title || '';
    $('nameInput').value = cleanName(main?.title || tab.title);
    render();
    const unloaded = items.filter((i) => !i.loaded).length;
    status(items.length
      ? `لقيت ${items.length} صورة.` + (unloaded && !withScroll ? `\n${unloaded} منها ما انحمّلت بعد — جرّب «تمرير + فحص» لو ناقص شي.` : '')
      : 'ما لقيت صور. جرّب «تمرير + فحص» أو تأكد إنك في صفحة الفصل.', items.length ? 'ok' : 'err');
  } catch (e) {
    status('ما قدرت أفحص هذي الصفحة: ' + e.message, 'err');
  } finally {
    $('scanBtn').disabled = $('scrollBtn').disabled = false;
  }
}

function render() {
  const grid = $('grid');
  grid.textContent = '';
  if (!state.items.length) {
    grid.innerHTML = '<div class="empty">لا توجد صور بعد</div>';
  }
  state.items.forEach((it, idx) => {
    const d = document.createElement('div');
    d.className = 'thumb' + (it.on ? ' on' : '');
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = it.url;
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = idx + 1;
    const dim = document.createElement('span');
    dim.className = 'dim';
    dim.textContent = it.w && it.h ? `${it.w}×${it.h}` : 'غير محمّلة';
    d.append(img, num, dim);
    d.onclick = () => { it.on = !it.on; d.classList.toggle('on', it.on); updateCount(); };
    grid.append(d);
  });
  updateCount();
}

function updateCount() {
  const n = state.items.filter((i) => i.on).length;
  $('count').textContent = `${n} من ${state.items.length} صورة محددة`;
  $('downloadBtn').disabled = n === 0;
}

// ---------- التحميل ----------

function sniffType(b, fallback) {
  if (b[0] === 0xff && b[1] === 0xd8) return ['image/jpeg', 'jpg'];
  if (b[0] === 0x89 && b[1] === 0x50) return ['image/png', 'png'];
  if (b[0] === 0x47 && b[1] === 0x49) return ['image/gif', 'gif'];
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return ['image/webp', 'webp'];
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return ['image/avif', 'avif'];
  const m = (fallback || '').split(';')[0];
  return [m || 'image/jpeg', (m.split('/')[1] || 'jpg').replace('jpeg', 'jpg')];
}

async function getBytes(item) {
  if (!item.url.startsWith('blob:')) {
    try {
      const res = await fetch(item.url, { credentials: 'include', cache: 'force-cache' });
      if (res.ok) {
        const type = res.headers.get('content-type') || '';
        if (!/text\/html/.test(type)) return { data: new Uint8Array(await res.arrayBuffer()), type };
      }
    } catch { /* نجرب من داخل الصفحة */ }
  }
  const [r] = await chrome.scripting.executeScript({
    target: { tabId: state.tabId, frameIds: [item.frameId] }, func: fetchInPage, args: [item.url],
  });
  if (!r?.result) throw new Error('فشل');
  const res = await fetch(r.result);
  return { data: new Uint8Array(await res.arrayBuffer()), type: res.headers.get('content-type') || '' };
}

async function saveBlob(blob, filename, saveAs) {
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename, saveAs, conflictAction: 'uniquify' });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  }
}

async function download() {
  const chosen = state.items.filter((i) => i.on);
  if (!chosen.length) return;
  const fmt = document.querySelector('input[name=fmt]:checked').value;
  const saveAs = $('saveAs').checked;
  const name = cleanName($('nameInput').value);
  const pad = String(chosen.length).length < 3 ? 3 : String(chosen.length).length;
  $('downloadBtn').disabled = $('scanBtn').disabled = $('scrollBtn').disabled = true;
  await setReferer(state.pageUrl);

  const results = new Array(chosen.length);
  const failed = [];
  let done = 0, next = 0;
  status(`جاري تحميل الصور… 0/${chosen.length}`);
  progress(0, chosen.length);
  const worker = async () => {
    while (next < chosen.length) {
      const i = next++;
      for (let attempt = 0; attempt < 3 && !results[i]; attempt++) {
        try { results[i] = await getBytes(chosen[i]); } catch { await new Promise((r) => setTimeout(r, 600)); }
      }
      if (!results[i]) failed.push(i + 1);
      done++;
      progress(done, chosen.length);
      status(`جاري تحميل الصور… ${done}/${chosen.length}`);
    }
  };
  try {
    await Promise.all(Array.from({ length: 4 }, worker));
    const files = results.map((r, i) => {
      if (!r) return null;
      const [mime, ext] = sniffType(r.data, r.type);
      return { name: `${String(i + 1).padStart(pad, '0')}.${ext}`, data: r.data, mime };
    }).filter(Boolean);
    if (!files.length) throw new Error('ما قدرت أحمّل أي صورة من الموقع');

    if (fmt === 'zip') {
      status('جاري إنشاء ملف ZIP…');
      await saveBlob(makeZip(files), `Manhwa/${name}.zip`, saveAs);
    } else if (fmt === 'pdf') {
      status('جاري إنشاء ملف PDF…');
      progress(0, files.length);
      const pdf = await makePdf(files, (d, t) => { progress(d, t); status(`جاري إنشاء PDF… ${d}/${t}`); });
      await saveBlob(pdf, `Manhwa/${name}.pdf`, saveAs);
    } else {
      for (const f of files) await saveBlob(new Blob([f.data], { type: f.mime }), `Manhwa/${name}/${f.name}`, false);
    }
    status(`تم ✅ نزّلت ${files.length} صورة` + (failed.length ? `\nفشلت الصور رقم: ${failed.join('، ')}` : ''), failed.length ? 'err' : 'ok');
  } catch (e) {
    status('صار خطأ: ' + e.message, 'err');
  } finally {
    $('downloadBtn').disabled = $('scanBtn').disabled = $('scrollBtn').disabled = false;
    setTimeout(() => progress(0, 0), 1500);
  }
}

// ---------- الإعدادات والأحداث ----------

chrome.storage.local.get({ fmt: 'zip', saveAs: false }).then(({ fmt, saveAs }) => {
  const r = document.querySelector(`input[name=fmt][value=${fmt}]`);
  if (r) r.checked = true;
  $('saveAs').checked = saveAs;
});
document.querySelectorAll('input[name=fmt]').forEach((r) => r.addEventListener('change', () => chrome.storage.local.set({ fmt: r.value })));
$('saveAs').addEventListener('change', () => chrome.storage.local.set({ saveAs: $('saveAs').checked }));
$('scanBtn').onclick = () => scan(false);
$('scrollBtn').onclick = () => scan(true);
$('downloadBtn').onclick = download;
$('selAll').onclick = () => { state.items.forEach((i) => (i.on = true)); render(); };
$('selNone').onclick = () => { state.items.forEach((i) => (i.on = false)); render(); };

// لما ينتقل المستخدم لفصل ثاني نمسح النتائج القديمة
chrome.tabs.onUpdated.addListener((id, info) => {
  if (id === state.tabId && info.url && info.url !== state.pageUrl) {
    state.items = [];
    render();
    $('pageTitle').textContent = 'تغيّرت الصفحة — اضغط «فحص الصفحة»';
    status('');
  }
});
chrome.tabs.onActivated.addListener(() => {
  if (state.items.length) status('غيّرت التبويب — اضغط «فحص الصفحة» للتبويب الحالي');
});
render();
activeTab().then((t) => { if (/^https?:/.test(t?.url || '')) scan(false); }).catch(() => {});
