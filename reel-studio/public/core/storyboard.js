// Storyboard stage: prompt, validation/repair, lint and self-review prompt.
import { normalize, clamp } from './text.js';
import { lang as L } from './lang.js';

export const SCENE_TYPES = ['intro', 'question', 'concept', 'process', 'compare', 'stat', 'recap'];
export const TEMPLATES = ['body', 'zoom', 'flow', 'cycle', 'timeline', 'chart', 'layers', 'cards', 'meter'];
/** Built-in layouts for the fixed beats of the series (not counted as illustration templates). */
export const LAYOUTS = ['hero', 'ask', 'checklist'];
export const ALL_TEMPLATES = [...TEMPLATES, ...LAYOUTS];
export const TONES = ['accent', 'accent2', 'success', 'warning'];
export const ORGANS = ['brain', 'eyes', 'nose', 'mouth', 'throat', 'lungs', 'heart', 'stomach', 'liver', 'kidneys', 'intestines', 'bladder', 'muscles', 'bones', 'skin', 'blood', 'nerves'];

const DEFAULT_TEMPLATE = { intro: 'hero', question: 'ask', concept: 'zoom', process: 'flow', compare: 'cards', stat: 'meter', recap: 'checklist' };
/** Good alternatives per type, in order of preference. */
const FITS = {
  intro: ['hero', 'zoom', 'body', 'cards'],
  question: ['ask'],
  concept: ['zoom', 'body', 'layers', 'cards', 'flow'],
  process: ['flow', 'cycle', 'timeline', 'layers'],
  compare: ['cards', 'chart', 'meter'],
  stat: ['meter', 'chart', 'cards'],
  recap: ['checklist', 'cards', 'flow'],
};
const ITEM_RANGE = { body: [0, 3], zoom: [2, 3], flow: [2, 4], cycle: [3, 5], timeline: [2, 5], chart: [2, 5], layers: [2, 5], cards: [1, 4], meter: [0, 1], hero: [0, 3], ask: [0, 0], checklist: [2, 4] };
const TYPE_SYNONYMS = { hook: 'intro', opening: 'intro', title: 'intro', why: 'question', ask: 'question', explain: 'concept', explanation: 'concept', analogy: 'concept', idea: 'concept', steps: 'process', step: 'process', mechanism: 'process', versus: 'compare', vs: 'compare', comparison: 'compare', number: 'stat', fact: 'stat', statistic: 'stat', summary: 'recap', outro: 'recap', conclusion: 'recap' };
const ORGAN_HINTS = [
  ['brain', /brain|mind|neuron|memory|مخ|دماغ|عقل/], ['eyes', /eye|vision|sight|عين|نظر/], ['nose', /nose|smell|انف|مناخير|شم/],
  ['mouth', /mouth|tongue|taste|tooth|teeth|بق|لسان|سنان/], ['throat', /throat|voice|زور|حنجر/], ['lungs', /lung|breath|oxygen|رئ|رئة|نفس/],
  ['heart', /heart|pulse|قلب/], ['stomach', /stomach|digest|معد|معده/], ['liver', /liver|كبد/], ['kidneys', /kidney|كلي|كلى/],
  ['intestines', /intestin|gut|bowel|مصار|امعا/], ['bladder', /bladder|مثان/], ['muscles', /muscle|عضل/], ['bones', /bone|skeleton|عظم/],
  ['skin', /skin|sweat|جلد|عرق/], ['blood', /blood|vein|artery|دم|شريان/], ['nerves', /nerve|عصب/],
];

export function guessOrgan(...texts) {
  const s = texts.filter(Boolean).join(' ').toLowerCase();
  const n = normalize(s);
  for (const [o, re] of ORGAN_HINTS) if (re.test(s) || re.test(n)) return o;
  return null;
}

export function sceneCountFor(duration) {
  return clamp(Math.round(duration / 3.3), 3, 18);
}

export function storyboardMessages({ title, tokens, duration, lang = 'ar' }) {
  const lg = L(lang);
  const words = tokens.map((t, i) => `${i}:${t.text}@${t.start.toFixed(1)}`).join(' ');
  const n = sceneCountFor(duration);
  const sys = `You are the motion designer of a dark, technical, illustrated science-explainer reel (vertical 9:16).
You turn a timed ${lg.labelLang} script into a storyboard. Reply with ONE JSON object and nothing else.

JSON schema:
{
  "scenes": [
    { "type": "<${SCENE_TYPES.join('|')}>",
      "at": <word index where the scene starts>,
      "template": "<${ALL_TEMPLATES.join('|')}>",
      "title": "<optional short ${lg.labelLang} heading, ≤ 4 words>",
      "icon": "<main icon: ONE simple English noun, e.g. heart, cell, sun, battery>",
      "organ": "<body template only: ${ORGANS.join('|')}>",
      "value": <meter only: number>, "max": <meter only: number>, "unit": "<meter/chart unit, e.g. % or bpm>",
      "items": [ { "label": "<${lg.labelLang}, ≤ 3 words${lg.rtl ? '; English loanwords stay English' : ''}>", "icon": "<English noun>", "value": <number, chart/timeline only>, "at": <word index when it appears> } ]
    }
  ],
  "accents": [ [<word index>, "<${TONES.join('|')}>", <true to underline> ] ]
}

Templates:
- hero: title card with one big icon (use for intro)
- ask: big «${lg.question}» moment (use for the question scene)
- body: one organ glowing inside a human body outline (organ + label)
- zoom: macro → micro, 2–3 levels (e.g. body → cell → DNA)
- flow: A → B → C causal steps (2–4 items)
- cycle: a loop of 3–5 steps
- timeline: dated or ordered events (2–5 items, value = year or time)
- chart: bars that compare numbers (2–5 items with value)
- layers: stacked layers, bottom to top (2–5 items)
- cards: 1–4 cards; 2 cards side by side = comparison
- meter: a gauge showing one number (value / max / unit)
- checklist: recap bullets (2–4 items)

Rules:
- The first scene is type "intro" at 0. Use about ${n} scenes for ${duration.toFixed(1)} s, each lasting 2–5 s.
- Put the "question" scene exactly at the word «${tokens.find(t => normalize(t.text) === normalize(lg.questionKey[0]))?.text || lg.questionKey[0]}».
- "at" values are word indices from the list, strictly increasing. Every item "at" lies inside its scene.
- Pick the template that makes the idea visible. Never use the same template 3 times in a row.
- Icons are simple concrete English nouns (heart, lungs, cell, virus, sun, water, battery, clock, brain, fire).
- Accent the 3–8 key words. Use "warning" only for danger or warnings.`;
  const user = `Title: ${title || ''}
Duration: ${duration.toFixed(2)} s
Words (index:word@seconds):
${words}`;
  return [{ role: 'system', content: sys }, { role: 'user', content: user }];
}

const toInt = v => {
  const n = typeof v === 'string' ? parseInt(v, 10) : Math.round(Number(v));
  return Number.isFinite(n) ? n : null;
};
const shortLabel = (s, max = 24) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > 6 ? cut.slice(0, sp) : cut).trim();
};
const iconNoun = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9 \-]/g, '').trim().split(/\s+/).slice(0, 2).join('-');

/**
 * Validate and repair a storyboard so the renderer can always draw it.
 * @returns {storyboard, fixes:string[]}
 */
export function repairStoryboard(input, tokens, { title, lang = 'ar' } = {}) {
  const [qa, qb] = L(lang).questionKey.map(normalize);
  const fixes = [];
  const n = tokens.length;
  const sb = input && typeof input === 'object' ? input : {};
  let scenes = Array.isArray(sb.scenes) ? sb.scenes.filter(s => s && typeof s === 'object') : [];
  if (!Array.isArray(sb.scenes)) fixes.push('scenes missing → rebuilt');

  scenes = scenes.map((raw, k) => {
    const s = { ...raw };
    let type = String(s.type || '').toLowerCase().trim();
    if (!SCENE_TYPES.includes(type)) {
      const syn = TYPE_SYNONYMS[type];
      fixes.push(`scene ${k}: type "${s.type}" → ${syn || 'concept'}`);
      type = syn || 'concept';
    }
    let at = toInt(s.at);
    if (at == null) { at = Math.round((k * n) / Math.max(1, scenes.length)); fixes.push(`scene ${k}: missing at → ${at}`); }
    if (at < 0 || at > n - 1) { fixes.push(`scene ${k}: at ${at} out of range → dropped`); return null; }
    let template = String(s.template || '').toLowerCase().trim();
    if (!ALL_TEMPLATES.includes(template)) {
      if (s.template) fixes.push(`scene ${k}: unknown template "${s.template}"`);
      template = DEFAULT_TEMPLATE[type];
    }
    if (type === 'question') template = 'ask';
    const items = (Array.isArray(s.items) ? s.items : []).map(it => (typeof it === 'string' ? { label: it } : it || {})).map(it => ({
      label: shortLabel(it.label ?? it.text ?? it.title ?? ''),
      icon: iconNoun(it.icon),
      value: Number.isFinite(Number(it.value)) && it.value !== '' && it.value != null ? Number(it.value) : undefined,
      at: toInt(it.at),
    }));
    return {
      type, at, template,
      title: shortLabel(s.title || '', 30),
      icon: iconNoun(s.icon),
      organ: s.organ ? String(s.organ).toLowerCase() : undefined,
      value: s.value != null && Number.isFinite(Number(s.value)) ? Number(s.value) : undefined,
      max: s.max != null && Number.isFinite(Number(s.max)) ? Number(s.max) : undefined,
      unit: s.unit ? shortLabel(s.unit, 8) : undefined,
      items,
    };
  }).filter(Boolean);

  // Sort, drop duplicates.
  scenes.sort((a, b) => a.at - b.at);
  scenes = scenes.filter((s, k) => {
    if (k > 0 && s.at <= scenes[k - 1].at) { fixes.push(`dropped duplicate scene at ${s.at}`); return false; }
    return true;
  });

  // First scene = intro at 0.
  if (!scenes.length || scenes[0].type !== 'intro') {
    if (scenes.length && scenes[0].at === 0) { fixes.push(`first scene ${scenes[0].type} → intro`); scenes[0].type = 'intro'; if (!FITS.intro.includes(scenes[0].template)) scenes[0].template = 'hero'; }
    else { fixes.push('inserted intro at 0'); scenes.unshift({ type: 'intro', at: 0, template: 'hero', title: shortLabel(title || '', 30), icon: scenes[0]?.icon || '', items: [] }); }
  }
  if (scenes[0].at !== 0) { fixes.push(`intro moved from ${scenes[0].at} to 0`); scenes[0].at = 0; }
  scenes = scenes.filter((s, k) => k === 0 || s.type !== 'intro' || (s.type = 'concept', fixes.push(`extra intro at ${s.at} → concept`), true));

  // The series question gets its own scene at «عارف».
  const qi = tokens.findIndex((t, i) => normalize(t.text) === qa && tokens[i + 1] && normalize(tokens[i + 1].text).startsWith(qb));
  if (qi > 0) {
    const existing = scenes.find(s => s.type === 'question');
    if (existing && Math.abs(existing.at - qi) <= 2) { if (existing.at !== qi) { existing.at = qi; fixes.push('question scene snapped to the series question'); } }
    else if (!existing) {
      if (!scenes.some(s => s.at === qi)) { scenes.push({ type: 'question', at: qi, template: 'ask', title: '', icon: '', items: [] }); fixes.push(`inserted question scene at ${qi}`); }
    }
    scenes.sort((a, b) => a.at - b.at);
  }

  // Minimum scene length: about 1 s (by word timing).
  const t0 = s => tokens[s.at]?.start ?? 0;
  scenes = scenes.filter((s, k) => {
    if (k === 0) return true;
    const prev = scenes[k - 1];
    if (t0(s) - t0(prev) < 0.9 && s.type !== 'question') { fixes.push(`dropped ${s.type} scene at ${s.at} (too short)`); return false; }
    return true;
  });
  // A cut in the last second of speech has no time to read.
  const lastStart = tokens[n - 1]?.start ?? 0;
  scenes = scenes.filter((s, k) => { if (k > 0 && lastStart - t0(s) < 0.8 && s.type !== 'recap') { fixes.push(`dropped ${s.type} scene at ${s.at} (too late)`); return false; } return true; });
  // Re-check after drops: a question scene squeezed against the previous one moves that one earlier if possible.
  for (let k = 1; k < scenes.length; k++) if (t0(scenes[k]) - t0(scenes[k - 1]) < 0.6 && k - 1 > 0) { fixes.push(`merged scene at ${scenes[k - 1].at}`); scenes.splice(k - 1, 1); k--; }

  // Never the same template three times in a row.
  for (let k = 2; k < scenes.length; k++) {
    const s = scenes[k];
    if (s.template === scenes[k - 1].template && s.template === scenes[k - 2].template) {
      const alt = (FITS[s.type] || TEMPLATES).find(t => t !== s.template && t !== 'ask') || TEMPLATES.find(t => t !== s.template);
      fixes.push(`scene ${k}: third "${s.template}" in a row → ${alt}`);
      s.template = alt;
    }
  }

  // Per-template normalisation of items and parameters.
  scenes.forEach((s, k) => {
    const endAt = k + 1 < scenes.length ? scenes[k + 1].at - 1 : n - 1;
    const sceneWords = tokens.slice(s.at, endAt + 1);
    const [lo, hi] = ITEM_RANGE[s.template] || [0, 4];
    let items = s.items.filter(it => it.label || it.icon || it.value != null);
    if (items.length > hi) { fixes.push(`scene ${k}: ${items.length} items → ${hi}`); items = items.slice(0, hi); }
    while (items.length < lo) {
      const w = sceneWords[Math.floor(((items.length + 0.5) * sceneWords.length) / lo)] || sceneWords[0];
      items.push({ label: shortLabel(w ? w.text.replace(/[.,،؟?!:]/g, '') : s.title || '…'), icon: s.icon || '', value: undefined, at: w ? w.i : s.at });
      fixes.push(`scene ${k}: padded ${s.template} items`);
    }
    // Item timing: inside the scene, increasing; missing → spread over the scene.
    const span = Math.max(1, endAt - s.at + 1);
    let last = s.at - 1;
    items.forEach((it, j) => {
      let at = it.at;
      const spread = s.at + Math.floor(((j + (s.template === 'meter' ? 0.3 : 0.15)) * span) / Math.max(1, items.length));
      if (at == null || at < s.at || at > endAt) at = spread;
      if (at <= last) at = Math.min(endAt, last + 1);
      it.at = clamp(at, s.at, endAt);
      last = it.at;
    });
    if (s.template === 'chart') items.forEach((it, j) => { if (!Number.isFinite(it.value)) { it.value = (items.length - j) * 10; fixes.push(`scene ${k}: chart value guessed`); } });
    if (s.template === 'timeline') items.forEach((it, j) => { if (it.value == null) it.value = undefined; });
    if (s.template === 'meter') {
      const v = s.value ?? items[0]?.value;
      s.max = s.max && s.max > 0 ? s.max : (v != null && v > 100 ? Math.pow(10, Math.ceil(Math.log10(v))) : 100);
      s.value = clamp(v != null ? v : s.max * 0.7, 0, s.max);
      if (v == null) fixes.push(`scene ${k}: meter value missing → ${s.value}`);
    }
    if (s.template === 'body') {
      const o = ORGANS.includes(s.organ) ? s.organ : guessOrgan(s.organ, s.icon, s.title, ...items.map(i => i.label + ' ' + i.icon), ...sceneWords.map(w => w.text));
      if (o !== s.organ) fixes.push(`scene ${k}: organ "${s.organ || ''}" → ${o || 'heart'}`);
      s.organ = o || 'heart';
    } else delete s.organ;
    if (s.template !== 'meter') { delete s.value; delete s.max; }
    if (!['meter', 'chart'].includes(s.template)) delete s.unit;
    s.items = items;
    if (!s.icon) s.icon = items.find(i => i.icon)?.icon || '';
  });

  // Accents.
  const seen = new Set();
  const accents = [];
  for (const a of Array.isArray(sb.accents) ? sb.accents : []) {
    let idx, tone = 'accent', underline = false;
    if (Array.isArray(a)) { idx = toInt(a[0]); tone = a[1]; underline = !!a[2]; }
    else if (a && typeof a === 'object') { idx = toInt(a.at ?? a.index ?? a.word); tone = a.tone; underline = !!a.underline; }
    else continue;
    if (idx == null || idx < 0 || idx >= n || seen.has(idx)) continue;
    tone = String(tone || 'accent').toLowerCase();
    if (tone === 'underline') { tone = 'accent'; underline = true; }
    if (!TONES.includes(tone)) tone = 'accent';
    seen.add(idx);
    accents.push([idx, tone, underline]);
  }
  accents.sort((a, b) => a[0] - b[0]);
  const maxAcc = Math.max(2, Math.ceil(n / 4));
  if (accents.length > maxAcc) { fixes.push(`accents ${accents.length} → ${maxAcc}`); accents.length = maxAcc; }

  return { storyboard: { scenes, accents }, fixes };
}

/** Weak spots for the self-review pass. */
export function lintStoryboard(sb, tokens, duration) {
  const issues = [];
  const t = i => tokens[i]?.start ?? 0;
  sb.scenes.forEach((s, k) => {
    const end = k + 1 < sb.scenes.length ? t(sb.scenes[k + 1].at) : duration;
    const len = end - t(s.at);
    if (len > 6.5) issues.push(`scene ${k} (${s.template}) lasts ${len.toFixed(1)} s — split it or add items`);
    if (s.type === 'compare' && !['cards', 'chart', 'meter'].includes(s.template)) issues.push(`scene ${k}: a comparison works better as cards or chart`);
    if (s.type === 'process' && s.items.length < 3 && ['flow', 'cycle'].includes(s.template)) issues.push(`scene ${k}: process with fewer than 3 steps`);
    if (s.type === 'stat' && !['meter', 'chart'].includes(s.template)) issues.push(`scene ${k}: a stat should show its number (meter/chart)`);
    if (!s.icon && !s.items.some(i => i.icon) && !['ask', 'meter', 'chart', 'timeline'].includes(s.template)) issues.push(`scene ${k}: no icon`);
    if (k > 0 && s.template === sb.scenes[k - 1].template) issues.push(`scenes ${k - 1}–${k} repeat template ${s.template}`);
  });
  const used = new Set(sb.scenes.map(s => s.template));
  if (sb.scenes.length >= 5 && used.size < 4) issues.push('low visual variety — use more templates');
  if (!sb.accents.length) issues.push('no accent words');
  return issues;
}

export function reviewMessages({ storyboard, issues, tokens, duration, lang = 'ar' }) {
  const words = tokens.map((t, i) => `${i}:${t.text}@${t.start.toFixed(1)}`).join(' ');
  return [
    { role: 'system', content: `You are a senior motion-design reviewer for a science-explainer reel. Improve weak scene choices in a storyboard JSON.
Keep the same JSON schema and the word indices. Labels and titles stay in ${L(lang).labelLang}. Keep what already works. Only improve:
- templates that don't make the idea visible (e.g. a number shown as cards instead of meter/chart, steps not shown as flow/cycle),
- scenes that are too long (split them at a natural word),
- missing or vague icons (use concrete English nouns),
- weak or missing accents on key words.
Templates: ${ALL_TEMPLATES.join(', ')}. Scene types: ${SCENE_TYPES.join(', ')}.
Reply with ONE JSON object only.` },
    { role: 'user', content: `Duration: ${duration.toFixed(1)} s
Words: ${words}
Detected issues:
${issues.length ? issues.map(i => '- ' + i).join('\n') : '- none detected, polish only'}

Storyboard:
${JSON.stringify(storyboard)}` },
  ];
}
