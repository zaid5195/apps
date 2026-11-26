// Text helpers shared by the server, the browser backend and the renderer.

const DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g; // harakat + tatweel
const MAP = {
  'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ى': 'ي', 'ة': 'ه', 'ؤ': 'و', 'ئ': 'ي', 'ک': 'ك', 'ی': 'ي', 'گ': 'ك',
};

/** Normalise one character for matching. Returns '' for characters that should be ignored. */
export function normChar(c) {
  if (!c) return '';
  if (DIACRITICS.test(c)) { DIACRITICS.lastIndex = 0; return ''; }
  DIACRITICS.lastIndex = 0;
  const code = c.codePointAt(0);
  if (code >= 0x660 && code <= 0x669) return String(code - 0x660);
  if (code >= 0x6f0 && code <= 0x6f9) return String(code - 0x6f0);
  const m = MAP[c];
  if (m) return m;
  if (code < 0x250 && code > 0x7f) c = c.normalize('NFD').replace(/[\u0300-\u036f]/g, '') || c; // á→a, ñ→n, ü→u
  if (!/[\p{L}\p{N}]/u.test(c)) return '';
  return c.toLowerCase();
}

/** Normalised string used for fuzzy matching (letters + digits only). */
export function normalize(str) {
  let out = '';
  for (const c of String(str || '')) out += normChar(c);
  return out;
}

export const hasArabic = s => /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/.test(s);
export const hasLatin = s => /[A-Za-z]/.test(s);
/** A word that should be laid out left-to-right (English loanword, number, formula). */
export const isLtrWord = s => !hasArabic(s) && /[A-Za-z0-9]/.test(s);

/**
 * Split a script into display tokens. Punctuation-only fragments are glued to the previous token so
 * captions keep the script's own spelling and punctuation. `br` marks a line break after the token.
 */
export function tokenize(script) {
  const tokens = [];
  const lines = String(script || '').replace(/\r/g, '').split('\n');
  for (const line of lines) {
    const parts = line.split(/\s+/).filter(Boolean);
    let added = false;
    let prefix = '';
    for (let p of parts) {
      if (!normalize(p) && /^[¿¡«“"(\[]+$/.test(p)) { prefix += p; continue; } // opening marks belong to the next word
      if (prefix && normalize(p)) { p = prefix + p; prefix = ''; }
      if (!normalize(p)) {
        if (tokens.length && !tokens[tokens.length - 1].br) tokens[tokens.length - 1].text += p;
        else if (tokens.length) tokens[tokens.length - 1].text += p;
        continue;
      }
      tokens.push({ text: p });
      added = true;
    }
    if (added && tokens.length) tokens[tokens.length - 1].br = true;
  }
  return tokens.map((t, i) => ({ i, text: t.text, br: !!t.br }));
}

export const countWords = s => tokenize(s).length;

/** Ends a sentence / clause → good caption break. */
export const isBreakPunct = s => /[.!?؟،,:;…»]$/.test(s);
export const isSentenceEnd = s => /[.!?؟…]$/.test(s);

/** Deterministic PRNG (mulberry32). */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
