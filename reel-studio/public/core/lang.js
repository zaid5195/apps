// Content languages. Everything language-specific lives here.
export const LANGS = {
  ar: {
    id: 'ar', name: 'العربية (مصري)', rtl: true, wps: 2.6,
    writer: 'Egyptian Arabic (Egyptian dialect, not Modern Standard Arabic)', labelLang: 'Arabic',
    question: 'عارف ليه؟', questionKey: ['عارف', 'ليه'], qmark: '؟', recap: 'الخلاصة', series: 'عارف ليه؟',
    styleFile: 'script-style.md', deepgram: 'ar', scribe: 'ara',
    typeLabel: { intro: 'البداية', question: 'السؤال', concept: 'الفكرة', process: 'الخطوات', compare: 'مقارنة', stat: 'بالأرقام', recap: 'الخلاصة' },
  },
  es: {
    id: 'es', name: 'Español', rtl: false, wps: 2.8,
    writer: 'natural conversational Spanish (neutral, easy to follow in Spain and Latin America)', labelLang: 'Spanish',
    question: '¿Sabes por qué?', questionKey: ['sabes', 'por'], qmark: '?', recap: 'En resumen', series: '¿Sabes por qué?',
    styleFile: 'script-style.es.md', deepgram: 'es', scribe: 'spa',
    typeLabel: { intro: 'Inicio', question: 'La pregunta', concept: 'La idea', process: 'Paso a paso', compare: 'Comparación', stat: 'En cifras', recap: 'Resumen' },
  },
};
export const lang = id => LANGS[id] || LANGS.ar;
