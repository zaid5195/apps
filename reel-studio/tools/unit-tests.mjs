// Fast unit tests for the pure modules (no network, no browser). Usage: node tools/unit-tests.mjs
import { stripThink, extractJson } from '../public/core/llm.js';
import { parseScript, ensureSeriesQuestion, checkLength } from '../public/core/script.js';
import { tokenize, normalize } from '../public/core/text.js';
import { alignTokens } from '../public/core/align.js';
import { repairStoryboard } from '../public/core/storyboard.js';
import { integratedLoudness, mixAudio } from '../public/core/audio.js';
import { buildTimeline } from '../public/core/timeline.js';
import { resolveIcon } from '../public/core/icons.js';
import { readFileSync } from 'node:fs';

let n = 0, bad = 0;
const t = (name, cond) => { n++; if (!cond) { bad++; console.log('✗ ' + name); } else console.log('✓ ' + name); };

// LLM helpers
t('stripThink closed', stripThink('<think>x</think>Hello') === 'Hello');
t('stripThink open while streaming', stripThink('<think>partial') === '');
t('stripThink partial tag', stripThink('Hi <thi') === 'Hi ');
t('stripThink orphan close', stripThink('reasoning…</think>Answer') === 'Answer');
t('extractJson fenced + trailing comma', extractJson('ok ```json\n{"a":[1,2,],}\n``` bye').a.length === 2);

// script parsing
const raw = '**TITLE:** ليه بنعطس؟\n**SCRIPT:**\n- العطسة بتطلع بسرعة 160 km في الساعة!\nعارف ليه؟\nالأنف بيطرد أي حاجة غريبة.\n**SOURCES:**\n- NIH';
const ps = parseScript(raw);
t('parseScript title', ps.title === 'ليه بنعطس؟');
t('parseScript strips bullets', ps.script.startsWith('العطسة'));
t('parseScript sources', ps.sources[0] === 'NIH');
t('ensureSeriesQuestion inserts', ensureSeriesQuestion('سطر أول\nسطر تاني').script.split('\n')[1] === 'عارف ليه؟');
t('checkLength', checkLength('a b c d e f g h i j k l m n o p q r s t u v w x y z', 10).ok);

// tokenizer keeps the script's spelling, glues punctuation
const toks = tokenize('القلب بيدق … عارف ليه ؟\nDNA جوه cells');
t('tokenize glue punctuation', toks.map(x => x.text).join('|') === 'القلب|بيدق…|عارف|ليه؟|DNA|جوه|cells');
t('normalize alef/taa', normalize('إزاي الصحّة') === 'ازايالصحه');

// alignment: STT spelling drift, merged words, a missing word
const script = tokenize('أنا رايح المدرسة النهارده عشان الامتحان مهم جداً');
const stt = [
  { text: 'انا', start: 0.1, end: 0.3 }, { text: 'رايحالمدرسه', start: 0.35, end: 1.0 },
  { text: 'النهارده', start: 1.05, end: 1.5 }, { text: 'الامتحان', start: 1.9, end: 2.4 }, { text: 'مهم', start: 2.45, end: 2.7 }, { text: 'جدا', start: 2.75, end: 3.0 },
];
const al = alignTokens(script, stt);
t('align: merged word split by chars', al.tokens[2].start > 0.5 && al.tokens[2].start < 0.8);
t('align: missing word interpolated + weak', al.tokens[4].weak && al.tokens[4].start >= 1.5 && al.tokens[4].start < 1.9);
t('align: onsets monotonic', al.tokens.every((x, i, a) => !i || x.start > a[i - 1].start));
t('align: exact onset kept', al.tokens[5].start === 1.9);

// storyboard repair
const tk = tokenize('القلب بيدق طول الوقت عارف ليه؟ عشان فيه كهربا جواه بتشغله زي ساعة بالظبط يعني القلب ماكينة').map((x, i) => ({ ...x, start: i * 0.4, end: i * 0.4 + 0.35 }));
const { storyboard: sb, fixes } = repairStoryboard({
  scenes: [
    { type: 'concept', at: 9, template: 'flow', items: ['كهربا', 'نبضة'] },
    { type: 'hook', at: 2, template: 'nope' },
    { type: 'concept', at: 12, template: 'flow', items: [{ label: 'a' }, { label: 'b' }] },
    { type: 'concept', at: 15, template: 'flow', items: [{ label: 'a' }, { label: 'b' }] },
    { type: 'stat', at: 99, template: 'meter' },
    { type: 'concept', at: '13', template: 'flow' },
  ],
  accents: [[0, 'underline'], [0, 'accent'], [99, 'accent'], [3, 'pink']],
}, tk);
t('repair: intro at 0 first', sb.scenes[0].type === 'intro' && sb.scenes[0].at === 0);
t('repair: question at «عارف»', sb.scenes.some(s => s.type === 'question' && s.at === 4));
t('repair: sorted & in range', sb.scenes.every((s, i, a) => s.at < tk.length && (!i || s.at > a[i - 1].at)));
t('repair: no template 3× in a row', sb.scenes.every((s, i, a) => i < 2 || !(s.template === a[i - 1].template && s.template === a[i - 2].template)));
t('repair: accents deduped/valid', sb.accents.length === 2 && sb.accents[0][2] === true && sb.accents[1][1] === 'accent');
t('repair: logs fixes', fixes.length > 3);

// timeline + loudness
const tl = buildTimeline({ tokens: tk, storyboard: sb, duration: 8 });
t('timeline: captions cover every word once', tl.captions.flatMap(c => c.words.map(w => w.i)).join() === tk.map(x => x.i).join());
t('timeline: whoosh on cuts', tl.sfx.filter(e => e.kind === 'whoosh').length >= sb.scenes.length - 2);
const sr = 48000, tone = new Float32Array(sr * 5).map((_, i) => 0.1 * Math.sin((2 * Math.PI * 1000 * i) / sr));
const L = integratedLoudness([tone], sr);
t(`LUFS of 1 kHz sine at -20 dBFS ≈ -23 (${L.toFixed(2)})`, Math.abs(L + 23.0) < 0.3);
const mix = mixAudio({ sampleRate: sr, channels: [tone] }, tl.sfx, 6);
t(`mix normalised to -14 LUFS (${mix.lufs.toFixed(2)})`, Math.abs(mix.lufs + 14) < 0.3);
t('mix peak ≤ -1 dBFS', mix.channels[0].reduce((m, v) => Math.max(m, Math.abs(v)), 0) <= 0.9);

// Spanish
const es = tokenize('¿Sabes por qué el corazón late?\n¡Es increíble! ADN y células.');
t('es: opening ¿ ¡ glued to next word', es[0].text === '¿Sabes' && es.find(x => x.text.startsWith('¡')).text === '¡Es');
t('es: accents normalised for matching', normalize('Corazón ÑANDÚ') === 'corazonnandu');
const esAl = alignTokens(tokenize('¿Sabes por qué late el corazón?'), [
  { text: 'sabes', start: 0.2, end: 0.5 }, { text: 'por', start: 0.55, end: 0.7 }, { text: 'que', start: 0.72, end: 0.9 },
  { text: 'late', start: 0.95, end: 1.2 }, { text: 'elcorazon', start: 1.25, end: 1.9 }]);
t('es: alignment through accents/merges (glued word flagged)', esAl.stats.weak === 1 && esAl.tokens[5].estimated && esAl.tokens[0].start === 0.2 && esAl.tokens[5].start > 1.35);
t('es: series question ensured', ensureSeriesQuestion('Hook.\nMás', 'es').script.split('\n')[1] === '¿Sabes por qué?');
const esTok = tokenize('Tu corazón late ¿Sabes por qué? Porque tiene electricidad propia dentro').map((x, i) => ({ ...x, start: i * 0.4, end: i * 0.4 + 0.3 }));
t('es: repair finds the question scene', repairStoryboard({ scenes: [] }, esTok, { lang: 'es' }).storyboard.scenes.some(s => s.type === 'question' && s.at === 3));
t('es: parse Spanish labels', parseScript('TÍTULO: Hola\nGUION:\nLínea uno\nFUENTES:\n- NASA').title === 'Hola');

// friendly errors
import('../public/core/errors.js').then(() => {});
const { friendly, providerOf, isLocalUrl } = await import('../public/core/errors.js');
const fe = friendly(Object.assign(new Error('LLM HTTP 400: [{"error":{"code":400,"message":"Missing or invalid Authorization header."}}]'), { status: 400 }), { name: 'Gemini', link: 'https://aistudio.google.com/apikey' });
t('errors: Gemini 400 auth → key error with link', fe.code === 'key' && fe.link.includes('aistudio') && /مفتاح Gemini/.test(fe.message));
t('errors: 429 → quota', friendly(Object.assign(new Error('x'), { status: 429 }), { name: 'Groq' }).code === 'quota');
t('errors: fetch failed → network', friendly(new TypeError('Failed to fetch'), { name: 'FreeLLMAPI', local: true }).code === 'network');
t('errors: provider detection', providerOf('https://generativelanguage.googleapis.com/v1beta/openai').name === 'Gemini' && isLocalUrl('http://127.0.0.1:31415/v1') && !isLocalUrl('https://api.groq.com'));

// base URL mix-ups (the website/key page instead of the API)
const ef = await import('../public/core/errors.js');
t('fixBaseUrl: aistudio → Gemini API', ef.fixBaseUrl('https://aistudio.google.com/').url === 'https://generativelanguage.googleapis.com/v1beta/openai');
t('fixBaseUrl: groq console / openrouter keys page', ef.fixBaseUrl('https://console.groq.com/keys').url === 'https://api.groq.com/openai/v1' && ef.fixBaseUrl('openrouter.ai/keys').url === 'https://openrouter.ai/api/v1');
t('fixBaseUrl: local FreeLLMAPI untouched', ef.fixBaseUrl('http://127.0.0.1:31415/v1').note === '');
const { Pipeline } = await import('../public/core/pipeline.js');
const pl = new Pipeline({});
const st1 = { llm: { baseUrl: 'https://aistudio.google.com/', apiKey: 'AIzaSyD-abcdefghijklmnopqrstuvwxyz12345', model: 'auto' } };
pl.checkLlm(st1);
t('run-time repair of saved settings (aistudio URL)', st1.llm.baseUrl.includes('generativelanguage') && st1.llm.model === 'gemini-flash-latest');
const st2 = { llm: { baseUrl: 'AIzaSyD-abcdefghijklmnopqrstuvwxyz12345', apiKey: '', model: 'auto' } };
pl.checkLlm(st2);
t('run-time repair: key pasted into Base URL', st2.llm.apiKey.startsWith('AIza') && st2.llm.baseUrl.includes('generativelanguage'));
let threw = null; try { pl.checkLlm({ llm: { baseUrl: 'https://aistudio.google.com/', apiKey: '' } }); } catch (e) { threw = e; }
t('still asks for the key when it is missing', threw?.code === 'key' && /Gemini/.test(threw.message));

// music + estimated timings + hook + end screen
const au = await import('../public/core/audio.js');
for (const mood of ['calm', 'suspense', 'upbeat']) {
  const [mL] = au.synthMusic(mood, 3);
  t(`music ${mood}: audible, no NaN, no clipping`, mL.every(Number.isFinite) && mL.some(v => Math.abs(v) > 0.01) && mL.every(v => Math.abs(v) < 1));
}
const sr2 = 48000, voice2 = new Float32Array(sr2 * 4);
for (let i = 0; i < voice2.length; i++) { const tt = i / sr2; voice2[i] = (tt % 1 < 0.6 ? 0.25 : 0) * Math.sin(2 * Math.PI * 150 * tt); }
const m1 = au.mixAudio({ sampleRate: sr2, channels: [voice2] }, [], 4, { music: 'calm' });
const dk = au.duckCurve(voice2, voice2.length);
t(`music ducks under the voice (gain ${dk[Math.round(1.4 * sr2)].toFixed(2)} speaking vs ${dk[Math.round(1.98 * sr2)].toFixed(2)} after a pause)`, m1.lufs > -14.3 && m1.lufs < -13.7 && dk[Math.round(1.4 * sr2)] < 0.4 && dk[Math.round(1.98 * sr2)] > dk[Math.round(1.4 * sr2)] + 0.15);
const { estimateTimings } = await import('../public/core/align.js');
const tk3 = tokenize('واحد اتنين تلاتة اربعة');
const pcm3 = new Float32Array(sr2 * 3);
[[0.2, 0.6], [0.8, 1.3], [1.5, 2.0], [2.2, 2.7]].forEach(([a, b]) => { for (let i = Math.round(a * sr2); i < Math.round(b * sr2); i++) pcm3[i] = 0.3 * Math.sin(2 * Math.PI * 180 * i / sr2); });
const est = estimateTimings(tk3, { sampleRate: sr2, channels: [pcm3] });
t(`estimated timings follow speech bursts (${est.tokens.map(x => x.start).join(', ')})`, est.tokens.every((x, i) => Math.abs(x.start - [0.2, 0.8, 1.5, 2.2][i]) < 0.12));
const { buildTimeline: bt2 } = await import('../public/core/timeline.js');
const tl2 = bt2({ tokens: tk, storyboard: sb, duration: 10, endAt: 7 });
t('hook = words before «عارف»', tl2.hook.length === 4 && tl2.hook[3].text === 'الوقت');
t('end screen gets whoosh + pop', tl2.sfx.some(e => e.kind === 'pop' && Math.abs(e.t - 7.45) < 0.01));
t('numbers in captions are highlighted', bt2({ tokens: tokenize('فيه 100 خلية').map((x, i) => ({ ...x, start: i * 0.3, end: i * 0.3 + 0.25 })), storyboard: { scenes: [{ type: 'intro', at: 0, template: 'hero', items: [] }], accents: [] }, duration: 4 }).captions[0].words[1].tone === 'accent2');

// icons
const lib = JSON.parse(readFileSync(new URL('../public/assets/icons/icons.json', import.meta.url)));
t('icons: licences included', lib.sets.health.license === 'CC0-1.0' && lib.sets.tabler.license === 'MIT');
t('icons: resolve plural / alias / tag', resolveIcon(lib, 'Neurons') === 'hand:neuron' && resolveIcon(lib, 'oxygen') === 'hand:molecule' && resolveIcon(lib, 'telescope').startsWith('tabler:'));

console.log(`\n${n - bad}/${n} passed`);
process.exit(bad ? 1 : 0);
