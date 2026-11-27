// حفظ محلي في المتصفح (IndexedDB): الترجمات + آخر فصل مفتوح
let dbp = null;
function open() {
  if (!dbp) {
    dbp = new Promise((ok, bad) => {
      try {
        const r = indexedDB.open('manhwa-translator', 1);
        r.onupgradeneeded = () => {
          r.result.createObjectStore('cache');
          r.result.createObjectStore('session');
        };
        r.onsuccess = () => ok(r.result);
        r.onerror = () => bad(r.error);
      } catch (e) { bad(e); }
    }).catch(() => null);
  }
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  if (!db) return undefined;
  return new Promise((ok) => {
    try {
      const t = db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => ok(req?.result);
      t.onerror = t.onabort = () => ok(undefined);
    } catch { ok(undefined); }
  });
}

export const dbGet = (store, key) => tx(store, 'readonly', (s) => s.get(key));
export const dbPut = (store, key, val) => tx(store, 'readwrite', (s) => s.put(val, key));
export const dbDel = (store, key) => tx(store, 'readwrite', (s) => s.delete(key));

// بصمة الصورة: نفس الصورة = نفس الترجمة المحفوظة
export async function hashBytes(data) {
  try {
    const d = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(d)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    let h = 2166136261 >>> 0;
    const step = Math.max(1, Math.floor(data.length / 200000));
    for (let i = 0; i < data.length; i += step) { h ^= data[i]; h = Math.imul(h, 16777619) >>> 0; }
    return `f${h.toString(16)}-${data.length}`;
  }
}
