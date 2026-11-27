// Settings: data/settings.json + .env. Keys never leave the server unmasked.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_SETTINGS as DEFAULTS, deepMerge, getPath as get, setPath as set, mask } from '../public/core/defaults.js';
export { DEFAULTS };
const SECRET = [['llm', 'apiKey'], ['eleven', 'apiKey'], ['deepgram', 'apiKey'], ['gemini', 'apiKey']];
// Environment variables. Base URLs from the environment win (handy for tests / mocks); keys are fallbacks.
const ENV_URLS = { LLM_BASE_URL: ['llm', 'baseUrl'], ELEVENLABS_BASE_URL: ['eleven', 'baseUrl'], DEEPGRAM_BASE_URL: ['deepgram', 'baseUrl'], GEMINI_BASE_URL: ['gemini', 'baseUrl'] };
const ENV_FALLBACK = { LLM_API_KEY: ['llm', 'apiKey'], LLM_MODEL: ['llm', 'model'], ELEVENLABS_API_KEY: ['eleven', 'apiKey'], ELEVENLABS_VOICE_ID: ['eleven', 'voiceId'], ELEVENLABS_MODEL_ID: ['eleven', 'modelId'], DEEPGRAM_API_KEY: ['deepgram', 'apiKey'], GEMINI_API_KEY: ['gemini', 'apiKey'], FONT_FOLDER: ['fontFolder'] };

export function loadDotEnv(root) {
  const f = join(root, '.env');
  if (!existsSync(f)) return;
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

export class Settings {
  constructor(dataDir) {
    this.file = join(dataDir, 'settings.json');
    mkdirSync(dataDir, { recursive: true });
  }
  stored() {
    try { return JSON.parse(readFileSync(this.file, 'utf8')); } catch { return {}; }
  }
  /** Effective settings with secrets (server side only). */
  get() {
    const s = deepMerge(DEFAULTS, this.stored());
    for (const [env, path] of Object.entries(ENV_FALLBACK)) if (process.env[env] && !get(s, path)) set(s, path, process.env[env]);
    for (const [env, path] of Object.entries(ENV_URLS)) if (process.env[env]) set(s, path, process.env[env]);
    return s;
  }
  /** What the browser sees: keys masked to the last 4 characters. */
  public() {
    const s = this.get();
    const out = structuredClone(s);
    out.has = {};
    for (const path of SECRET) { set(out, path, mask(get(s, path))); out.has[path[0]] = !!get(s, path); }
    out.envLocked = Object.entries(ENV_URLS).filter(([e]) => process.env[e]).map(([, p]) => p.join('.'));
    return out;
  }
  update(patch) {
    const cur = this.stored();
    const next = deepMerge(cur, patch || {});
    // A masked value coming back from the browser means "unchanged".
    for (const path of SECRET) {
      const v = get(patch || {}, path);
      if (typeof v === 'string' && v.includes('••••')) set(next, path, get(cur, path) || '');
      else if (typeof v === 'string') set(next, path, v.trim());
    }
    delete next.has; delete next.envLocked;
    writeFileSync(this.file, JSON.stringify(next, null, 2));
    return this.public();
  }
}
