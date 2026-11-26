// The 5-stage pipeline (script → voice → timing → storyboard → render).
// Runs unchanged on the Node server and inside the browser (phone mode); `env` supplies I/O.
import { chatStream, extractJson } from './llm.js';
import { scriptMessages, parseScript, ensureSeriesQuestion, checkLength, targetWords } from './script.js';
import { tokenize } from './text.js';
import { alignTokens } from './align.js';
import { elevenTTS, alignmentToWords, deepgramListen, elevenSTT } from './providers.js';
import { storyboardMessages, repairStoryboard, lintStoryboard, reviewMessages } from './storyboard.js';
import { resolveStoryboardIcons } from './icons.js';
import { buildTimeline, videoDuration } from './timeline.js';
import { mixAudio, encodeWav } from './audio.js';

export const STAGES = ['script', 'voice', 'timing', 'storyboard', 'render'];
export const LENGTHS = [10, 20, 30, 45, 60];
export const DEFAULT_APPROVALS = { script: 'wait', voice: 'auto', timing: 'auto', storyboard: 'auto', render: 'auto' };
export const FPS = 30;

const now = () => new Date().toISOString();
const newStage = () => ({ status: 'idle', log: [], error: null, startedAt: null, endedAt: null });
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export function newProject({ topic, length = 30, notes = '', approvals, voiceSource = 'tts', voiceId } = {}) {
  if (!topic || !String(topic).trim()) throw new Error('Topic is required');
  length = LENGTHS.includes(Number(length)) ? Number(length) : 30;
  const stages = {};
  for (const s of STAGES) stages[s] = newStage();
  return {
    id: uid(), topic: String(topic).trim(), length, notes: String(notes || ''), title: '', createdAt: now(), updatedAt: now(),
    voiceSource: voiceSource === 'upload' ? 'upload' : 'tts', voiceId: voiceId || '', approvals: { ...DEFAULT_APPROVALS, ...(approvals || {}) }, stages,
  };
}

/** Render payload for render.html / the browser encoder. Only the icons the project uses are included. */
export function renderData(p, settings = {}) {
  const tokens = (p.timing?.tokens || []).map(t => ({ i: t.i, text: t.text, start: t.start, end: t.end, br: t.br }));
  return {
    v: 1, id: p.id, fps: FPS, w: 720, h: 1280, scale: 1.5,
    duration: p.render?.duration || videoDuration(tokens, p.voice?.duration),
    title: p.script?.title || p.title || p.topic, series: settings.seriesTag || 'عارف ليه؟', tokens,
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
      const len = checkLength(text, p.length);
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
      const { storyboard, fixes } = repairStoryboard(payload.storyboard ?? payload, p.timing.tokens, { title: p.script?.title });
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
        Object.assign(st, { status: 'running', error: null, startedAt: now(), endedAt: null, log: [] });
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
        } catch (e) {
          const cancelled = ctrl.signal.aborted || e?.name === 'AbortError';
          st.status = cancelled ? 'idle' : 'error';
          st.error = cancelled ? null : String(e?.message || e);
          st.endedAt = now();
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

  // ---------------------------------------------------------------- stages
  async stage_script(p, ctx) {
    const { settings } = ctx;
    const styleGuide = await this.env.loadStyleGuide();
    ctx.log(`Writing a ${p.length}s script (~${targetWords(p.length)} words) with ${settings.llm.model || 'auto'} @ ${settings.llm.baseUrl}`);
    let messages = scriptMessages({ topic: p.topic, seconds: p.length, styleGuide, notes: p.notes });
    let parsed, len, raw;
    for (let attempt = 0; attempt < 2; attempt++) {
      raw = await chatStream({ ...settings.llm, messages, temperature: settings.llm.temperature ?? 0.8, signal: ctx.signal, onDelta: ctx.llm, fetchImpl: this.env.fetch, log: ctx.log });
      parsed = parseScript(raw);
      if (!parsed.script) throw new Error('The model returned no script');
      len = checkLength(parsed.script, p.length);
      if (len.ok || attempt === 1) break;
      ctx.log(`Length ${len.words} words vs target ${len.target} — asking for a corrected version`);
      messages = [...messages, { role: 'assistant', content: raw }, { role: 'user', content: `The SCRIPT has ${len.words} words but must have about ${len.target}. Rewrite it ${len.ratio > 1 ? 'shorter' : 'longer'} in the same format.` }];
    }
    const q = ensureSeriesQuestion(parsed.script);
    if (q.fixed) ctx.log('Inserted the series question «عارف ليه؟» after the hook');
    len = checkLength(q.script, p.length);
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

  async stage_timing(p, ctx) {
    if (!p.voice) throw new Error('No voice');
    const { settings } = ctx;
    let words, provider;
    if (p.voice.provider === 'upload') {
      const bytes = await this.env.store.readFile(p.id, p.voice.file);
      provider = settings.stt === 'elevenlabs' ? 'elevenlabs-scribe' : 'deepgram';
      ctx.log(`Transcribing the uploaded audio with ${provider}…`);
      const r = provider === 'deepgram'
        ? await deepgramListen({ ...settings.deepgram, audio: bytes, mime: p.voice.mime, signal: ctx.signal, fetchImpl: this.env.fetch })
        : await elevenSTT({ ...settings.eleven, audio: bytes, mime: p.voice.mime, fileName: p.voice.file, signal: ctx.signal, fetchImpl: this.env.fetch });
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
    const tokens = p.timing.tokens;
    const duration = videoDuration(tokens, p.voice?.duration);
    ctx.log(`Storyboarding ${tokens.length} words / ${duration.toFixed(1)} s`);
    const ask = async (messages, label) => {
      const raw = await chatStream({ ...settings.llm, messages, temperature: 0.5, signal: ctx.signal, onDelta: ctx.llm, fetchImpl: this.env.fetch, log: ctx.log });
      try { return extractJson(raw); } catch (e) { ctx.log(`${label}: ${e.message}`); return null; }
    };
    let json = await ask(storyboardMessages({ title: p.script.title, tokens, duration }), 'storyboard');
    if (!json) { ctx.log('Retrying for valid JSON…'); json = await ask(storyboardMessages({ title: p.script.title, tokens, duration }), 'storyboard'); }
    if (!json) throw new Error('The model did not return a valid storyboard JSON');
    let { storyboard, fixes } = repairStoryboard(json, tokens, { title: p.script.title });
    if (fixes.length) ctx.log(`Repaired: ${fixes.join('; ')}`);
    if (settings.selfReview !== false) {
      const issues = lintStoryboard(storyboard, tokens, duration);
      ctx.log(`Self-review pass (${issues.length} issues)${issues.length ? ': ' + issues.join('; ') : ''}`);
      ctx.llm(null, '');
      const reviewed = await ask(reviewMessages({ storyboard, issues, tokens, duration }), 'review');
      if (reviewed) {
        const r2 = repairStoryboard(reviewed, tokens, { title: p.script.title });
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
    const data = renderData({ ...p, render: null }, settings);
    const timeline = buildTimeline({ tokens: data.tokens, storyboard: data.storyboard, duration: data.duration });
    ctx.log(`Mixing voice + ${timeline.sfx.length} SFX → −14 LUFS`);
    const voiceBytes = await this.env.store.readFile(p.id, p.voice.file);
    const voice = await this.env.decodeAudio(voiceBytes, p.voice.mime);
    const mix = mixAudio(voice, timeline.sfx, data.duration, { targetLufs: -14, sfxLevel: settings.sfxLevel ?? 1 });
    ctx.log(`Mix loudness ${mix.lufs.toFixed(1)} LUFS`);
    const wav = encodeWav(mix);
    await this.env.store.writeFile(p.id, 'mix.wav', wav);
    const frames = Math.ceil(data.duration * FPS);
    ctx.log(`Rendering ${frames} frames @ ${FPS} fps (1080×1920)…`);
    const t0 = Date.now();
    const out = await this.env.render({ project: p, data, wav, mix, settings, signal: ctx.signal, onProgress: ctx.progress, onFrame: ctx.frame, log: ctx.log, emit: ev => this.emit(p.id, ev) });
    p.render = { file: out.file, duration: data.duration, frames, lufs: +mix.lufs.toFixed(2), size: out.size, renderer: out.renderer, seconds: +((Date.now() - t0) / 1000).toFixed(1), at: now() };
    ctx.log(`${out.file} · ${(out.size / 1e6).toFixed(2)} MB · ${p.render.seconds}s · ${out.renderer}`);
  }
}
