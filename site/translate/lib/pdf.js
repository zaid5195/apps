// منشئ PDF بسيط: كل صورة في صفحة بنفس مقاسها
const MAX_PT = 14400; // أقصى مقاس صفحة في PDF

function isJpeg(b) { return b[0] === 0xff && b[1] === 0xd8; }

// عدد قنوات الألوان في JPEG (نضمن RGB فقط، غيرها نعيد ترميزه)
function jpegComponents(b) {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return b[i + 9];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    i += 2 + ((b[i + 2] << 8) | b[i + 3]);
  }
  return 0;
}

async function toJpeg(bytes, mime) {
  const bmp = await createImageBitmap(new Blob([bytes], { type: mime || '' }));
  const w = bmp.width, h = bmp.height;
  if (isJpeg(bytes) && jpegComponents(bytes) === 3) { bmp.close(); return { data: bytes, w, h }; }
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  return { data: new Uint8Array(await blob.arrayBuffer()), w, h };
}

export async function makePdf(images, onProgress) {
  // images: [{ data: Uint8Array, mime }]
  const enc = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let pos = 0;
  const push = (x) => { const u = typeof x === 'string' ? enc.encode(x) : x; chunks.push(u); pos += u.length; };
  const obj = (id, body) => { offsets[id] = pos; push(`${id} 0 obj\n`); body(); push('\nendobj\n'); };

  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const n = images.length;
  // 1: catalog, 2: pages, then for each page i: page=3+3i, content=4+3i, image=5+3i
  const pageIds = images.map((_, i) => 3 + i * 3);

  for (let i = 0; i < n; i++) {
    const { data, w, h } = await toJpeg(images[i].data, images[i].mime);
    let pw = w, ph = h;
    const s = Math.min(1, MAX_PT / Math.max(pw, ph));
    pw = +(pw * s).toFixed(2); ph = +(ph * s).toFixed(2);
    const pid = 3 + i * 3, cid = pid + 1, iid = pid + 2;
    obj(pid, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im${i} ${iid} 0 R >> >> /Contents ${cid} 0 R >>`));
    const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im${i} Do Q`;
    obj(cid, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
    obj(iid, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${data.length} >>\nstream\n`);
      push(data);
      push('\nendstream');
    });
    onProgress?.(i + 1, n);
  }
  obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => push(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${n} >>`));

  const total = 3 + n * 3;
  const xref = pos;
  let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) x += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  push(x);
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  return new Blob(chunks, { type: 'application/pdf' });
}
