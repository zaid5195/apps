// Clear, actionable (Arabic) errors for the common API failures.
export const KEY_LINKS = [
  [/generativelanguage\.googleapis\.com/, 'Gemini', 'https://aistudio.google.com/apikey'],
  [/groq\.com/, 'Groq', 'https://console.groq.com/keys'],
  [/openrouter\.ai/, 'OpenRouter', 'https://openrouter.ai/keys'],
  [/openai\.com/, 'OpenAI', 'https://platform.openai.com/api-keys'],
  [/elevenlabs/, 'ElevenLabs', 'https://elevenlabs.io/app/developers/'],
  [/deepgram/, 'Deepgram', 'https://console.deepgram.com/'],
  [/127\.0\.0\.1:31415|localhost:31415/, 'FreeLLMAPI', 'https://github.com/tashfeenahmed/freellmapi'],
];
export const isLocalUrl = u => /^https?:\/\/(127\.\d+\.\d+\.\d+|localhost|\[::1\])(:|\/|$)/i.test(String(u || '').trim());
export function providerOf(baseUrl) {
  const hit = KEY_LINKS.find(([re]) => re.test(String(baseUrl || '')));
  let host = '';
  try { host = new URL(baseUrl).host; } catch {}
  return { name: hit ? hit[1] : host || 'LLM', link: hit ? hit[2] : '' };
}

export class FriendlyError extends Error {
  constructor(message, { code = 'other', link = '', raw = '' } = {}) {
    super(message);
    Object.assign(this, { code, link, raw, friendly: true });
  }
}

/** Translate a provider/network error into a FriendlyError (keeps the raw text for the log). */
export function friendly(e, { name, link = '', local = false, host = '' } = {}) {
  if (e?.friendly || e?.name === 'AbortError') return e;
  const raw = String(e?.message || e);
  const status = e?.status;
  const authish = /auth|api[_ ]?key|credential|unauthori|permission|invalid.*key|key.*invalid|API_KEY/i.test(raw);
  if (status === 401 || status === 403 || (status === 400 && authish)) {
    return new FriendlyError(`مفتاح ${name} ناقص أو غلط. افتح الإعدادات وحط المفتاح الصحيح${link ? ' (تقدر تاخد واحد مجاني من الرابط)' : ''}.`, { code: 'key', link, raw });
  }
  if (status === 429 || /quota|rate.?limit|RESOURCE_EXHAUSTED|too many/i.test(raw)) {
    return new FriendlyError(`وصلت للحد المسموح في ${name} (quota). استنى دقيقة وعاود، أو غيّر الموديل/المزوّد من الإعدادات.`, { code: 'quota', link, raw });
  }
  if (status === 404 || /model.*(not found|does not exist)|not found.*model/i.test(raw)) {
    return new FriendlyError(`${name} ما لقاش الموديل أو الرابط. راجع «Model» و«Base URL» في الإعدادات.`, { code: 'model', link, raw });
  }
  if (e instanceof TypeError || /failed to fetch|fetch failed|networkerror|ECONNREFUSED|ENOTFOUND|load failed/i.test(raw)) {
    return new FriendlyError(local
      ? `ما قدرناش نوصل لـ ${name} على ${host || 'جهازك'}. تأكد إنه شغّال، ولو انت على الهاتف اختار مزوّد أونلاين (Gemini / Groq / OpenRouter) من الإعدادات.`
      : `ما قدرناش نوصل لـ ${name}${host && host !== name ? ` (${host})` : ''}. تأكد من الإنترنت ومن «Base URL» في الإعدادات (مثلاً Gemini: https://generativelanguage.googleapis.com/v1beta/openai).`, { code: 'network', link, raw });
  }
  return new FriendlyError(`${name}: ${raw.slice(0, 300)}`, { code: 'other', link, raw });
}

export function missingKey(name, link) {
  return new FriendlyError(`ما حطّيتش مفتاح ${name}. افتح الإعدادات والصق المفتاح${link ? ' (تقدر تاخد واحد مجاني من الرابط)' : ''}.`, { code: 'key', link });
}

/** Keys have recognisable prefixes: use them to pick the right provider automatically. */
export function providerFromKey(key) {
  const k = String(key || '').trim();
  if (/^AIza[0-9A-Za-z_\-]{20,}$/.test(k)) return { name: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-flash-latest' };
  if (/^gsk_/.test(k)) return { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' };
  if (/^sk-or-/.test(k)) return { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/auto' };
  return null;
}
export const looksLikeKey = v => { const s = String(v || '').trim(); return !!s && !/[:/\s.]/.test(s.slice(0, 12)) && /^[A-Za-z0-9_\-]{20,}$/.test(s); };

/**
 * Repair common Base URL mistakes: the provider's website / key page instead of its API,
 * a full /chat/completions URL, a missing scheme. Returns {url, note}.
 */
export function fixBaseUrl(raw) {
  let u = String(raw || '').trim();
  if (!u) return { url: u, note: '' };
  const before = u;
  if (!/^https?:\/\//i.test(u) && /^[\w.-]+\.[a-z]{2,}|^127\.|^localhost/i.test(u)) u = (/^(127\.|localhost)/i.test(u) ? 'http://' : 'https://') + u;
  u = u.replace(/\/chat\/completions\/?$/i, '').replace(/\/+$/, '');
  let host = '', path = '';
  try { const x = new URL(u); host = x.host.toLowerCase(); path = x.pathname; } catch { return { url: before, note: '' }; }
  const map = [
    [/^(aistudio\.google\.com|ai\.google\.dev|makersuite\.google\.com)$/, 'https://generativelanguage.googleapis.com/v1beta/openai'],
    [/^generativelanguage\.googleapis\.com$/, path.includes('/openai') ? null : 'https://generativelanguage.googleapis.com/v1beta/openai'],
    [/^(console\.groq\.com|groq\.com|www\.groq\.com)$/, 'https://api.groq.com/openai/v1'],
    [/^api\.groq\.com$/, path.startsWith('/openai') ? null : 'https://api.groq.com/openai/v1'],
    [/^(www\.)?openrouter\.ai$/, path.startsWith('/api') ? null : 'https://openrouter.ai/api/v1'],
    [/^(platform\.openai\.com|openai\.com|chatgpt\.com)$/, 'https://api.openai.com/v1'],
  ];
  for (const [re, fixed] of map) if (re.test(host) && fixed) u = fixed;
  return { url: u, note: u !== before ? `Base URL صلّحناه تلقائيًا: ${before} ← ${u}` : '' };
}
