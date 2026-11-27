// Default settings shared by the server and the phone (browser-only) mode.
export const DEFAULT_SETTINGS = {
  llm: { baseUrl: 'http://127.0.0.1:31415/v1', apiKey: '', model: 'auto', temperature: 0.8 },
  eleven: { baseUrl: 'https://api.elevenlabs.io', apiKey: '', voiceId: '', modelId: 'eleven_multilingual_v2', languageCode: '' },
  deepgram: { baseUrl: 'https://api.deepgram.com', apiKey: '', model: 'nova-3', language: 'ar' },
  stt: 'deepgram',
  seriesTag: 'عارف ليه؟',
  seriesTagEs: '¿Sabes por qué?',
  handle: '@uryon29',
  endFollow: '',
  endComment: '',
  llmBackups: [],
  gemini: { apiKey: '', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', ttsModel: 'gemini-2.5-flash-preview-tts', voice: 'Kore' },
  style: { music: 'calm', musicLevel: 1, captions: 'classic', endScreen: true, hook: true, formats: ['9:16'] },
  fontFolder: '',
  approvals: { script: 'wait', voice: 'auto', timing: 'auto', storyboard: 'auto', render: 'auto' },
  selfReview: true,
  sfxLevel: 1,
  renderer: 'auto',
};
export const SECRET_PATHS = [['llm', 'apiKey'], ['eleven', 'apiKey'], ['deepgram', 'apiKey'], ['gemini', 'apiKey']];
/** One-tap presets for OpenAI-compatible providers (all work from a phone browser except a local FreeLLMAPI). */
export const LLM_PRESETS = [
  { id: 'freellmapi', name: 'FreeLLMAPI (local)', baseUrl: 'http://127.0.0.1:31415/v1', model: 'auto', keyLink: 'https://github.com/tashfeenahmed/freellmapi', free: true, local: true },
  { id: 'gemini', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-flash-latest', keyLink: 'https://aistudio.google.com/apikey', free: true },
  { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', keyLink: 'https://console.groq.com/keys', free: true },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/auto', keyLink: 'https://openrouter.ai/keys', free: true },
  { id: 'cerebras', name: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1', model: 'llama-3.3-70b', keyLink: 'https://cloud.cerebras.ai', free: true },
  { id: 'mistral', name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-small-latest', keyLink: 'https://console.mistral.ai/api-keys', free: true },
  { id: 'github', name: 'GitHub Models', baseUrl: 'https://models.github.ai/inference', model: 'openai/gpt-4.1-mini', keyLink: 'https://github.com/settings/tokens', free: true },
  { id: 'nvidia', name: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com/v1', model: 'meta/llama-3.3-70b-instruct', keyLink: 'https://build.nvidia.com', free: true },
  { id: 'sambanova', name: 'SambaNova', baseUrl: 'https://api.sambanova.ai/v1', model: 'Meta-Llama-3.3-70B-Instruct', keyLink: 'https://cloud.sambanova.ai/apis', free: true },
  { id: 'together', name: 'Together AI', baseUrl: 'https://api.together.xyz/v1', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free', keyLink: 'https://api.together.ai/settings/api-keys', free: true },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', keyLink: 'https://platform.deepseek.com/api_keys' },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', keyLink: 'https://platform.openai.com/api-keys' },
];
export const presetById = id => LLM_PRESETS.find(p => p.id === id);
/** Mask / unmask the keys of the backup LLM providers (list of {id, apiKey, …}). */
export function maskBackups(list) { return (list || []).map(b => ({ ...b, apiKey: mask(b.apiKey), hasKey: !!b.apiKey })); }
export function mergeBackups(incoming, stored) {
  if (!Array.isArray(incoming)) return stored || [];
  const old = new Map((stored || []).map(b => [b.id, b]));
  return incoming.slice(0, 12).map((b, i) => {
    const id = String(b.id || `b${Date.now().toString(36)}${i}`);
    let apiKey = typeof b.apiKey === 'string' ? b.apiKey.trim() : '';
    if (apiKey.includes('••••')) apiKey = old.get(id)?.apiKey || '';
    return { id, preset: String(b.preset || ''), name: String(b.name || '').slice(0, 40), baseUrl: String(b.baseUrl || '').trim(), model: String(b.model || '').trim(), apiKey, enabled: b.enabled !== false };
  });
}
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
