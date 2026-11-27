// Reel Studio UI (RTL Arabic, mobile-first). Works against the PC server or fully in the browser (phone mode).
import { STAGES, LENGTHS, DEFAULT_STYLE } from './core/pipeline.js';
import { GEMINI_VOICES } from './core/providers.js';
import { resolveIcon } from './core/icons.js';
import { LLM_PRESETS, presetById } from './core/defaults.js';
import { LANGS } from './core/lang.js';
import { providerOf, isLocalUrl, fixBaseUrl, providerFromKey, looksLikeKey } from './core/errors.js';
import { createRenderer, loadFonts } from './render/engine.js';
import { icon } from './ui-icons.js';

const STAGE_AR = { script: 'السكريبت', voice: 'الصوت', timing: 'التوقيت', storyboard: 'الستوري بورد', render: 'الرندر' };
const STATUS_AR = { idle: 'في الانتظار', running: 'شغّال…', review: 'محتاج موافقتك', done: 'تم', error: 'خطأ' };
const MUSIC_AR = [['calm', '🎹 هادئ'], ['suspense', '🕵 تشويق'], ['upbeat', '⚡ حماسي'], ['none', '🔇 بدون']];
const CAPTIONS_AR = [['classic', 'عادي'], ['word', 'كلمة كبيرة'], ['box', 'صندوق']];
const FORMATS_AR = [['9:16', '9:16 ريلز'], ['1:1', '1:1 مربع'], ['16:9', '16:9 يوتيوب']];
const VOICE_AR = [['tts', 'ElevenLabs'], ['gemini', 'Gemini (مجاني)'], ['upload', 'صوتي أنا']];
/** Style controls (music / captions / end screen / hook / formats). Mutates `st`. */
function styleControls(st, onChange = () => {}) {
  const fm = h('div', { class: 'chips' }, FORMATS_AR.map(([v, l]) => h('span', { class: 'chip' + (st.formats.includes(v) ? ' on' : ''), onclick: e => {
    const on = !st.formats.includes(v);
    st.formats = on ? [...st.formats, v] : st.formats.filter(x => x !== v);
    if (!st.formats.length) st.formats = ['9:16'];
    st.formats.sort((a, b) => FORMATS_AR.findIndex(x => x[0] === a) - FORMATS_AR.findIndex(x => x[0] === b));
    [...fm.children].forEach((c, i) => c.classList.toggle('on', st.formats.includes(FORMATS_AR[i][0])));
    onChange(); void e;
  } }, l)));
  const chk = (key, label) => h('label', { class: 'row', style: 'gap:8px;color:var(--text)' }, h('input', { type: 'checkbox', checked: st[key], onchange: e => { st[key] = e.target.checked; onChange(); } }), label);
  return h('div', {},
    h('label', {}, 'الموسيقى'), seg(MUSIC_AR, st.music, v => { st.music = v; onChange(); }),
    h('label', {}, 'شكل الترجمة'), seg(CAPTIONS_AR, st.captions, v => { st.captions = v; onChange(); }),
    h('label', {}, 'المقاسات'), fm,
    h('div', { style: 'margin-top:8px' }, chk('hook', 'بداية خاطفة (الجملة الأولى بخط كبير)'), chk('endScreen', 'شاشة النهاية (تابعني + سؤال للتعليقات)')),
    h('div', { class: 'grid2' },
      h('div', {}, h('label', {}, 'الاسم في شاشة النهاية'), h('input', { type: 'text', dir: 'auto', value: st.handle ?? '', placeholder: '@username (من الإعدادات)', oninput: e => { st.handle = e.target.value; onChange(); } })),
      h('div', {}, h('label', {}, 'السطر تحت الاسم'), h('input', { type: 'text', dir: 'auto', value: st.endFollow ?? '', placeholder: 'تابعني عشان الحلقة الجاية', oninput: e => { st.endFollow = e.target.value; onChange(); } }))),
    h('label', {}, 'سؤال التعليقات'), h('input', { type: 'text', dir: 'auto', value: st.endComment ?? '', placeholder: 'قولّي في الكومنتات: نشرح إيه المرة الجاية؟', oninput: e => { st.endComment = e.target.value; onChange(); } }));
}
const TYPE_AR = { intro: 'بداية', question: 'سؤال', concept: 'فكرة', process: 'خطوات', compare: 'مقارنة', stat: 'رقم', recap: 'خلاصة' };

// ---------------------------------------------------------------- tiny DOM helpers
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && k !== 'list' && k !== 'form') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
const $ = s => document.querySelector(s);
const clean = (...a) => a.flat().filter(x => x != null && x !== false);
const app = $('#app');
let toastTimer;
function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), bad ? 6000 : 2500);
}
const fmtT = s => (s == null ? '–' : Number(s).toFixed(2));
const ago = iso => { const d = (Date.now() - new Date(iso)) / 1000; return d < 60 ? 'الآن' : d < 3600 ? `من ${Math.round(d / 60)} د` : d < 86400 ? `من ${Math.round(d / 3600)} س` : new Date(iso).toLocaleDateString('ar-EG'); };
async function guard(fn, okMsg) { try { const r = await fn(); if (okMsg) toast(okMsg); return r; } catch (e) { toast(e.message || String(e), true); throw e; } }

// ---------------------------------------------------------------- backend selection
let be;
async function pickBackend() {
  const forceLocal = new URLSearchParams(location.search).get('mode') === 'local' || localStorage.getItem('reel.mode') === 'local';
  if (!forceLocal) {
    try {
      const ctl = new AbortController();
      setTimeout(() => ctl.abort(), 1500);
      const r = await fetch('api/health', { signal: ctl.signal });
      if (r.ok && (await r.json()).mode === 'server') { const { RemoteBackend } = await import('./backends/remote.js'); return new RemoteBackend(); }
    } catch {}
  }
  const { LocalBackend } = await import('./backends/local.js');
  return new LocalBackend();
}

// ---------------------------------------------------------------- router
let cleanup = null;
async function route() {
  cleanup?.(); cleanup = null;
  const hash = location.hash.slice(1) || '/';
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('on', (hash.startsWith('/settings') ? 'settings' : 'home') === a.dataset.nav));
  document.querySelectorAll('.overlay').forEach(o => o.remove());
  app.replaceChildren();
  window.scrollTo(0, 0);
  try {
    if (hash.startsWith('/p/')) await viewProject(hash.slice(3));
    else if (hash.startsWith('/settings')) await viewSettings();
    else await viewHome();
  } catch (e) { app.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'card err' }, e.message))); }
}
window.addEventListener('hashchange', route);

// ---------------------------------------------------------------- home (workflow list)
const STATUS_EN = { idle: 'جاهز', running: 'شغّال', review: 'بانتظارك', done: 'نجح', error: 'خطأ' };
function overallStatus(stages) {
  const v = STAGES.map(s => stages[s]?.status || stages[s]);
  if (v.includes('running')) return 'running';
  if (v.includes('error')) return 'error';
  if (v.includes('review')) return 'review';
  if (v.every(x => x === 'done')) return 'done';
  return 'idle';
}
function pill(st) { return h('span', { class: 'pill ' + st }, h('i', { class: 'd' }), STATUS_EN[st]); }

/** Modal dialog. Returns {el, close}. */
function modal(title, iconName, body, { foot, narrow = false, onClose } = {}) {
  const ov = h('div', { class: 'overlay' });
  const close = () => { ov.remove(); document.removeEventListener('keydown', esc); onClose?.(); };
  const esc = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc);
  ov.addEventListener('pointerdown', e => { if (e.target === ov) ov._down = true; });
  ov.addEventListener('click', e => { if (e.target === ov && ov._down) close(); ov._down = false; });
  const panel = h('div', { class: 'ndv' + (narrow ? ' narrow' : '') },
    h('div', { class: 'ndv-head' }, h('span', { class: 'ic' }, icon(iconName, 20)), h('h2', {}, title), h('button', { class: 'ghost icon sm', title: 'إغلاق', onclick: close }, icon('x', 18))),
    h('div', { class: 'ndv-body' }, body),
    foot ? h('div', { class: 'ndv-foot' }, foot) : null);
  ov.append(panel);
  document.body.append(ov);
  return { el: ov, panel, close };
}

async function viewHome() {
  const settings = await be.getSettings();
  const llmPr = providerOf(settings.llm.baseUrl);
  const missing = [];
  const hasBackup = (settings.llmBackups || []).some(b => b.hasKey && b.enabled !== false);
  if (!settings.has?.llm && !isLocalUrl(settings.llm.baseUrl) && !hasBackup) missing.push([llmPr.name, llmPr.link]);
  if (!settings.has?.eleven && !settings.has?.gemini && !(settings.has?.llm && /generativelanguage/.test(settings.llm.baseUrl))) missing.push(['صوت (ElevenLabs أو Gemini)', 'https://elevenlabs.io/app/developers/']);
  if (be.mode === 'local' && isLocalUrl(settings.llm.baseUrl) && !hasBackup) missing.push(['LLM أونلاين (FreeLLMAPI ما يشتغلش من الهاتف)', '']);

  const opts = {
    length: +(localStorage.getItem('reel.length') || 10),
    voiceSource: localStorage.getItem('reel.voice') || 'tts',
    lang: localStorage.getItem('reel.lang') || 'ar',
    style: { ...DEFAULT_STYLE, ...(settings.style || {}), handle: settings.style?.handle },
    approvals: { ...settings.approvals },
  };
  opts.style.formats = [...(opts.style.formats || ['9:16'])];

  const list = h('div', { class: 'wf-list' }, h('p', { class: 'muted' }, '…'));
  const batchInfo = h('div', { class: 'hint' });
  const page = h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'الريلز'), h('div', { class: 'sub' }, 'كل ريل = workflow: موضوع ← سكريبت ← صوت ← توقيت ← ستوري بورد ← رندر')),
      h('span', { class: 'spacer' }),
      h('button', { class: 'sm', onclick: () => openBatch() }, icon('stack', 16), 'دفعة مواضيع'),
      h('button', { class: 'primary', onclick: () => openNew() }, icon('plus', 18), 'ريل جديد')),
    missing.length ? h('div', { class: 'banner' }, icon('key', 20),
      h('div', { class: 'grow' }, h('b', {}, 'ناقص مفاتيح قبل ما تبدأ'),
        h('div', { class: 'small muted' }, missing.map(([n, l], i) => [i ? ' · ' : '', n, l ? [' (', h('a', { href: l, target: '_blank', rel: 'noopener' }, 'مفتاح مجاني'), ')'] : null]))),
      h('a', { class: 'btn sm primary', href: '#/settings' }, 'الإعدادات')) : null,
    batchInfo, list);
  app.append(page);

  function commonFields() {
    const lenChips = h('div', { class: 'chips' }, LENGTHS.map(l => h('span', { class: 'chip' + (l === opts.length ? ' on' : ''), onclick: e => { opts.length = l; localStorage.setItem('reel.length', l); [...e.target.parentNode.children].forEach(c => c.classList.toggle('on', c === e.target)); } }, `${l} ث`)));
    const langSeg = seg(Object.values(LANGS).map(l => [l.id, (l.id === 'ar' ? '🇪🇬 ' : '🇪🇸 ') + l.name]), opts.lang, v => { opts.lang = v; localStorage.setItem('reel.lang', v); });
    const srcSeg = seg(VOICE_AR, opts.voiceSource, v => { opts.voiceSource = v; localStorage.setItem('reel.voice', v); });
    return [
      h('div', { class: 'grid2' }, h('div', {}, h('label', {}, 'لغة الفيديو'), langSeg), h('div', {}, h('label', {}, 'التعليق الصوتي'), srcSeg)),
      h('label', {}, 'المدة'), lenChips,
      h('details', {}, h('summary', {}, '🎨 الشكل والموسيقى وشاشة النهاية'), styleControls(opts.style)),
    ];
  }

  function openNew() {
    const topic = h('textarea', { placeholder: opts.lang === 'es' ? 'Ejemplo: ¿Por qué bostezamos cuando alguien bosteza?' : 'مثال: ليه بنتاوب لما نشوف حد بيتاوب؟', rows: 3, style: 'min-height:80px' });
    const notes = h('input', { type: 'text', placeholder: 'ملاحظات اختيارية للكاتب (زاوية، مصدر، جمهور…)' });
    const ideaBox = h('div', { class: 'chips', style: 'margin-top:8px' });
    const ideaBtn = h('button', { class: 'sm', type: 'button', onclick: async () => {
      ideaBtn.disabled = true;
      try {
        const { ideas } = await guard(() => be.ideas({ lang: opts.lang, hint: topic.value.trim() }));
        ideaBox.replaceChildren(...ideas.map(x => h('span', { class: 'chip', dir: 'auto', title: x.hook, onclick: () => { topic.value = x.topic; if (x.hook && !notes.value) notes.value = 'Hook: ' + x.hook; } }, x.topic)));
      } finally { ideaBtn.disabled = false; }
    } }, icon('bulb', 16), 'اقترح عليا مواضيع');
    const apr = h('div', { class: 'grid2' }, STAGES.map(s => h('div', { class: 'row' }, h('span', { class: 'grow' }, STAGE_AR[s]), seg([['auto', 'تلقائي'], ['wait', 'استناني']], opts.approvals[s], v => (opts.approvals[s] = v)))));
    const go = h('button', { class: 'primary', onclick: async () => {
      if (!topic.value.trim()) return toast('اكتب الموضوع الأول', true);
      go.disabled = true;
      try {
        const p = await guard(() => be.createProject({ topic: topic.value.trim(), length: opts.length, notes: notes.value, approvals: opts.approvals, voiceSource: opts.voiceSource, lang: opts.lang, style: opts.style }));
        m.close(); location.hash = '#/p/' + p.id;
      } finally { go.disabled = false; }
    } }, icon('play', 18), 'أنشئ وشغّل');
    const m = modal('ريل جديد', 'bolt', h('div', {},
      h('label', {}, 'الموضوع (الـ trigger)'), topic, h('div', { class: 'row', style: 'margin-top:6px' }, ideaBtn), ideaBox,
      ...commonFields(),
      h('details', {}, h('summary', {}, 'الموافقات لكل خطوة + ملاحظات'), h('div', { class: 'hint' }, '«استناني» = الخطوة تقف لحد ما توافق أو تعدّل.'), apr, h('label', {}, 'ملاحظات'), notes)),
      { foot: go });
    setTimeout(() => topic.focus(), 50);
  }

  function openBatch() {
    const ta = h('textarea', { rows: 6, placeholder: 'موضوع في كل سطر — كلهم يتعملوا لوحدهم واحد ورا التاني', style: 'min-height:130px' });
    const go = h('button', { class: 'primary', onclick: async () => {
      const topics = ta.value.split('\n').map(s => s.trim()).filter(Boolean);
      if (!topics.length) return toast('اكتب موضوع واحد على الأقل', true);
      const r = await guard(() => be.batch(topics, { lang: opts.lang, length: opts.length, voiceSource: opts.voiceSource === 'upload' ? 'tts' : opts.voiceSource, style: opts.style }));
      toast(`${r.queued.length} ريل في الطابور ✓`); m.close(); refreshList();
    } }, icon('play', 18), 'شغّل الكل');
    const m = modal('دفعة مواضيع', 'stack', h('div', {}, h('label', {}, 'المواضيع'), ta, ...commonFields()), { foot: go });
  }

  async function refreshList() {
    const { projects } = await be.listProjects();
    const bs = await be.batchState?.().catch(() => null);
    batchInfo.replaceChildren(...(bs?.pending?.length ? [h('div', { class: 'banner', style: 'border-color:rgba(255,109,90,.35);background:rgba(255,109,90,.06)' }, icon('stack', 18), `في الطابور: ${bs.pending.length} — ${be.mode === 'local' ? 'خلّي الصفحة مفتوحة' : 'الكمبيوتر بيكمّل حتى لو قفلت الصفحة'}`)] : []));
    list.replaceChildren(...(projects.length ? projects.map(p => {
      const st = overallStatus(p.stages);
      return h('a', { class: 'wf', href: '#/p/' + p.id },
        h('span', { class: 'ic' }, icon(st === 'done' ? 'movie' : 'bolt', 20)),
        h('div', { class: 'grow' }, h('b', { dir: 'auto' }, p.title || p.topic), h('span', { class: 'meta' }, `${p.lang === 'es' ? '🇪🇸' : '🇪🇬'} ${p.length} ث · آخر تعديل ${ago(p.updatedAt)}`)),
        h('span', { class: 'mini', title: 'الخطوات' }, STAGES.map((s, i) => [i ? h('u') : null, h('i', { class: 's-' + p.stages[s] })])),
        pill(st));
    }) : [h('div', { class: 'empty' }, icon('bolt', 30), h('div', { style: 'margin-top:8px' }, 'لسه مفيش ريلز — اضغط «ريل جديد».'))]));
  }
  await refreshList();
  const timer = setInterval(() => { if (!document.body.contains(list)) return clearInterval(timer); refreshList().catch(() => {}); }, 4000);
  cleanup = () => clearInterval(timer);
}

function seg(options, value, onChange) {
  const el = h('div', { class: 'seg' });
  for (const [v, label] of options) el.append(h('button', { type: 'button', class: v === value ? 'on' : '', onclick: e => { [...el.children].forEach(b => b.classList.toggle('on', b === e.currentTarget)); onChange(v); } }, label));
  return el;
}

// ---------------------------------------------------------------- project
async function viewProject(id) {
  let p = await be.getProject(id);
  const settings = await be.getSettings().catch(() => null);
  const live = { stream: {}, progress: {}, frame: null, editing: {} };
  let preview = null;
  const cards = Object.fromEntries(STAGES.map(s => [s, h('section', { class: 'stage', id: 'st-' + s })]));
  const running = () => p.running || STAGES.some(s => p.stages[s].status === 'running');

  // ---------------- editor chrome (n8n-style)
  const titleEl = h('div', { class: 'title' });
  const statusEl = h('span');
  const actionsEl = h('div', { class: 'row', style: 'flex-wrap:nowrap' });
  const canvas = h('div', { class: 'canvas' });
  const world = h('div', { class: 'world' });
  const SVGNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'edges');
  const nodesLayer = h('div');
  world.append(svg, nodesLayer);
  const hintEl = h('div', { class: 'hint-float' });
  const ctrls = h('div', { class: 'ctrls' },
    h('button', { class: 'sm', title: 'ملاءمة', onclick: () => { userMoved = false; fit(); } }, icon('fit', 18)),
    h('button', { class: 'sm', title: 'تكبير', onclick: () => zoomBy(1.2) }, icon('plus', 18)),
    h('button', { class: 'sm', title: 'تصغير', onclick: () => zoomBy(1 / 1.2) }, icon('minus', 18)));
  canvas.append(world, hintEl, ctrls);
  app.append(h('div', { class: 'editor' },
    h('div', { class: 'ebar' },
      h('a', { class: 'btn icon sm ghost', href: '#/', title: 'رجوع' }, icon('back', 18)),
      titleEl, statusEl, actionsEl),
    canvas));

  // ---------------- node model
  const NODES = [
    { id: 'topic', icon: 'bolt', name: 'الموضوع', kind: 'trigger' },
    { id: 'script', icon: 'pencil', name: STAGE_AR.script },
    { id: 'voice', icon: 'mic', name: STAGE_AR.voice },
    { id: 'timing', icon: 'clock', name: STAGE_AR.timing },
    { id: 'storyboard', icon: 'board', name: STAGE_AR.storyboard },
    { id: 'render', icon: 'movie', name: STAGE_AR.render },
    { id: 'publish', icon: 'send', name: 'النشر', kind: 'out' },
  ];
  const modelLabel = () => {
    if (!settings) return '';
    const n = (settings.llmBackups || []).filter(b => b.enabled !== false && b.hasKey).length;
    return `${settings.llm.model || 'auto'}${n ? ` +${n} احتياطي` : ''}`;
  };
  const SUBS = [
    { id: 'm1', parent: 'script', icon: 'brain', name: 'الموديل', sub: modelLabel, open: () => (location.hash = '#/settings') },
    { id: 'vp', parent: 'voice', icon: 'volume', name: 'مزوّد الصوت', sub: () => ({ tts: 'ElevenLabs', gemini: 'Gemini TTS', upload: 'ملفك' })[p.voiceSource] || '', open: () => openNdv('voice') },
    { id: 'm2', parent: 'storyboard', icon: 'brain', name: 'الموديل', sub: modelLabel, open: () => (location.hash = '#/settings') },
    { id: 'sty', parent: 'render', icon: 'music', name: 'الشكل', sub: () => { const st = { ...DEFAULT_STYLE, ...(p.style || {}) }; return `${MUSIC_AR.find(m => m[0] === st.music)?.[1] || ''} · ${st.formats.join('+')}`; }, open: () => openNdv('render') },
  ];
  const nodeStatus = nid => {
    if (nid === 'topic') return 'done';
    if (nid === 'publish') return p.stages.render.status === 'done' && p.render ? 'done' : p.stages.render.status === 'running' ? 'running-soft' : 'idle';
    return p.stages[nid].status;
  };
  const nodeSub = nid => {
    const st = nodeStatus(nid);
    if (nid === 'topic') return p.topic;
    if (nid === 'publish') return p.render ? 'فيديو + غلاف + وصف' : 'في الانتظار';
    if (st === 'running') return nid === 'render' ? `${Math.round((live.progress.render?.value || 0) * 100)}%` : { script: 'يكتب…', voice: 'يسجّل…', timing: 'يطابق…', storyboard: 'يصمّم…' }[nid];
    if (st === 'review') return 'بانتظار موافقتك';
    if (st === 'error') return 'خطأ — اضغط';
    if (nid === 'script' && p.script) return `${p.script.words} كلمة`;
    if (nid === 'voice' && p.voice) return `${p.voice.duration.toFixed(1)} ث`;
    if (nid === 'timing' && p.timing) return p.timing.provider === 'estimate' ? 'تقريبي' : `${Math.round(p.timing.stats.coverage * 100)}%${p.timing.stats.weak ? ` · ${p.timing.stats.weak} ضعيفة` : ''}`;
    if (nid === 'storyboard' && p.storyboard) return `${p.storyboard.scenes.length} مشاهد`;
    if (nid === 'render' && p.render) return `${p.render.duration.toFixed(1)} ث · ${(p.render.size / 1e6).toFixed(1)} MB`;
    return '';
  };

  // ---------------- layout + drawing
  let vertical = false, pos = {}, bbox = null;
  const BOX = 96, SUBBOX = 60;
  function layout() {
    vertical = canvas.clientWidth < 640;
    canvas.classList.toggle('vertical', vertical);
    pos = {};
    NODES.forEach((n, i) => { pos[n.id] = vertical ? { x: 0, y: i * 150 } : { x: (NODES.length - 1 - i) * 200, y: 0 }; });
    for (const sn of SUBS) { const pp = pos[sn.parent]; pos[sn.id] = vertical ? { x: -118, y: pp.y + (BOX - SUBBOX) / 2 } : { x: pp.x + (BOX - SUBBOX) / 2, y: 200 }; }
    const xs = Object.values(pos).map(q => q.x), ys = Object.values(pos).map(q => q.y);
    const minX = Math.min(...xs) - (vertical ? 30 : 60), minY = Math.min(...ys) - 40;
    for (const k of Object.keys(pos)) { pos[k].x -= minX; pos[k].y -= minY; }
    bbox = { w: Math.max(...xs) - minX + BOX + (vertical ? 150 : 60), h: Math.max(...ys) - minY + BOX + 70 };
  }
  function edgePath(a, b) {
    if (vertical) { const sx = a.x + BOX / 2, sy = a.y + BOX, tx = b.x + BOX / 2, ty = b.y; return `M${sx},${sy} C${sx},${sy + 40} ${tx},${ty - 40} ${tx},${ty}`; }
    const sx = a.x, sy = a.y + BOX / 2, tx = b.x + BOX, ty = b.y + BOX / 2;
    return `M${sx},${sy} C${sx - 60},${sy} ${tx + 60},${ty} ${tx},${ty}`;
  }
  function subPath(sn) {
    const a = pos[sn.id], b = pos[sn.parent];
    if (vertical) { const sx = a.x + SUBBOX, sy = a.y + SUBBOX / 2, tx = b.x, ty = b.y + BOX / 2; return [`M${sx},${sy} C${sx + 30},${sy} ${tx - 30},${ty} ${tx},${ty}`, tx, ty]; }
    const sx = a.x + SUBBOX / 2, sy = a.y, tx = b.x + BOX / 2, ty = b.y + BOX + 46;
    return [`M${sx},${sy} C${sx},${sy - 30} ${tx},${ty + 30} ${tx},${ty}`, tx, ty];
  }
  function svgEl(tag, attrs) { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; }
  function drawCanvas() {
    layout();
    svg.setAttribute('width', bbox.w); svg.setAttribute('height', bbox.h);
    svg.replaceChildren();
    NODES.slice(1).forEach((n, i) => {
      const from = NODES[i], st = nodeStatus(n.id), fs = nodeStatus(from.id);
      const cls = st === 'running' || st === 'running-soft' ? 'active' : fs === 'done' && ['done', 'review', 'error'].includes(st) ? 'done' : '';
      svg.append(svgEl('path', { d: edgePath(pos[from.id], pos[n.id]), class: cls }));
    });
    for (const sn of SUBS) { const [d, tx, ty] = subPath(sn); svg.append(svgEl('path', { d, class: 'sub' }), svgEl('circle', { cx: tx, cy: ty, r: 4, class: 'port' })); }
    const els = [];
    for (const n of NODES) {
      const st = nodeStatus(n.id);
      const box = h('div', { class: 'box' });
      if (n.id === 'publish' && p.render?.cover) { const img = h('img', { class: 'thumb', alt: '' }); be.fileUrl(id, p.render.cover).then(u => (img.src = u)); box.append(img); }
      else box.append(icon(n.icon, 40));
      const badge = { done: 'check', error: 'alert', review: 'pause', running: 'refresh' }[st];
      if (badge) box.append(h('span', { class: 'badge-s' }, icon(badge, 15)));
      if (STAGES.includes(n.id) && p.approvals[n.id] === 'wait' && st !== 'done') box.append(h('span', { class: 'wait', title: 'بتستنى موافقتك' }, icon('pause', 11), 'استناني'));
      if (n.id === 'render' && st === 'running') box.append(h('span', { class: 'prog' }, h('i', { id: 'node-prog', style: `width:${((live.progress.render?.value || 0) * 100).toFixed(1)}%` })));
      els.push(h('div', { class: `node ${n.kind || ''} s-${st === 'running-soft' ? 'idle' : st}`, id: 'node-' + n.id, style: `left:${pos[n.id].x}px;top:${pos[n.id].y}px`, onclick: () => openNdv(n.id) },
        box, h('div', { class: 'lbl' }, n.name), h('div', { class: 'sub', dir: 'auto', id: n.id === 'render' ? 'node-render-sub' : null }, nodeSub(n.id))));
    }
    for (const sn of SUBS) {
      els.push(h('div', { class: 'node subnode', style: `left:${pos[sn.id].x}px;top:${pos[sn.id].y}px`, onclick: sn.open },
        h('div', { class: 'box' }, icon(sn.icon, 26)), h('div', { class: 'lbl' }, sn.name), h('div', { class: 'sub', dir: 'auto' }, sn.sub())));
    }
    nodesLayer.replaceChildren(...els);
    world.style.width = bbox.w + 'px'; world.style.height = bbox.h + 'px';
    if (!userMoved) fit();
  }

  // ---------------- pan / zoom
  const view = { x: 0, y: 0, k: 1 };
  let userMoved = false;
  function apply() {
    world.style.transform = `translate(${view.x}px,${view.y}px) scale(${view.k})`;
    canvas.style.backgroundSize = `${22 * view.k}px ${22 * view.k}px`;
    canvas.style.backgroundPosition = `${view.x}px ${view.y}px`;
  }
  function fit() {
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (!cw || !bbox) return;
    // phone (vertical flow): fit the width and let the user scroll down; desktop: fit everything
    view.k = vertical ? Math.max(0.6, Math.min(1, (cw - 16) / bbox.w)) : Math.max(0.35, Math.min(1.15, (cw - 30) / bbox.w, (ch - 80) / bbox.h));
    view.x = (cw - bbox.w * view.k) / 2;
    view.y = vertical ? 46 : Math.max(50, (ch - bbox.h * view.k) / 2);
    apply();
  }
  function zoomBy(f, cx = canvas.clientWidth / 2, cy = canvas.clientHeight / 2) {
    const k = Math.max(0.25, Math.min(2.2, view.k * f));
    view.x = cx - ((cx - view.x) * k) / view.k; view.y = cy - ((cy - view.y) * k) / view.k; view.k = k;
    userMoved = true; apply();
  }
  const ptrs = new Map();
  let pinch = null;
  canvas.addEventListener('pointerdown', e => {
    if (e.target.closest('.node, .ctrls')) return;
    canvas.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.classList.add('panning');
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: view.k }; }
  });
  canvas.addEventListener('pointermove', e => {
    if (!ptrs.has(e.pointerId)) return;
    const prev = ptrs.get(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2 && pinch) {
      const [a, b] = [...ptrs.values()];
      const r = canvas.getBoundingClientRect();
      zoomBy((pinch.k * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d) / view.k, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
      return;
    }
    view.x += e.clientX - prev.x; view.y += e.clientY - prev.y; userMoved = true; apply();
  });
  const up = e => { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null; if (!ptrs.size) canvas.classList.remove('panning'); };
  canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', e => { e.preventDefault(); const r = canvas.getBoundingClientRect(); zoomBy(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
  const ro = new ResizeObserver(() => { const v = canvas.clientWidth < 640; if (v !== vertical) { userMoved = false; drawCanvas(); } else if (!userMoved) fit(); });
  ro.observe(canvas);

  // ---------------- node panel (opens on click)
  let ndv = null;
  function openNdv(nid) {
    if (nid === 'publish') nid = 'render';
    ndv?.close();
    if (nid === 'topic') {
      ndv = modal('الموضوع (trigger)', 'bolt', h('div', {},
        h('label', {}, 'الموضوع'), h('div', { dir: 'auto', style: 'font-size:16px;font-weight:700' }, p.topic),
        p.notes ? [h('label', {}, 'ملاحظات'), h('div', { dir: 'auto' }, p.notes)] : null,
        h('div', { class: 'grid2' }, h('div', {}, h('label', {}, 'اللغة'), LANGS[p.lang || 'ar'].name), h('div', {}, h('label', {}, 'المدة'), `${p.length} ثانية`)),
        h('label', {}, 'اتعمل'), new Date(p.createdAt).toLocaleString('ar-EG')),
        { narrow: true, foot: h('button', { class: 'danger', onclick: async () => { if (confirm('امسح المشروع؟')) { await guard(() => be.deleteProject(id)); ndv?.close(); location.hash = '#/'; } } }, icon('trash', 16), 'حذف المشروع'), onClose: () => (ndv = null) });
      return;
    }
    const n = NODES.find(x => x.id === nid);
    ndv = modal(`${STAGES.indexOf(nid) + 1}. ${n.name}`, n.icon, cards[nid], { onClose: () => { ndv = null; live.openStage = null; } });
    live.openStage = nid;
  }

  function drawHead() {
    titleEl.replaceChildren(h('b', { dir: 'auto' }, p.title || p.topic), h('span', {}, `${LANGS[p.lang || 'ar'].name} · ${p.length} ث`));
    const st = overallStatus(p.stages);
    statusEl.replaceChildren(pill(st));
    const review = STAGES.find(s => p.stages[s].status === 'review');
    const next = STAGES.find(s => p.stages[s].status !== 'done');
    const err = STAGES.find(s => p.stages[s].status === 'error');
    actionsEl.replaceChildren(...clean(
      running() ? h('button', { class: 'danger sm', onclick: () => guard(() => be.cancel(id), 'اتلغى') }, icon('stop', 16), 'إيقاف')
        : review ? h('button', { class: 'ok sm', onclick: () => guard(() => be.approve(id, review), 'تمام ✓') }, icon('check', 16), `موافق`)
        : next ? h('button', { class: 'primary sm', onclick: () => guard(() => be.start(id)) }, icon('play', 16), err ? 'كمّل' : 'تشغيل')
        : h('button', { class: 'primary sm', onclick: () => openNdv('render') }, icon('movie', 16), 'الفيديو')));
    const runningStage = STAGES.find(s => p.stages[s].status === 'running');
    hintEl.textContent = runningStage ? `⏳ شغّال: ${STAGE_AR[runningStage]}${runningStage === 'render' && live.progress.render ? ` · ${Math.round(live.progress.render.value * 100)}%` : ''}`
      : review ? `⏸ «${STAGE_AR[review]}» بانتظار موافقتك — اضغط عليها تراجعها`
      : err ? `⚠ خطأ في «${STAGE_AR[err]}» — اضغط عليها تشوف السبب`
      : !next ? '✓ الريل جاهز — اضغط «النشر»'
      : '▶ اضغط «تشغيل» أو اضغط أي خطوة تشوف تفاصيلها';
  }

  function stageShell(s, body) {
    const st = p.stages[s];
    const appr = seg([['auto', 'تلقائي'], ['wait', 'استناني']], p.approvals[s], v => guard(() => be.setApprovals(id, { [s]: v })));
    const btns = [];
    if (st.status === 'review') btns.push(h('button', { class: 'ok sm', onclick: () => guard(() => be.approve(id, s), 'تمام ✓') }, icon('check', 15), 'موافق'));
    if (!running() && (st.status !== 'idle' || STAGES.indexOf(s) === 0 || p.stages[STAGES[STAGES.indexOf(s) - 1]].status === 'done')) btns.push(h('button', { class: 'sm', onclick: () => guard(() => be.rerun(id, s)) }, icon(st.status === 'idle' ? 'play' : 'refresh', 15), st.status === 'idle' ? 'شغّل الخطوة' : 'أعد الخطوة'));
    if (st.status === 'running') btns.push(h('button', { class: 'danger sm', onclick: () => guard(() => be.cancel(id)) }, icon('stop', 15), 'إيقاف'));
    const log = h('div', { class: 'log', id: 'log-' + s }, st.log.slice(-60).map(l => h('div', { dir: 'auto', class: /^✗/.test(l.msg) ? 'err' : '' }, l.msg)));
    cards[s].replaceChildren(...clean(
      h('div', { class: 'stage-head' }, h('span', { class: 'badge ' + st.status }, STATUS_AR[st.status]), h('span', { class: 'spacer' }), appr, ...btns),
      st.error ? h('div', { class: 'errbox' },
        h('div', { dir: 'auto' }, '⚠️ ' + st.error),
        h('div', { class: 'row', style: 'margin-top:8px' },
          ['key', 'model', 'network', 'quota', 'busy'].includes(st.errorCode) ? h('a', { class: 'btn sm', href: '#/settings' }, '⚙ افتح الإعدادات') : null,
          st.errorLink ? h('a', { class: 'btn sm primary', href: st.errorLink, target: '_blank', rel: 'noopener' }, st.errorCode === 'key' ? '🔑 هات مفتاح مجاني' : '↗ المساعدة') : null,
          !running() ? h('button', { class: 'sm', onclick: () => guard(() => be.rerun(id, s)) }, '↻ جرّب تاني') : null)) : null,
      body,
      h('details', { open: st.status === 'running' || st.status === 'error' }, h('summary', {}, `السجل (${st.log.length})`), log),
    ));
    setTimeout(() => (log.scrollTop = log.scrollHeight));
  }

  // ---- stage bodies
  function bodyScript() {
    const st = p.stages.script;
    if (st.status === 'running') return h('div', { class: 'stream', id: 'stream-script' }, live.stream.script || '…');
    if (!p.script) return h('p', { class: 'muted' }, 'الكاتب هيكتب سكريبت مصري بأسلوب السلسلة.');
    if (live.editing.script) {
      const title = h('input', { type: 'text', value: p.script.title, dir: 'auto' });
      const text = h('textarea', { value: p.script.text, rows: 10, dir: p.lang === 'es' ? 'ltr' : 'rtl' });
      const count = h('span', { class: 'muted small' });
      const upd = () => (count.textContent = `${text.value.split(/\s+/).filter(Boolean).length} كلمة · الهدف ${p.script.target}`);
      text.addEventListener('input', upd); upd();
      const sources = h('textarea', { class: 'ltr', value: (p.script.sources || []).join('\n'), rows: 3, style: 'min-height:70px' });
      return h('div', {}, h('label', {}, 'العنوان'), title, h('label', {}, 'السكريبت'), text, count, h('label', {}, 'المصادر'), sources,
        h('div', { class: 'row', style: 'margin-top:10px' },
          h('button', { class: 'primary', onclick: async () => { await guard(() => be.edit(id, 'script', { title: title.value, text: text.value, sources: sources.value.split('\n').map(s => s.trim()).filter(Boolean) }), 'اتحفظ'); live.editing.script = false; refresh(); } }, 'حفظ'),
          h('button', { class: 'ghost', onclick: () => { live.editing.script = false; refresh(); } }, 'إلغاء')));
    }
    return h('div', {},
      h('h3', { dir: 'auto' }, p.script.title),
      h('div', { dir: p.lang === 'es' ? 'ltr' : 'rtl', style: 'white-space:pre-wrap;font-size:17px;line-height:2' }, p.script.text),
      h('div', { class: 'muted small' }, `${p.script.words} كلمة (الهدف ${p.script.target} ≈ ${p.length} ث × 2.6)`),
      p.script.sources?.length ? h('details', {}, h('summary', {}, 'المصادر'), h('ul', { class: 'small ltr', style: 'direction:ltr' }, p.script.sources.map(s => h('li', {}, s)))) : null,
      !running() ? h('button', { class: 'sm', style: 'margin-top:8px', onclick: () => { live.editing.script = true; refresh(); } }, '✎ تعديل') : null,
    );
  }

  function bodyVoice() {
    const wrap = h('div');
    const srcSeg = seg(VOICE_AR, p.voiceSource, v => guard(() => be.setVoiceSource(id, { source: v, voiceId: '' })));
    wrap.append(h('div', { class: 'row' }, srcSeg));
    if (p.voiceSource === 'upload') {
      const inp = h('input', { type: 'file', accept: 'audio/*,.mp3,.wav,.m4a,.ogg,.opus,.webm', onchange: async () => {
        const f = inp.files[0]; if (!f) return;
        await guard(() => be.uploadVoice(id, f), 'اترفع ✓');
      } });
      wrap.append(h('label', {}, p.upload ? `الملف الحالي: ${p.upload.name}` : 'اختار ملف التعليق الصوتي (اقرأ السكريبت زي ما هو)'), inp,
        h('div', { class: 'hint' }, 'التوقيت هيتعمل بـ Deepgram (أو ElevenLabs Scribe من الإعدادات) وبعدين يتطابق مع كلمات السكريبت.'));
    } else if (p.voiceSource === 'gemini') {
      const sel = h('select', { onchange: () => guard(() => be.setVoiceSource(id, { source: 'gemini', voiceId: sel.value })) },
        h('option', { value: '' }, 'الصوت الافتراضي من الإعدادات'), ...GEMINI_VOICES.map(v => h('option', { value: v, selected: v === p.voiceId }, v)));
      wrap.append(h('div', { class: 'row', style: 'margin-top:8px' }, h('div', { class: 'grow' }, sel)),
        h('div', { class: 'hint' }, 'صوت Gemini مجاني بنفس مفتاح Gemini. لو عندك مفتاح ElevenLabs أو Deepgram التوقيت بيبقى دقيق، وإلا بيتحسب تقريبيًا من الصوت.'));
    } else {
      const sel = h('select', { onchange: () => guard(() => be.setVoiceSource(id, { source: 'tts', voiceId: sel.value })) }, h('option', { value: '' }, p.voiceId ? p.voiceId : 'الصوت الافتراضي من الإعدادات'));
      const load = h('button', { class: 'sm', onclick: async () => {
        const { voices } = await guard(() => be.voices());
        sel.replaceChildren(h('option', { value: '' }, 'الصوت الافتراضي من الإعدادات'), ...voices.map(v => h('option', { value: v.id, selected: v.id === p.voiceId }, v.name)));
        toast(`${voices.length} صوت`);
      } }, '⟳ تحميل الأصوات');
      wrap.append(h('div', { class: 'row', style: 'margin-top:8px' }, h('div', { class: 'grow' }, sel), load));
    }
    if (p.voice) {
      const au = h('audio', { controls: true, style: 'width:100%;margin-top:10px' });
      be.fileUrl(id, p.voice.file).then(u => (au.src = u));
      wrap.append(au, h('div', { class: 'muted small' }, `${p.voice.duration.toFixed(2)} ث · ${p.voice.provider}`));
    }
    return wrap;
  }

  function bodyTiming() {
    if (!p.timing) return h('p', { class: 'muted' }, 'هيطابق توقيت كل كلمة اتقالت مع كلمات السكريبت نفسها (LCS على مستوى الحروف).');
    const { stats } = p.timing;
    const au = h('audio', { controls: true, style: 'width:100%' });
    if (p.voice) be.fileUrl(id, p.voice.file).then(u => (au.src = u));
    const words = h('div', { class: 'words', dir: p.lang === 'es' ? 'ltr' : 'rtl' }, p.timing.tokens.map((t, i) => h('span', { class: 'word' + (t.weak ? ' weak' : ''), 'data-i': i, title: `coverage ${t.coverage}`, onclick: async () => {
      if (au.src && !au.paused) { const tt = au.currentTime; if (confirm(`اضبط بداية «${t.text}» على ${tt.toFixed(2)}؟`)) { const toks = p.timing.tokens.map((x, j) => (j === i ? { start: tt } : {})); await guard(() => be.edit(id, 'timing', { tokens: toks }), 'اتعدل'); } return; }
      const v = prompt(`بداية «${t.text}» بالثواني`, t.start);
      if (v == null || isNaN(+v)) return;
      const toks = p.timing.tokens.map((x, j) => (j === i ? { start: +v } : {}));
      await guard(() => be.edit(id, 'timing', { tokens: toks }), 'اتعدل');
    } }, t.text, h('small', {}, fmtT(t.start)))));
    au.addEventListener('timeupdate', () => { const t = au.currentTime; words.querySelectorAll('.word').forEach((w, i) => w.classList.toggle('now', p.timing.tokens[i].start <= t && t < p.timing.tokens[i].end + 0.05)); });
    return h('div', {}, au,
      h('div', { class: 'muted small', style: 'margin:8px 0' }, `${stats.tokens} كلمة · تغطية ${(stats.coverage * 100).toFixed(0)}% · ${stats.weak} ضعيفة (بالبرتقالي) · المصدر ${p.timing.provider}`),
      p.timing.provider === 'estimate' ? h('div', { class: 'errbox', style: 'border-color:var(--warn);background:rgba(242,138,48,.08)' }, '⏱ التوقيت تقريبي (محسوب من الصوت). للدقة الكاملة حط مفتاح ElevenLabs أو Deepgram في الإعدادات وأعد مرحلة التوقيت.') : null,
      h('div', { class: 'hint' }, 'اضغط على كلمة لتعديل توقيتها (أو شغّل الصوت واضغط عليها في لحظتها).'),
      words);
  }

  function bodyStoryboard() {
    const st = p.stages.storyboard;
    if (st.status === 'running') return h('div', { class: 'stream', id: 'stream-storyboard' }, live.stream.storyboard || '…');
    if (!p.storyboard) return h('p', { class: 'muted' }, 'المصمم هيختار المشاهد والقوالب والأيقونات، وبعدين مراجعة ذاتية تحسّن الاختيارات الضعيفة.');
    if (live.editing.storyboard) {
      const ta = h('textarea', { class: 'ltr mono', value: JSON.stringify(p.storyboard, null, 1), rows: 18, style: 'font-size:12px' });
      return h('div', {}, ta, h('div', { class: 'row', style: 'margin-top:8px' },
        h('button', { class: 'primary', onclick: async () => { let j; try { j = JSON.parse(ta.value); } catch (e) { return toast('JSON غلط: ' + e.message, true); } await guard(() => be.edit(id, 'storyboard', { storyboard: j }), 'اتحفظ (واتصلّح لو لزم)'); live.editing.storyboard = false; refresh(); } }, 'حفظ'),
        h('button', { class: 'ghost', onclick: () => { live.editing.storyboard = false; refresh(); } }, 'إلغاء')));
    }
    const tok = p.timing?.tokens || [];
    if (live.editing.scene != null) return sceneEditor(live.editing.scene);
    const scenes = h('div', { class: 'scenes' }, p.storyboard.scenes.map((s, k) => h('div', { class: 'scene', style: 'cursor:pointer', onclick: () => { if (running()) return; live.editing.scene = k; live.editing.storyboard = false; refresh(); } },
      h('div', { class: 'row' }, h('b', { class: 'grow' }, `${k + 1}. ${TYPE_AR[s.type] || s.type} · ${s.template}`), running() ? null : h('span', { class: 'muted small' }, '✎ تعديل')), ` عند «${tok[s.at]?.text || s.at}» (${fmtT(tok[s.at]?.start)} ث)`,
      s.title ? h('div', {}, s.title) : null,
      h('div', { class: 'muted' }, [s.organ ? `organ: ${s.organ}` : '', s.value != null ? `${s.value}/${s.max} ${s.unit || ''}` : '', ...s.items.map(i => `${i.label}${i.icon ? ` [${i.icon}]` : ''}${i.value != null ? ` = ${i.value}` : ''}`)].filter(Boolean).join(' · ')),
    )));
    return h('div', { class: 'preview' }, previewBox(), h('div', {},
      scenes,
      p.iconMisses?.length ? h('div', { class: 'hint' }, 'أيقونات مالقيناش ليها تطابق: ' + p.iconMisses.join(', ')) : null,
      p.storyboardFixes?.length ? h('details', {}, h('summary', {}, `إصلاحات تلقائية (${p.storyboardFixes.length})`), h('div', { class: 'log ltr' }, p.storyboardFixes.join('\n'))) : null,
      !running() ? h('div', { class: 'row', style: 'margin-top:8px' },
        h('button', { class: 'sm', onclick: () => { const sb = structuredClone(p.storyboard); const last = sb.scenes[sb.scenes.length - 1]; const at = Math.min(tok.length - 1, (last?.at ?? 0) + 3); sb.scenes.push({ type: 'concept', at, template: 'cards', title: '', icon: 'spark', items: [{ label: tok[at]?.text || '…', icon: 'spark', at }] }); saveSb(sb, sb.scenes.length - 1); } }, '+ مشهد'),
        h('button', { class: 'ghost sm', onclick: () => { live.editing.storyboard = true; refresh(); } }, '{ } JSON')) : null));
  }

  async function saveSb(sb, openScene = null) {
    await guard(() => be.edit(id, 'storyboard', { storyboard: sb }), 'اتحفظ ✓');
    live.editing.scene = openScene;
    cards.storyboard.dataset.editing = '';
    refresh();
  }

  let iconLib = null;
  const loadIconLib = () => (iconLib ??= fetch('assets/icons/icons.json').then(r => r.json()));
  function iconPreview(noun) {
    const c = h('canvas', { width: 44, height: 44, style: 'width:44px;height:44px;background:var(--bg);border-radius:10px;flex:none' });
    loadIconLib().then(lib => {
      const key = resolveIcon(lib, noun); const ic = lib.icons[key]; const x = c.getContext('2d');
      x.clearRect(0, 0, 44, 44); x.save(); x.translate(8, 8); x.scale(28 / ic.v, 28 / ic.v);
      if (ic.m === 'f') { x.fillStyle = '#F4F3EE'; for (const d of ic.d) x.fill(new Path2D(d), 'evenodd'); } else { x.strokeStyle = '#F4F3EE'; x.lineWidth = 1.8; x.lineCap = x.lineJoin = 'round'; for (const d of ic.d) x.stroke(new Path2D(d)); }
      x.restore(); c.title = key;
    });
    return c;
  }
  function iconField(val, onInput) {
    const wrap = h('div', { class: 'row', style: 'gap:6px;flex-wrap:nowrap' });
    let pv = iconPreview(val);
    const inp = h('input', { type: 'text', class: 'ltr', value: val || '', placeholder: 'icon (English noun)', oninput: () => { onInput(inp.value.trim()); clearTimeout(inp._t); inp._t = setTimeout(() => { const n = iconPreview(inp.value.trim()); pv.replaceWith(n); pv = n; }, 300); } });
    wrap.append(inp, pv);
    return wrap;
  }

  /** Touch-friendly editor for one scene (no JSON needed). */
  function sceneEditor(k) {
    const sb = structuredClone(p.storyboard);
    const s = sb.scenes[k];
    const tok = p.timing?.tokens || [];
    const wordSel = (val, onCh) => h('select', { onchange: e => onCh(+e.target.value) }, tok.map((t, i) => h('option', { value: i, selected: i === val }, `${fmtT(t.start)} ث — ${t.text}`)));
    const opt = (list, val, onCh) => h('select', { onchange: e => onCh(e.target.value) }, list.map(([v, l]) => h('option', { value: v, selected: v === val }, l)));
    const TEMPL = [['hero', 'hero — عنوان + أيقونة'], ['ask', 'ask — السؤال'], ['body', 'body — عضو في الجسم'], ['zoom', 'zoom — من الكبير للصغير'], ['flow', 'flow — أ ← ب ← ج'], ['cycle', 'cycle — دورة'], ['timeline', 'timeline — خط زمني'], ['chart', 'chart — أعمدة'], ['layers', 'layers — طبقات'], ['cards', 'cards — كروت / مقارنة'], ['meter', 'meter — عدّاد'], ['checklist', 'checklist — خلاصة']];
    const itemsBox = h('div');
    const drawItems = () => itemsBox.replaceChildren(...s.items.map((it, j) => h('div', { class: 'scene', style: 'margin-bottom:6px' },
      h('div', { class: 'row' }, h('b', { class: 'grow' }, `عنصر ${j + 1}`), h('button', { class: 'danger sm', type: 'button', onclick: () => { s.items.splice(j, 1); drawItems(); } }, '✕')),
      h('input', { type: 'text', dir: 'auto', value: it.label || '', placeholder: 'النص', oninput: e => (it.label = e.target.value) }),
      h('div', { style: 'margin-top:6px' }, iconField(it.icon, v => (it.icon = v))),
      h('div', { class: 'grid2', style: 'margin-top:6px' },
        h('input', { type: 'number', class: 'ltr', value: it.value ?? '', placeholder: 'رقم (اختياري)', oninput: e => (it.value = e.target.value === '' ? undefined : +e.target.value) }),
        wordSel(it.at, v => (it.at = v))))));
    drawItems();
    return h('div', {},
      h('div', { class: 'row' }, h('h3', { class: 'grow', style: 'margin:0' }, `تعديل المشهد ${k + 1}`), h('button', { class: 'danger sm', type: 'button', onclick: () => { if (!confirm('امسح المشهد ده؟')) return; sb.scenes.splice(k, 1); saveSb(sb); } }, 'حذف المشهد')),
      h('label', {}, 'النوع'), opt(Object.entries(TYPE_AR), s.type, v => (s.type = v)),
      h('label', {}, 'القالب'), opt(TEMPL, s.template, v => (s.template = v)),
      h('label', {}, 'يبدأ عند الكلمة'), wordSel(s.at, v => (s.at = v)),
      h('label', {}, 'العنوان'), h('input', { type: 'text', dir: 'auto', value: s.title || '', oninput: e => (s.title = e.target.value) }),
      h('label', {}, 'الأيقونة الرئيسية'), iconField(s.icon, v => (s.icon = v)),
      s.template === 'meter' ? h('div', { class: 'grid2' }, h('div', {}, h('label', {}, 'القيمة'), h('input', { type: 'number', class: 'ltr', value: s.value ?? '', oninput: e => (s.value = +e.target.value) })), h('div', {}, h('label', {}, 'الحد الأقصى'), h('input', { type: 'number', class: 'ltr', value: s.max ?? 100, oninput: e => (s.max = +e.target.value) }))) : null,
      ['meter', 'chart'].includes(s.template) ? h('div', {}, h('label', {}, 'الوحدة'), h('input', { type: 'text', class: 'ltr', value: s.unit || '', oninput: e => (s.unit = e.target.value) })) : null,
      s.template === 'body' ? h('div', {}, h('label', {}, 'العضو'), opt(['brain', 'eyes', 'nose', 'mouth', 'throat', 'lungs', 'heart', 'stomach', 'liver', 'kidneys', 'intestines', 'bladder', 'muscles', 'bones', 'skin', 'blood', 'nerves'].map(o => [o, o]), s.organ, v => (s.organ = v))) : null,
      h('label', {}, 'العناصر'), itemsBox,
      h('button', { class: 'sm', type: 'button', onclick: () => { s.items.push({ label: '', icon: '', at: s.at }); drawItems(); } }, '+ عنصر'),
      h('div', { class: 'sticky-actions' },
        h('button', { class: 'primary', onclick: () => saveSb(sb) }, 'حفظ المشهد'),
        h('button', { class: 'ghost', onclick: () => { live.editing.scene = null; refresh(); } }, 'رجوع')));
  }

  function bodyRender() {
    const st = p.stages.render;
    if (st.status === 'running') {
      const pr = live.progress.render || { value: 0, label: '' };
      return h('div', { class: 'preview' },
        h('div', {}, h('div', { class: 'phone' }, live.frame ? h('img', { id: 'live-frame', src: live.frame }) : h('img', { id: 'live-frame', alt: '' }))),
        h('div', {}, h('div', { class: 'bar' }, h('i', { id: 'render-bar', style: `width:${(pr.value * 100).toFixed(1)}%` })), h('div', { class: 'muted small', id: 'render-label' }, pr.label || '…'),
          be.mode === 'local' ? h('div', { class: 'hint' }, 'خلّي الصفحة مفتوحة والشاشة شغالة لحد ما الرندر يخلص.') : null));
    }
    const stl = { ...DEFAULT_STYLE, ...(p.style || {}) };
    stl.formats = [...(stl.formats || ['9:16'])];
    let dirty = false;
    const applyBtn = h('button', { class: 'primary sm', hidden: true, onclick: async () => { await guard(() => be.setStyle(id, stl)); await guard(() => be.rerun(id, 'render')); } }, '↻ رندر بالشكل الجديد');
    const stylePanel = h('details', { open: !p.render }, h('summary', {}, `🎨 الشكل والموسيقى (${MUSIC_AR.find(m => m[0] === stl.music)?.[1] || ''} · ${CAPTIONS_AR.find(c => c[0] === stl.captions)?.[1] || ''} · ${stl.formats.join(' + ')})`),
      styleControls(stl, () => { dirty = true; applyBtn.hidden = running(); if (!p.render) be.setStyle(id, stl).catch(() => {}); }), h('div', { style: 'margin-top:8px' }, p.render ? applyBtn : null));
    if (!p.render || st.status !== 'done' && st.status !== 'review') return h('div', {}, h('p', { class: 'muted' }, '30fps · H.264 · موسيقى + مؤثرات ناعمة على −14 LUFS.'), stylePanel);
    void dirty;
    const v = h('video', { controls: true, playsinline: true, preload: 'metadata' });
    const dl = h('a', { class: 'btn primary', download: `${(p.title || 'reel').replace(/[\\/:*?"<>|]/g, '')}.mp4` }, '⬇ تحميل الفيديو');
    be.fileUrl(id, p.render.file).then(u => { v.src = u; dl.href = u + (be.mode === 'server' ? '?download=1' : ''); });
    const shareBtn = navigator.share ? h('button', { onclick: async () => {
      try { const blob = await (await fetch(v.src)).blob(); await navigator.share({ files: [new File([blob], 'reel.mp4', { type: 'video/mp4' })], title: p.title }); } catch (e) { if (e.name !== 'AbortError') toast(e.message, true); }
    } }, '↗ مشاركة') : null;
    const files = p.render.files || [{ aspect: '9:16', file: p.render.file }];
    const extra = files.slice(1).map(f => { const a = h('a', { class: 'btn sm', download: `${(p.title || 'reel').replace(/[\\/:*?"<>|]/g, '')}-${f.aspect.replace(':', 'x')}.mp4` }, `⬇ ${f.aspect}`); be.fileUrl(id, f.file).then(u => (a.href = u + (be.mode === 'server' ? '?download=1' : ''))); return a; });
    const coverImg = p.render.cover ? h('img', { style: 'width:120px;border-radius:12px;border:1px solid var(--line)', alt: 'cover' }) : null;
    const coverDl = p.render.cover ? h('a', { class: 'btn sm', download: 'cover.jpg' }, '⬇ الغلاف') : null;
    if (coverImg) be.fileUrl(id, p.render.cover).then(u => { coverImg.src = u; coverDl.href = u + (be.mode === 'server' ? '?download=1' : ''); });
    const pub = p.publish;
    const copyBtn = (txt, label) => h('button', { class: 'sm', onclick: async () => { try { await navigator.clipboard.writeText(txt); toast('اتنسخ ✓'); } catch { toast('ما قدرناش ننسخ — حدّد النص وانسخه', true); } } }, label);
    const pubBox = pub ? h('div', { class: 'card', style: 'background:var(--elev);margin-top:10px' },
      h('h3', {}, '📲 جاهز للنشر'),
      h('textarea', { rows: 4, dir: 'auto', value: pub.caption }),
      h('div', { class: 'chips', dir: 'ltr', style: 'margin:8px 0' }, pub.hashtags.map(t => h('span', { class: 'chip', style: 'min-height:30px;padding:4px 10px' }, t))),
      h('div', { class: 'row' }, copyBtn(pub.caption + '\n\n' + pub.hashtags.join(' '), '📋 انسخ الكل'), copyBtn(pub.hashtags.join(' '), '# انسخ الهاشتاغات'))) : null;
    return h('div', { class: 'preview' }, h('div', {}, h('div', { class: 'phone' }, v)),
      h('div', {}, h('div', { class: 'row' }, dl, shareBtn, ...extra),
        coverImg ? h('div', { class: 'row', style: 'margin-top:10px;align-items:flex-end' }, coverImg, coverDl) : null,
        pubBox, stylePanel,
        h('div', { class: 'muted small', style: 'margin-top:8px' }, `${p.render.duration.toFixed(1)} ث · ${p.render.frames} فريم · ${(p.render.size / 1e6).toFixed(1)} MB · ${p.render.lufs} LUFS · ${p.render.renderer} · ${p.render.seconds} ث رندر`),
        p.script?.sources?.length ? h('details', {}, h('summary', {}, 'نص الوصف + المصادر'), h('textarea', { rows: 5, value: `${p.title}\n\n${p.script.text}\n\nالمصادر:\n${p.script.sources.join('\n')}` })) : null));
  }

  // ---- live preview player (same renderer as the export)
  function previewBox() {
    const pid = JSON.stringify(p.storyboard || '').length + ':' + (p.timing?.tokens || []).map(t => t.start).join(',');
    if (preview && preview.pid === pid) return preview.el;
    preview?.destroy();
    const canvas = h('canvas', { width: 540, height: 960 });
    const range = h('input', { type: 'range', min: 0, max: 1000, value: 0 });
    const tl = h('span', { class: 't' }, '0.00');
    const audio = h('audio', { preload: 'auto' });
    let r = null, raf = 0, dur = 1;
    const draw = t => { if (!r) return; r.drawFrame(t); range.value = Math.round((t / dur) * 1000); tl.textContent = `${t.toFixed(2)} / ${dur.toFixed(1)}`; };
    const loop = () => { draw(audio.currentTime); if (!audio.paused) raf = requestAnimationFrame(loop); };
    const play = h('button', { class: 'sm', onclick: () => { if (audio.paused) { if (audio.currentTime >= dur - 0.05) audio.currentTime = 0; audio.play(); raf = requestAnimationFrame(loop); play.textContent = '❚❚'; } else { audio.pause(); play.textContent = '▶'; } } }, '▶');
    audio.addEventListener('ended', () => (play.textContent = '▶'));
    range.addEventListener('input', () => { audio.currentTime = (range.value / 1000) * dur; draw(audio.currentTime); });
    const el = h('div', {}, h('div', { class: 'phone' }, canvas), h('div', { class: 'player' }, play, range, tl));
    be.renderData(id).then(async rd => {
      await loadFonts(document, 'assets/fonts/', rd.font);
      r = createRenderer(canvas, rd.data);
      dur = r.duration;
      if (rd.audio) audio.src = rd.audio;
      draw(Math.min(dur, 0.8));
    }).catch(e => toast('معاينة: ' + e.message, true));
    preview = { el, pid, destroy: () => { cancelAnimationFrame(raf); audio.pause(); } };
    return el;
  }

  const bodies = { script: bodyScript, voice: bodyVoice, timing: bodyTiming, storyboard: bodyStoryboard, render: bodyRender };
  function refresh() {
    drawHead();
    drawCanvas();
    for (const s of STAGES) {
      const editing = live.editing[s] || (s === 'storyboard' && live.editing.scene != null);
      if (editing && cards[s].dataset.editing) continue;
      cards[s].dataset.editing = editing ? '1' : '';
      stageShell(s, bodies[s]());
    }
  }
  refresh();

  const unsub = be.subscribe(id, ev => {
    if (ev.type === 'state') {
      const before = p;
      p = ev.project;
      for (const s of STAGES) if (before.stages[s].status !== 'running' && p.stages[s].status === 'running') { live.stream[s] = ''; if (s === 'render') { live.frame = null; live.progress.render = null; } }
      refresh();
      const nowReview = STAGES.find(s => before.stages[s].status === 'running' && p.stages[s].status === 'review');
      if (nowReview && !ndv) openNdv(nowReview);
    } else if (ev.type === 'log') {
      const el = document.getElementById('log-' + ev.stage);
      if (el) { el.append(h('div', { dir: 'auto', class: /^✗/.test(ev.line.msg) ? 'err' : '' }, ev.line.msg)); el.scrollTop = el.scrollHeight; }
    } else if (ev.type === 'llm') {
      live.stream[ev.stage] = ev.delta == null ? ev.full : (live.stream[ev.stage] || '') + ev.delta;
      const el = document.getElementById('stream-' + ev.stage);
      if (el) { el.textContent = live.stream[ev.stage]; el.scrollTop = el.scrollHeight; }
    } else if (ev.type === 'progress') {
      live.progress[ev.stage] = ev;
      const bar = document.getElementById('render-bar'), lab = document.getElementById('render-label');
      if (bar) bar.style.width = (ev.value * 100).toFixed(1) + '%';
      if (lab) lab.textContent = ev.label;
      const np = document.getElementById('node-prog'), ns = document.getElementById('node-render-sub');
      if (np) np.style.width = (ev.value * 100).toFixed(1) + '%';
      if (ns && ev.stage === 'render') ns.textContent = `${Math.round(ev.value * 100)}%`;
    } else if (ev.type === 'frame') {
      live.frame = ev.data;
      const img = document.getElementById('live-frame');
      if (img) img.src = ev.data;
    }
  });
  cleanup = () => { unsub(); preview?.destroy(); ro.disconnect(); ndv?.close(); };
}

// ---------------------------------------------------------------- settings
async function viewSettings() {
  let s = await be.getSettings();
  const f = {};
  const inp = (path, attrs = {}) => {
    const v = path.split('.').reduce((a, k) => a?.[k], s);
    const el = h('input', { type: 'text', value: v ?? '', ...attrs });
    f[path] = el;
    if (s.envLocked?.includes(path)) { el.disabled = true; el.title = 'مضبوط من متغيرات البيئة (.env)'; }
    return el;
  };
  const key = (path, link) => h('div', {}, h('div', { class: 'keyrow' }, inp(path, { type: 'password', class: 'ltr', autocomplete: 'off', placeholder: 'الصق المفتاح هنا' })), link ? h('div', { class: 'hint' }, 'هات مفتاح من ', h('a', { href: link, target: '_blank', rel: 'noopener' }, link)) : null);
  const llmKeyHint = h('div', { class: 'hint' });
  // ---- backup LLM providers
  const backups = (s.llmBackups || []).map(b => ({ ...b }));
  const backupsBox = h('div');
  const drawBackups = () => backupsBox.replaceChildren(...backups.map((b, i) => {
    const pr = presetById(b.preset);
    const mlist = h('datalist', { id: 'bm-' + i });
    const model = h('input', { type: 'text', class: 'ltr', value: b.model || '', placeholder: pr?.model || 'model', list: 'bm-' + i, oninput: e => (b.model = e.target.value.trim()) });
    return h('div', { class: 'scene', style: 'margin-bottom:8px' },
      h('div', { class: 'row' },
        h('label', { class: 'row grow', style: 'gap:8px;color:var(--text);margin:0' }, h('input', { type: 'checkbox', checked: b.enabled !== false, onchange: e => (b.enabled = e.target.checked) }), h('b', {}, `${i + 1}. ${b.name || pr?.name || 'مزوّد'}`)),
        i > 0 ? h('button', { class: 'ghost sm', type: 'button', title: 'لفوق', onclick: () => { [backups[i - 1], backups[i]] = [backups[i], backups[i - 1]]; drawBackups(); } }, '↑') : null,
        h('button', { class: 'danger sm', type: 'button', onclick: () => { backups.splice(i, 1); drawBackups(); } }, '✕')),
      h('input', { type: 'password', class: 'ltr', autocomplete: 'off', value: b.apiKey || '', placeholder: pr?.local ? 'مفتاح (اختياري)' : 'الصق المفتاح هنا', oninput: e => (b.apiKey = e.target.value) }),
      pr?.keyLink && !pr.local ? h('div', { class: 'hint' }, 'هات مفتاح', pr.free ? ' مجاني' : '', ' من: ', h('a', { href: pr.keyLink, target: '_blank', rel: 'noopener' }, pr.keyLink)) : null,
      h('div', { class: 'keyrow', style: 'margin-top:6px' }, model, mlist,
        h('button', { class: 'sm', type: 'button', title: 'تحميل الموديلات', onclick: async () => {
          await save(true);
          const { models } = await guard(() => be.models(b.id));
          mlist.replaceChildren(...models.map(m => h('option', { value: m })));
          if (models.length && !models.includes(b.model)) { b.model = model.value = models[0]; }
          toast(`${models.length} موديل`);
        } }, '⟳')),
      pr ? null : h('input', { type: 'url', class: 'ltr', style: 'margin-top:6px', value: b.baseUrl || '', placeholder: 'Base URL (OpenAI-compatible)', oninput: e => (b.baseUrl = e.target.value.trim()) }));
  }));
  drawBackups();
  const addBackupSel = h('select', { onchange: e => {
    const pr = presetById(e.target.value);
    if (e.target.value === 'custom') backups.push({ id: 'b' + Date.now().toString(36), preset: '', name: 'Custom', baseUrl: '', model: '', apiKey: '', enabled: true });
    else if (pr) backups.push({ id: 'b' + Date.now().toString(36), preset: pr.id, name: pr.name, baseUrl: pr.baseUrl, model: pr.model, apiKey: '', enabled: true });
    e.target.value = ''; drawBackups();
  } }, h('option', { value: '' }, '+ زيد مزوّد احتياطي…'), ...LLM_PRESETS.filter(p => !p.local).map(p => h('option', { value: p.id }, `${p.name}${p.free ? ' (فيه مجاني)' : ''}`)), h('option', { value: 'custom' }, 'مزوّد آخر (OpenAI-compatible)'));
  const modelList = h('datalist', { id: 'llm-models' });
  const loadModels = h('button', { class: 'sm', type: 'button', title: 'تحميل الموديلات المتاحة', onclick: async () => {
    await save(true);
    const { models } = await guard(() => be.models());
    modelList.replaceChildren(...models.map(m => h('option', { value: m })));
    if (models.length && (!f['llm.model'].value || f['llm.model'].value === 'auto' || !models.includes(f['llm.model'].value))) { f['llm.model'].value = models[0]; await save(true); }
    toast(`${models.length} موديل — المختار: ${f['llm.model'].value}`);
  } }, '⟳');
  const updHint = () => {
    const url = f['llm.baseUrl']?.value || s.llm.baseUrl;
    const pr = providerOf(url);
    llmKeyHint.replaceChildren(...clean(isLocalUrl(url) ? 'FreeLLMAPI على جهازك — مفيش مفتاح مطلوب (ما يشتغلش من الهاتف).' : pr.link ? ['هات مفتاح ', pr.name, ' مجاني من: ', h('a', { href: pr.link, target: '_blank', rel: 'noopener' }, pr.link)] : null));
  };
  const presets = h('div', { class: 'chips' }, LLM_PRESETS.map(pr => h('span', { class: 'chip', onclick: () => { f['llm.baseUrl'].value = pr.baseUrl; f['llm.model'].value = pr.model; updHint(); toast(pr.name + (pr.id === 'freellmapi' ? '' : ' — الصق المفتاح تحت')); } }, pr.name)));
  const voiceSel = h('select', {}, h('option', { value: s.eleven.voiceId }, s.eleven.voiceId || '— اختار صوت —'));
  const loadVoices = h('button', { onclick: async () => {
    await save(true);
    const { voices } = await guard(() => be.voices());
    voiceSel.replaceChildren(...voices.map(v => h('option', { value: v.id, selected: v.id === s.eleven.voiceId }, `${v.name}${v.labels?.accent ? ' · ' + v.labels.accent : ''}`)));
    toast(`${voices.length} صوت`);
  } }, '⟳ تحميل الأصوات');
  let stt = s.stt, renderer = s.renderer, selfReview = s.selfReview;
  const defStyle = { ...DEFAULT_STYLE, ...(s.style || {}) }; defStyle.formats = [...(defStyle.formats || ['9:16'])];
  const defStyleBox = styleControls(defStyle);
  const gemVoice = h('select', {}, GEMINI_VOICES.map(v => h('option', { value: v, selected: v === (s.gemini?.voice || 'Kore') }, v)));
  const approvals = { ...s.approvals };

  async function save(quiet) {
    const patch = { llm: {}, eleven: {}, deepgram: {}, gemini: { voice: gemVoice.value }, approvals, stt, renderer, selfReview, style: defStyle, llmBackups: backups.map(b => ({ ...b })) };
    for (const [path, el] of Object.entries(f)) {
      if (el.disabled) continue;
      const parts = path.split('.');
      let v = el.value;
      if (el.type === 'number') v = +v;
      if (parts.length === 2) patch[parts[0]][parts[1]] = v; else patch[parts[0]] = v;
    }
    patch.eleven.voiceId = voiceSel.value;
    // Help with the usual mix-ups: key pasted into Base URL, website link instead of the API URL, key of another provider.
    const notes = [];
    if (!f['llm.baseUrl'].disabled) {
      if (looksLikeKey(patch.llm.baseUrl)) { if (!patch.llm.apiKey || patch.llm.apiKey.includes('••••')) patch.llm.apiKey = patch.llm.baseUrl.trim(); patch.llm.baseUrl = ''; notes.push('المفتاح اتنقل لخانة المفتاح'); }
      const byKey = !String(patch.llm.apiKey || '').includes('••••') && providerFromKey(patch.llm.apiKey);
      if (byKey && (!patch.llm.baseUrl || isLocalUrl(patch.llm.baseUrl) || providerOf(patch.llm.baseUrl).name !== byKey.name)) { patch.llm.baseUrl = byKey.baseUrl; patch.llm.model = byKey.model; notes.push(`المفتاح ده ${byKey.name} — ضبطنا الرابط والموديل`); }
      const fx = fixBaseUrl(patch.llm.baseUrl);
      if (fx.note) { patch.llm.baseUrl = fx.url; notes.push('Base URL اتصلّح'); }
      if (/generativelanguage/.test(patch.llm.baseUrl) && (!patch.llm.model || patch.llm.model === 'auto')) patch.llm.model = 'gemini-flash-latest';
      f['llm.baseUrl'].value = patch.llm.baseUrl; f['llm.model'].value = patch.llm.model; updHint();
    }
    s = await guard(() => be.saveSettings(patch), quiet ? null : 'اتحفظ ✓' + (notes.length ? ' — ' + notes.join('، ') : ''));
    for (const [path, el] of Object.entries(f)) if (el.type === 'password') el.value = path.split('.').reduce((a, k) => a?.[k], s) || '';
    const saved = new Map((s.llmBackups || []).map(b => [b.id, b]));
    backups.forEach(b => { if (saved.has(b.id)) b.apiKey = saved.get(b.id).apiKey; });
    drawBackups();
  }

  const fontBlock = be.mode === 'local'
    ? h('div', {}, h('label', {}, 'ملف خط عربي (اختياري، بدل IBM Plex Sans Arabic)'), h('input', { type: 'file', accept: '.ttf,.otf,.woff,.woff2', onchange: async e => { s = await guard(() => be.setFontFile(e.target.files[0]), 'اتحفظ الخط'); } }), h('div', { class: 'hint' }, s.fontFile ? `الحالي: ${s.fontFile}` : 'الحالي: IBM Plex Sans Arabic'))
    : h('div', {}, h('label', {}, 'فولدر الخط (مسار على الجهاز فيه ملف ttf/otf/woff2)'), inp('fontFolder', { class: 'ltr', placeholder: 'C:\\Fonts\\MyArabicFont' }), h('div', { class: 'hint' }, 'سيبه فاضي = IBM Plex Sans Arabic (مرفق مع رخصة OFL).'));

  app.append(...clean(
    h('div', { class: 'card' },
      h('p', { class: 'muted small' }, be.mode === 'server' ? '🔒 المفاتيح محفوظة على جهازك في data/settings.json، والمتصفح بيشوف آخر 4 حروف بس.' : '📱 وضع الهاتف: كل حاجة شغالة جوه المتصفح، والمفاتيح محفوظة على الجهاز ده بس (IndexedDB).')),
    h('div', { class: 'card' }, h('h2', {}, '1. الذكاء الاصطناعي (LLM)'),
      h('div', { class: 'hint' }, 'أي API متوافق مع OpenAI. الافتراضي FreeLLMAPI على جهازك.'), presets,
      h('label', {}, 'Base URL'), inp('llm.baseUrl', { class: 'ltr' }),
      h('div', { class: 'grid2' }, h('div', {}, h('label', {}, 'Model'), h('div', { class: 'keyrow' }, inp('llm.model', { class: 'ltr', list: 'llm-models' }), loadModels), modelList), h('div', {}, h('label', {}, 'Temperature'), inp('llm.temperature', { type: 'number', step: '0.1', min: 0, max: 2, class: 'ltr' }))),
      h('label', {}, 'API key (مطلوب لـ Gemini / Groq / OpenRouter — اختياري لـ FreeLLMAPI)'), key('llm.apiKey'), llmKeyHint,
      h('hr'), h('h3', {}, '🔁 مزوّدين احتياطيين'),
      h('div', { class: 'hint' }, 'لو الأساسي فشل أو مزحوم أو خلص الحد المجاني، البرنامج بيجرّب دول بالترتيب لوحده. أغلبهم عندهم خطة مجانية. (على الهاتف: بعض المزوّدين ممكن يرفضوا الطلب من المتصفح — جرّب Gemini / Groq / OpenRouter الأول.)'),
      backupsBox, h('div', { class: 'row', style: 'margin-top:8px' }, addBackupSel),
      h('label', { class: 'row', style: 'gap:8px' }, h('input', { type: 'checkbox', checked: selfReview, onchange: e => (selfReview = e.target.checked) }), 'مراجعة ذاتية للستوري بورد (تمريرة تانية تحسّن الاختيارات)')),
    h('div', { class: 'card' }, h('h2', {}, '2. الصوت — ElevenLabs'),
      h('label', {}, 'API key'), key('eleven.apiKey', 'https://elevenlabs.io/app/developers/'),
      h('label', {}, 'الصوت'), h('div', { class: 'row' }, h('div', { class: 'grow' }, voiceSel), loadVoices),
      h('div', { class: 'grid2' }, h('div', {}, h('label', {}, 'Model'), inp('eleven.modelId', { class: 'ltr' })), h('div', {}, h('label', {}, 'Base URL'), inp('eleven.baseUrl', { class: 'ltr' })))),
    h('div', { class: 'card' }, h('h2', {}, '2ب. صوت مجاني — Gemini TTS'),
      h('div', { class: 'hint' }, 'لو بتستعمل Gemini للكتابة، نفس المفتاح بيكفي (سيب الخانة فاضية).'),
      h('label', {}, 'Gemini API key (اختياري)'), key('gemini.apiKey', 'https://aistudio.google.com/apikey'),
      h('div', { class: 'grid2' }, h('div', {}, h('label', {}, 'الصوت'), gemVoice), h('div', {}, h('label', {}, 'TTS model'), inp('gemini.ttsModel', { class: 'ltr' })))),
    h('div', { class: 'card' }, h('h2', {}, '3. توقيت الصوت المرفوع'),
      seg([['deepgram', 'Deepgram nova-3'], ['elevenlabs', 'ElevenLabs Scribe']], stt, v => (stt = v)),
      h('div', { class: 'hint' }, 'على الموبايل Scribe بيشتغل بنفس مفتاح ElevenLabs من غير مفتاح تاني.'),
      h('label', {}, 'Deepgram API key'), key('deepgram.apiKey', 'https://console.deepgram.com/'),
      h('div', { class: 'grid2' }, h('div', {}, h('label', {}, 'Model'), inp('deepgram.model', { class: 'ltr' })), h('div', {}, h('label', {}, 'Base URL'), inp('deepgram.baseUrl', { class: 'ltr' })))),
    h('div', { class: 'card' }, h('h2', {}, '4. الشكل والرندر'),
      h('div', { class: 'grid2' }, h('div', {}, h('label', {}, 'اسم السلسلة — عربي'), inp('seriesTag')), h('div', {}, h('label', {}, 'اسم السلسلة — Español'), inp('seriesTagEs', { dir: 'ltr' }))),
      fontBlock,
      h('label', {}, 'اسمك / حسابك (يظهر في شاشة النهاية والغلاف — بدّله زي ما تحب)'), inp('handle', { dir: 'auto', placeholder: '@username' }),
      h('div', { class: 'grid2' }, h('div', {}, h('label', {}, 'السطر تحت الاسم (فاضي = الافتراضي)'), inp('endFollow', { dir: 'auto', placeholder: 'تابعني عشان الحلقة الجاية' })), h('div', {}, h('label', {}, 'سؤال التعليقات (فاضي = الافتراضي)'), inp('endComment', { dir: 'auto', placeholder: 'قولّي في الكومنتات: نشرح إيه المرة الجاية؟' }))),
      h('label', {}, 'الشكل الافتراضي للمشاريع الجديدة'), defStyleBox,
      h('label', {}, 'مستوى المؤثرات الصوتية (0 = بدون، 1 = عادي)'), inp('sfxLevel', { type: 'number', step: '0.1', min: 0, max: 2, class: 'ltr' }),
      be.mode === 'server' ? h('div', {}, h('label', {}, 'محرك الرندر'), seg([['auto', 'تلقائي'], ['server', 'Chromium + ffmpeg'], ['browser', 'المتصفح (WebCodecs)']], renderer, v => (renderer = v))) : null,
      h('label', {}, 'الموافقات الافتراضية'),
      h('div', { class: 'grid2' }, STAGES.map(st => h('div', { class: 'row' }, h('span', { class: 'grow' }, STAGE_AR[st]), seg([['auto', 'تلقائي'], ['wait', 'استناني']], approvals[st], v => (approvals[st] = v)))))),
    h('div', { class: 'sticky-actions' }, h('button', { class: 'primary', onclick: () => save() }, 'حفظ الإعدادات')),
    h('div', { class: 'card small muted' }, h('h3', {}, 'الوضع والتراخيص'),
      h('div', {}, `الوضع: ${be.mode === 'server' ? 'سيرفر على الكمبيوتر' : 'داخل المتصفح (هاتف)'}`),
      be.mode === 'local' && location.protocol !== 'file:' ? null : null,
      h('div', {}, 'الخط: IBM Plex Sans Arabic — SIL OFL 1.1 (', h('a', { href: 'assets/fonts/OFL.txt', target: '_blank' }, 'OFL.txt'), ')'),
      h('div', {}, 'الأيقونات: رسم يدوي (CC0) + Health Icons (CC0) + Tabler Icons (MIT) — التراخيص كاملة داخل assets/icons/icons.json'),
      h('div', { class: 'row', style: 'margin-top:8px' },
        be.mode === 'server' ? h('button', { class: 'ghost sm', onclick: () => { localStorage.setItem('reel.mode', 'local'); location.reload(); } }, 'جرّب وضع المتصفح') : localStorage.getItem('reel.mode') === 'local' ? h('button', { class: 'ghost sm', onclick: () => { localStorage.removeItem('reel.mode'); location.reload(); } }, 'ارجع لوضع السيرفر') : null)),
  ));
  updHint();
  f['llm.baseUrl'].addEventListener('input', updHint);
  const pg = h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'الإعدادات والمفاتيح'), h('div', { class: 'sub' }, 'مفاتيح الـ APIs (credentials)، الموديلات، الصوت والشكل الافتراضي'))));
  pg.append(...app.childNodes);
  app.append(pg);
}

// ---------------------------------------------------------------- boot
be = await pickBackend();
const h0 = await be.health().catch(() => ({}));
$('#mode').textContent = be.mode === 'server' ? 'PC' : 'هاتف';
$('#logo').append(icon('movie', 22));
$('#nav-home').prepend(icon('grid', 22));
$('#nav-settings').prepend(icon('key', 22));
$('#mode').title = be.mode === 'server' ? `ffmpeg: ${h0.ffmpeg ? '✓' : '✗'}` : `WebCodecs: ${h0.webcodecs ? '✓' : '✗'}`;
if ('serviceWorker' in navigator && location.protocol === 'https:' ) navigator.serviceWorker.register('sw.js').catch(() => {});
route();
