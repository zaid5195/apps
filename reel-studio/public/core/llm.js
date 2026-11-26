// OpenAI-compatible streaming chat client (FreeLLMAPI, OpenRouter, Groq, Gemini, …).

/** Remove <think>…</think> reasoning blocks (also an unfinished one while streaming). */
export function stripThink(text) {
  let s = String(text || '');
  if (/<\/think>/i.test(s) && !/<think>/i.test(s)) s = s.replace(/^[\s\S]*?<\/think>/i, '');
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '');
  s = s.replace(/<think>[\s\S]*$/i, '');
  s = s.replace(/<t(h(i(nk?)?)?)?$/i, ''); // partial tag at the very end of a stream
  return s.replace(/^\s+/, '');
}

export function chatUrl(baseUrl) {
  const b = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(b)) return b;
  return b + '/chat/completions';
}

/**
 * Stream a chat completion. Calls onDelta(visibleDelta, visibleSoFar) with <think> stripped.
 * Resolves with the final visible text.
 */
export async function chatStream({ baseUrl, apiKey, model, messages, temperature = 0.7, maxTokens, signal, onDelta, fetchImpl = fetch, retries = 2, log = () => {} }) {
  const url = chatUrl(baseUrl);
  const body = { model: model || 'auto', messages, temperature, stream: true };
  if (maxTokens) body.max_tokens = maxTokens;
  const headers = { 'content-type': 'application/json', accept: 'text/event-stream' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  let attempt = 0;
  for (;;) {
    let raw = '', shown = '';
    const emit = () => {
      const vis = stripThink(raw);
      if (vis.length > shown.length && vis.startsWith(shown)) { onDelta?.(vis.slice(shown.length), vis); shown = vis; }
      else if (vis !== shown && vis.length >= shown.length) { onDelta?.(null, vis); shown = vis; }
    };
    try {
      const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        const err = new Error(`LLM HTTP ${res.status}: ${txt.slice(0, 300)}`);
        err.status = res.status;
        throw err;
      }
      const ctype = res.headers.get('content-type') || '';
      if (!ctype.includes('event-stream') || !res.body) {
        // Provider ignored stream:true.
        const j = await res.json();
        raw = j.choices?.[0]?.message?.content ?? '';
        emit();
        return stripThink(raw).trim();
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '', done = false;
      while (!done) {
        const r = await reader.read();
        if (r.done) break;
        buf += dec.decode(r.value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          if (data === '[DONE]') { done = true; break; }
          let j;
          try { j = JSON.parse(data); } catch { continue; }
          if (j.error) throw new Error('LLM error: ' + (j.error.message || JSON.stringify(j.error)));
          const d = j.choices?.[0]?.delta?.content ?? j.choices?.[0]?.message?.content ?? '';
          if (d) { raw += d; emit(); }
        }
      }
      try { reader.cancel(); } catch {}
      const out = stripThink(raw).trim();
      if (!out) throw new Error('LLM returned an empty answer');
      return out;
    } catch (e) {
      if (signal?.aborted) throw e;
      const retryable = !e.status || e.status >= 500 || e.status === 429;
      if (attempt < retries && retryable && !shown) {
        attempt++;
        log(`LLM attempt ${attempt} failed (${e.message}); retrying…`);
        await new Promise(r => setTimeout(r, 800 * attempt));
        continue;
      }
      throw e;
    }
  }
}

/** Pull the first balanced JSON object out of a model answer (handles ```json fences and chatter). */
export function extractJson(text) {
  const s = String(text || '');
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = fence ? [fence[1], s] : [s];
  for (const c of candidates) {
    const start = c.indexOf('{');
    if (start < 0) continue;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < c.length; i++) {
      const ch = c[i];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (!depth) { const chunk = c.slice(start, i + 1); try { return JSON.parse(chunk); } catch { try { return JSON.parse(chunk.replace(/,\s*([}\]])/g, '$1')); } catch { break; } } } }
    }
  }
  throw new Error('No valid JSON object in the model answer');
}

/** GET {base}/models (OpenAI-compatible). Returns model ids, newest-looking first. */
export async function listModels({ baseUrl, apiKey, fetchImpl = fetch, signal }) {
  const b = String(baseUrl || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  const res = await fetchImpl(b + '/models', { headers, signal });
  if (!res.ok) { const e = new Error(`models HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`); e.status = res.status; throw e; }
  const j = await res.json();
  const ids = (j.data || j.models || []).map(m => String(m.id || m.name || '').replace(/^models\//, '')).filter(Boolean);
  return [...new Set(ids)].sort((a, b) => modelScore(b) - modelScore(a) || b.localeCompare(a, 'en', { numeric: true }));
}

/** Rank chat models: fast general text models first; skip embeddings / audio / image / tts / vision-only. */
export function modelScore(id) {
  const s = String(id).toLowerCase();
  if (/embed|tts|audio|image|imagen|veo|vision|whisper|guard|moderation|aqa|learnlm|live|native|computer-use|robotics|search/.test(s)) return -100;
  let v = 0;
  if (/flash/.test(s)) v += 30;
  if (/latest/.test(s)) v += 25;
  if (/lite|8b|nano|mini/.test(s)) v -= 12;
  if (/pro/.test(s)) v += 8;
  if (/exp|preview/.test(s)) v -= 6;
  if (/70b|versatile|auto$/.test(s)) v += 20;
  const ver = s.match(/(\d+(?:\.\d+)?)/);
  if (ver) v += Math.min(10, parseFloat(ver[1]));
  return v;
}

/** Model-gone / model-unknown errors, plus the replacement a provider suggests ("use models/gemini-x-flash"). */
export function modelProblem(err) {
  const m = String(err?.message || err || '');
  const gone = (err?.status === 404 || err?.status === 400) && /model|no longer available|not found|does not exist|not supported|deprecated/i.test(m);
  if (!gone) return null;
  const sug = m.match(/use\s+(?:the\s+)?(?:model\s+)?(?:models\/)?([a-z0-9][\w.\-]*[a-z0-9])/i);
  return { suggested: sug ? sug[1] : null };
}
