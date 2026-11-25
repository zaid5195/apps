import { makeZip } from './lib/zip.js';
import { makePdf } from './lib/pdf.js';
import { LANGS, FatalError, pickModels, translateImage } from './lib/translate.js';
import { typesetImage } from './lib/typeset.js';

// الفكرة: ما نطلب أي شي من الموقع. نأخذ الصور اللي المتصفح عرضها:
// 1) الملف الأصلي من ذاكرة المتصفح (CDP: Page.getResourceContent)
// 2) وإذا ما توفر: لقطة للصورة نفسها بدقتها الأصلية (CDP: Page.captureScreenshot)

const $ = (id) => document.getElementById(id);
let state = { tabId: null, pageUrl: '', items: [], busy: false, cache: new Map(), stop: null };
const cacheKey = (it) => `${state.pageUrl}#${it.frameId}#${it.idx}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- دوال تنحقن في صفحة القارئ ----------

const PH_RE = /placeholder|loading|blank|spinner|transparen|lazy[-_.]?(img|load)|dummy|pixel\.(gif|png)|grey\.|gray\./i;
const LAZY_ATTRS = ['data-src', 'data-url', 'data-lazy-src', 'data-original', 'data-lazy', 'data-echo',
  'data-cfsrc', 'data-full', 'data-image', 'data-img', 'data-pagespeed-lazy-src'];

function scanPage(LAZY, PH) {
  const ph = new RegExp(PH.source, PH.flags);
  const items = [];
  const seen = new Set();
  const groupKey = (el) => {
    const p = el.parentElement;
    const cls = (e) => (e && typeof e.className === 'string' ? e.className.trim().split(/\s+/).sort().join('.') : '');
    // الصور اللي في نفس الحاوية وبنفس الكلاس = صفحات الفصل
    return `${p?.tagName}.${cls(p)}|${p?.parentElement?.tagName}.${cls(p?.parentElement)}`;
  };
  // الحدود نسبةً لعرض الصفحة (في الجوال الصفحة ضيقة لما تكون اللوحة مفتوحة)
  const vw = innerWidth || document.documentElement.clientWidth || 400;
  const minW = Math.min(120, vw * 0.4);
  document.querySelectorAll('img, canvas').forEach((el, idx) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    el.setAttribute('data-mhd-idx', idx);
    if (el.tagName === 'CANVAS') {
      if (el.width < 200 || el.height < 200 || r.width < minW) return;
      items.push({ idx, tag: 'canvas', w: el.width, h: el.height, rw: Math.round(r.width), vw, loaded: true, key: groupKey(el) });
      return;
    }
    const lazy = LAZY.map((a) => el.getAttribute(a)).find((v) => v && v.trim() && !v.startsWith('data:'));
    const cur = el.currentSrc || el.src || '';
    let lazyAbs = '';
    try { lazyAbs = lazy ? new URL(lazy.trim(), document.baseURI).href : ''; } catch {}
    const small = el.complete && el.naturalWidth > 0 && el.naturalWidth * el.naturalHeight < 120 * 120;
    const placeholder = !cur || /^data:image\/(gif|svg)/.test(cur) || ph.test(cur) || (lazyAbs && lazyAbs !== cur && small);
    const loaded = el.complete && el.naturalWidth > 0 && !placeholder;
    if (/\.svg(\?|$)/i.test(cur)) return;
    if (loaded && (el.naturalWidth < 100 || el.naturalHeight < 100)) return;
    if (!loaded && !lazy && r.width < minW) return;
    const url = loaded ? cur : (lazyAbs || cur);
    if (seen.has(url)) return;
    seen.add(url);
    items.push({
      idx, tag: 'img', url, loaded, rw: Math.round(r.width), vw, key: groupKey(el),
      w: loaded ? el.naturalWidth : +el.getAttribute('width') || Math.round(r.width),
      h: loaded ? el.naturalHeight : +el.getAttribute('height') || Math.round(r.height),
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
async function prepareEl(idx, LAZY, PH) {
  const ph = new RegExp(PH.source, PH.flags);
  const el = document.querySelector(`[data-mhd-idx="${idx}"]`);
  if (!el) return null;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const isImg = el.tagName === 'IMG';
  const lazy = isImg && LAZY.map((a) => el.getAttribute(a)).find((v) => v && v.trim() && !v.startsWith('data:'));
  const ready = () => {
    if (!isImg) return true;
    const cur = el.currentSrc || el.src || '';
    return el.complete && el.naturalWidth > 40 && el.naturalWidth * el.naturalHeight >= 120 * 120 &&
      !/^data:image\/(gif|svg)/.test(cur) && !ph.test(cur);
  };
  el.scrollIntoView({ block: el.getBoundingClientRect().height > innerHeight ? 'start' : 'center', behavior: 'instant' });
  let t0 = Date.now();
  while (!ready() && Date.now() - t0 < 6000) await wait(150);
  if (!ready() && lazy) {
    // الموقع ما حمّلها — نحطها نحن مثل ما يسوي الموقع نفسه
    el.src = lazy.trim();
    t0 = Date.now();
    while (!ready() && Date.now() - t0 < 10000) await wait(150);
  }
  if (isImg) { try { await el.decode(); } catch {} }
  await wait(200);
  const r = el.getBoundingClientRect();
  return {
    ok: ready(), tag: el.tagName.toLowerCase(), url: isImg ? (el.currentSrc || el.src) : '',
    nw: isImg ? el.naturalWidth : el.width, nh: isImg ? el.naturalHeight : el.height,
    x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height,
  };
}

async function fetchInPage(url) {
  const res = await fetch(url, { credentials: 'include', cache: 'force-cache' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const blob = await res.blob();
  return await new Promise((ok, bad) => {
    const fr = new FileReader();
    fr.onload = () => ok(fr.result);
    fr.onerror = () => bad(fr.error);
    fr.readAsDataURL(blob);
  });
}

// نخفي الأشرطة الثابتة (فوق/تحت) عشان ما تطلع في لقطات الشاشة
function hideFixed(hide) {
  if (hide) {
    document.querySelectorAll('body *').forEach((e) => {
      const p = getComputedStyle(e).position;
      if (p === 'fixed' || p === 'sticky') { e.setAttribute('data-mhd-hidden', '1'); e.style.setProperty('visibility', 'hidden', 'important'); }
    });
  } else {
    document.querySelectorAll('[data-mhd-hidden]').forEach((e) => { e.style.removeProperty('visibility'); e.removeAttribute('data-mhd-hidden'); });
  }
}

// يمرّر بحيث يكون أعلى الصورة عند -offset من أعلى الشاشة
async function scrollPart(idx, offset) {
  const el = document.querySelector(`[data-mhd-idx="${idx}"]`);
  if (!el) return null;
  let sc = el.parentElement;
  while (sc && sc !== document.body) {
    const o = getComputedStyle(sc).overflowY;
    if (/(auto|scroll)/.test(o) && sc.scrollHeight > sc.clientHeight + 5) break;
    sc = sc.parentElement;
  }
  const delta = el.getBoundingClientRect().top + offset;
  if (sc && sc !== document.body) sc.scrollTop += delta; else scrollBy(0, delta);
  await new Promise((r) => setTimeout(r, 350));
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height, vw: innerWidth, vh: innerHeight };
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
const setBusy = (b) => {
  state.busy = b;
  const none = !state.items.some((i) => i.on);
  $('downloadBtn').disabled = b || none;
  $('trBtn').disabled = b || none;
  $('scanBtn').disabled = $('scrollBtn').disabled = b;
  $('stopBtn').hidden = !b;
};

function cleanName(s) {
  return (s || 'chapter')
    .replace(/\s*[|–—-]\s*(read|اقرأ|manga|manhwa|مانهوا|مانجا).*$/i, '')
    .replace(/[\\/:*?"<>|~\u0000-\u001f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
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

// ---------- طرق الالتقاط ----------
const PH_ARG = { source: PH_RE.source, flags: PH_RE.flags };
const RULE_ID = 1;

const cdp = {
  ok: false, shotBroken: false,
  async attach(tabId) {
    this.ok = false; this.shotBroken = false;
    try {
      await chrome.debugger.attach({ tabId }, '1.3').catch((e) => { if (!/already attached/i.test(e.message)) throw e; });
      await this.send(tabId, 'Page.enable');
      this.ok = true;
    } catch (e) { this.err = e.message; }
    return this.ok;
  },
  detach(tabId) { return chrome.debugger.detach({ tabId }).catch(() => {}); },
  send(tabId, method, params = {}) { return chrome.debugger.sendCommand({ tabId }, method, params); },
  async resourceMap(tabId) {
    const { frameTree } = await this.send(tabId, 'Page.getResourceTree');
    const map = new Map();
    const walk = (node) => {
      for (const r of node.resources || []) map.set(r.url, node.frame.id);
      (node.childFrames || []).forEach(walk);
    };
    walk(frameTree);
    return { map, top: frameTree.frame.id };
  },
  // 1) الملف الأصلي من ذاكرة المتصفح
  async original(tabId, url) {
    let res = await this.resourceMap(tabId);
    const frameId = res.map.get(url) || res.top;
    const { content, base64Encoded } = await this.send(tabId, 'Page.getResourceContent', { frameId, url });
    const bytes = base64Encoded ? b64ToBytes(content) : new TextEncoder().encode(content);
    if (!sniffType(bytes)[0]) throw new Error('not image');
    return bytes;
  },
  // 2) لقطة للعنصر بدقته الأصلية
  async shot(tabId, info) {
    const scale = Math.min(Math.max(info.nw / info.w || 1, 1), 4);
    const { data } = await this.send(tabId, 'Page.captureScreenshot', {
      format: 'jpeg', quality: 95, captureBeyondViewport: true,
      clip: { x: info.x, y: info.y, width: info.w, height: info.h, scale },
    });
    return b64ToBytes(data);
  },
};

// 3) الملف الأصلي عبر الإضافة (نفس الطلب اللي سواه المتصفح، مع رابط الصفحة كـ Referer)
async function setReferer(pageUrl) {
  let origin = '';
  try { origin = new URL(pageUrl).origin; } catch {}
  const headers = [{ header: 'referer', operation: 'set', value: pageUrl }];
  if (origin) headers.push({ header: 'origin', operation: 'set', value: origin });
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [RULE_ID],
    addRules: [{ id: RULE_ID, priority: 1, action: { type: 'modifyHeaders', requestHeaders: headers },
      condition: { initiatorDomains: [chrome.runtime.id], excludedRequestDomains: ['googleapis.com'], resourceTypes: ['xmlhttprequest', 'other'] } }],
  }).catch(() => {});
}
const clearReferer = () => chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [RULE_ID] }).catch(() => {});

async function fetchExt(url) {
  const res = await fetch(url, { credentials: 'include', cache: 'force-cache' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!sniffType(bytes)[0]) throw new Error('not image');
  return bytes;
}

// 4) لقطات الشاشة المرئية وتركيبها (تشتغل في كل المتصفحات)
let lastCap = 0, fixedHidden = false;
async function visibleShot(it) {
  if (it.frameId !== 0) throw new Error('inside iframe');
  const tab = await chrome.tabs.get(state.tabId);
  const target = { tabId: state.tabId };
  if (!fixedHidden) { await chrome.scripting.executeScript({ target, func: hideFixed, args: [true] }); fixedHidden = true; }
  let canvas, ctx, k, H = 0, covered = 0;
  for (let guard = 0; guard < 60; guard++) {
    const [{ result: r }] = await chrome.scripting.executeScript({ target, func: scrollPart, args: [it.idx, covered] });
    if (!r || !r.width || !r.height) throw new Error('element gone');
    const wait = 600 - (Date.now() - lastCap);
    if (wait > 0) await sleep(wait);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    lastCap = Date.now();
    const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
    if (!canvas) {
      k = bmp.width / r.vw; H = r.height;
      canvas = new OffscreenCanvas(Math.max(1, Math.floor(r.width * k)), Math.max(1, Math.floor(r.height * k)));
      ctx = canvas.getContext('2d');
    }
    const from = Math.max(0, r.top, r.top + covered);
    const to = Math.min(r.vh, r.top + r.height);
    if (to - from < 1) { bmp.close(); break; }
    ctx.drawImage(bmp, r.left * k, from * k, r.width * k, (to - from) * k, 0, (from - r.top) * k, r.width * k, (to - from) * k);
    bmp.close();
    const now = to - r.top;
    if (now <= covered + 1) break;
    covered = now;
    if (covered >= H - 1) break;
  }
  if (!canvas || covered < H * 0.95) throw new Error(`covered ${Math.round(covered)}/${Math.round(H)}`);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
  return new Uint8Array(await blob.arrayBuffer());
}

// ---------- الفحص ----------

function pickDefaults(items) {
  // «عريضة» = نصف عرض الصفحة أو أكثر (مو رقم ثابت، عشان الجوال)
  const wide = (i) => i.rw >= Math.min(150, (i.vw || 400) * 0.45);
  const sameW = (a, w) => Math.abs(a - w) <= Math.max(w * 0.08, 6);
  const modeW = (list) => {
    const c = new Map();
    list.forEach((i) => { const k = Math.round(i.rw / 5); c.set(k, (c.get(k) || 0) + 1); });
    let w = 0, m = 0;
    c.forEach((n, k) => { if (n > m) { m = n; w = k * 5; } });
    return { w, m };
  };
  // 1) أكبر مجموعة صور عريضة في نفس الحاوية = صفحات الفصل
  const groups = new Map();
  items.forEach((i) => { if (wide(i) || !i.loaded) groups.set(i.key, [...(groups.get(i.key) || []), i]); });
  let best = null;
  groups.forEach((g) => { if (!best || g.length > best.length) best = g; });
  state.groupInfo = [...groups.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 4)
    .map(([k, g]) => `${g.length}× ${k.slice(0, 70)} rw=${g.slice(0, 3).map((i) => i.rw).join(',')}`);
  if (best && best.length >= 3) {
    const { w } = modeW(best.filter(wide));
    const set = new Set(best);
    // داخل الحاوية: نستبعد اللي عرضه مختلف (إعلان بين الصفحات)
    items.forEach((i) => (i.on = set.has(i) && (!w || !wide(i) || sameW(i.rw, w))));
    return;
  }
  // 2) وإلا: الصور العريضة اللي بنفس العرض
  const { w, m } = modeW(items.filter(wide));
  items.forEach((i) => {
    if (m >= 2) i.on = wide(i) && sameW(i.rw, w);
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
    const results = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: scanPage, args: [LAZY_ATTRS, PH_ARG] });
    const main = results.find((r) => r.frameId === 0)?.result;
    const items = [];
    for (const r of results.sort((a, b) => a.frameId - b.frameId)) {
      for (const it of r.result?.items || []) items.push({ ...it, key: r.frameId + '|' + it.key, frameId: r.frameId });
    }
    pickDefaults(items);
    state.items.forEach((i) => i.thumb && URL.revokeObjectURL(i.thumb));
    state.items = items;
    for (const it of items) {
      const c = state.cache.get(cacheKey(it));
      if (c) Object.assign(it, { bytes: c.bytes, mime: c.mime, tr: c.tr, ts: c.ts, thumb: URL.createObjectURL(new Blob([c.bytes], { type: c.mime })) });
    }
    $('pageTitle').textContent = main?.title || tab.title || '';
    $('nameInput').value = cleanName(main?.title || tab.title);
    $('log').textContent = `page width: ${items[0]?.vw}px\ngroups:\n  ` + (state.groupInfo || []).join('\n  ');
    $('logBox').hidden = false;
    $('logBox').open = false;
    render();
    const on = items.filter((i) => i.on).length;
    status(items.length
      ? `لقيت ${on} صورة للفصل. اضغط «تحميل الفصل» وبتنلقط صورة صورة.`
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
    d.className = 'thumb' + (it.on ? ' on' : '') + (it.thumb ? ' done' : '') + (it.failed ? ' fail' : '') + (it.tr ? ' tr' : '');
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
  if (!state.busy) $('downloadBtn').disabled = $('trBtn').disabled = n === 0;
}

// ---------- الالتقاط والتحميل ----------

const METHOD_NAMES = { cache: 'من ذاكرة المتصفح', canvas: 'من اللوحة', page: 'من الصفحة', net: 'الملف الأصلي', cdpshot: 'لقطة عالية الدقة', screen: 'لقطة شاشة' };

async function captureItem(it, shotOnly) {
  const target = { tabId: state.tabId, frameIds: [it.frameId] };
  const errs = [];
  const [{ result: info }] = await chrome.scripting.executeScript({ target, func: prepareEl, args: [it.idx, LAZY_ATTRS, PH_ARG] });
  if (!info) throw new Error('الصورة اختفت من الصفحة');
  if (info.tag === 'img' && !info.ok) errs.push('not loaded: ' + (info.url || '').slice(0, 80));
  it.w = info.nw; it.h = info.nh; it.loaded = true;
  const tryIt = async (name, fn) => {
    try { const bytes = await fn(); if (bytes?.length) return { bytes, how: name }; errs.push(name + ': empty'); }
    catch (e) { errs.push(name + ': ' + (e?.message || e)); }
    return null;
  };
  let r = null;
  if (!shotOnly) {
    if (info.tag === 'canvas') {
      r = await tryIt('canvas', async () => {
        const [{ result }] = await chrome.scripting.executeScript({ target, func: canvasData, args: [it.idx] });
        if (!result) throw new Error('tainted');
        return dataUrlToBytes(result);
      });
    } else if (info.url) {
      if (info.url.startsWith('data:')) r = await tryIt('page', () => dataUrlToBytes(info.url));
      if (!r && cdp.ok) r = await tryIt('cache', () => cdp.original(state.tabId, info.url));
      if (!r && !info.url.startsWith('blob:')) r = await tryIt('net', () => fetchExt(info.url));
      if (!r) r = await tryIt('page', async () => {
        const [{ result }] = await chrome.scripting.executeScript({ target, func: fetchInPage, args: [info.url] });
        return dataUrlToBytes(result);
      });
    }
  }
  if (!r && cdp.ok && !cdp.shotBroken && it.frameId === 0) {
    r = await tryIt('cdpshot', () => cdp.shot(state.tabId, info));
    if (!r) cdp.shotBroken = true;
  }
  if (!r) r = await tryIt('screen', () => visibleShot(it));
  if (!r) throw new Error(errs.join('\n   '));
  return r;
}

async function saveBlob(blob, filename, saveAs) {
  const url = URL.createObjectURL(blob);
  try {
    try { await chrome.downloads.download({ url, filename, saveAs, conflictAction: 'uniquify' }); }
    catch (e) {
      if (!/filename/i.test(e.message)) throw e;
      // بعض المتصفحات ترفض الاسم: نحفظه باسم بديل بدل ما يضيع الملف
      const ext = filename.match(/\.[a-z0-9]+$/i)?.[0] || '';
      const safe = filename.replace(/\.[a-z0-9]+$/i, '').split('/').map((p) => p.replace(/[^\w\- ().]/g, '').trim() || 'chapter-' + Date.now()).join('/');
      await chrome.downloads.download({ url, filename: safe + ext, saveAs, conflictAction: 'uniquify' });
    }
  }
  finally { setTimeout(() => URL.revokeObjectURL(url), 120000); }
}

// يجهز الالتقاط (أداة المتصفح + Referer + حفظ مكان القراءة) ويرجع كل شي لحاله بعده
async function withCapture(log, fn) {
  fixedHidden = false;
  const tabTarget = { tabId: state.tabId };
  let pos = null;
  try {
    const attached = await cdp.attach(state.tabId);
    log.push('debugger: ' + (attached ? 'ok' : 'unavailable (' + cdp.err + ')'));
    await setReferer(state.pageUrl);
    [{ result: pos }] = await chrome.scripting.executeScript({ target: tabTarget, func: () => [scrollX, scrollY] });
    return await fn();
  } finally {
    if (fixedHidden) await chrome.scripting.executeScript({ target: tabTarget, func: hideFixed, args: [false] }).catch(() => {});
    if (pos) await chrome.scripting.executeScript({ target: tabTarget, func: (x, y) => scrollTo(x, y), args: pos }).catch(() => {});
    await cdp.detach(state.tabId);
    await clearReferer();
  }
}

// يلتقط الصور اللي ما انلقطت قبل (اللي انلقطت تنحفظ وما نعيدها)
async function captureMissing(items, log, used, onEach) {
  const shotOnly = $('shotOnly').checked;
  const todo = items.filter((it) => !it.bytes);
  let failedLogged = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (state.stop?.aborted) break;
    if (!it.bytes) {
      status(`جاري التقاط الصورة ${todo.indexOf(it) + 1} من ${todo.length}…`);
      try {
        const { bytes, how } = await captureItem(it, shotOnly);
        used[how] = (used[how] || 0) + 1;
        it.bytes = bytes;
        it.mime = sniffType(bytes)[0];
        it.failed = false;
        if (it.thumb) URL.revokeObjectURL(it.thumb);
        it.thumb = URL.createObjectURL(new Blob([bytes], { type: it.mime }));
        state.cache.set(cacheKey(it), { bytes, mime: it.mime, tr: it.tr });
      } catch (e) {
        it.failed = true;
        if (++failedLogged <= 3) log.push(`#${state.items.indexOf(it) + 1}:\n   ${e.message}`);
      }
      progress(i + 1, items.length);
      if (i % 5 === 4) render();
    }
    if (it.bytes) onEach?.(it);
  }
  render();
}

// ---------- الترجمة ----------

let models = null; // { list, i }
const trCtx = [];

async function getModels(key) {
  if (models) return models;
  const { gemModels, gemModelKey, gemModelAt } = await chrome.storage.local.get(['gemModels', 'gemModelKey', 'gemModelAt']);
  if (gemModels?.length && gemModelKey === key.slice(-6) && Date.now() - (gemModelAt || 0) < 86400000) return (models = { list: gemModels, i: 0 });
  let list;
  try { list = await pickModels(key); } catch (e) { if (e instanceof FatalError) throw e; list = ['gemini-2.5-flash', 'gemini-2.5-flash-lite']; }
  chrome.storage.local.set({ gemModels: list, gemModelKey: key.slice(-6), gemModelAt: Date.now() });
  return (models = { list, i: 0 });
}

async function ensureTypeset(it) {
  if (it.ts || !it.tr) return it.ts;
  it.ts = it.tr.length ? await typesetImage(it.bytes, it.mime, it.tr, state.trLang || $('langSel').value) : { bytes: null, patches: [] };
  const c = state.cache.get(cacheKey(it));
  if (c) c.ts = it.ts;
  return it.ts;
}

async function showOverlay(it) {
  if (!it.tr?.length) return;
  await ensureTypeset(it);
  const target = { tabId: state.tabId, frameIds: [it.frameId] };
  await chrome.scripting.executeScript({ target, files: ['overlay.js'] });
  await chrome.scripting.executeScript({
    target, func: (idx, patches) => window.__mhdOverlay.add(idx, patches), args: [it.idx, it.ts.patches],
  });
  $('ovBtn').disabled = false;
  $('ovBtn').textContent = '👁️ إخفاء الترجمة';
}

// طابور ترجمة: ترجمتين في نفس الوقت، والالتقاط يكمل بالتوازي
function makeTranslator(key, lang, stats) {
  let active = 0, fatal = null, waiting = '';
  const queue = [];
  const done = [];
  const pump = () => {
    while (active < 2 && queue.length && !fatal && !state.stop?.aborted) {
      const it = queue.shift();
      active++;
      const signal = {
        get aborted() { return state.stop?.aborted; },
        onWait: (s, why) => { waiting = why === 'اتصال' ? ` (انقطع الاتصال، نعيد بعد ${s} ث)` : ` (Gemini مزحوم، ننتظر ${s} ث)`; stats.update?.(waiting); },
        onModel: (m) => { $('modelName').textContent = m; waiting = ` (انتقلنا لموديل ${m})`; stats.update?.(waiting); },
      };
      const p = (async () => {
        const ms = await getModels(key);
        $('modelName').textContent = ms.list[ms.i];
        it.tr = await translateImage(it.bytes, it.mime, { key, models: ms, lang, context: trCtx.slice(-12), signal });
        waiting = '';
        it.tr.forEach((b) => trCtx.push(`${b.text} → ${b.tr}`));
        const c = state.cache.get(cacheKey(it));
        if (c) c.tr = it.tr;
        stats.ok++;
        stats.bubbles += it.tr.length;
        await showOverlay(it).catch(() => {});
        render();
      })().catch((e) => {
        if (e instanceof FatalError) { fatal = e; if (state.stop) state.stop.aborted = true; }
        else { stats.fail++; stats.errs.push(e.message); }
      }).finally(() => { active--; stats.update?.(waiting); pump(); });
      done.push(p);
    }
  };
  return {
    add(it) { if (!it.tr && it.bytes) { queue.push(it); pump(); } },
    async finish() {
      while (queue.length || active) {
        if (fatal) throw fatal;
        await Promise.allSettled(done.slice());
        await sleep(50);
        pump();
      }
      if (fatal) throw fatal;
    },
    get waiting() { return waiting; },
  };
}

async function translateChapter({ andThen } = {}) {
  const key = $('keyInput').value.trim();
  const items = state.items.filter((i) => i.on);
  if (!key) { status('حط مفتاح Gemini أولاً (فوق في قسم الترجمة)', 'err'); $('keyInput').focus(); return null; }
  if (!items.length) return null;
  const lang = $('langSel').value;
  if (state.trLang && state.trLang !== lang) { state.items.forEach((i) => (i.tr = i.ts = null)); state.cache.forEach((c) => (c.tr = c.ts = null)); trCtx.length = 0; }
  state.trLang = lang;
  setBusy(true);
  state.stop = { aborted: false };
  const log = [];
  const used = {};
  const stats = { ok: 0, fail: 0, bubbles: 0, errs: [] };
  const total = items.filter((i) => !i.tr).length;
  stats.update = (w) => status(`جاري الترجمة… ${stats.ok + stats.fail}/${total}${w || ''}`);
  try {
    const tr = makeTranslator(key, lang, stats);
    await withCapture(log, () => captureMissing(items, log, used, (it) => {
      if (it.tr) showOverlay(it).catch(() => {}); else tr.add(it);
    }));
    status(`جاري الترجمة… ${stats.ok + stats.fail}/${total}${tr.waiting}`);
    await tr.finish();
    if (stats.errs.length) log.push('translate errors:\n   ' + [...new Set(stats.errs)].slice(0, 3).join('\n   '));
    const failedCap = items.filter((i) => i.failed).length;
    const already = items.filter((i) => i.tr).length - stats.ok;
    if (!stats.ok && !already) {
      status('ما قدرت أترجم أي صورة 😕' + (stats.errs[0] ? `\nالسبب: ${stats.errs[0]}` : '') + '\nجرّب «ترجم الفصل» مرة ثانية بعد شوي', 'err');
      return null;
    }
    if (!andThen) {
      status(`تمت الترجمة ✅ ${stats.ok + already} صورة، ${stats.bubbles} فقاعة جديدة` +
        (stats.fail || failedCap ? `\nفشلت ${stats.fail + failedCap} صورة — اضغط «ترجم الفصل» مرة ثانية يكمل الناقص بس` : ''), stats.fail || failedCap ? 'err' : 'ok');
    }
    return true;
  } catch (e) {
    status((e instanceof FatalError ? '' : 'صار خطأ في الترجمة: ') + e.message, 'err');
    return null;
  } finally {
    if (log.length > 1) { $('log').textContent = log.join('\n'); $('logBox').hidden = false; }
    if (!andThen) { setBusy(false); setTimeout(() => progress(0, 0), 1500); }
  }
}

// ---------- التحميل ----------

async function download() {
  const chosen = state.items.filter((i) => i.on);
  if (!chosen.length) return;
  const fmt = document.querySelector('input[name=fmt]:checked').value;
  const saveAs = $('saveAs').checked;
  const withTr = $('trDl').checked;
  const name = cleanName($('nameInput').value) + (withTr ? ` (${LANGS[$('langSel').value]?.name || ''})` : '');
  const pad = Math.max(3, String(chosen.length).length);
  const log = [];
  const used = {};
  try {
    if (withTr) {
      // الترجمة تلتقط الصور الناقصة وتترجمها، بعدين نكمل التحميل
      if (!(await translateChapter({ andThen: true }))) return;
    } else {
      setBusy(true);
      state.stop = { aborted: false };
      status('جاري التجهيز…');
      if (chosen.some((i) => !i.bytes)) await withCapture(log, () => captureMissing(chosen, log, used));
    }
    const files = [];
    const failed = [];
    for (let i = 0; i < chosen.length; i++) {
      const it = chosen[i];
      if (!it.bytes) { failed.push(i + 1); continue; }
      let data = it.bytes, mime = it.mime;
      if (withTr && it.tr?.length) {
        status(`جاري تجهيز الصور المترجمة… ${i + 1}/${chosen.length}`);
        const ts = await ensureTypeset(it);
        if (ts?.bytes) { data = ts.bytes; mime = 'image/jpeg'; }
      }
      const ext = sniffType(data)[1];
      files.push({ name: `${String(i + 1).padStart(pad, '0')}.${ext}`, data, mime });
    }
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
    const how = Object.entries(used).map(([k, v]) => `${v} ${METHOD_NAMES[k]}`).join('، ');
    status(`تم ✅ ${files.length} صورة` + (how ? ` (${how})` : '') + (failed.length ? `\nما قدرت ألتقط الصور رقم: ${failed.join('، ')}` : ''), failed.length ? 'err' : 'ok');
    if (failed.length) log.push('failed: ' + failed.join(', '));
  } catch (e) {
    status('صار خطأ: ' + e.message, 'err');
  } finally {
    if (log.length > 1) { $('log').textContent = log.join('\n'); $('logBox').hidden = false; }
    setBusy(false);
    render();
    setTimeout(() => progress(0, 0), 1500);
  }
}

// ---------- الإعدادات والأحداث ----------

for (const [code, l] of Object.entries(LANGS)) $('langSel').add(new Option(l.name, code));
chrome.storage.local.get({ fmt: 'zip', saveAs: false, shotOnly: false, trDl: false, gemKey: '', lang: 'ar' }).then((o) => {
  const r = document.querySelector(`input[name=fmt][value=${o.fmt}]`);
  if (r) r.checked = true;
  $('saveAs').checked = o.saveAs;
  $('shotOnly').checked = o.shotOnly;
  $('trDl').checked = o.trDl;
  $('keyInput').value = o.gemKey;
  $('langSel').value = o.lang;
});
$('keyInput').addEventListener('change', () => { models = null; chrome.storage.local.set({ gemKey: $('keyInput').value.trim() }); });
$('langSel').addEventListener('change', () => chrome.storage.local.set({ lang: $('langSel').value }));
$('trDl').addEventListener('change', () => chrome.storage.local.set({ trDl: $('trDl').checked }));
$('trBtn').onclick = () => translateChapter();
$('stopBtn').onclick = () => { if (state.stop) state.stop.aborted = true; status('جاري الإيقاف…'); };
$('ovBtn').onclick = async () => {
  const res = await chrome.scripting.executeScript({ target: { tabId: state.tabId, allFrames: true }, func: () => window.__mhdOverlay?.toggle() });
  const shown = res.find((r) => r.result !== undefined && r.result !== null)?.result;
  $('ovBtn').textContent = shown === false ? '👁️ إظهار الترجمة' : '👁️ إخفاء الترجمة';
};
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
    state.cache.clear();
    trCtx.length = 0;
    $('ovBtn').disabled = true;
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
