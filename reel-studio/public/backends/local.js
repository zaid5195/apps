// Phone mode: the whole studio runs inside the browser. Projects and files live in IndexedDB,
// APIs are called directly from the device, rendering uses WebCodecs.
import { Pipeline, STAGES, renderData } from '../core/pipeline.js';
import { DEFAULT_SETTINGS, SECRET_PATHS, deepMerge, getPath, setPath, mask } from '../core/defaults.js';
import { elevenVoices } from '../core/providers.js';
import { listModels } from '../core/llm.js';
import { decodeWav } from '../core/audio.js';
import { lang } from '../core/lang.js';
import { encodeReel, decodeAudioBrowser } from './encode.js';

const DB = 'reel-studio', VER = 1;
// A phone browser can't reach a FreeLLMAPI on another machine, and Deepgram may refuse browser (CORS) calls:
// default to providers that work straight from the device. Everything stays editable in Settings.
const PHONE_DEFAULTS = { llm: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-flash-latest' }, stt: 'elevenlabs' };
let dbp;
function db() {
  return (dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = () => { const d = r.result; for (const s of ['projects', 'files', 'kv']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req?.result);
    t.onerror = () => rej(t.error);
  });
}
const idb = {
  get: (s, k) => tx(s, 'readonly', st => st.get(k)),
  put: (s, k, v) => tx(s, 'readwrite', st => st.put(v, k)),
  del: (s, k) => tx(s, 'readwrite', st => st.delete(k)),
  all: s => tx(s, 'readonly', st => st.getAll()),
  keys: s => tx(s, 'readonly', st => st.getAllKeys()),
};

const store = {
  save: p => idb.put('projects', p.id, structuredClone(p)),
  load: id => idb.get('projects', id),
  list: async () => (await idb.all('projects')).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
  async remove(id) { await idb.del('projects', id); for (const k of await idb.keys('files')) if (String(k).startsWith(id + '/')) await idb.del('files', k); },
  writeFile: (id, name, data) => idb.put('files', `${id}/${name}`, data instanceof Blob ? data : new Blob([data])),
  async readFile(id, name) { const b = await idb.get('files', `${id}/${name}`); if (!b) throw new Error(`File ${name} missing`); return new Uint8Array(await b.arrayBuffer()); },
  getBlob: (id, name) => idb.get('files', `${id}/${name}`),
};

export class LocalBackend {
  constructor() {
    this.mode = 'local';
    this.subs = new Map();
    this.urls = new Map();
    this.pipeline = new Pipeline({
      store,
      fetch: (...a) => fetch(...a),
      getSettings: () => this._settings(),
      loadStyleGuide: lg => fetch(new URL('../references/' + lang(lg).styleFile, import.meta.url)).then(r => { if (!r.ok) throw new Error('style guide missing'); return r.text(); }),
      loadIcons: () => (this.icons ??= fetch(new URL('../assets/icons/icons.json', import.meta.url)).then(r => r.json())),
      decodeAudio: bytes => decodeAudioBrowser(bytes),
      updateSettings: patch => this.saveSettings(patch),
      emit: (id, ev) => { for (const cb of this.subs.get(id) || []) cb(ev); },
      render: async ({ project, data, wav, signal, onProgress, onFrame, log }) => {
        const mix = decodeWav(wav);
        const font = await this._font();
        const blob = await encodeReel({ data, mix, font, signal, onProgress, onFrame, log });
        await store.writeFile(project.id, 'reel.mp4', blob);
        return { file: 'reel.mp4', size: blob.size, renderer: 'browser(WebCodecs)' };
      },
    });
  }
  async _settings() { return deepMerge(deepMerge(DEFAULT_SETTINGS, PHONE_DEFAULTS), (await idb.get('kv', 'settings')) || {}); }
  async _font() {
    const f = await idb.get('kv', 'font');
    if (!f) return null;
    return { url: URL.createObjectURL(f.blob), name: f.name };
  }
  async health() { return { ok: true, mode: 'local', ffmpeg: false, browser: 'this browser', webcodecs: 'VideoEncoder' in window }; }
  async getSettings() {
    const s = await this._settings();
    const out = structuredClone(s);
    out.has = {};
    for (const p of SECRET_PATHS) { setPath(out, p, mask(getPath(s, p))); out.has[p[0]] = !!getPath(s, p); }
    const f = await idb.get('kv', 'font');
    out.fontFile = f ? f.name : '';
    out.envLocked = [];
    return out;
  }
  async saveSettings(patch) {
    const cur = (await idb.get('kv', 'settings')) || {};
    const next = deepMerge(cur, patch);
    for (const p of SECRET_PATHS) {
      const v = getPath(patch, p);
      if (typeof v === 'string' && v.includes('••••')) setPath(next, p, getPath(cur, p) || '');
      else if (typeof v === 'string') setPath(next, p, v.trim());
    }
    delete next.has; delete next.envLocked; delete next.fontFile;
    await idb.put('kv', 'settings', next);
    return this.getSettings();
  }
  async setFontFile(file) {
    if (!file) await idb.del('kv', 'font'); else await idb.put('kv', 'font', { name: file.name, blob: file });
    return this.getSettings();
  }
  async models() { const s = await this._settings(); return { models: await listModels({ ...s.llm }) }; }
  async voices() { const s = await this._settings(); return { voices: await elevenVoices({ ...s.eleven }) }; }
  async listProjects() {
    return { projects: (await store.list()).map(p => ({ id: p.id, topic: p.topic, lang: p.lang || 'ar', title: p.title, length: p.length, updatedAt: p.updatedAt, stages: Object.fromEntries(STAGES.map(s => [s, p.stages[s].status])), render: p.render, running: this.pipeline.isRunning(p.id) })) };
  }
  async createProject(b) {
    const p = await this.pipeline.create(b);
    if (b.start !== false && p.voiceSource !== 'upload') this.pipeline.start(p.id).catch(() => {});
    return p;
  }
  async getProject(id) { const p = await this.pipeline.get(id); return { ...p, running: this.pipeline.isRunning(id) }; }
  async deleteProject(id) { await this.pipeline.cancel(id).catch(() => {}); await store.remove(id); }
  async start(id) { this.pipeline.start(id).catch(() => {}); return this.getProject(id); }
  cancel(id) { return this.pipeline.cancel(id); }
  approve(id, stage) { return this.pipeline.approve(id, stage); }
  rerun(id, stage) { return this.pipeline.rerun(id, stage); }
  edit(id, stage, payload) { return this.pipeline.edit(id, stage, payload); }
  setApprovals(id, a) { return this.pipeline.setApprovals(id, a); }
  async uploadVoice(id, file) {
    if (this.pipeline.isRunning(id)) throw new Error('Pipeline is running');
    const p = await this.pipeline.get(id);
    const ext = (file.name.match(/\.[a-z0-9]+$/i)?.[0] || '.mp3').toLowerCase();
    const name = 'upload' + ext;
    await store.writeFile(id, name, file);
    p.upload = { file: name, name: file.name, mime: file.type || 'audio/mpeg', size: file.size };
    p.voiceSource = 'upload';
    this.pipeline.resetFrom(p, 'voice');
    await this.pipeline.save(p);
    return p;
  }
  async setVoiceSource(id, { source, voiceId }) {
    const p = await this.pipeline.get(id);
    p.voiceSource = source === 'upload' ? 'upload' : 'tts';
    if (voiceId !== undefined) p.voiceId = voiceId;
    if (p.stages.voice.status !== 'idle') this.pipeline.resetFrom(p, 'voice');
    await this.pipeline.save(p);
    return p;
  }
  async renderData(id) {
    const p = await this.pipeline.get(id);
    return { data: renderData(p, await this._settings()), font: await this._font(), audio: p.voice ? await this.fileUrl(id, p.voice.file) : null };
  }
  async fileUrl(id, name) {
    const b = await store.getBlob(id, name);
    if (!b) return null;
    const key = `${id}/${name}`;
    const old = this.urls.get(key);
    if (old && old.size === b.size && old.ts === b.lastModified) return old.url;
    if (old) URL.revokeObjectURL(old.url);
    const type = name.endsWith('.mp4') ? 'video/mp4' : name.endsWith('.wav') ? 'audio/wav' : b.type || 'audio/mpeg';
    const url = URL.createObjectURL(new Blob([b], { type }));
    this.urls.set(key, { url, size: b.size, ts: b.lastModified });
    return url;
  }
  subscribe(id, cb) {
    if (!this.subs.has(id)) this.subs.set(id, new Set());
    this.subs.get(id).add(cb);
    this.getProject(id).then(p => cb({ type: 'state', project: p })).catch(() => {});
    return () => this.subs.get(id)?.delete(cb);
  }
}
