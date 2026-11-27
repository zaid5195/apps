"""Style 2 - "forms ladder": no narrator, no captions. Manga-panel intro, a ladder
of the character's forms (huge name BEHIND the cut-out character + aura), a
"SAY MY NAME"-style title card in the silence, then a 2.5D parallax drop with
anime impact frames and a scrolling marquee behind the subject.

usage: python3 render_forms.py config.json WORKDIR out.mp4 [--preview]
Needs: masks from cutouts.py (WORKDIR/img/cut/<id>_mask.png), song kicks
(analyze_song.py --from <song_start> ...). See examples/goku_forms.json.
"""
import json, math, os, subprocess, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fx  # noqa: E402

cfg = json.load(open(sys.argv[1]))
WORK, OUT = sys.argv[2], sys.argv[3]
PREVIEW = "--preview" in sys.argv
W, H = fx.W, fx.H
FPS = 15 if PREVIEW else 30
CW, CH = int(W * 1.12), int(H * 1.12)
IMG, CUT = cfg["images_dir"], cfg["masks_dir"]
FONT = fx.FONT
T0 = cfg["song_start"]
TOTAL = cfg["duration"]
song = json.load(open(f"{WORK}/song.json"))
KICKS = [k - T0 for k in song["kicks"]]
rng = np.random.default_rng(3)


def font(sz):
    return ImageFont.truetype(FONT, sz)


# ------------------------------------------------------------------ image + mask loading
_img = {}


def load(i):
    if i not in _img:
        im = Image.open(f"{IMG}/{i}.jpg").convert("RGB")
        mp = f"{CUT}/{i}_mask.png"
        m = Image.open(mp).convert("L").resize(im.size, Image.BILINEAR) if os.path.exists(mp) else None
        _img[i] = (im, m)
    return _img[i]


_cover = {}


def cover(i, focus=0.5, fy=0.5, blur_bg=0):
    """9:16 crop around focus scaled to CW x CH. Returns (rgb uint8, mask float or None, bg-blurred rgb)."""
    key = (i, focus, fy, blur_bg)
    if key in _cover:
        return _cover[key]
    im, m = load(i)
    iw, ih = im.size
    ch = ih
    cw = ch * 9 / 16
    if cw > iw:
        cw, ch = iw, iw * 16 / 9
    x0 = min(max(focus * iw - cw / 2, 0), iw - cw)
    y0 = min(max(fy * ih - ch / 2, 0), ih - ch)
    box = (x0, y0, x0 + cw, y0 + ch)
    rgb = im.resize((CW, CH), Image.LANCZOS, box=box)
    mk = m.resize((CW, CH), Image.BILINEAR, box=box) if m is not None else None
    bg = rgb.filter(ImageFilter.GaussianBlur(blur_bg)) if blur_bg else rgb
    out = (np.asarray(rgb), None if mk is None else np.asarray(mk, np.float32) / 255, np.asarray(bg))
    _cover[key] = out
    return out


def view(a, z, dx=0.0, dy=0.0):
    """Zoom z (>=1) into a CW x CH array, shifted by dx,dy output pixels -> W x H."""
    h, w = a.shape[:2]
    ch, cw = h / 1.12 / z, w / 1.12 / z
    x0 = min(max((w - cw) / 2 + dx * cw / W, 0), w - cw)
    y0 = min(max((h - ch) / 2 + dy * ch / H, 0), h - ch)
    mode = "L" if a.ndim == 2 else "RGB"
    src = Image.fromarray(a if a.dtype == np.uint8 else (np.clip(a, 0, 1) * 255).astype(np.uint8), mode)
    out = np.asarray(src.resize((W, H), Image.BILINEAR, box=(x0, y0, x0 + cw, y0 + ch)))
    return out if a.dtype == np.uint8 else out.astype(np.float32) / 255


def rgb_split(a, off):
    o = a.copy()
    o[:, off:, 0] = a[:, :-off, 0]
    o[:, :-off, 2] = a[:, off:, 2]
    return o


# ------------------------------------------------------------------ 1. manga intro
PAPER = np.array([244, 240, 232], np.float32)
PANELS = [[(0, 0), (W, 0), (W, 560), (0, 700)],
          [(0, 730), (W, 590), (W, 1250), (0, 1330)],
          [(0, 1360), (W, 1280), (W, H), (0, H)]]


def halftone(rgb, period=7):
    g = np.asarray(ImageOps.autocontrast(rgb.convert("L"), cutoff=1), np.float32) / 255
    yy, xx = np.mgrid[0:g.shape[0], 0:g.shape[1]]
    a = math.radians(45)
    u = (xx * math.cos(a) + yy * math.sin(a)) * 2 * math.pi / period
    v = (-xx * math.sin(a) + yy * math.cos(a)) * 2 * math.pi / period
    dots = 0.5 + 0.25 * (np.cos(u) + np.cos(v))
    ink = np.where(g < 0.16, 0.0, np.where(g > 0.86, 1.0, (g > dots).astype(np.float32)))
    edges = np.asarray(rgb.convert("L").filter(ImageFilter.FIND_EDGES), np.float32) / 255
    ink = np.clip(ink - (edges > 0.25) * 1.0, 0, 1)
    return (PAPER * ink[..., None]).astype(np.uint8)


_panel = {}


def panel_layer(slot, spec):
    key = (slot, spec["img"])
    if key in _panel:
        return _panel[key]
    poly = PANELS[slot]
    xs, ys = [p[0] for p in poly], [p[1] for p in poly]
    bw, bh = max(xs) - min(xs), max(ys) - min(ys)
    im, _ = load(spec["img"])
    iw, ih = im.size
    s = max(bw * 1.08 / iw, bh * 1.08 / ih)
    rim = im.resize((int(iw * s), int(ih * s)), Image.LANCZOS)
    fx_, fy_ = spec.get("focus", 0.5), spec.get("fy", 0.5)
    x0 = int(min(max(fx_ * rim.width - bw / 2, 0), rim.width - bw))
    y0 = int(min(max(fy_ * rim.height - bh / 2, 0), rim.height - bh))
    tile = Image.fromarray(halftone(rim.crop((x0, y0, x0 + bw, y0 + bh))))
    mask = Image.new("L", (bw, bh), 0)
    local = [(x - min(xs), y - min(ys)) for x, y in poly]
    ImageDraw.Draw(mask).polygon(local, fill=255)
    layer = Image.new("RGBA", (bw, bh), (0, 0, 0, 0))
    layer.paste(tile, (0, 0), mask)
    ImageDraw.Draw(layer).line(local + [local[0]], fill=(10, 10, 10, 255), width=10)
    _panel[key] = (layer, (min(xs), min(ys)))
    return _panel[key]


def ease(p):
    p = min(1, max(0, p))
    return 1 - (1 - p) ** 3


def manga_frame(t, pages):
    page = Image.new("RGB", (W, H), tuple(int(c) for c in PAPER))
    for pg in pages:
        if not (pg["start"] <= t < pg["end"]):
            continue
        for slot, spec in enumerate(pg["panels"]):
            ti = pg["start"] + spec["at"]
            if t < ti:
                continue
            layer, (px, py) = panel_layer(slot, spec)
            p = ease((t - ti) / 0.35)
            side = -1 if slot % 2 == 0 else 1
            off = int(side * (1 - p) * (W + 60))
            page.paste(layer, (px + off, py), layer)
            if t - ti < 0.08:                     # landing thud
                page = Image.fromarray(np.roll(np.asarray(page), int(rng.integers(-14, 14)), axis=0))
        a = np.asarray(page).astype(np.float32)
        if t > pg["end"] - pg.get("exit", 0):     # push into the page and burn to white
            p = (t - (pg["end"] - pg["exit"])) / pg["exit"]
            a = view(np.asarray(Image.fromarray(a.astype(np.uint8)).resize((CW, CH))), 1 + 0.7 * p ** 2).astype(np.float32)
            a = a * (1 - p ** 2) + 255 * p ** 2
        return a
    return np.asarray(page).astype(np.float32)


# ------------------------------------------------------------------ 2. forms ladder
_subj = {}


def subject(spec):
    """Cut-out RGBA of the character, scaled to fit the frame, anchored bottom-center."""
    key = spec["img"]
    if key in _subj:
        return _subj[key]
    im, m = load(spec["img"])
    bb = Image.fromarray((np.asarray(m) > 128).astype(np.uint8) * 255).getbbox()
    rgba = im.copy()
    rgba.putalpha(m)
    rgba = rgba.crop(bb)
    s = min(spec.get("height", 1500) / rgba.height, spec.get("width", 1040) / rgba.width)
    rgba = rgba.resize((int(rgba.width * s), int(rgba.height * s)), Image.LANCZOS)
    a = rgba.getchannel("A")
    aura = a.filter(ImageFilter.MaxFilter(21)).filter(ImageFilter.GaussianBlur(28))
    _subj[key] = (rgba, aura)
    return _subj[key]


def big_word_layer(lines, color, y_center, max_w=1040, outline=False, alpha=255):
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    sizes = []
    for ln in lines:
        sz = 420
        while d.textlength(ln, font=font(sz)) > max_w and sz > 60:
            sz -= 8
        sizes.append(sz)
    total = sum(int(s * 0.86) for s in sizes)
    y = y_center - total / 2
    for ln, sz in zip(lines, sizes):
        f = font(sz)
        w = d.textlength(ln, font=f)
        if outline:
            d.text(((W - w) / 2, y - sz * 0.2), ln, font=f, fill=(0, 0, 0, 0), stroke_width=4, stroke_fill=color + (alpha,))
        else:
            d.text(((W - w) / 2, y - sz * 0.2), ln, font=f, fill=color + (alpha,), stroke_width=6, stroke_fill=(12, 12, 16, alpha))
        y += int(sz * 0.86)
    return layer


_bg = {}


def form_bg(color):
    if color in _bg:
        return _bg[color]
    yy, xx = np.mgrid[0:H, 0:W]
    r = np.sqrt(((xx - W / 2) / W) ** 2 + ((yy - H * 0.45) / H) ** 2)
    glow = np.clip(1 - r * 1.6, 0, 1) ** 2
    base = np.array([10, 10, 16], np.float32)
    a = base + glow[..., None] * np.array(color, np.float32) * 0.55
    # faint halftone dots in the colour
    dots = (np.cos(xx * 0.45) + np.cos(yy * 0.45)) > 1.2
    a += dots[..., None] * np.array(color, np.float32) * 0.06
    _bg[color] = a.astype(np.float32)
    return _bg[color]


def form_frame(t, f, idx, n_forms):
    s0, color = f["start"], tuple(f["color"])
    dt = t - s0
    a = form_bg(color).copy()
    half = fx.speed_lines(t, 0.35, int(t * 15)) * (np.array(color, np.float32) / 255)
    a = fx.add_layer(a, half)
    im = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).convert("RGBA")
    # huge form name behind
    tz = 1 + 0.6 * max(0, 1 - dt / 0.14) ** 2
    word = big_word_layer(f["name"], color, f.get("text_y", 760))
    if tz > 1.001:
        word = word.resize((int(W * tz), int(H * tz)), Image.BILINEAR).crop(
            (int((W * tz - W) / 2), int((H * tz - H) / 2), int((W * tz - W) / 2) + W, int((H * tz - H) / 2) + H))
    im.alpha_composite(word)
    # aura
    rgba, aura = subject(f)
    sz = 1 + 0.22 * max(0, 1 - dt / 0.2) ** 2
    sw, sh = int(rgba.width * sz), int(rgba.height * sz)
    x = (W - sw) // 2 + int(rng.uniform(-1, 1) * 18 * max(0, 1 - dt / 0.3))
    y = H - sh + int(f.get("y_offset", 0))
    flick = 0.75 + 0.25 * math.sin(t * 31) + rng.uniform(-0.1, 0.1)
    au = aura.resize((sw, sh), Image.BILINEAR).point(lambda v: int(min(255, v * flick)))
    glow = Image.new("RGBA", (sw, sh), color + (0,))
    glow.putalpha(au)
    im.alpha_composite(glow, (x, y))
    im.alpha_composite(glow, (x, y))
    im.alpha_composite(rgba.resize((sw, sh), Image.BILINEAR), (x, y))
    # HUD: form counter + power bar
    d = ImageDraw.Draw(im)
    fs = font(40)
    d.text((70, 120), f"FORM {idx + 1:02d}/{n_forms:02d}", font=fs, fill=(255, 255, 255, 230))
    for k in range(n_forms):
        x0 = 70 + k * 64
        on = k <= idx
        d.rectangle((x0, 180, x0 + 52, 196), fill=(color + (255,)) if on else (255, 255, 255, 60))
    out = np.asarray(im.convert("RGB")).astype(np.float32)
    if dt < 0.1:
        out = out * (1 - (1 - dt / 0.1) * 0.8) + 255 * (1 - dt / 0.1) * 0.8
    out = fx.add_layer(out, fx.Sparks(90, idx).layer(t, 0.5, tuple(min(255, c + 60) for c in color)))
    return out


# ------------------------------------------------------------------ 3. title card in the silence
def title_frame(t, tc):
    a = np.zeros((H, W, 3), np.float32)
    dt = t - tc["start"]
    if "eyes" in tc:
        rgb, _, _ = cover(tc["eyes"]["img"], tc["eyes"].get("focus", 0.5), tc["eyes"].get("fy", 0.5))
        g = view(rgb, 1.0 + 0.08 * dt / (tc["end"] - tc["start"])).astype(np.float32).mean(2, keepdims=True)
        op = min(1, dt / (tc["end"] - tc["start"])) * 0.55
        a += g * np.array([1.0, 0.25, 0.3], np.float32) * op
    im = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).convert("RGBA")
    d = ImageDraw.Draw(im)
    ys = [700, 930, 1160]
    for (word, at), y in zip(tc["words"], ys):
        wd = t - (tc["start"] + at)
        if wd < 0:
            continue
        sz = int(230 * (1 + 0.5 * max(0, 1 - wd / 0.1) ** 2))
        f = font(sz)
        w = d.textlength(word, font=f)
        jx = rng.uniform(-8, 8) * max(0, 1 - wd / 0.25)
        d.text(((W - w) / 2 + jx, y - sz / 2 + 20), word, font=f, fill=(255, 255, 255, 255))
    out = np.asarray(im.convert("RGB")).astype(np.float32)
    if t > tc["end"] - 0.25:                      # pull into the drop
        p = (t - (tc["end"] - 0.25)) / 0.25
        out = view(np.asarray(Image.fromarray(out.astype(np.uint8)).resize((CW, CH))), 1 + 0.8 * p ** 2).astype(np.float32)
    return out


# ------------------------------------------------------------------ 4. drop
def impact(mask_w, inverse=False):
    """Anime impact frame: white silhouette on black (or black on red) + radial streaks."""
    m = mask_w[..., None]
    if inverse:
        bg = np.array([200, 10, 30], np.float32)
        a = bg * (1 - m)
    else:
        a = 255 * m * np.ones(3, np.float32)
    half = fx.speed_lines(0, 0.9, int(rng.integers(0, 1e6)))
    return fx.add_layer(a, half * (0.4 if inverse else 1.0))


_marq = {}


def marquee(text, color):
    if text not in _marq:
        f = font(330)
        tmp = ImageDraw.Draw(Image.new("L", (1, 1)))
        unit = text + "  ·  "
        w = int(tmp.textlength(unit, font=f))
        strip = Image.new("RGBA", (w * 3, 400), (0, 0, 0, 0))
        d = ImageDraw.Draw(strip)
        for k in range(3):
            d.text((k * w, 0), unit, font=f, fill=color + (70,), stroke_width=8, stroke_fill=color + (245,))
        _marq[text] = (strip, w)
    return _marq[text]


def drop_frame(t, s0, s1, spec, k_index, dcfg):
    p = (t - s0) / max(0.05, s1 - s0)
    dt = t - s0
    rgb, m, bgb = cover(spec["img"], spec.get("focus", 0.5), spec.get("fy", 0.5), blur_bg=4 if spec.get("cut") else 0)
    punch = max(0, 1 - dt / 0.22) ** 2
    dx = rng.uniform(-1, 1) * 40 * punch
    dy = rng.uniform(-1, 1) * 40 * punch
    if spec.get("cut") and m is not None:
        bgv = view(bgb, 1.02 + 0.04 * p, dx * 0.5, dy * 0.5).astype(np.float32) * 0.8
        zs = 1.06 + 0.12 * p + 0.06 * punch
        sv = view(rgb, zs, dx * 1.4, dy * 1.4).astype(np.float32)
        mv = view(m, zs, dx * 1.4, dy * 1.4)[..., None]
        a = bgv
        if spec.get("marquee"):
            strip, w = marquee(dcfg["marquee"], tuple(spec.get("color", [255, 255, 255])))
            off = int((t * 900) % w)
            off2 = (w - off) % w                  # second row scrolls the other way
            layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
            layer.alpha_composite(strip.crop((off, 0, off + W, 400)), (0, int(H * 0.30)))
            layer.alpha_composite(strip.crop((off2, 0, off2 + W, 400)), (0, int(H * 0.55)))
            la = np.asarray(layer).astype(np.float32)
            al = la[..., 3:4] / 255
            a = a * (1 - al) + la[..., :3] * al
        a = a * (1 - mv) + sv * mv
    else:
        a = view(rgb, 1.06 + 0.1 * p + 0.06 * punch, dx, dy).astype(np.float32)
    if dt < 0.12:
        a = rgb_split(np.clip(a, 0, 255).astype(np.uint8), int(6 + 26 * (1 - dt / 0.12))).astype(np.float32)
    if dt < 0.08:
        a = a * 0.6 + 255 * 0.4 * (1 - dt / 0.08)
    a = fx.add_layer(a, fx.Sparks(120, 7).layer(t, 0.45, (255, 230, 200)))
    return a


# ------------------------------------------------------------------ 5. end card
def end_frame(t, e):
    dt = t - e["start"]
    a = form_bg(tuple(e["color"])).copy() * 0.8
    im = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).convert("RGBA")
    p = ease(dt / 0.8)
    word = big_word_layer(e["name"], tuple(e["color"]), e.get("text_y", 720), alpha=int(255 * p))
    im.alpha_composite(word)
    rgba, aura = subject(e)
    rise = int((1 - p) * 220)
    x = (W - rgba.width) // 2
    y = H - rgba.height + rise
    glow = Image.new("RGBA", rgba.size, tuple(e["color"]) + (0,))
    glow.putalpha(aura.point(lambda v: int(v * (0.7 + 0.2 * math.sin(t * 9)))))
    im.alpha_composite(glow, (x, y))
    im.alpha_composite(rgba, (x, y))
    d = ImageDraw.Draw(im)
    if e.get("tag") and dt > 0.6:
        f = font(54)
        w = d.textlength(e["tag"], font=f)
        d.text(((W - w) / 2, 250), e["tag"], font=f, fill=(255, 255, 255, int(255 * min(1, (dt - 0.6) / 0.4))))
    out = np.asarray(im.convert("RGB")).astype(np.float32)
    out = fx.add_layer(out, fx.Sparks(120, 3).layer(t, 0.5, (230, 235, 255)))
    return out


# ------------------------------------------------------------------ timeline
intro, forms, tc, drop, end = cfg["intro"], cfg["forms"], cfg["title_card"], cfg["drop"], cfg["end"]
dk = [k for k in KICKS if drop["start"] <= k < drop["end"]]
if not dk or dk[0] > drop["start"] + 0.05:
    dk = [drop["start"]] + dk
dk = [k for i, k in enumerate(dk) if i == 0 or k - dk[i - 1] >= drop.get("min_gap", 0.3)]
dshots = []
for i, k in enumerate(dk):
    s1 = dk[i + 1] if i + 1 < len(dk) else drop["end"]
    dshots.append((k, s1, drop["images"][i % len(drop["images"])], i))

nframes = int(TOTAL * FPS)
vf = ["-vf", "scale=540:960"] if PREVIEW else []
afilter = f"afade=t=in:d=0.4,afade=t=out:st={TOTAL - 1.5}:d=1.5"
ff = subprocess.Popen(
    ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS),
     "-i", "-", "-ss", str(T0), "-t", str(TOTAL), "-i", cfg["song"], *vf, "-af", afilter,
     "-c:v", "libx264", "-preset", "veryfast" if PREVIEW else "medium", "-crf", "19", "-pix_fmt", "yuv420p",
     "-c:a", "aac", "-b:a", "256k", "-shortest", "-movflags", "+faststart", OUT], stdin=subprocess.PIPE)

for fi in range(nframes):
    t = fi / FPS
    if t < intro["end"]:
        a = manga_frame(t, intro["pages"])
    elif t < forms[-1]["end"]:
        idx = max(i for i, f in enumerate(forms) if f["start"] <= t)
        a = form_frame(t, forms[idx], idx, len(forms))
    elif t < tc["end"]:
        a = title_frame(t, tc)
    elif t < drop["end"]:
        s0, s1, spec, i = next(s for s in dshots if s[0] <= t < s[1]) if t >= dshots[0][0] else dshots[0]
        every = drop.get("impact_every", 8)
        dt = t - s0
        if (i % every == 0) and dt < 0.1 and spec.get("cut"):
            _, m, _ = cover(spec["img"], spec.get("focus", 0.5), spec.get("fy", 0.5))
            a = impact(view(m, 1.08), inverse=dt >= 0.05)
        else:
            a = drop_frame(t, s0, s1, spec, i, drop)
    else:
        a = end_frame(t, end)
    a = fx.grain(a, fi)
    if t > TOTAL - 1.2:
        a = a * max(0, (TOTAL - t) / 1.2)
    ff.stdin.write(np.clip(a, 0, 255).astype(np.uint8).tobytes())
    if fi % (FPS * 5) == 0:
        print(f"{t:5.1f}s / {TOTAL}s", flush=True)

ff.stdin.close()
ff.wait()
print("done" if ff.returncode == 0 else "ffmpeg failed", OUT)
