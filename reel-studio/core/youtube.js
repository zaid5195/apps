// YouTube Data API v3: resumable upload with title / description / tags, thumbnail, channel info.
// Works the same from Node (PC server, refresh token) and from the browser (phone mode, Google sign-in token).
export const YT_SCOPES = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly';
export const YT_DEFAULTS = {
  api: 'https://www.googleapis.com/youtube/v3',
  upload: 'https://www.googleapis.com/upload/youtube/v3',
  token: 'https://oauth2.googleapis.com/token',
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
};
const CHUNK = 4 * 1024 * 1024; // multiple of 256 KiB

async function ytError(res, what) {
  let t = await res.text().catch(() => '');
  let reason = '';
  try { const j = JSON.parse(t); reason = j.error?.errors?.[0]?.reason || j.error?.status || ''; t = j.error?.message || j.error_description || t; } catch {}
  const e = new Error(`YouTube ${what} HTTP ${res.status}: ${String(t).slice(0, 240)}`);
  e.status = res.status; e.reason = reason;
  if (/quotaExceeded|uploadLimitExceeded/.test(reason)) e.friendlyAr = 'وصلت للحد اليومي ديال يوتيوب (تقريبًا 6 فيديوهات في اليوم لكل مشروع Google). جرّب بكرة.';
  else if (res.status === 401) e.friendlyAr = 'صلاحية الدخول ليوتيوب خلصت أو اتلغت — اربط الحساب تاني من الإعدادات.';
  else if (/youtubeSignupRequired/.test(reason)) e.friendlyAr = 'الحساب ده ما عندوش قناة يوتيوب — اعمل قناة الأول.';
  return e;
}

/** Title / description / tags for YouTube from the project (editable before upload). */
export function youtubeMeta(p, overrides = {}) {
  const pub = p.publish || {};
  const tags = (overrides.hashtags || pub.hashtags || []).map(t => String(t).replace(/^#+/, '').trim()).filter(Boolean);
  const vertical = (p.render?.files?.[0]?.aspect || '9:16') === '9:16';
  const title = String(overrides.title ?? pub.title ?? p.script?.title ?? p.topic).replace(/[<>]/g, '').slice(0, 100);
  const hashLine = [...tags.slice(0, 12).map(t => '#' + t.replace(/\s+/g, '_')), vertical ? '#Shorts' : ''].filter(Boolean).join(' ');
  const sources = (p.script?.sources || []).length ? `\n\n${p.lang === 'es' ? 'Fuentes' : 'المصادر'}:\n${p.script.sources.join('\n')}` : '';
  const description = String(overrides.description ?? `${pub.caption || title}${sources}\n\n${hashLine}`).replace(/[<>]/g, '').slice(0, 4900);
  let total = 0;
  const ytTags = [];
  for (const t of [...tags, ...(vertical ? ['Shorts'] : [])]) { if (total + t.length + 1 > 450) break; ytTags.push(t); total += t.length + 1; }
  return { title, description, tags: ytTags, privacy: overrides.privacy || 'public', categoryId: '28', lang: p.lang === 'es' ? 'es' : 'ar' };
}

/** Resumable upload in 4 MB chunks (gives progress everywhere). Returns {id, url}. */
export async function uploadVideo({ accessToken, bytes, meta, onProgress, fetchImpl = fetch, base = YT_DEFAULTS.upload, signal }) {
  const body = {
    snippet: { title: meta.title, description: meta.description, tags: meta.tags, categoryId: meta.categoryId || '28', defaultLanguage: meta.lang, defaultAudioLanguage: meta.lang },
    status: { privacyStatus: meta.privacy || 'public', selfDeclaredMadeForKids: false, embeddable: true },
  };
  const init = await fetchImpl(`${base}/videos?uploadType=resumable&part=snippet,status`, {
    method: 'POST', signal,
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': 'video/mp4', 'x-upload-content-length': String(bytes.length) },
    body: JSON.stringify(body),
  });
  if (!init.ok) throw await ytError(init, 'upload start');
  const loc = init.headers.get('location');
  if (!loc) throw new Error('YouTube did not return an upload URL');
  let sent = 0, result = null;
  while (sent < bytes.length) {
    const end = Math.min(bytes.length, sent + CHUNK);
    const res = await fetchImpl(loc, { method: 'PUT', signal, headers: { 'content-type': 'video/mp4', 'content-range': `bytes ${sent}-${end - 1}/${bytes.length}` }, body: bytes.subarray(sent, end) });
    if (res.status === 308) {
      const range = res.headers.get('range');
      sent = range ? +range.split('-')[1] + 1 : end;
    } else if (res.ok) { result = await res.json(); sent = bytes.length; }
    else throw await ytError(res, 'upload');
    onProgress?.(sent / bytes.length);
  }
  if (!result?.id) throw new Error('YouTube upload finished without a video id');
  return { id: result.id, url: `https://youtu.be/${result.id}`, privacy: result.status?.privacyStatus };
}

export async function setThumbnail({ accessToken, videoId, jpeg, fetchImpl = fetch, base = YT_DEFAULTS.upload }) {
  const res = await fetchImpl(`${base}/thumbnails/set?videoId=${encodeURIComponent(videoId)}`, { method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'image/jpeg' }, body: jpeg });
  if (!res.ok) throw await ytError(res, 'thumbnail');
}

export async function getChannel({ accessToken, fetchImpl = fetch, base = YT_DEFAULTS.api }) {
  const res = await fetchImpl(`${base}/channels?part=snippet&mine=true`, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw await ytError(res, 'channel');
  const j = await res.json();
  const c = j.items?.[0];
  return c ? { id: c.id, title: c.snippet?.title, thumb: c.snippet?.thumbnails?.default?.url } : null;
}

/** OAuth (server side): authorization URL, code exchange, refresh. */
export function authUrl({ clientId, redirectUri, state, base = YT_DEFAULTS.auth }) {
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: YT_SCOPES, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state });
  return `${base}?${q}`;
}
export async function exchangeCode({ clientId, clientSecret, code, redirectUri, fetchImpl = fetch, tokenUrl = YT_DEFAULTS.token }) {
  const res = await fetchImpl(tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri, grant_type: 'authorization_code' }) });
  if (!res.ok) throw await ytError(res, 'login');
  return res.json();
}
export async function refreshToken({ clientId, clientSecret, refreshToken: rt, fetchImpl = fetch, tokenUrl = YT_DEFAULTS.token }) {
  const res = await fetchImpl(tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: rt, grant_type: 'refresh_token' }) });
  if (!res.ok) throw await ytError(res, 'token');
  return res.json();
}
