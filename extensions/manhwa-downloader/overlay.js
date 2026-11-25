// طبقة الترجمة فوق صور الفصل في صفحة القارئ
(() => {
  if (window.__mhdOverlay) return;
  const FONT = '"Noto Naskh Arabic", "Segoe UI", Tahoma, "Noto Sans", Arial, sans-serif';
  const root = document.createElement('div');
  root.id = 'mhd-overlay-root';
  root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;overflow:hidden;';
  document.documentElement.appendChild(root);
  const entries = new Map(); // el -> { boxes, nodes, w, rtl }
  let shown = true, raf = 0;

  const textColor = (bg) => {
    let h = bg.replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) || 0);
    return 0.299 * r + 0.587 * g + 0.114 * b > 140 ? '#111' : '#fff';
  };
  const expand = (b) => {
    const px = b.w * 0.06, py = b.h * 0.08;
    const x = Math.max(0, b.x - px), y = Math.max(0, b.y - py);
    return { x, y, w: Math.min(1, b.x + b.w + px) - x, h: Math.min(1, b.y + b.h + py) - y };
  };
  const fit = (node, w, h) => {
    let lo = 6, hi = Math.max(8, Math.min(h * 0.5, 40)), best = lo;
    node.style.width = w + 'px';
    node.style.height = h + 'px';
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      node.style.fontSize = mid + 'px';
      if (node.scrollHeight <= h + 1 && node.scrollWidth <= w + 1) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    node.style.fontSize = best + 'px';
  };

  function layout() {
    raf = 0;
    if (!shown) return;
    const vh = innerHeight;
    for (const [el, e] of entries) {
      if (!el.isConnected) { e.nodes.forEach((n) => n.remove()); entries.delete(el); continue; }
      const r = el.getBoundingClientRect();
      const visible = r.bottom > -50 && r.top < vh + 50 && r.width > 0;
      const resized = Math.abs(r.width - e.w) > 0.5;
      e.w = r.width;
      e.nodes.forEach((n, i) => {
        if (!visible) { n.style.display = 'none'; return; }
        n.style.display = 'flex';
        const b = expand(e.boxes[i]);
        const w = b.w * r.width, h = b.h * r.height;
        n.style.transform = `translate(${r.left + b.x * r.width}px, ${r.top + b.y * r.height}px)`;
        if (resized || !n.dataset.fit) { fit(n, w, h); n.dataset.fit = '1'; }
      });
    }
    raf = requestAnimationFrame(layout);
  }
  const kick = () => { if (!raf && shown && entries.size) raf = requestAnimationFrame(layout); };

  window.__mhdOverlay = {
    add(idx, boxes, rtl) {
      const el = document.querySelector(`[data-mhd-idx="${idx}"]`);
      if (!el) return false;
      entries.get(el)?.nodes.forEach((n) => n.remove());
      const nodes = boxes.map((b) => {
        const n = document.createElement('div');
        n.textContent = b.tr;
        n.title = b.text;
        n.dir = rtl ? 'rtl' : 'ltr';
        const r = Math.min(b.w, b.h) > 0 ? 12 : 4;
        n.style.cssText = `position:absolute;left:0;top:0;display:flex;align-items:center;justify-content:center;
          text-align:center;box-sizing:border-box;padding:3px;overflow:hidden;border-radius:${r}px;
          background:${b.bg};color:${textColor(b.bg)};font:600 12px/1.2 ${FONT};pointer-events:auto;cursor:pointer;
          word-break:break-word;white-space:normal;will-change:transform;`;
        // ضغطة على الفقاعة = تشوف الأصل، ضغطة ثانية = ترجع الترجمة
        n.addEventListener('click', (ev) => {
          ev.stopPropagation(); ev.preventDefault();
          n.style.opacity = n.style.opacity === '0' ? '1' : '0';
        });
        root.appendChild(n);
        return n;
      });
      entries.set(el, { boxes, nodes, w: -1 });
      kick();
      return true;
    },
    toggle(v) {
      shown = v ?? !shown;
      root.style.display = shown ? '' : 'none';
      if (shown) { entries.forEach((e) => (e.w = -1)); kick(); }
      return shown;
    },
    clear() { entries.forEach((e) => e.nodes.forEach((n) => n.remove())); entries.clear(); },
    count() { return entries.size; },
  };
})();
