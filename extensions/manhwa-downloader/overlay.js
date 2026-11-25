// طبقة الترجمة فوق صور الفصل: قطع الفقاعات المنظّفة والمترجمة
(() => {
  if (window.__mhdOverlay) return;
  const root = document.createElement('div');
  root.id = 'mhd-overlay-root';
  root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;overflow:hidden;';
  document.documentElement.appendChild(root);
  const entries = new Map(); // el -> { patches, nodes }
  let shown = true, raf = 0;

  function layout() {
    raf = 0;
    if (!shown) return;
    const vh = innerHeight;
    for (const [el, e] of entries) {
      if (!el.isConnected) { e.nodes.forEach((n) => n.remove()); entries.delete(el); continue; }
      const r = el.getBoundingClientRect();
      const visible = r.bottom > -50 && r.top < vh + 50 && r.width > 0;
      e.nodes.forEach((n, i) => {
        if (!visible) { n.style.display = 'none'; return; }
        const p = e.patches[i];
        n.style.display = 'block';
        n.style.width = p.w * r.width + 'px';
        n.style.height = p.h * r.height + 'px';
        n.style.transform = `translate(${r.left + p.x * r.width}px, ${r.top + p.y * r.height}px)`;
      });
    }
    raf = requestAnimationFrame(layout);
  }
  const kick = () => { if (!raf && shown && entries.size) raf = requestAnimationFrame(layout); };

  window.__mhdOverlay = {
    add(idx, patches) {
      const el = document.querySelector(`[data-mhd-idx="${idx}"]`);
      if (!el) return false;
      entries.get(el)?.nodes.forEach((n) => n.remove());
      const nodes = patches.map((p) => {
        const n = document.createElement('img');
        n.src = p.url;
        n.alt = '';
        n.draggable = false;
        n.style.cssText = 'position:absolute;left:0;top:0;display:none;max-width:none;margin:0;padding:0;border:0;' +
          'pointer-events:auto;cursor:pointer;will-change:transform;user-select:none;';
        // ضغطة على الفقاعة = تشوف الأصل، ضغطة ثانية = ترجع الترجمة
        n.addEventListener('click', (ev) => {
          ev.stopPropagation(); ev.preventDefault();
          n.style.opacity = n.style.opacity === '0' ? '1' : '0';
        });
        root.appendChild(n);
        return n;
      });
      entries.set(el, { patches, nodes });
      kick();
      return true;
    },
    toggle(v) {
      shown = v ?? !shown;
      root.style.display = shown ? '' : 'none';
      kick();
      return shown;
    },
    clear() { entries.forEach((e) => e.nodes.forEach((n) => n.remove())); entries.clear(); },
    count() { return entries.size; },
  };
})();
