// Topic ideas for the series.
import { lang as L } from './lang.js';

export function ideasMessages({ lang = 'ar', hint = '', count = 10, avoid = [] }) {
  const lg = L(lang);
  return [
    { role: 'system', content: `You are the producer of a viral faceless science-explainer series («${lg.question}»). Suggest topics that make people stop scrolling: everyday mysteries of the body, nature, space, food, tech. Each must be answerable in under 60 seconds with one clear mechanism, and be scientifically solid. Write in ${lg.labelLang}${lang === 'ar' ? ' (Egyptian dialect)' : ''}. Reply with ONE JSON object only: {"ideas":[{"topic":"...","hook":"..."}]}` },
    { role: 'user', content: `Give ${count} fresh topic ideas${hint ? ` around: ${hint}` : ''}. "topic" is a short why/how question (≤ 10 words), "hook" a one-line surprising fact to open with.${avoid.length ? `\nAvoid these (already done): ${avoid.slice(0, 40).join(' | ')}` : ''}` },
  ];
}

export function parseIdeas(json) {
  const list = Array.isArray(json) ? json : json?.ideas || [];
  return list.map(x => (typeof x === 'string' ? { topic: x, hook: '' } : { topic: String(x.topic || x.title || '').trim(), hook: String(x.hook || '').trim() })).filter(x => x.topic).slice(0, 20);
}

export function publishMessages({ lang = 'ar', title, script, sources = [] }) {
  const lg = L(lang);
  return [
    { role: 'system', content: `You write social-media captions for a faceless science reel series («${lg.question}») in ${lg.labelLang}${lang === 'ar' ? ' (Egyptian dialect)' : ''}. Reply with ONE JSON object only: {"caption":"...","hashtags":["#..."]}. caption: 2–3 short lines — a curiosity hook, one line of value, a question that invites comments; at most 2 emojis. hashtags: 8–12, mixing ${lg.labelLang} and English, broad + niche (e.g. #science #علوم), no spaces inside a hashtag.` },
    { role: 'user', content: `Title: ${title}\nScript:\n${script}\n${sources.length ? 'Sources: ' + sources.join(' | ') : ''}` },
  ];
}

export function fallbackPublish({ lang = 'ar', title }) {
  const ar = lang !== 'es';
  return {
    caption: ar ? `${title}\nالإجابة هتفاجئك 👀\nقولّي في الكومنتات: كنت عارفها؟` : `${title}\nLa respuesta te va a sorprender 👀\n¿Lo sabías? Cuéntamelo en comentarios`,
    hashtags: ar ? ['#عارف_ليه', '#علوم', '#معلومة', '#ثقافة_عامة', '#تعلم_على_تيك_توك', '#science', '#facts', '#learnontiktok'] : ['#sabesporque', '#ciencia', '#curiosidades', '#datoscuriosos', '#aprendeentiktok', '#science', '#facts', '#learnontiktok'],
  };
}
