// Default settings shared by the server and the phone (browser-only) mode.
export const DEFAULT_SETTINGS = {
  llm: { baseUrl: 'http://127.0.0.1:31415/v1', apiKey: '', model: 'auto', temperature: 0.8 },
  eleven: { baseUrl: 'https://api.elevenlabs.io', apiKey: '', voiceId: '', modelId: 'eleven_multilingual_v2', languageCode: '' },
  deepgram: { baseUrl: 'https://api.deepgram.com', apiKey: '', model: 'nova-3', language: 'ar' },
  stt: 'deepgram',
  seriesTag: 'عارف ليه؟',
  seriesTagEs: '¿Sabes por qué?',
  fontFolder: '',
  approvals: { script: 'wait', voice: 'auto', timing: 'auto', storyboard: 'auto', render: 'auto' },
  selfReview: true,
  sfxLevel: 1,
  renderer: 'auto',
};
export const SECRET_PATHS = [['llm', 'apiKey'], ['eleven', 'apiKey'], ['deepgram', 'apiKey']];
/** One-tap presets for OpenAI-compatible providers (all work from a phone browser except a local FreeLLMAPI). */
export const LLM_PRESETS = [
  { id: 'freellmapi', name: 'FreeLLMAPI (local)', baseUrl: 'http://127.0.0.1:31415/v1', model: 'auto' },
  { id: 'gemini', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash' },
  { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/auto' },
];
export const deepMerge = (base, over) => {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object') out[k] = deepMerge(out[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
};
export const getPath = (o, path) => path.reduce((a, k) => (a == null ? a : a[k]), o);
export const setPath = (o, path, v) => { let a = o; for (const k of path.slice(0, -1)) a = a[k] ??= {}; a[path[path.length - 1]] = v; };
export const mask = v => (v ? '••••' + String(v).slice(-4) : '');
