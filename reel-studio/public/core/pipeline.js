// The 5-stage pipeline (script → voice → timing → storyboard → render).
// Runs unchanged on the Node server and inside the browser (phone mode); `env` supplies I/O.
import { chatStream, extractJson, listModels, modelProblem, isBusy } from './llm.js';
import { scriptMessages, parseScript, ensureSeriesQuestion, checkLength, targetWords } from './script.js';
import { tokenize } from './text.js';
import { alignTokens, estimateTimings } from './align.js';
import { elevenTTS, alignmentToWords, deepgramListen, elevenSTT, geminiTTS, geminiTtsModels } from './providers.js';
import { ideasMessages, parseIdeas, publishMessages, fallbackPublish } from './ideas.js';
import { storyboardMessages, repairStoryboard, lintStoryboard, reviewMessages } from './storyboard.js';
import { resolveStoryboardIcons } from './icons.js';
import { buildTimeline, videoDuration, speechEnd, TAIL } from './timeline.js';
import { mixAudio, encodeWav } from './audio.js';
import { LANGS, lang as L } from './lang.js';
import { friendly, providerOf, isLocalUrl, missingKey, fixBaseUrl, providerFromKey, looksLikeKey } from './errors.js';

export const STAGES = ['script', 'voice', 'timing', 'storyboard', 'render'];
export const LENGTHS = [10, 20, 30, 45, 60];
export const DEFAULT_APPROVALS = { script: 'wait', voice: 'auto', timing: 'auto', storyboard: 'auto', render: 'auto' };
export const FPS = 30;
export const FORMATS = { '9:16': 'reel.mp4', '1:1': 'reel-1x1.mp4', '16:9': 'reel-16x9.mp4' };
export const DEFAULT_STYLE = { music: 'calm', musicLevel: 1, captions: 'classic', endScreen: true, hook: true, formats: ['9:16'] };
export const VOICE_SOURCES = ['tts', 'gemini', 'upload'];
/** The Gemini key: its own field, else the LLM key when the LLM is Gemini. */
export const geminiKey = s => s.gemini?.apiKey || (/generativelanguage/.test(s.llm?.baseUrl || '') ? s.llm.apiKey : '');

const now = () => new Date().toISOString();
const newStage = () => ({ status: 'idle', log: [], error: null, startedAt: null, endedAt: null });
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export function newProject({ topic, length = 30, notes = '', approvals, voiceSource = 'tts', voiceId, lang = 'ar', style } = {}) {
  if (!topic || !String(topic).trim()) throw new Error('Topic is required');
  length = LENGTHS.includes(Number(length)) ? Number(length) : 30;
  const stages = {};
  for (const s of STAGES) stages[s] = newStage();
  return {
    id: uid(), topic: String(topic).trim(), lang: LANGS[lang] ? lang : 'ar', length, notes: String(notes || ''), title: '', createdAt: now(), updatedAt: now(),
    voiceSource: VOICE_SOURCES.includes(voiceSource) ? voiceSource : 'tts', voiceId: voiceId || '', approvals: { ...DEFAULT_APPROVALS, ...(approvals || {}) }, stages,
    style: { ...DEFAULT_STYLE, ...(style || {}) },
  };
}

/** Render payload for render.html / the browser encoder. Only the icons the project uses are included. */
export function renderData(p, settings = {}, aspect = '9:16') {
  const tokens = (p.timing?.tokens || []).map(t => ({ i: t.i, text: t.text, start: t.start, end: t.end, br: t.br }));
  const style = { ...DEFAULT_STYLE, ...(p.style || {}) };
  return {
    v: 1, id: p.id, fps: FPS, aspect,
    style: { ...style, handle: settings.handle ?? '' },
    endAt: speechEnd(tokens, p.voice?.duration) + TAIL,
    duration: videoDuration(tokens, p.voice?.duration, { endScreen: style.endScreen }),
    title: p.script?.title || p.title || p.topic, lang: p.lang || 'ar',
    series: (p.lang === 'es' ? settings.seriesTagEs : settings.seriesTag) || L(p.lang).series, tokens,
    storyboard: p.storyboard || { scenes: [], accents: [] }, icons: p.icons || {}, iconMap: p.iconMap || {},
  };
}

export class Pipeline {
  constructor(env) {
    this.env = env;
    this.runs = new Map(); // id → {ctrl, stage}
    this.locks = new Map();
  }

  emit(id, ev) { try { this.env.emit?.(id, ev); } catch {} }

  async create(opts) {
    const s = await this.env.getSettings();
    const p = newProject({ approvals: s.approvals, ...opts, approvals: { ...(s.approvals || {}), ...(opts.approvals || {}) } });
    await this.save(p);
    return p;
  }

  async save(p) {
    p.updatedAt = now();
    await this.env.store.save(p);
    this.emit(p.id, { type: 'state', project: p });
  }

  async get(id) {
    const p = await this.env.store.load(id);
    if (!p) throw Object.assign(new Error('Project not found'), { status: 404 });
    return p;
  }

  isRunning(id) { return this.runs.has(id); }

  log(p, stage, msg) {
    const line = { t: now(), msg: String(msg) };
    const st = p.stages[stage];
    st.log.push(line);
    if (st.log.length > 400) st.log.splice(0, st.log.length - 400);
    this.emit(p.id, { type: 'log', stage, line });
  }

  /** Reset a stage and everything after it. */
  resetFrom(p, stage) {
    for (const s of STAGES.slice(STAGES.indexOf(stage))) p.stages[s] = newStage();
  }

  /** Start (or continue) the pipeline from the first stage that isn't done. */
  async start(id) {
    const p = await this.get(id);
    const first = STAGES.find(s => p.stages[s].status !== 'done');
    if (!first) return p;
    if (p.stages[first].status === 'review') return p; // waiting for approval
    return this.runFrom(id, first);
  }

  async approve(id, stage) {
    const p = await this.get(id);
    if (p.stages[stage].status !== 'review') throw Object.assign(new Error(`Stage ${stage} is not waiting for approval`), { status: 409 });
    p.stages[stage].status = 'done';
    this.log(p, stage, 'Approved ✓');
    await this.save(p);
    const next = STAGES[STAGES.indexOf(stage) + 1];
    if (next) this.runFrom(id, next).catch(() => {});
    return p;
  }

  async rerun(id, stage) {
    if (this.isRunning(id)) await this.cancel(id);
    const p = await this.get(id);
    this.resetFrom(p, stage);
    await this.save(p);
    this.runFrom(id, stage).catch(() => {});
    return p;
  }

  async cancel(id) {
    const run = this.runs.get(id);
    if (run) { run.ctrl.abort(); await run.done.catch(() => {}); }
    return this.get(id);
  }

  /** Look & sound options. Changing them only needs a new render. */
  async setStyle(id, style) {
    if (this.isRunning(id)) throw Object.assign(new Error('Pipeline is running — cancel it first'), { status: 409 });
    const p = await this.get(id);
    const s = { ...DEFAULT_STYLE, ...(p.style || {}) };
    if (['calm', 'suspense', 'upbeat', 'none'].includes(style.music)) s.music = style.music;
    if (Number.isFinite(+style.musicLevel)) s.musicLevel = Math.max(0, Math.min(2, +style.musicLevel));
    if (['classic', 'word', 'box'].includes(style.captions)) s.captions = style.captions;
    for (const k of ['endScreen', 'hook']) if (typeof style[k] === 'boolean') s[k] = style[k];
    if (Array.isArray(style.formats)) { const f = style.formats.filter(x => FORMATS[x]); s.formats = f.length ? f : ['9:16']; }
    p.style = s;
    if (p.stages.render.status === 'done' || p.stages.render.status === 'review') { p.stages.render.status = 'idle'; this.log(p, 'render', 'Style changed — render again'); }
    await this.save(p);
    return p;
  }

  /** Topic ideas from the LLM. */
  async ideas({ lang = 'ar', hint = '', count = 10 } = {}) {
    const settings = await this.env.getSettings();
    const logs = [];
    this.checkLlm(settings, m => logs.push(m));
    const avoid = (await this.env.store.list()).map(p => p.topic).filter(Boolean);
    const ctx = { signal: undefined, log: m => logs.push(m), llm: () => {} };
    try {
      const raw = await this.llm(settings, ctx, { messages: ideasMessages({ lang, hint, count, avoid }), temperature: 1 });
      return { ideas: parseIdeas(extractJson(raw)), log: logs };
    } catch (e) { throw friendly(e, this.serviceFor('script', settings, {})); }
  }

  /** Queue many topics: each becomes a project that runs fully automatically, one after another. */
  async batch(topics, opts = {}) {
    const list = topics.map(t => String(t).trim()).filter(Boolean).slice(0, 30);
    if (!list.length) throw Object.assign(new Error('No topics'), { status: 400 });
    const ids = [];
    for (const topic of list) {
      const p = await this.create({ ...opts, topic, approvals: Object.fromEntries(STAGES.map(s => [s, 'auto'])), voiceSource: opts.voiceSource === 'upload' ? 'tts' : opts.voiceSource });
      ids.push(p.id);
    }
    this.queue = (this.queue || []).concat(ids);
    if (!this.queueRunning) this.runQueue();
    return { queued: ids, pending: this.queue.length };
  }
  async runQueue() {
    this.queueRunning = true;
    try {
      while (this.queue?.length) {
        const id = this.queue[0];
        try { await this.runFrom(id, 'script'); } catch {}
        this.queue.shift();
      }
    } finally { this.queueRunning = false; }
  }
  queueState() { return { pending: this.queue || [], running: !!this.queueRunning }; }

  async setApprovals(id, approvals) {
    const p = await this.get(id);
    for (const s of STAGES) if (approvals?.[s] === 'auto' || approvals?.[s] === 'wait') p.approvals[s] = approvals[s];
    await this.save(p);
    return p;
  }

  /** Manual edits to a stage's output. Downstream stages are reset. */
  async edit(id, stage, payload) {
    if (this.isRunning(id)) throw Object.assign(new Error('Pipeline is running — cancel it first'), { status: 409 });
    const p = await this.get(id);
    const settings = await this.env.getSettings();
    if (stage === 'script') {
      const text = String(payload.text ?? p.script?.text ?? '').trim();
      if (!text) throw Object.assign(new Error('Script is empty'), { status: 400 });
      const len = checkLength(text, p.length, p.lang);
      p.script = { ...(p.script || {}), title: String(payload.title ?? p.script?.title ?? ''), text, sources: Array.isArray(payload.sources) ? payload.sources : p.script?.sources || [], words: len.words, target: len.target, edited: true };
      p.title = p.script.title;
    } else if (stage === 'timing') {
      const toks = payload.tokens;
      if (!Array.isArray(toks) || !p.timing) throw Object.assign(new Error('tokens[] required'), { status: 400 });
      p.timing.tokens = p.timing.tokens.map((t, i) => {
        const e = toks[i] || {};
        const start = Number.isFinite(+e.start) ? +e.start : t.start, end = Number.isFinite(+e.end) ? +e.end : t.end;
        return { ...t, text: e.text ? String(e.text) : t.text, start, end: Math.max(end, start + 0.03), weak: e.start != null ? false : t.weak };
      });
      p.timing.edited = true;
    } else if (stage === 'storyboard') {
      if (!p.timing) throw Object.assign(new Error('Timing first'), { status: 409 });
      const { storyboard, fixes } = repairStoryboard(payload.storyboard ?? payload, p.timing.tokens, { title: p.script?.title, lang: p.lang });
      p.storyboard = storyboard;
      p.storyboardFixes = fixes;
      const lib = await this.env.loadIcons();
      const r = resolveStoryboardIcons(lib, storyboard);
      Object.assign(p, { iconMap: r.map, icons: r.icons, iconMisses: r.misses });
    } else throw Object.assign(new Error(`Stage ${stage} cannot be edited`), { status: 400 });
    const keepReview = p.stages[stage].status === 'review';
    const idx = STAGES.indexOf(stage);
    for (const s of STAGES.slice(idx + 1)) p.stages[s] = newStage();
    p.stages[stage].status = keepReview ? 'review' : 'done';
    p.stages[stage].error = null;
    this.log(p, stage, 'Edited manually');
    void settings;
    await this.save(p);
    return p;
  }

  async runFrom(id, stage) {
    if (this.isRunning(id)) throw Object.assign(new Error('Already running'), { status: 409 });
    const ctrl = new AbortController();
    let resolveDone;
    const done = new Promise(r => (resolveDone = r));
    this.runs.set(id, { ctrl, done });
    try {
      for (const name of STAGES.slice(STAGES.indexOf(stage))) {
        const p = await this.get(id);
        const st = p.stages[name];
        if (st.status === 'done') continue;
        if (st.status === 'review') break;
        Object.assign(st, { status: 'running', error: null, errorCode: null, errorLink: null, startedAt: now(), endedAt: null, log: [] });
        await this.save(p);
        const settings = await this.env.getSettings();
        const ctx = {
          signal: ctrl.signal, settings,
          log: m => this.log(p, name, m),
          llm: (delta, full) => this.emit(id, { type: 'llm', stage: name, delta, full }),
          progress: (value, label) => this.emit(id, { type: 'progress', stage: name, value, label }),
          frame: (data, t) => this.emit(id, { type: 'frame', stage: name, data, t }),
        };
        try {
          await this['stage_' + name](p, ctx);
          if (ctrl.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        } catch (e0) {
          const cancelled = ctrl.signal.aborted || e0?.name === 'AbortError';
          const e = cancelled ? e0 : friendly(e0, this.serviceFor(name, settings, p));
          st.status = cancelled ? 'idle' : 'error';
          st.error = cancelled ? null : String(e?.message || e);
          st.errorCode = cancelled ? null : e.code || 'other';
          st.errorLink = cancelled ? null : e.link || '';
          st.endedAt = now();
          if (!cancelled && e.raw && e.raw !== st.error) this.log(p, name, e.raw);
          this.log(p, name, cancelled ? 'Cancelled' : '✗ ' + st.error);
          await this.save(p);
          break;
        }
        st.endedAt = now();
        st.status = p.approvals[name] === 'wait' ? 'review' : 'done';
        this.log(p, name, st.status === 'review' ? 'Waiting for your approval' : 'Done ✓');
        await this.save(p);
        if (st.status === 'review') break;
      }
    } finally {
      this.runs.delete(id);
      resolveDone();
      this.emit(id, { type: 'idle' });
    }
    return this.get(id);
  }

  /** Which service a stage talks to (for error messages). */
  serviceFor(stage, settings, p) {
    if (stage === 'script' || stage === 'storyboard') {
      const pr = providerOf(settings.llm.baseUrl);
      let host = ''; try { host = new URL(settings.llm.baseUrl).host; } catch {}
      return { name: pr.name, link: pr.link, local: isLocalUrl(settings.llm.baseUrl), host };
    }
    if (stage === 'timing' && p.voice?.provider === 'upload' && settings.stt !== 'elevenlabs') return { name: 'Deepgram', link: 'https://console.deepgram.com/' };
    if (stage === 'voice' || stage === 'timing') return { name: 'ElevenLabs', link: 'https://elevenlabs.io/app/developers/' };
    return { name: 'Render' };
  }

  /**
   * One LLM call. If the provider says the model is gone/unknown (e.g. Gemini retired a model),
   * switch to the model it suggests — or the best one from /models — save it, and retry once.
   */
  async llm(settings, ctx, { messages, temperature }) {
    const call = (model = settings.llm.model) => chatStream({ ...settings.llm, model, messages, temperature, signal: ctx.signal, onDelta: ctx.llm, fetchImpl: this.env.fetch, log: ctx.log });
    try { return await call(); } catch (e) {
      if (isBusy(e) && !ctx.signal?.aborted && e.status !== 429) {
        // Overload is per model: try up to two other models for this call only (settings unchanged).
        let ids = [];
        try { ids = await listModels({ ...settings.llm, fetchImpl: this.env.fetch, signal: ctx.signal }); } catch {}
        const family = m => (String(m).match(/gemini|llama|gpt|claude|mistral|qwen|deepseek/i) || [''])[0].toLowerCase();
        const alts = ids.filter(id => id !== settings.llm.model && family(id) === family(settings.llm.model) && !/embed|tts|audio|image|vision|imagen|veo/i.test(id)).slice(0, 2);
        for (const alt of alts) {
          ctx.log(`«${settings.llm.model}» مزحوم — نجرّب «${alt}» المرة دي بس`);
          try { return await call(alt); } catch (e2) { if (!isBusy(e2) || ctx.signal?.aborted) throw e2; }
        }
        throw e;
      }
      const mp = modelProblem(e);
      if (!mp || ctx.signal?.aborted) throw e;
      const old = settings.llm.model;
      let next = mp.suggested;
      let ids = [];
      try { ids = await listModels({ ...settings.llm, fetchImpl: this.env.fetch, signal: ctx.signal }); } catch (le) { ctx.log(`Could not list models: ${le.message}`); }
      if (next && ids.length && !ids.includes(next)) next = null;
      if (!next) next = ids.find(id => id !== old && !/embed|tts|audio|image|vision/i.test(id));
      if (!next || next === old) throw e;
      ctx.log(`الموديل «${old}» مش متاح — بدّلناه لـ «${next}»${this.env.updateSettings ? ' وحفظناه في الإعدادات' : ''}`);
      settings.llm.model = next;
      try { await this.env.updateSettings?.({ llm: { model: next } }); } catch {}
      return await call();
    }
  }

  /** Fail fast (before any call) when an online LLM has no key. */
  checkLlm(settings, log = () => {}) {
    // Repair settings mistakes in place (for this run): website instead of API URL, key pasted in the URL field…
    if (looksLikeKey(settings.llm.baseUrl) && !settings.llm.apiKey) { settings.llm.apiKey = settings.llm.baseUrl.trim(); settings.llm.baseUrl = ''; log('المفتاح كان مكتوب في خانة Base URL — استعملناه كمفتاح'); }
    const byKey = providerFromKey(settings.llm.apiKey);
    if (byKey && (!settings.llm.baseUrl || isLocalUrl(settings.llm.baseUrl) || !/^https?:\/\//.test(settings.llm.baseUrl))) {
      log(`المفتاح ده مفتاح ${byKey.name} — استعملنا ${byKey.baseUrl}`);
      settings.llm.baseUrl = byKey.baseUrl; if (!settings.llm.model || settings.llm.model === 'auto') settings.llm.model = byKey.model;
    }
    const fx = fixBaseUrl(settings.llm.baseUrl);
    if (fx.note) { log(fx.note); settings.llm.baseUrl = fx.url; }
    if (/generativelanguage/.test(settings.llm.baseUrl) && (!settings.llm.model || settings.llm.model === 'auto')) settings.llm.model = 'gemini-flash-latest';
    const { baseUrl, apiKey } = settings.llm;
    if (!String(baseUrl || '').trim()) throw missingKey('LLM (Base URL)', '');
    if (!apiKey && !isLocalUrl(baseUrl)) { const pr = providerOf(baseUrl); throw missingKey(pr.name, pr.link); }
  }

  // ---------------------------------------------------------------- stages
  async stage_script(p, ctx) {
    const { settings } = ctx;
    this.checkLlm(settings, ctx.log);
    const lg = p.lang || 'ar';
    const styleGuide = await this.env.loadStyleGuide(lg);
    ctx.log(`Writing a ${p.length}s ${L(lg).name} script (~${targetWords(p.length, lg)} words) with ${settings.llm.model || 'auto'} @ ${settings.llm.baseUrl}`);
    let messages = scriptMessages({ topic: p.topic, seconds: p.length, styleGuide, notes: p.notes, lang: lg });
    let parsed, len, raw;
    for (let attempt = 0; attempt < 2; attempt++) {
      raw = await this.llm(settings, ctx, { messages, temperature: settings.llm.temperature ?? 0.8 });
      parsed = parseScript(raw);
      if (!parsed.script) throw new Error('The model returned no script');
      len = checkLength(parsed.script, p.length, lg);
      if (len.ok || attempt === 1) break;
      ctx.log(`Length ${len.words} words vs target ${len.target} — asking for a corrected version`);
      messages = [...messages, { role: 'assistant', content: raw }, { role: 'user', content: `The SCRIPT has ${len.words} words but must have about ${len.target}. Rewrite it ${len.ratio > 1 ? 'shorter' : 'longer'} in the same format.` }];
    }
    const q = ensureSeriesQuestion(parsed.script, lg);
    if (q.fixed) ctx.log(`Inserted the series question «${L(lg).question}» after the hook`);
    len = checkLength(q.script, p.length, lg);
    p.script = { title: parsed.title || p.topic, text: q.script, sources: parsed.sources, words: len.words, target: len.target, raw };
    p.title = p.script.title;
    ctx.log(`Title: ${p.script.title} · ${len.words} words (target ${len.target}) · ${parsed.sources.length} sources`);
    if (!len.ok) ctx.log(`⚠ length is off target (${Math.round(len.ratio * 100)}%) — edit the script if needed`);
  }

  async stage_voice(p, ctx) {
    if (!p.script?.text) throw new Error('No script');
    const { settings } = ctx;
    if (p.voiceSource === 'upload') {
      if (!p.upload?.file) throw new Error('Upload a voice-over file first');
      const bytes = await this.env.store.readFile(p.id, p.upload.file);
      const audio = await this.env.decodeAudio(bytes, p.upload.mime);
      p.voice = { file: p.upload.file, mime: p.upload.mime, duration: audio.channels[0].length / audio.sampleRate, provider: 'upload' };
      ctx.log(`Using uploaded voice-over ${p.upload.name || p.upload.file} (${p.voice.duration.toFixed(2)} s)`);
      return;
    }
    if (p.voiceSource === 'gemini') return this.geminiVoice(p, ctx);
    const voiceId = p.voiceId || settings.eleven.voiceId;
    ctx.log(`ElevenLabs TTS · voice ${voiceId || '(none)'} · ${settings.eleven.modelId}`);
    ctx.progress(0.2, 'TTS');
    const text = p.script.text.replace(/\n+/g, '\n');
    const r = await elevenTTS({ ...settings.eleven, voiceId, text, signal: ctx.signal, fetchImpl: this.env.fetch });
    await this.env.store.writeFile(p.id, 'voice.mp3', r.audio);
    const words = alignmentToWords(r.alignment);
    await this.env.store.writeFile(p.id, 'words.json', JSON.stringify({ source: 'elevenlabs', words }));
    const audio = await this.env.decodeAudio(r.audio, 'audio/mpeg');
    p.voice = { file: 'voice.mp3', mime: 'audio/mpeg', duration: audio.channels[0].length / audio.sampleRate, provider: 'elevenlabs', voiceId, words: words.length };
    ctx.progress(1, 'TTS');
    ctx.log(`voice.mp3 ${(r.audio.length / 1024).toFixed(0)} KB · ${p.voice.duration.toFixed(2)} s · ${words.length} timed words`);
  }

  async geminiVoice(p, ctx) {
    const { settings } = ctx;
    const g = { ...settings.gemini, apiKey: geminiKey(settings) };
    const voice = p.voiceId || g.voice || 'Kore';
    const style = p.lang === 'es'
      ? 'Read this aloud like an enthusiastic science creator: warm, clear, natural pace, in Spanish:'
      : 'اقرأ النص ده بصوت عالي زي صانع محتوى علمي مصري: حماس خفيف، واضح، ولهجة مصرية طبيعية:';
    const text = p.script.text.replace(/\n+/g, '\n');
    ctx.log(`Gemini TTS · voice ${voice} · ${g.ttsModel}`);
    ctx.progress(0.2, 'TTS');
    let r;
    for (let attempt = 0; ; attempt++) {
      try { r = await geminiTTS({ ...g, model: g.ttsModel, voice, text, style, signal: ctx.signal, fetchImpl: this.env.fetch }); break; }
      catch (e) {
        if (ctx.signal?.aborted) throw e;
        if (modelProblem(e) && attempt === 0) {
          const models = await geminiTtsModels({ ...g, fetchImpl: this.env.fetch, signal: ctx.signal }).catch(() => []);
          const next = models.find(m => m !== g.ttsModel);
          if (!next) throw e;
          ctx.log(`موديل الصوت «${g.ttsModel}» مش متاح — بدّلناه لـ «${next}»`);
          g.ttsModel = next;
          await this.env.updateSettings?.({ gemini: { ttsModel: next } }).catch(() => {});
          continue;
        }
        if (isBusy(e) && attempt < 3) { const w = 2000 * 2 ** attempt; ctx.log(`Gemini مزحوم — نعاود بعد ${w / 1000} ث`); await new Promise(res => setTimeout(res, w)); continue; }
        throw e;
      }
    }
    const audio = r.pcm || (await this.env.decodeAudio(r.bytes, r.mime));
    const wav = encodeWav(audio);
    await this.env.store.writeFile(p.id, 'voice.wav', wav);
    p.voice = { file: 'voice.wav', mime: 'audio/wav', duration: audio.channels[0].length / audio.sampleRate, provider: 'gemini', voiceId: voice };
    ctx.progress(1, 'TTS');
    ctx.log(`voice.wav ${(wav.length / 1024).toFixed(0)} KB · ${p.voice.duration.toFixed(2)} s`);
  }

  async stage_timing(p, ctx) {
    if (!p.voice) throw new Error('No voice');
    const { settings } = ctx;
    let words, provider;
    if (p.voice.provider === 'gemini' && !settings.eleven.apiKey && !settings.deepgram.apiKey) {
      // No transcription key: estimate timings from the audio itself (our own TTS reads every word in order).
      const audio = await this.env.decodeAudio(await this.env.store.readFile(p.id, p.voice.file), p.voice.mime);
      const r = estimateTimings(tokenize(p.script.text), audio);
      p.timing = { tokens: r.tokens, stats: r.stats, provider: 'estimate' };
      ctx.log(`Estimated timings for ${r.stats.tokens} words from the audio (add an ElevenLabs or Deepgram key for exact timings)`);
      return;
    }
    if (p.voice.provider === 'upload' || p.voice.provider === 'gemini') {
      const bytes = await this.env.store.readFile(p.id, p.voice.file);
      provider = (p.voice.provider === 'gemini' ? (settings.eleven.apiKey ? 'elevenlabs' : 'deepgram') : settings.stt) === 'elevenlabs' ? 'elevenlabs-scribe' : 'deepgram';
      ctx.log(`Transcribing the uploaded audio with ${provider}…`);
      const r = provider === 'deepgram'
        ? await deepgramListen({ ...settings.deepgram, language: L(p.lang).deepgram, audio: bytes, mime: p.voice.mime, signal: ctx.signal, fetchImpl: this.env.fetch })
        : await elevenSTT({ ...settings.eleven, languageCode: L(p.lang).scribe, audio: bytes, mime: p.voice.mime, fileName: p.voice.file, signal: ctx.signal, fetchImpl: this.env.fetch });
      words = r.words;
      await this.env.store.writeFile(p.id, 'words.json', JSON.stringify({ source: provider, transcript: r.transcript, words }));
    } else {
      const j = JSON.parse(new TextDecoder().decode(await this.env.store.readFile(p.id, 'words.json')));
      words = j.words; provider = j.source;
    }
    if (!words?.length) throw new Error('No timed words to align');
    const tokens = tokenize(p.script.text);
    const r = alignTokens(tokens, words, { totalDuration: p.voice.duration });
    p.timing = { tokens: r.tokens, stats: r.stats, provider };
    ctx.log(`Aligned ${r.stats.tokens} script words onto ${r.stats.timedWords} timed words · coverage ${(r.stats.coverage * 100).toFixed(0)}% · ${r.stats.weak} weak`);
    const weak = r.tokens.filter(t => t.weak).slice(0, 12).map(t => `${t.i}:${t.text}`);
    if (weak.length) ctx.log('⚠ weak words: ' + weak.join(' '));
  }

  async stage_storyboard(p, ctx) {
    if (!p.timing) throw new Error('No timing');
    const { settings } = ctx;
    this.checkLlm(settings, ctx.log);
    const tokens = p.timing.tokens;
    const duration = videoDuration(tokens, p.voice?.duration);
    ctx.log(`Storyboarding ${tokens.length} words / ${duration.toFixed(1)} s`);
    const ask = async (messages, label) => {
      const raw = await this.llm(settings, ctx, { messages, temperature: 0.5 });
      try { return extractJson(raw); } catch (e) { ctx.log(`${label}: ${e.message}`); return null; }
    };
    const lg = p.lang || 'ar';
    let json = await ask(storyboardMessages({ title: p.script.title, tokens, duration, lang: lg }), 'storyboard');
    if (!json) { ctx.log('Retrying for valid JSON…'); json = await ask(storyboardMessages({ title: p.script.title, tokens, duration, lang: lg }), 'storyboard'); }
    if (!json) throw new Error('The model did not return a valid storyboard JSON');
    let { storyboard, fixes } = repairStoryboard(json, tokens, { title: p.script.title, lang: lg });
    if (fixes.length) ctx.log(`Repaired: ${fixes.join('; ')}`);
    if (settings.selfReview !== false) {
      const issues = lintStoryboard(storyboard, tokens, duration);
      ctx.log(`Self-review pass (${issues.length} issues)${issues.length ? ': ' + issues.join('; ') : ''}`);
      ctx.llm(null, '');
      const reviewed = await ask(reviewMessages({ storyboard, issues, tokens, duration, lang: lg }), 'review');
      if (reviewed) {
        const r2 = repairStoryboard(reviewed, tokens, { title: p.script.title, lang: lg });
        const before = issues.length, after = lintStoryboard(r2.storyboard, tokens, duration).length;
        if (r2.storyboard.scenes.length >= Math.max(2, Math.floor(storyboard.scenes.length / 2)) && after <= before) {
          ctx.log(`Review accepted (${before} → ${after} issues)${r2.fixes.length ? ' · repaired: ' + r2.fixes.join('; ') : ''}`);
          storyboard = r2.storyboard; fixes = fixes.concat(r2.fixes);
        } else ctx.log(`Review rejected (${before} → ${after} issues) — keeping the first pass`);
      }
    }
    const lib = await this.env.loadIcons();
    const ic = resolveStoryboardIcons(lib, storyboard);
    Object.assign(p, { storyboard, storyboardFixes: fixes, iconMap: ic.map, icons: ic.icons, iconMisses: ic.misses });
    ctx.log(`${storyboard.scenes.length} scenes: ${storyboard.scenes.map(s => `${s.type}/${s.template}@${s.at}`).join(' · ')}`);
    ctx.log(`${Object.keys(ic.icons).length} icons resolved${ic.misses.length ? ' · no match for: ' + ic.misses.join(', ') : ''} · ${storyboard.accents.length} accents`);
  }

  async stage_render(p, ctx) {
    if (!p.storyboard) throw new Error('No storyboard');
    const settings = ctx.settings;
    p.style = { ...DEFAULT_STYLE, ...(p.style || {}) };
    const formats = p.style.formats?.length ? p.style.formats : ['9:16'];
    const data = renderData({ ...p, render: null }, settings, formats[0]);
    const timeline = buildTimeline({ tokens: data.tokens, storyboard: data.storyboard, duration: data.duration, endAt: p.style.endScreen ? data.endAt : null });
    ctx.log(`Mixing voice + ${timeline.sfx.length} SFX${p.style.music !== 'none' ? ` + music (${p.style.music})` : ''} → −14 LUFS`);
    const voiceBytes = await this.env.store.readFile(p.id, p.voice.file);
    const voice = await this.env.decodeAudio(voiceBytes, p.voice.mime);
    const mix = mixAudio(voice, timeline.sfx, data.duration, { targetLufs: -14, sfxLevel: settings.sfxLevel ?? 1, music: p.style.music, musicLevel: p.style.musicLevel ?? 1, seed: (p.id.charCodeAt(0) || 7) });
    ctx.log(`Mix loudness ${mix.lufs.toFixed(1)} LUFS`);
    const wav = encodeWav(mix);
    await this.env.store.writeFile(p.id, 'mix.wav', wav);
    const frames = Math.ceil(data.duration * FPS);
    const t0 = Date.now();
    const files = [];
    let cover = null, renderer = '';
    for (const [n, aspect] of formats.entries()) {
      const d = n === 0 ? data : renderData({ ...p, render: null }, settings, aspect);
      ctx.log(`Rendering ${aspect} · ${frames} frames @ ${FPS} fps…`);
      const prog = (v, label) => ctx.progress((n + v) / formats.length, `${aspect} · ${label}`);
      const out = await this.env.render({ project: p, data: d, file: FORMATS[aspect], cover: n === 0, wav, mix, settings, signal: ctx.signal, onProgress: prog, onFrame: ctx.frame, log: ctx.log, emit: ev => this.emit(p.id, ev) });
      files.push({ aspect, file: out.file || FORMATS[aspect], size: out.size });
      if (out.cover) cover = out.cover;
      renderer = out.renderer;
      ctx.log(`${out.file || FORMATS[aspect]} · ${(out.size / 1e6).toFixed(2)} MB`);
    }
    p.render = { file: files[0].file, files, cover, duration: data.duration, frames, lufs: +mix.lufs.toFixed(2), size: files[0].size, renderer, seconds: +((Date.now() - t0) / 1000).toFixed(1), at: now(), style: { ...p.style } };
    ctx.log(`Done in ${p.render.seconds}s · ${renderer}`);
    // Caption + hashtags for posting (never fails the render).
    try {
      this.checkLlm(settings);
      ctx.llm(null, '');
      const raw = await this.llm(settings, { ...ctx, llm: () => {} }, { messages: publishMessages({ lang: p.lang, title: p.script.title, script: p.script.text, sources: p.script.sources }), temperature: 0.8 });
      const j = extractJson(raw);
      const tags = (Array.isArray(j.hashtags) ? j.hashtags : String(j.hashtags || '').split(/\s+/)).map(h => '#' + String(h).replace(/^#+/, '').replace(/\s+/g, '_')).filter(h => h.length > 1).slice(0, 14);
      p.publish = { caption: String(j.caption || '').trim(), hashtags: tags };
      if (!p.publish.caption) throw new Error('empty caption');
      ctx.log(`Caption + ${tags.length} hashtags ready`);
    } catch (e) {
      p.publish = fallbackPublish({ lang: p.lang, title: p.script.title });
      ctx.log(`Caption: using a template (${String(e.message || e).slice(0, 80)})`);
    }
  }
}
