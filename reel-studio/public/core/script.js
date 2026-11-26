// Script stage: prompt building + parsing of TITLE / SCRIPT / SOURCES.
import { countWords, normalize } from './text.js';

export const WORDS_PER_SECOND = 2.6;
export const SERIES_QUESTION = 'عارف ليه؟';

export function targetWords(seconds) {
  return Math.round(seconds * WORDS_PER_SECOND);
}

export function scriptMessages({ topic, seconds, styleGuide, notes }) {
  const n = targetWords(seconds);
  const sys = `You are the head writer of a viral faceless science-explainer series in Egyptian Arabic.
Follow this style guide exactly:

${styleGuide}`;
  const user = `Topic: ${topic}
Video length: ${seconds} seconds → write about ${n} spoken words (between ${Math.round(n * 0.88)} and ${Math.round(n * 1.12)}).
${notes ? 'Extra notes from the producer: ' + notes + '\n' : ''}Answer ONLY in the exact output format (TITLE / SCRIPT / SOURCES).`;
  return [{ role: 'system', content: sys }, { role: 'user', content: user }];
}

const cleanLine = l => l
  .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')
  .replace(/\*\*|__|`/g, '')
  .replace(/^\s*#+\s*/, '')
  .replace(/\[[^\]]*\]|\((?:موسيقى|music|pause|وقفة)[^)]*\)/gi, '')
  .trim();

/** Parse the model answer. Tolerates markdown, Arabic labels and missing sections. */
export function parseScript(text) {
  const s = String(text || '').replace(/\r/g, '');
  const label = name => new RegExp(`^\\s*[*#\\s]*(?:${name})\\s*[*]*\\s*[:：]\\s*[*]*`, 'im');
  const T = label('TITLE|العنوان'), S = label('SCRIPT|السكريبت|النص'), R = label('SOURCES|المصادر');
  const find = re => { const m = re.exec(s); return m ? { i: m.index, end: m.index + m[0].length } : null; };
  const t = find(T), sc = find(S), so = find(R);
  const cut = (from, ...tos) => {
    const ends = tos.filter(x => x && x.i > from).map(x => x.i);
    return s.slice(from, ends.length ? Math.min(...ends) : s.length);
  };
  let title = t ? cut(t.end, sc, so).split('\n')[0].trim() : '';
  let body = sc ? cut(sc.end, t, so) : (so ? s.slice(0, so.i) : s);
  if (!sc && t) body = body.replace(/^.*TITLE.*$/im, '');
  const sources = so ? cut(so.end, t, sc).split('\n').map(cleanLine).filter(Boolean) : [];
  const lines = body.split('\n').map(cleanLine).filter(l => l && !/^```/.test(l));
  title = cleanLine(title).replace(/^["«]|["»]$/g, '');
  return { title, script: lines.join('\n'), sources };
}

/** Make sure the series question is present (after the hook). Returns {script, fixed}. */
export function ensureSeriesQuestion(script) {
  if (normalize(script).includes(normalize('عارف ليه'))) return { script, fixed: false };
  const lines = script.split('\n');
  lines.splice(Math.min(1, lines.length), 0, SERIES_QUESTION);
  return { script: lines.join('\n'), fixed: true };
}

export function checkLength(script, seconds) {
  const words = countWords(script);
  const target = targetWords(seconds);
  const ratio = words / Math.max(1, target);
  return { words, target, ratio, ok: ratio >= 0.75 && ratio <= 1.3 };
}
