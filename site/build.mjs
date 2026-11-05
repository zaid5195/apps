// Builds the apps website from site/apps.json into _site/.
// Usage: node site/build.mjs   (no dependencies)
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, cpSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, '..', '_site');
const data = JSON.parse(readFileSync(join(root, 'apps.json'), 'utf8'));
const { site, apps } = data;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

for (const a of apps) {
  // "Coming soon" apps (announced from the control panel) have no download yet.
  a.comingSoon = !a.download;
  for (const k of ['slug', 'name']) if (!a[k]) throw new Error(`app missing "${k}": ${JSON.stringify(a)}`);
  if (!/^[a-z0-9-]+$/.test(a.slug)) throw new Error(`bad slug: ${a.slug}`);
}

const socials = () => {
  const l = site.links || {};
  const items = [
    l.youtube && `<a class="soc" href="${esc(l.youtube)}" target="_blank" rel="noopener">▶️ يوتيوب</a>`,
    l.tiktok && `<a class="soc" href="${esc(l.tiktok)}" target="_blank" rel="noopener">🎵 تيك توك</a>`,
    l.support && `<a class="soc support" href="${esc(l.support)}" target="_blank" rel="noopener">💚 ادعمنا</a>`,
  ].filter(Boolean);
  return items.length ? `<div class="socials">${items.join('')}</div>` : '';
};

const page = ({ title, desc, path, body, depth }) => {
  const up = depth ? '../'.repeat(depth) : './';
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(site.baseUrl + path)}">
<meta name="theme-color" content="#0b1220">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@500;700;900&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${up}style.css">
</head>
<body>
<header class="top"><a class="brand" href="${up}">📱 ${esc(site.title)}</a></header>
<main>
${body}
</main>
<footer>
  ${socials()}
  <p>التطبيقات مجانية ومصنوعة بالذكاء الاصطناعي بناءً على اقتراحات المتابعين.</p>
  <p><a href="${up}privacy/">🔒 سياسة الخصوصية</a></p>
</footer>
</body>
</html>
`;
};

const icon = a => `<div class="icon" style="--c:${esc(a.color || '#2563eb')}">${esc(a.emoji || '📱')}</div>`;

const card = a => `
  <a class="card" href="${esc(a.slug)}/">
    ${icon(a)}
    <div class="card-body">
      <h3>${esc(a.name)}</h3>
      <p>${esc(a.tagline)}</p>
      <div class="meta">
        <span class="badge${a.comingSoon ? ' soon' : ''}">${esc(a.comingSoon ? 'قريباً 🔜' : (a.status || 'متاح'))}</span>
        ${a.version && !a.comingSoon ? `<span>نسخة ${esc(a.version)}</span>` : ''}
        ${a.suggestedBy ? `<span>💡 اقتراح ${esc(a.suggestedBy)}</span>` : ''}
      </div>
    </div>
  </a>`;

// Available apps first (newest first), then the ones coming soon.
const sorted = [...apps].sort((x, y) => (x.comingSoon - y.comingSoon) || String(y.released || '').localeCompare(String(x.released || '')));

const home = page({
  title: `${site.title} — ${site.tagline}`,
  desc: site.tagline,
  path: '/',
  depth: 0,
  body: `
<section class="hero">
  <h1>${esc(site.tagline)}</h1>
  <div class="steps">
    <div><span>💡</span>تقترح فكرة</div>
    <div><span>🤖</span>نسويها بالذكاء الاصطناعي</div>
    <div><span>⬇️</span>تحمّلها مجانًا</div>
  </div>
</section>
<section>
  <h2>التطبيقات <small>(${apps.length})</small></h2>
  <div class="grid">${sorted.map(card).join('')}</div>
</section>
<section class="suggest">
  <h2>عندك فكرة تطبيق؟ 💡</h2>
  <p>اكتبها في تعليقات آخر فيديو، وممكن يكون تطبيقك هو الجاي — ونكتب اسمك عليه.</p>
  ${socials()}
</section>`,
});

// Relative download paths (e.g. "downloads/x.apk") are files hosted on this site.
const dl = (a, depth) => /^https?:\/\//.test(a.download) ? a.download : '../'.repeat(depth) + a.download;

const appPage = a => page({
  title: `${a.name} — ${site.title}`,
  desc: a.tagline || a.description,
  path: `/${a.slug}/`,
  depth: 1,
  body: `
<section class="app-hero">
  ${icon(a)}
  <h1>${esc(a.name)}</h1>
  <p class="lead">${esc(a.tagline)}</p>
  <div class="meta center">
    <span class="badge${a.comingSoon ? ' soon' : ''}">${esc(a.comingSoon ? 'قريباً 🔜' : (a.status || 'متاح'))}</span>
    ${a.version && !a.comingSoon ? `<span>نسخة ${esc(a.version)}</span>` : ''}
    ${a.platform ? `<span>${esc(a.platform)}</span>` : ''}
  </div>
  ${a.comingSoon
    ? `<div class="download soon">🔜 قيد الصنع — تابعنا على تيك توك عشان تعرف أول ما ينزل</div>`
    : `<a class="download" href="${esc(dl(a, 1))}">⬇️ تحميل التطبيق مجانًا</a>`}
  ${a.suggestedBy ? `<p class="credit">💡 فكرة التطبيق من: <b>${esc(a.suggestedBy)}</b></p>` : ''}
</section>
${a.description ? `<section><p class="desc">${esc(a.description)}</p></section>` : ''}
${a.video ? `<section><a class="video" href="${esc(a.video)}" target="_blank" rel="noopener">🎬 شوف فيديو التطبيق</a></section>` : ''}
${a.features?.length ? `<section><h2>المزايا</h2><ul class="features">${a.features.map(f => `<li>${esc(f)}</li>`).join('')}</ul></section>` : ''}
${a.howTo?.length ? `<section><h2>طريقة الاستخدام</h2><ol class="howto">${a.howTo.map(s => `<li>${esc(s)}</li>`).join('')}</ol></section>` : ''}
${a.comingSoon ? '' : `<section class="install">
  <h2>طريقة التثبيت</h2>
  <ol class="howto">
    <li>اضغط «تحميل التطبيق» وانتظر ينزل الملف</li>
    <li>افتح الملف من الإشعارات أو من مجلد التنزيلات</li>
    <li>إذا طلب منك، اسمح بـ «التثبيت من مصادر غير معروفة»</li>
    <li>اضغط «تثبيت» — وللتحديث نزّل النسخة الجديدة وثبّتها فوق القديمة</li>
  </ol>
</section>`}
${a.signature ? `<section class="official">
  <h2>✅ نسخة رسمية</h2>
  <p>كل تطبيقاتنا موقّعة بمفتاح المطوّر ${esc(site.developer || '')}. التطبيق نفسه يتأكد من توقيعه، وتلقى في «عن التطبيق» كلمة «نسخة رسمية». إذا لقيت نسخة من مكان ثاني، أندرويد ما راح يقبلها كتحديث لتطبيقنا.</p>
  <p class="sig-label">بصمة التوقيع (SHA-256):</p>
  <code class="sig">${esc(a.signature)}</code>
</section>` : ''}
<p class="back"><a href="../">→ كل التطبيقات</a></p>`,
});

const privacyPage = page({
  title: `سياسة الخصوصية — ${site.title}`,
  desc: 'وش تجمع تطبيقاتنا من بيانات، وكيف نستخدمها.',
  path: '/privacy/',
  depth: 1,
  body: `
<section>
  <h1>🔒 سياسة الخصوصية</h1>
  <p class="lead" style="margin-top:8px">باختصار: ما نطلب منك حساب، ما نبيع بياناتك، وما في إعلانات تتبعك.</p>
  <p class="credit" style="margin-top:6px">آخر تحديث: ${esc(site.privacyUpdated || '')}</p>
</section>
<section>
  <h2>ينطبق على كل تطبيقاتنا</h2>
  <ul class="features">
    <li>📱 إعداداتك (مثل لغاتك) تنحفظ على جوالك بس.</li>
    <li>🎛️ التطبيق يقرأ ملف إعدادات عام من موقعنا ومن GitHub (للصيانة والتحديثات والرسائل). هذا طلب عادي مثل فتح صفحة إنترنت، وما يرسل أي معلومة عنك.</li>
    <li>📊 إحصائيات مجهولة: التطبيق يرسل «+1» لعدّاد عند أول تشغيل، ومرة باليوم لما تفتحه، عشان نعرف كم واحد يستخدمه. ما يرسل اسمك ولا رقمك ولا أي محتوى، وما في رقم تعريف لجوالك. العداد على خدمة abacus.jasoncameron.dev، ومثل أي موقع تقدر الخدمة تشوف عنوان الإنترنت (IP) وقت الطلب. تقدر توقفها من «عن التطبيق» داخل التطبيق.</li>
    <li>⬇️ التحميل من GitHub، وهم يعدّون مرات التحميل بس.</li>
    <li>🚫 ما نشارك بياناتك مع أحد لأغراض إعلانية أو تجارية.</li>
  </ul>
</section>
${apps.filter(a => a.dataUse?.length).map(a => `
<section>
  <h2>${esc(a.emoji || '📱')} ${esc(a.name)}</h2>
  <ul class="features">${a.dataUse.map(d => `<li>${esc(d)}</li>`).join('')}</ul>
</section>`).join('')}
<section>
  <h2>تواصل معنا</h2>
  <p class="desc">أي سؤال عن خصوصيتك؟ راسلنا على ${site.links?.tiktok ? `<a href="${esc(site.links.tiktok)}" target="_blank" rel="noopener">تيك توك</a>` : 'حساباتنا'}.</p>
</section>
<p class="back"><a href="../">→ كل التطبيقات</a></p>`,
});

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'index.html'), home);
copyFileSync(join(root, 'style.css'), join(out, 'style.css'));
for (const a of apps) {
  mkdirSync(join(out, a.slug), { recursive: true });
  writeFileSync(join(out, a.slug, 'index.html'), appPage(a));
}
mkdirSync(join(out, 'privacy'), { recursive: true });
writeFileSync(join(out, 'privacy', 'index.html'), privacyPage);
const adminDir = join(root, 'admin');
if (existsSync(adminDir)) cpSync(adminDir, join(out, 'admin'), { recursive: true });
const cfgDir = join(root, 'config');
if (existsSync(cfgDir)) cpSync(cfgDir, join(out, 'config'), { recursive: true });
for (const a of apps) {
  const f = join(out, 'config', `${a.slug}.json`);
  if (existsSync(f)) JSON.parse(readFileSync(f, 'utf8')); // fail the build on a broken control file
}
// APKs are store releases now; local files are only for an app that has not moved yet.
const localApks = join(root, 'downloads');
if (apps.some(a => a.download && !/^https?:\/\//.test(a.download)) && existsSync(localApks)) cpSync(localApks, join(out, 'downloads'), { recursive: true });
for (const a of apps) {
  if (a.download && !/^https?:\/\//.test(a.download) && !existsSync(join(out, a.download))) throw new Error(`missing file for ${a.slug}: ${a.download}`);
}
console.log(`Built ${apps.length} app page(s) into ${out}`);
