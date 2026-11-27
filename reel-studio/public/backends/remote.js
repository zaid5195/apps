// PC mode: talks to the local Node server (127.0.0.1:4301) over HTTP + SSE.
import { decodeWav } from '../core/audio.js';
import { encodeReel } from './encode.js';

async function req(path, { method = 'GET', body, headers } = {}) {
  const isRaw = body instanceof Blob || body instanceof ArrayBuffer || body instanceof Uint8Array;
  const r = await fetch(path, { method, headers: isRaw ? headers : { 'content-type': 'application/json', ...headers }, body: body == null ? undefined : isRaw ? body : JSON.stringify(body) });
  const t = await r.text();
  let j; try { j = t ? JSON.parse(t) : {}; } catch { j = { error: t }; }
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

export class RemoteBackend {
  constructor() { this.mode = 'server'; this.rendering = new Set(); }
  health() { return req('/api/health'); }
  getSettings() { return req('/api/settings'); }
  saveSettings(patch) { return req('/api/settings', { method: 'PUT', body: patch }); }
  voices() { return req('/api/voices'); }
  models(backup) { return req('/api/models' + (backup ? `?backup=${encodeURIComponent(backup)}` : '')); }
  ideas(b) { return req('/api/ideas', { method: 'POST', body: b }); }
  batch(topics, options) { return req('/api/batch', { method: 'POST', body: { topics, options } }); }
  batchState() { return req('/api/batch'); }
  setStyle(id, s) { return req(`/api/projects/${id}/style`, { method: 'POST', body: s }); }
  listProjects() { return req('/api/projects'); }
  createProject(b) { return req('/api/projects', { method: 'POST', body: b }); }
  getProject(id) { return req(`/api/projects/${id}`); }
  deleteProject(id) { return req(`/api/projects/${id}`, { method: 'DELETE' }); }
  start(id) { return req(`/api/projects/${id}/start`, { method: 'POST' }); }
  cancel(id) { return req(`/api/projects/${id}/cancel`, { method: 'POST' }); }
  approve(id, stage) { return req(`/api/projects/${id}/stages/${stage}/approve`, { method: 'POST' }); }
  rerun(id, stage) { return req(`/api/projects/${id}/stages/${stage}/rerun`, { method: 'POST' }); }
  edit(id, stage, payload) { return req(`/api/projects/${id}/stages/${stage}/edit`, { method: 'POST', body: payload }); }
  setApprovals(id, a) { return req(`/api/projects/${id}/approvals`, { method: 'POST', body: a }); }
  uploadVoice(id, file) { return req(`/api/projects/${id}/voice?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file, headers: { 'content-type': file.type || 'audio/mpeg' } }); }
  setVoiceSource(id, b) { return req(`/api/projects/${id}/voice-source`, { method: 'POST', body: b }); }
  async renderData(id, aspect = '9:16') { const j = await req(`/api/projects/${id}/render-data?aspect=${encodeURIComponent(aspect)}`); return { ...j, audio: j.audio }; }
  async fileUrl(id, name) { return `/api/projects/${id}/files/${encodeURIComponent(name)}`; }
  subscribe(id, cb) {
    const es = new EventSource(`/api/projects/${id}/events`);
    es.onmessage = e => {
      const ev = JSON.parse(e.data);
      if (ev.type === 'render-request') this._clientRender(id, cb, ev.aspect);
      cb(ev);
    };
    es.onerror = () => cb({ type: 'disconnected' });
    return () => es.close();
  }
  /** The server has no Chromium: render here with WebCodecs and upload the mp4. */
  async _clientRender(id, cb, aspect = '9:16') {
    if (this.rendering.has(id)) return;
    this.rendering.add(id);
    try {
      const rd = await this.renderData(id, aspect);
      const wav = new Uint8Array(await (await fetch(rd.mix)).arrayBuffer());
      const blob = await encodeReel({ data: rd.data, mix: decodeWav(wav), font: rd.font, onProgress: (value, label) => cb({ type: 'progress', stage: 'render', value, label }), onFrame: (data, t) => cb({ type: 'frame', stage: 'render', data, t }) });
      await req(`/api/projects/${id}/render-upload`, { method: 'POST', body: blob, headers: { 'content-type': 'video/mp4' } });
    } catch (e) {
      await req(`/api/projects/${id}/render-failed`, { method: 'POST', body: { error: String(e.message || e) } }).catch(() => {});
    } finally { this.rendering.delete(id); }
  }
}
