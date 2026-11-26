// Offline mocks for FreeLLMAPI (OpenAI-compatible), ElevenLabs and Deepgram on :4399.
// Run: node tools/mock-apis.mjs   then start the server with
//   LLM_BASE_URL=http://127.0.0.1:4399/v1 ELEVENLABS_BASE_URL=http://127.0.0.1:4399 DEEPGRAM_BASE_URL=http://127.0.0.1:4399
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.MOCK_PORT || 4399);
const ffmpeg = (() => { if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH; try { return createRequire(import.meta.url)('ffmpeg-static') || 'ffmpeg'; } catch { return 'ffmpeg'; } })();
const tts = new Map(); // sha1(audio) → words
export const stats = { chat: 0, tts: 0, listen: 0, scribe: 0, voices: 0 };

// ---------------------------------------------------------------- LLM
const POOL = [
  'الجسم فيه مليارات من cells شغالة طول الوقت.',
  'كل خلية بتاخد oxygen وتطلع طاقة.',
  'والطاقة دي بتتنقل في الدم بسرعة رهيبة.',
  'المخ بيبعت إشارات كهربا للعضلات في أجزاء من الثانية.',
  'ولو حاجة وقفت، الجسم بيعوضها بسرعة.',
  'العلما قاسوا ده بأجهزة دقيقة جدا.',
  'والنتيجة إن العملية دي بتتكرر آلاف المرات.',
  'وده بيحصل من غير ما تحس بأي حاجة.',
];
function mockScript(topic, words) {
  const hook = `${topic}… بيحصل جواك كل يوم من غير ما تاخد بالك.`;
  const analogy = 'تخيلها زي محطة مترو زحمة الصبح، كل واحد عارف طريقه.';
  const recap = 'يعني الموضوع كله فريق شغال في صمت.';
  const lines = [hook, 'عارف ليه؟', 'السر في cells صغيرة شغالة زي فريق.'];
  const count = () => [...lines, analogy, recap].join(' ').split(/\s+/).length;
  let k = 0;
  while (count() < words - 4 && k < POOL.length * 3) lines.push(POOL[k++ % POOL.length]);
  if (words <= 30) { lines.length = 2; lines.push('السر في cells شغالة زي فريق.'); return { lines: [...lines, 'زي مترو الصبح.', 'يعني شغل جماعي.'] }; }
  return { lines: [...lines, analogy, recap] };
}
function scriptAnswer(user) {
  const topic = (user.match(/Topic:\s*(.+)/) || [, 'الموضوع'])[1].trim();
  const words = +(user.match(/about (\d+) spoken words/) || [, 26])[1];
  const { lines } = mockScript(topic, words);
  return `<think>The user wants an Egyptian script about ${topic}. Let me plan the hook…</think>
**TITLE:** ليه ${topic}؟
**SCRIPT:**
${lines.join('\n')}
**SOURCES:**
- OpenStax Biology 2e — https://openstax.org/details/books/biology-2e
- NIH MedlinePlus — https://medlineplus.gov`;
}
function parseWords(user) {
  return [...user.matchAll(/(\d+):(\S+?)@([\d.]+)/g)].map(m => ({ i: +m[1], text: m[2], t: +m[3] }));
}
const TEMPLATE_CYCLE = [
  { type: 'concept', template: 'zoom', items: [['الجسم', 'person'], ['الخلية', 'cell'], ['DNA', 'dna']] },
  { type: 'process', template: 'flow', items: [['oxygen', 'oxygen'], ['الدم', 'blood'], ['طاقة', 'battery']] },
  { type: 'stat', template: 'meter', value: 72, max: 100, unit: '%', items: [['كفاءة', 'heart']] },
  { type: 'concept', template: 'body', organ: 'heart', items: [['القلب', 'heart']] },
  { type: 'compare', template: 'cards', items: [['قبل', 'clock'], ['بعد', 'bolt']] },
  { type: 'process', template: 'cycle', items: [['شهيق', 'lungs'], ['دم', 'blood'], ['خلايا', 'cell'], ['زفير', 'wind']] },
  { type: 'stat', template: 'chart', unit: 'مرة', items: [['دقيقة', 'clock', 70], ['ساعة', 'clock', 4200], ['يوم', 'sun', 100000]] },
  { type: 'concept', template: 'layers', items: [['جلد', 'skin'], ['عضلات', 'muscle'], ['عظم', 'bone']] },
  { type: 'process', template: 'timeline', items: [['اكتشاف', 'microscope', 1665], ['تجارب', 'flask', 1850], ['اليوم', 'chip', 2024]] },
];
function storyboardAnswer(user) {
  const w = parseWords(user);
  const n = w.length;
  const dur = +(user.match(/Duration:\s*([\d.]+)/) || [, w[n - 1]?.t || 10])[1];
  const qi = w.findIndex(x => x.text.startsWith('عارف'));
  const scenes = [{ type: 'intro', at: 0, template: 'hero', title: 'ليه بيحصل كده؟', icon: 'heart' }];
  if (qi > 0) scenes.push({ type: 'question', at: qi, template: 'ask' });
  const startAt = qi > 0 ? qi + 2 : 2;
  const rest = Math.max(1, Math.round((dur - (w[startAt]?.t || 0)) / 3.2));
  for (let k = 0; k < rest; k++) {
    const at = Math.min(n - 1, startAt + Math.floor((k * (n - startAt)) / rest));
    const tpl = TEMPLATE_CYCLE[k % TEMPLATE_CYCLE.length];
    const span = Math.max(1, Math.floor((n - startAt) / rest));
    scenes.push({ ...tpl, at, items: tpl.items.map(([label, icon, value], j) => ({ label, icon, value, at: at + Math.floor((j * span) / tpl.items.length) })) });
  }
  scenes[scenes.length - 1] = { type: 'recap', at: scenes[scenes.length - 1].at, template: 'checklist', items: [{ label: 'فريق شغال', icon: 'people' }, { label: 'طاقة مستمرة', icon: 'bolt' }] };
  scenes.push({ type: 'concept', at: n + 40, template: 'zoom' }); // deliberately invalid → repair drops/clamps it
  const accents = [[0, 'accent', true], [qi > 0 ? qi : 1, 'accent2'], [Math.min(n - 1, startAt + 1), 'success'], [Math.floor(n / 2), 'accent']];
  return '```json\n' + JSON.stringify({ scenes, accents }) + '\n```';
}
function reviewAnswer(user) {
  const m = user.match(/Storyboard:\n([\s\S]+)$/);
  const sb = JSON.parse(m[1]);
  sb.scenes.forEach(s => { if (!s.icon && s.items?.[0]?.icon) s.icon = s.items[0].icon; });
  return JSON.stringify(sb);
}
function chat(req, res, body) {
  stats.chat++;
  const sys = body.messages.find(m => m.role === 'system')?.content || '';
  const user = [...body.messages].reverse().find(m => m.role === 'user')?.content || '';
  let answer;
  if (/head writer/.test(sys)) answer = /must have about/.test(user) ? scriptAnswer(body.messages.find(m => m.role === 'user').content) : scriptAnswer(user);
  else if (/reviewer/.test(sys)) answer = reviewAnswer(user);
  else if (/motion designer/.test(sys)) answer = storyboardAnswer(user);
  else answer = 'OK';
  if (!body.stream) return json(res, 200, { id: 'mock', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }] });
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const chunks = answer.match(/[\s\S]{1,12}/g) || [];
  let i = 0;
  const tick = () => {
    if (i < chunks.length) {
      res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: chunks[i++] } }] })}\n\n`);
      setTimeout(tick, 2);
    } else { res.write('data: [DONE]\n\n'); res.end(); }
  };
  tick();
}

// ---------------------------------------------------------------- TTS
const SR = 44100;
function synthSpeech(text) {
  // One "syllable babble" burst per word; timings per character.
  const chars = [...text];
  const starts = [], ends = [];
  const segs = [];
  let t = 0.15;
  let i = 0;
  while (i < chars.length) {
    if (/\s/.test(chars[i])) { starts.push(t); ends.push(t + 0.04); t += 0.04; i++; continue; }
    let j = i;
    while (j < chars.length && !/\s/.test(chars[j])) j++;
    const word = chars.slice(i, j);
    const letters = word.filter(c => /[\p{L}\p{N}]/u.test(c)).length || 1;
    const dur = 0.09 + letters * 0.055;
    segs.push([t, t + dur]);
    word.forEach((c, k) => { starts.push(t + (dur * k) / word.length); ends.push(t + (dur * (k + 1)) / word.length); });
    t += dur;
    if (/[.!?؟،,…]$/.test(word.join(''))) t += 0.22;
    i = j;
  }
  t += 0.2;
  const n = Math.ceil(t * SR);
  const pcm = new Float32Array(n);
  for (const [a, b] of segs) {
    const s0 = Math.floor(a * SR), s1 = Math.floor(b * SR);
    for (let s = s0; s < s1; s++) {
      const x = (s - s0) / (s1 - s0), tt = s / SR;
      const env = Math.min(1, x / 0.08) * Math.min(1, (1 - x) / 0.15);
      const f0 = 140 + 25 * Math.sin(2 * Math.PI * 3 * tt);
      let v = 0;
      for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f0 * h * tt) / h * (1 + Math.sin(2 * Math.PI * 4.5 * tt + h));
      pcm[s] = v * 0.12 * env;
    }
  }
  return { pcm, alignment: { characters: chars, character_start_times_seconds: starts.map(v => +v.toFixed(3)), character_end_times_seconds: ends.map(v => +v.toFixed(3)) }, words: segs };
}
function encodeMp3(pcm) {
  // Written to a real file so the LAME/Xing header (encoder delay → gapless decode) is present, like real TTS mp3s.
  const dir = mkdtempSync(join(tmpdir(), 'mock-tts-'));
  const out = join(dir, 'a.mp3');
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ['-v', 'error', '-f', 'f32le', '-ar', String(SR), '-ac', '1', '-i', 'pipe:0', '-c:a', 'libmp3lame', '-b:a', '128k', out]);
    p.on('error', reject);
    p.on('close', c => {
      try { if (c !== 0) throw new Error('ffmpeg mp3 failed'); resolve(readFileSync(out)); } catch (e) { reject(e); } finally { rmSync(dir, { recursive: true, force: true }); }
    });
    p.stdin.end(Buffer.from(pcm.buffer));
  });
}
async function speak(req, res, body) {
  stats.tts++;
  if (!req.headers['xi-api-key']) return json(res, 401, { detail: { status: 'invalid_api_key', message: 'missing xi-api-key' } });
  const { pcm, alignment } = synthSpeech(String(body.text || ''));
  const mp3 = await encodeMp3(pcm);
  const words = [];
  let cur = null;
  alignment.characters.forEach((c, i) => {
    if (/\s/.test(c)) { if (cur) words.push(cur); cur = null; return; }
    if (!cur) cur = { text: '', start: alignment.character_start_times_seconds[i] };
    cur.text += c; cur.end = alignment.character_end_times_seconds[i];
  });
  if (cur) words.push(cur);
  tts.set(createHash('sha1').update(mp3).digest('hex'), words);
  json(res, 200, { audio_base64: mp3.toString('base64'), alignment, normalized_alignment: alignment });
}
// STT spelling drift so the LCS alignment has real work to do.
const drift = w => w.replace(/[.,،؟?!…:]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة$/, 'ه').replace(/ى$/, 'ي');
function transcribe(bytes) {
  const words = tts.get(createHash('sha1').update(bytes).digest('hex'));
  if (!words) return [{ text: 'كلام', start: 0.2, end: 0.6 }, { text: 'مش', start: 0.7, end: 0.9 }, { text: 'معروف', start: 1.0, end: 1.5 }];
  const out = [];
  words.forEach((w, i) => {
    // merge every 7th pair into one word (STT often glues words), keep timing span
    if (i % 7 === 3 && words[i + 1]) { out.push({ text: drift(w.text) + drift(words[i + 1].text), start: w.start, end: words[i + 1].end, _skip: true }); return; }
    if (i % 7 === 4 && out[out.length - 1]?._skip) return;
    out.push({ text: drift(w.text), start: +(w.start + 0.01).toFixed(3), end: w.end });
  });
  return out.map(({ _skip, ...w }) => w);
}

// ---------------------------------------------------------------- server
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
async function readBody(req) { const c = []; for await (const d of req) c.push(d); return Buffer.concat(c); }

export function startMock(port = PORT) {
  const server = http.createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const url = new URL(req.url, 'http://x');
    try {
      const raw = await readBody(req);
      if (url.pathname === '/v1/chat/completions' && req.method === 'POST') return chat(req, res, JSON.parse(raw));
      if (url.pathname === '/v1/models') return json(res, 200, { data: [{ id: 'auto' }] });
      if (url.pathname === '/v1/voices') { stats.voices++; return json(res, 200, { voices: [{ voice_id: 'mock-voice-eg', name: 'Mock Egyptian (male)', category: 'premade', labels: { accent: 'egyptian' } }, { voice_id: 'mock-voice-2', name: 'Mock Narrator', category: 'premade', labels: {} }] }); }
      const ttsM = url.pathname.match(/^\/v1\/text-to-speech\/([^/]+)\/with-timestamps$/);
      if (ttsM && req.method === 'POST') return await speak(req, res, JSON.parse(raw));
      if (url.pathname === '/v1/listen' && req.method === 'POST') {
        stats.listen++;
        if (!/^Token /.test(req.headers.authorization || '')) return json(res, 401, { err_msg: 'missing token' });
        const words = transcribe(raw);
        return json(res, 200, { results: { channels: [{ alternatives: [{ transcript: words.map(w => w.text).join(' '), words: words.map(w => ({ word: w.text, punctuated_word: w.text, start: w.start, end: w.end, confidence: 0.93 })) }] }] } });
      }
      if (url.pathname === '/v1/speech-to-text' && req.method === 'POST') {
        stats.scribe++;
        // crude multipart: find the file part bytes
        const boundary = (req.headers['content-type'].match(/boundary=(.+)$/) || [])[1];
        let file = raw;
        if (boundary) {
          const parts = raw.toString('latin1').split('--' + boundary);
          const fp = parts.find(p => /name="file"/.test(p));
          if (fp) { const body = fp.slice(fp.indexOf('\r\n\r\n') + 4, fp.lastIndexOf('\r\n')); file = Buffer.from(body, 'latin1'); }
        }
        const words = transcribe(file);
        const out = [];
        words.forEach((w, i) => { if (i) out.push({ text: ' ', type: 'spacing', start: w.start, end: w.start }); out.push({ text: w.text, type: 'word', start: w.start, end: w.end }); });
        return json(res, 200, { language_code: 'ara', text: words.map(w => w.text).join(' '), words: out });
      }
      json(res, 404, { error: 'mock: unknown route ' + url.pathname });
    } catch (e) { json(res, 500, { error: String(e.message) }); }
  });
  return new Promise(r => server.listen(port, '127.0.0.1', () => { console.log(`mock APIs on http://127.0.0.1:${port}`); r(server); }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) startMock();
