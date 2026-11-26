// Reel Studio UI (RTL Arabic, mobile-first). Works against the PC server or fully in the browser (phone mode).
import { STAGES, LENGTHS } from './core/pipeline.js';
import { LLM_PRESETS } from './core/defaults.js';
import { LANGS } from './core/lang.js';
import { providerOf, isLocalUrl } from './core/errors.js';
import { createRenderer, loadFonts } from './render/engine.js';

const STAGE_AR = { script: 'السكريبت', voice: 'الصوت', timing: 'التوقيت', storyboard: 'الستوري بورد', render: 'الرندر' };
const STATUS_AR = { idle: 'في الانتظار', running: 'شغّال…', review: 'محتاج موافقتك', done: 'تم', error: 'خطأ' };
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
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('on', (hash.startsWith('/settings') ? 'settings' : hash === '/' ? 'home' : '') === a.dataset.nav));
  app.replaceChildren();
  window.scrollTo(0, 0);
  try {
    if (hash.startsWith('/p/')) await viewProject(hash.slice(3));
    else if (hash.startsWith('/settings')) await viewSettings();
    else await viewHome();
  } catch (e) { app.replaceChildren(h('div', { class: 'card err' }, e.message)); }
}
window.addEventListener('hashchange', route);

// ---------------------------------------------------------------- home
async function viewHome() {
  const settings = await be.getSettings();
  const llmPr = providerOf(settings.llm.baseUrl);
  const missing = [];
  if (!settings.has?.llm && !isLocalUrl(settings.llm.baseUrl)) missing.push([llmPr.name, llmPr.link]);
  if (!settings.has?.eleven) missing.push(['ElevenLabs', 'https://elevenlabs.io/app/developers/']);
  if (be.mode === 'local' && isLocalUrl(settings.llm.baseUrl)) missing.push(['LLM أونلاين (FreeLLMAPI ما يشتغلش من الهاتف)', '']);
  let length = +(localStorage.getItem('reel.length') || 10);
  let voiceSource = 'tts';
  let lang = localStorage.getItem('reel.lang') || 'ar';
  const approvals = { ...settings.approvals };
  const topic = h('textarea', { placeholder: 'مثال: ليه بنتاوب لما نشوف حد بيتاوب؟', rows: 3, style: 'min-height:84px' });
  const notes = h('input', { type: 'text', placeholder: 'ملاحظات اختيارية للكاتب (زاوية، مصدر، جمهور…)' });
  const lenChips = h('div', { class: 'chips' }, LENGTHS.map(l => h('span', { class: 'chip' + (l === length ? ' on' : ''), onclick: e => { length = l; localStorage.setItem('reel.length', l); [...e.target.parentNode.children].forEach(c => c.classList.toggle('on', c === e.target)); } }, `${l} ث`)));
  const langSeg = seg(Object.values(LANGS).map(l => [l.id, (l.id === 'ar' ? '🇪🇬 ' : '🇪🇸 ') + l.name]), lang, v => { lang = v; localStorage.setItem('reel.lang', v); topic.placeholder = v === 'es' ? 'Ejemplo: ¿Por qué bostezamos cuando alguien bosteza?' : 'مثال: ليه بنتاوب لما نشوف حد بيتاوب؟'; });
  const srcSeg = seg([['tts', 'صوت ElevenLabs'], ['upload', 'صوتي أنا (رفع ملف)']], voiceSource, v => (voiceSource = v));
  const apr = h('div', { class: 'grid2' }, STAGES.map(s => h('div', { class: 'row' }, h('span', { class: 'grow' }, STAGE_AR[s]), seg([['auto', 'تلقائي'], ['wait', 'استناني']], approvals[s], v => (approvals[s] = v)))));
  const go = h('button', { class: 'primary', onclick: async () => {
    if (!topic.value.trim()) return toast('اكتب الموضوع الأول', true);
    go.disabled = true;
    try {
      const p = await guard(() => be.createProject({ topic: topic.value.trim(), length, notes: notes.value, approvals, voiceSource, lang }));
      location.hash = '#/p/' + p.id;
    } finally { go.disabled = false; }
  } }, '✦ ابدأ الريل');

  const list = h('div', { class: 'list' }, h('p', { class: 'muted' }, '…'));
  app.append(...clean(
    missing.length ? h('div', { class: 'card', style: 'border-color:var(--warn)' },
      h('b', {}, '⚠️ قبل ما تبدأ: ناقص مفاتيح'),
      h('ul', { class: 'small' }, missing.map(([n, l]) => h('li', {}, n, l ? [' — ', h('a', { href: l, target: '_blank', rel: 'noopener' }, 'هات مفتاح مجاني')] : null))),
      h('a', { class: 'btn sm primary', href: '#/settings' }, '⚙ افتح الإعدادات')) : null,
    h('div', { class: 'card' },
      h('h1', {}, 'ريل جديد'),
      h('label', {}, 'الموضوع'), topic,
      h('label', {}, 'لغة الفيديو'), langSeg,
      h('label', {}, 'مدة الفيديو'), lenChips,
      h('label', {}, 'التعليق الصوتي'), srcSeg,
      h('details', {}, h('summary', {}, 'الموافقات لكل مرحلة + ملاحظات'), h('div', { class: 'hint' }, '«استناني» = توقف المرحلة لحد ما توافق أو تعدّل.'), apr, h('label', {}, 'ملاحظات'), notes),
      h('div', { class: 'row', style: 'margin-top:14px' }, go),
    ),
    h('div', { class: 'card' }, h('h2', {}, 'المشاريع'), list),
  ));
  const { projects } = await be.listProjects();
  list.replaceChildren(...(projects.length ? projects.map(p => h('a', { class: 'item', href: '#/p/' + p.id },
    h('div', { class: 'grow' }, h('b', {}, p.title || p.topic), h('span', { class: 'muted small' }, `${p.lang === 'es' ? '🇪🇸' : '🇪🇬'} ${p.length} ث · ${ago(p.updatedAt)}`)),
    h('div', { class: 'dots', title: 'المراحل' }, STAGES.map(s => h('i', { class: 'dot s-' + p.stages[s] }))),
  )) : [h('div', { class: 'empty' }, 'لسه مفيش مشاريع — اكتب موضوع فوق وابدأ.')]));
}

function seg(options, value, onChange) {
  const el = h('div', { class: 'seg' });
  for (const [v, label] of options) el.append(h('button', { type: 'button', class: v === value ? 'on' : '', onclick: e => { [...el.children].forEach(b => b.classList.toggle('on', b === e.currentTarget)); onChange(v); } }, label));
  return el;
}

// ---------------------------------------------------------------- project
async function viewProject(id) {
  let p = await be.getProject(id);
  const live = { stream: {}, progress: {}, frame: null, editing: {} };
  let preview = null;

  const head = h('div');
  const stepper = h('div', { class: 'stepper' });
  const cards = Object.fromEntries(STAGES.map(s => [s, h('section', { class: 'card stage', id: 'st-' + s })]));
  const actions = h('div', { class: 'sticky-actions' });
  app.append(...clean(head, stepper, ...STAGES.map(s => cards[s]), actions));

  const running = () => p.running || STAGES.some(s => p.stages[s].status === 'running');

  function drawHead() {
    head.replaceChildren(h('div', { class: 'row' },
      h('div', { class: 'grow' }, h('h1', {}, p.title || p.topic), h('div', { class: 'muted small' }, `${p.topic} · ${p.length} ثانية · ${LANGS[p.lang || 'ar'].name}`)),
      h('button', { class: 'danger sm', onclick: async () => { if (confirm('امسح المشروع؟')) { await guard(() => be.deleteProject(id)); location.hash = '#/'; } } }, 'حذف'),
    ));
    stepper.replaceChildren(...STAGES.map(s => h('div', { class: 'step ' + p.stages[s].status, onclick: () => cards[s].scrollIntoView({ behavior: 'smooth' }) }, h('b', {}, STAGE_AR[s]), STATUS_AR[p.stages[s].status])));
    const review = STAGES.find(s => p.stages[s].status === 'review');
    const next = STAGES.find(s => p.stages[s].status !== 'done');
    actions.replaceChildren(...clean(
      running() ? h('button', { class: 'danger', onclick: () => guard(() => be.cancel(id), 'اتلغى') }, '■ إلغاء')
        : review ? h('button', { class: 'ok', onclick: () => guard(() => be.approve(id, review), 'تمام ✓') }, `✓ موافق على ${STAGE_AR[review]}`)
        : next ? h('button', { class: 'primary', onclick: () => guard(() => be.start(id)) }, p.stages[next].status === 'error' ? `↻ كمّل من ${STAGE_AR[next]}` : `▶ ابدأ ${STAGE_AR[next]}`)
        : h('button', { class: 'primary', onclick: () => cards.render.scrollIntoView({ behavior: 'smooth' }) }, '🎬 الفيديو جاهز'),
    ));
  }

  function stageShell(s, body) {
    const st = p.stages[s];
    const appr = seg([['auto', 'تلقائي'], ['wait', 'استناني']], p.approvals[s], v => guard(() => be.setApprovals(id, { [s]: v })));
    const btns = [];
    if (st.status === 'review') btns.push(h('button', { class: 'ok sm', onclick: () => guard(() => be.approve(id, s), 'تمام ✓') }, '✓ موافق'));
    if (!running() && (st.status !== 'idle' || STAGES.indexOf(s) === 0 || p.stages[STAGES[STAGES.indexOf(s) - 1]].status === 'done')) btns.push(h('button', { class: 'ghost sm', onclick: () => guard(() => be.rerun(id, s)) }, st.status === 'idle' ? '▶ شغّل' : '↻ إعادة'));
    if (st.status === 'running') btns.push(h('button', { class: 'danger sm', onclick: () => guard(() => be.cancel(id)) }, 'إلغاء'));
    const log = h('div', { class: 'log', id: 'log-' + s }, st.log.slice(-60).map(l => h('div', { dir: 'auto', class: /^✗/.test(l.msg) ? 'err' : '' }, l.msg)));
    cards[s].replaceChildren(...clean(
      h('div', { class: 'stage-head' }, h('h2', {}, `${STAGES.indexOf(s) + 1}. ${STAGE_AR[s]}`), h('span', { class: 'badge ' + st.status }, STATUS_AR[st.status]), h('span', { class: 'spacer' }), appr, ...btns),
      st.error ? h('div', { class: 'errbox' },
        h('div', { dir: 'auto' }, '⚠️ ' + st.error),
        h('div', { class: 'row', style: 'margin-top:8px' },
          ['key', 'model', 'network', 'quota'].includes(st.errorCode) ? h('a', { class: 'btn sm', href: '#/settings' }, '⚙ افتح الإعدادات') : null,
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
  const srcSeg = seg([['tts', 'ElevenLabs TTS'], ['upload', 'رفع صوتي']], p.voiceSource, v => guard(() => be.setVoiceSource(id, { source: v })));
    wrap.append(h('div', { class: 'row' }, srcSeg));
    if (p.voiceSource === 'upload') {
      const inp = h('input', { type: 'file', accept: 'audio/*,.mp3,.wav,.m4a,.ogg,.opus,.webm', onchange: async () => {
        const f = inp.files[0]; if (!f) return;
        await guard(() => be.uploadVoice(id, f), 'اترفع ✓');
      } });
      wrap.append(h('label', {}, p.upload ? `الملف الحالي: ${p.upload.name}` : 'اختار ملف التعليق الصوتي (اقرأ السكريبت زي ما هو)'), inp,
        h('div', { class: 'hint' }, 'التوقيت هيتعمل بـ Deepgram (أو ElevenLabs Scribe من الإعدادات) وبعدين يتطابق مع كلمات السكريبت.'));
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
    const scenes = h('div', { class: 'scenes' }, p.storyboard.scenes.map((s, k) => h('div', { class: 'scene' },
      h('b', {}, `${k + 1}. ${TYPE_AR[s.type] || s.type} · ${s.template}`), ` — عند «${tok[s.at]?.text || s.at}» (${fmtT(tok[s.at]?.start)} ث)`,
      s.title ? h('div', {}, s.title) : null,
      h('div', { class: 'muted' }, [s.organ ? `organ: ${s.organ}` : '', s.value != null ? `${s.value}/${s.max} ${s.unit || ''}` : '', ...s.items.map(i => `${i.label}${i.icon ? ` [${i.icon}]` : ''}${i.value != null ? ` = ${i.value}` : ''}`)].filter(Boolean).join(' · ')),
    )));
    return h('div', { class: 'preview' }, previewBox(), h('div', {},
      scenes,
      p.iconMisses?.length ? h('div', { class: 'hint' }, 'أيقونات مالقيناش ليها تطابق: ' + p.iconMisses.join(', ')) : null,
      p.storyboardFixes?.length ? h('details', {}, h('summary', {}, `إصلاحات تلقائية (${p.storyboardFixes.length})`), h('div', { class: 'log ltr' }, p.storyboardFixes.join('\n'))) : null,
      !running() ? h('button', { class: 'sm', style: 'margin-top:8px', onclick: () => { live.editing.storyboard = true; refresh(); } }, '✎ تعديل JSON') : null));
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
    if (!p.render || st.status !== 'done' && st.status !== 'review') return h('p', { class: 'muted' }, '1080×1920 · 30fps · H.264 · صوت مع مؤثرات ناعمة على −14 LUFS.');
    const v = h('video', { controls: true, playsinline: true, preload: 'metadata' });
    const dl = h('a', { class: 'btn primary', download: `${(p.title || 'reel').replace(/[\\/:*?"<>|]/g, '')}.mp4` }, '⬇ تحميل الفيديو');
    be.fileUrl(id, p.render.file).then(u => { v.src = u; dl.href = u + (be.mode === 'server' ? '?download=1' : ''); });
    const shareBtn = navigator.share ? h('button', { onclick: async () => {
      try { const blob = await (await fetch(v.src)).blob(); await navigator.share({ files: [new File([blob], 'reel.mp4', { type: 'video/mp4' })], title: p.title }); } catch (e) { if (e.name !== 'AbortError') toast(e.message, true); }
    } }, '↗ مشاركة') : null;
    return h('div', { class: 'preview' }, h('div', {}, h('div', { class: 'phone' }, v)),
      h('div', {}, h('div', { class: 'row' }, dl, shareBtn),
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
    for (const s of STAGES) {
      if (live.editing[s] && cards[s].dataset.editing) continue;
      cards[s].dataset.editing = live.editing[s] ? '1' : '';
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
    } else if (ev.type === 'frame') {
      live.frame = ev.data;
      const img = document.getElementById('live-frame');
      if (img) img.src = ev.data;
    }
  });
  cleanup = () => { unsub(); preview?.destroy(); };
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
  const approvals = { ...s.approvals };

  async function save(quiet) {
    const patch = { llm: {}, eleven: {}, deepgram: {}, approvals, stt, renderer, selfReview };
    for (const [path, el] of Object.entries(f)) {
      if (el.disabled) continue;
      const parts = path.split('.');
      let v = el.value;
      if (el.type === 'number') v = +v;
      if (parts.length === 2) patch[parts[0]][parts[1]] = v; else patch[parts[0]] = v;
    }
    patch.eleven.voiceId = voiceSel.value;
    s = await guard(() => be.saveSettings(patch), quiet ? null : 'اتحفظ ✓');
    for (const [path, el] of Object.entries(f)) if (el.type === 'password') el.value = path.split('.').reduce((a, k) => a?.[k], s) || '';
  }

  const fontBlock = be.mode === 'local'
    ? h('div', {}, h('label', {}, 'ملف خط عربي (اختياري، بدل IBM Plex Sans Arabic)'), h('input', { type: 'file', accept: '.ttf,.otf,.woff,.woff2', onchange: async e => { s = await guard(() => be.setFontFile(e.target.files[0]), 'اتحفظ الخط'); } }), h('div', { class: 'hint' }, s.fontFile ? `الحالي: ${s.fontFile}` : 'الحالي: IBM Plex Sans Arabic'))
    : h('div', {}, h('label', {}, 'فولدر الخط (مسار على الجهاز فيه ملف ttf/otf/woff2)'), inp('fontFolder', { class: 'ltr', placeholder: 'C:\\Fonts\\MyArabicFont' }), h('div', { class: 'hint' }, 'سيبه فاضي = IBM Plex Sans Arabic (مرفق مع رخصة OFL).'));

  app.append(...clean(
    h('div', { class: 'card' }, h('h1', {}, 'الإعدادات'),
      h('p', { class: 'muted small' }, be.mode === 'server' ? '🔒 المفاتيح محفوظة على جهازك في data/settings.json، والمتصفح بيشوف آخر 4 حروف بس.' : '📱 وضع الهاتف: كل حاجة شغالة جوه المتصفح، والمفاتيح محفوظة على الجهاز ده بس (IndexedDB).')),
    h('div', { class: 'card' }, h('h2', {}, '1. الذكاء الاصطناعي (LLM)'),
      h('div', { class: 'hint' }, 'أي API متوافق مع OpenAI. الافتراضي FreeLLMAPI على جهازك.'), presets,
      h('label', {}, 'Base URL'), inp('llm.baseUrl', { class: 'ltr' }),
      h('div', { class: 'grid2' }, h('div', {}, h('label', {}, 'Model'), inp('llm.model', { class: 'ltr' })), h('div', {}, h('label', {}, 'Temperature'), inp('llm.temperature', { type: 'number', step: '0.1', min: 0, max: 2, class: 'ltr' }))),
      h('label', {}, 'API key (مطلوب لـ Gemini / Groq / OpenRouter — اختياري لـ FreeLLMAPI)'), key('llm.apiKey'), llmKeyHint,
      h('label', { class: 'row', style: 'gap:8px' }, h('input', { type: 'checkbox', checked: selfReview, onchange: e => (selfReview = e.target.checked) }), 'مراجعة ذاتية للستوري بورد (تمريرة تانية تحسّن الاختيارات)')),
    h('div', { class: 'card' }, h('h2', {}, '2. الصوت — ElevenLabs'),
      h('label', {}, 'API key'), key('eleven.apiKey', 'https://elevenlabs.io/app/developers/'),
      h('label', {}, 'الصوت'), h('div', { class: 'row' }, h('div', { class: 'grow' }, voiceSel), loadVoices),
      h('div', { class: 'grid2' }, h('div', {}, h('label', {}, 'Model'), inp('eleven.modelId', { class: 'ltr' })), h('div', {}, h('label', {}, 'Base URL'), inp('eleven.baseUrl', { class: 'ltr' })))),
    h('div', { class: 'card' }, h('h2', {}, '3. توقيت الصوت المرفوع'),
      seg([['deepgram', 'Deepgram nova-3'], ['elevenlabs', 'ElevenLabs Scribe']], stt, v => (stt = v)),
      h('div', { class: 'hint' }, 'على الموبايل Scribe بيشتغل بنفس مفتاح ElevenLabs من غير مفتاح تاني.'),
      h('label', {}, 'Deepgram API key'), key('deepgram.apiKey', 'https://console.deepgram.com/'),
      h('div', { class: 'grid2' }, h('div', {}, h('label', {}, 'Model'), inp('deepgram.model', { class: 'ltr' })), h('div', {}, h('label', {}, 'Base URL'), inp('deepgram.baseUrl', { class: 'ltr' })))),
    h('div', { class: 'card' }, h('h2', {}, '4. الشكل والرندر'),
      h('div', { class: 'grid2' }, h('div', {}, h('label', {}, 'اسم السلسلة — عربي'), inp('seriesTag')), h('div', {}, h('label', {}, 'اسم السلسلة — Español'), inp('seriesTagEs', { dir: 'ltr' }))),
      fontBlock,
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
}

// ---------------------------------------------------------------- boot
be = await pickBackend();
const h0 = await be.health().catch(() => ({}));
$('#mode').textContent = be.mode === 'server' ? '💻 PC' : '📱 هاتف';
$('#mode').title = be.mode === 'server' ? `ffmpeg: ${h0.ffmpeg ? '✓' : '✗'}` : `WebCodecs: ${h0.webcodecs ? '✓' : '✗'}`;
if ('serviceWorker' in navigator && location.protocol === 'https:' ) navigator.serviceWorker.register('sw.js').catch(() => {});
route();
