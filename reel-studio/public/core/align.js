// Character-level LCS alignment of timed words (TTS / STT) onto the script's own tokens.
import { normChar, normalize } from './text.js';

/**
 * Turn timed words into a flat list of normalised characters with times.
 * A word may carry per-character timings (`chars: [{c,start,end}]`, e.g. ElevenLabs);
 * otherwise the word's duration is spread evenly over its characters (e.g. Deepgram).
 */
export function timedChars(words) {
  const out = [];
  words.forEach((w, wi) => {
    if (Array.isArray(w.chars) && w.chars.length) {
      for (const ch of w.chars) {
        const n = normChar(ch.c);
        for (const c of n) out.push({ c, start: ch.start, end: ch.end, w: wi });
      }
      return;
    }
    const n = normalize(w.text);
    const len = Math.max(1, n.length);
    const dur = Math.max(0.01, (w.end ?? w.start) - w.start);
    [...n].forEach((c, k) => out.push({ c, start: w.start + (dur * k) / len, end: w.start + (dur * (k + 1)) / len, w: wi }));
  });
  return out;
}

/** Longest common subsequence over two code arrays. Returns matched index pairs. */
export function lcsPairs(a, b) {
  const n = a.length, m = b.length;
  if (!n || !m) return [];
  if ((n + 1) * (m + 1) > 40e6) {
    // Very long input: align in halves to bound memory.
    const ha = n >> 1, hb = Math.round((m * ha) / n);
    const left = lcsPairs(a.slice(0, ha), b.slice(0, hb));
    const right = lcsPairs(a.slice(ha), b.slice(hb)).map(([i, j]) => [i + ha, j + hb]);
    return left.concat(right);
  }
  const W = m + 1;
  const dp = new Uint16Array((n + 1) * W);
  for (let i = 1; i <= n; i++) {
    const ai = a[i - 1];
    const row = i * W, prev = (i - 1) * W;
    for (let j = 1; j <= m; j++) {
      dp[row + j] = ai === b[j - 1] ? dp[prev + j - 1] + 1 : (dp[prev + j] >= dp[row + j - 1] ? dp[prev + j] : dp[row + j - 1]);
    }
  }
  const pairs = [];
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1] && dp[i * W + j] === dp[(i - 1) * W + j - 1] + 1) { pairs.push([i - 1, j - 1]); i--; j--; }
    else if (dp[(i - 1) * W + j] >= dp[i * W + j - 1]) i--;
    else j--;
  }
  return pairs.reverse();
}

/**
 * Align timed words onto script tokens.
 * @param tokens  [{text}]  script tokens (display spelling)
 * @param words   [{text,start,end,chars?}] timed words from TTS/STT
 * @returns {tokens:[{text,start,end,weak,coverage}], stats}
 */
export function alignTokens(tokens, words, { totalDuration } = {}) {
  const A = []; // script chars
  const tokLen = tokens.map(() => 0);
  tokens.forEach((t, ti) => { for (const c of normalize(t.text)) { A.push({ c, t: ti }); tokLen[ti]++; } });
  const B = timedChars(words);
  const pairs = lcsPairs(A.map(x => x.c), B.map(x => x.c));

  const first = tokens.map(() => -1), last = tokens.map(() => -1), hits = tokens.map(() => 0);
  for (const [i, j] of pairs) {
    const ti = A[i].t;
    if (first[ti] < 0) first[ti] = j;
    last[ti] = j;
    hits[ti]++;
  }

  const out = tokens.map((t, ti) => {
    const coverage = tokLen[ti] ? hits[ti] / tokLen[ti] : 0;
    const base = { ...t, coverage: +coverage.toFixed(2) };
    // A token with only a stray 1-char match (of ≥4 chars) is not trustworthy.
    if (first[ti] < 0 || (hits[ti] === 1 && tokLen[ti] >= 4)) return { ...base, start: null, end: null, weak: true };
    let start = B[first[ti]].start;
    // If the first matched char is the first char of its timed word, snap to the word onset.
    const wi = B[first[ti]].w;
    if (first[ti] === 0 || B[first[ti] - 1].w !== wi) start = words[wi].start;
    const end = Math.max(B[last[ti]].end, start + 0.05);
    return { ...base, start, end, weak: coverage < 0.6 };
  });

  // Interpolate unmatched tokens between anchors, proportional to their length.
  const total = totalDuration ?? (words.length ? words[words.length - 1].end : out.length * 0.4);
  let k = 0;
  while (k < out.length) {
    if (out[k].start != null) { k++; continue; }
    let e = k;
    while (e < out.length && out[e].start == null) e++;
    const prevEnd = k > 0 ? out[k - 1].end : 0;
    const len = out.slice(k, e).reduce((s, t) => s + Math.max(1, normalize(t.text).length), 0);
    let nextStart = e < out.length ? out[e].start : Math.min(total, prevEnd + len * 0.075 + 0.1);
    if (nextStart <= prevEnd) nextStart = prevEnd + 0.08 * (e - k);
    let acc = prevEnd;
    for (let q = k; q < e; q++) {
      const share = ((nextStart - prevEnd) * Math.max(1, normalize(out[q].text).length)) / len;
      out[q].start = acc; out[q].end = acc + share * 0.92; acc += share;
    }
    k = e;
  }

  // Monotonic clean-up.
  for (let q = 0; q < out.length; q++) {
    if (q > 0 && out[q].start < out[q - 1].start + 0.02) out[q].start = out[q - 1].start + 0.02;
    if (out[q].end < out[q].start + 0.05) out[q].end = out[q].start + 0.05;
    if (q > 0 && out[q - 1].end > out[q].start) out[q - 1].end = out[q].start;
    out[q].start = +out[q].start.toFixed(3);
    out[q].end = +out[q].end.toFixed(3);
  }

  const weak = out.filter(t => t.weak).length;
  const cov = out.length ? out.reduce((s, t) => s + t.coverage, 0) / out.length : 0;
  return { tokens: out, stats: { tokens: out.length, timedWords: words.length, weak, coverage: +cov.toFixed(3), matchedChars: pairs.length, scriptChars: A.length } };
}
