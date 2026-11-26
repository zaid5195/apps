// File-system project store: data/projects/<id>/{project.json, voice.mp3, words.json, mix.wav, reel.mp4, …}
import { readFile, writeFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const safeId = id => { if (!/^[a-z0-9]{6,40}$/.test(String(id))) throw Object.assign(new Error('Bad project id'), { status: 400 }); return id; };
export const safeName = n => { if (!/^[\w][\w.-]{0,80}$/.test(String(n)) || n.includes('..')) throw Object.assign(new Error('Bad file name'), { status: 400 }); return n; };

export class FileStore {
  constructor(dir) { this.dir = join(dir, 'projects'); }
  path(id, name = '') { return join(this.dir, safeId(id), name ? safeName(name) : ''); }
  async save(p) {
    await mkdir(this.path(p.id), { recursive: true });
    const tmp = this.path(p.id, 'project.json.tmp');
    await writeFile(tmp, JSON.stringify(p));
    const { rename } = await import('node:fs/promises');
    await rename(tmp, this.path(p.id, 'project.json'));
  }
  async load(id) {
    try { return JSON.parse(await readFile(this.path(id, 'project.json'), 'utf8')); } catch (e) { if (e.status) throw e; return null; }
  }
  async list() {
    if (!existsSync(this.dir)) return [];
    const ids = await readdir(this.dir);
    const out = [];
    for (const id of ids) {
      try { const p = await this.load(id); if (p) out.push(p); } catch {}
    }
    return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }
  async remove(id) { await rm(this.path(id), { recursive: true, force: true }); }
  async writeFile(id, name, data) { await mkdir(this.path(id), { recursive: true }); await writeFile(this.path(id, name), typeof data === 'string' ? data : Buffer.from(data.buffer ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : data)); }
  async readFile(id, name) { return new Uint8Array(await readFile(this.path(id, name))); }
  async fileStat(id, name) { try { return await stat(this.path(id, name)); } catch { return null; } }
}
