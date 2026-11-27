// Deterministic timeline: scene times, item times, caption chunks and SFX cues.
// Shared by the renderer (visuals) and the audio mixer (SFX), so both agree to the frame.
import { isBreakPunct, isSentenceEnd, normalize, isLtrWord } from './text.js';

export const SCENE_LEAD = 0.12; // a cut lands slightly before its word
export const TAIL = 0.7; // seconds after the last word
export const END_CARD = 2.6; // follow / comment end screen

export function speechEnd(tokens, audioDuration) {
  const lastEnd = tokens.length ? tokens[tokens.length - 1].end : 0;
  return Math.max(audioDuration || 0, lastEnd);
}
export function videoDuration(tokens, audioDuration, { endScreen = false } = {}) {
  return speechEnd(tokens, audioDuration) + TAIL + (endScreen ? END_CARD : 0);
}

export function buildTimeline({ tokens, storyboard, duration, endAt = null }) {
  const at = i => tokens[Math.max(0, Math.min(tokens.length - 1, i))]?.start ?? 0;
  const tone = new Map((storyboard.accents || []).map(a => [a[0], { tone: a[1], underline: !!a[2] }]));

  const scenes = storyboard.scenes.map((s, k) => {
    const t0 = k === 0 ? 0 : Math.max(0, at(s.at) - SCENE_LEAD);
    return { ...s, k, t0, items: s.items.map((it, j) => ({ ...it, j, t: Math.max(t0 + 0.05, at(it.at)) })) };
  });
  scenes.forEach((s, k) => { s.t1 = k + 1 < scenes.length ? scenes[k + 1].t0 : duration; });
  // scene-level reveal time for single-value templates
  scenes.forEach(s => { s.tv = s.items.length ? s.items[0].t : Math.min(s.t1, s.t0 + 0.4); });

  // Caption chunks: 1–3 words, ≤ ~20 letters, break on punctuation, long pauses, line and scene boundaries.
  const sceneStarts = new Set(storyboard.scenes.map(s => s.at));
  const chunks = [];
  let cur = [];
  const flush = () => { if (cur.length) chunks.push(cur); cur = []; };
  tokens.forEach((t, i) => {
    if (cur.length && sceneStarts.has(i)) flush();
    if (cur.length) {
      const letters = cur.reduce((s, w) => s + normalize(w.text).length, 0) + normalize(t.text).length;
      const gap = t.start - cur[cur.length - 1].end;
      if (cur.length >= 3 || letters > 20 || gap > 0.45) flush();
    }
    cur.push(t);
    if (isBreakPunct(t.text) || t.br) flush();
  });
  flush();

  const captions = chunks.map(ws => ({
    words: ws.map(w => {
      const num = /\d/.test(w.text);
      return { i: w.i, text: w.text, start: w.start, end: w.end, ltr: isLtrWord(w.text), num, ...(num ? { tone: 'accent2' } : {}), ...(tone.get(w.i) || {}) };
    }),
    first: ws[0].start, last: ws[ws.length - 1].end, sentenceEnd: isSentenceEnd(ws[ws.length - 1].text),
  }));
  captions.forEach((c, k) => {
    const next = captions[k + 1];
    c.t0 = Math.max(k ? captions[k - 1].first : 0, c.first - 0.1);
    // hold until the next chunk, unless there is a long silence
    c.t1 = next ? (next.first - c.last > 1.2 ? c.last + 0.7 : next.first - 0.1) : (endAt ?? duration);
    if (c.t1 < c.t0 + 0.2) c.t1 = c.t0 + 0.2;
  });

  // SFX cues: whoosh on scene cuts, soft tick on item reveals (thinned out), pop on the intro icon.
  const sfx = [];
  scenes.forEach((s, k) => {
    if (k > 0) sfx.push({ t: Math.max(0, s.t0 - 0.18), kind: 'whoosh', gain: 0.9 });
    else sfx.push({ t: 0.08, kind: 'pop', gain: 0.6 });
    for (const it of s.items) sfx.push({ t: it.t, kind: 'tick', gain: 0.5 });
  });
  if (endAt != null && endAt < duration) sfx.push({ t: endAt, kind: 'whoosh', gain: 0.8 }, { t: endAt + 0.45, kind: 'pop', gain: 0.7 });
  sfx.sort((a, b) => a.t - b.t);
  const thinned = [];
  for (const e of sfx) {
    const prev = thinned[thinned.length - 1];
    if (prev && e.t - prev.t < 0.22) { if (e.kind === 'whoosh' && prev.kind !== 'whoosh') thinned[thinned.length - 1] = e; continue; }
    thinned.push(e);
  }

  // Hook = words before the series question (or the first sentence), shown as kinetic type on the intro.
  const qScene = scenes.find(s => s.type === 'question');
  let hookEnd = qScene ? qScene.at - 1 : tokens.findIndex(t => isSentenceEnd(t.text));
  if (hookEnd < 0) hookEnd = Math.min(tokens.length - 1, 7);
  const hook = hookEnd >= 1 && hookEnd < 16 ? tokens.slice(0, hookEnd + 1).map(t => ({ i: t.i, text: t.text, start: t.start, end: t.end, ltr: isLtrWord(t.text), num: /\d/.test(t.text), ...(tone.get(t.i) || {}) })) : [];
  return { duration, scenes, captions, sfx: thinned, hook, hookEnd: hook.length ? hook[hook.length - 1].end : 0, endAt };
}

export function sceneAt(timeline, t) {
  const { scenes } = timeline;
  let k = 0;
  while (k + 1 < scenes.length && scenes[k + 1].t0 <= t) k++;
  return k;
}
