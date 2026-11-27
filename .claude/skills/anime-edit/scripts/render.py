"""Render a 9:16 character edit from still images.

usage: python3 render.py config.json WORKDIR out.mp4 [--preview]
Needs in WORKDIR: song.json (analyze_song.py), spans.json + mix.wav (voice.py).
--preview renders at half size and 15 fps for a quick look.

Config keys used here (see examples/killua.json):
  images_dir, duration, drop, drop_end
  shots: [{start, end, img, mode, focus, fy}]   before the drop
         mode: intro | pan | free | flicker | push
         focus: x centre of interest 0..1, or [from, to] for a pan; fy: y centre
  drop_images: [{img, focus, fy}]               cut on every kick from drop to drop_end
  end_image: {img, focus, fy}                   title card shot
  title: [line1, line2], subtitle
  colors: {accent, intro_tint, drop_tint, spark}
  voice.lines[].chunks, keywords, name_words    captions
  lightning: [[t, n_bolts], ...]                extra bolts (names, key words)
  flicker: [from, to]                           rapid bolts ("he became lightning")
"""
import json, subprocess, sys, os
import numpy as np
from PIL import Image, ImageFilter, ImageDraw, ImageFont, ImageEnhance

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fx  # noqa: E402

cfg = json.load(open(sys.argv[1]))
WORK = sys.argv[2]
OUT = sys.argv[3]
PREVIEW = "--preview" in sys.argv

W, H, FPS = fx.W, fx.H, (15 if PREVIEW else 30)
TOTAL = cfg["duration"]
DROP = cfg["drop"]
DROP_END = cfg["drop_end"]
IMG_DIR = cfg["images_dir"]
FONT = fx.FONT
C = cfg.get("colors", {})
ACCENT = tuple(C.get("accent", [90, 180, 255]))
INTRO_TINT = np.array(C.get("intro_tint", [110, 80, 190]), np.float32)
DROP_TINT = np.array(C.get("drop_tint", [80, 150, 255]), np.float32)
SPARK = tuple(C.get("spark", [170, 215, 255]))
fx.BLUE = ACCENT

song = json.load(open(f"{WORK}/song.json"))
spans = json.load(open(f"{WORK}/spans.json"))
KICKS = song["kicks"]

# ---------------------------------------------------------------- shot list
shots = [(s["start"], s["end"], s, s["mode"]) for s in cfg["shots"]]
drop_k = [k for k in KICKS if DROP <= k < DROP_END]
if not drop_k or drop_k[0] > DROP + 0.05:
    drop_k = [DROP] + drop_k
for i, k in enumerate(drop_k):
    end = drop_k[i + 1] if i + 1 < len(drop_k) else DROP_END
    shots.append((k, end, cfg["drop_images"][i % len(cfg["drop_images"])], "drop"))
shots.append((DROP_END, TOTAL + 1, cfg["end_image"], "end"))

cache = {}


def src(spec, mode):
    key = (spec["img"], mode)
    if key in cache:
        return cache[key]
    im = Image.open(os.path.join(IMG_DIR, spec["img"])).convert("RGB")
    s = max(W / im.width, H / im.height) * 1.12          # cover 9:16 + 12% room to move
    im = im.resize((int(im.width * s), int(im.height * s)), Image.LANCZOS)
    im = im.filter(ImageFilter.UnsharpMask(radius=3, percent=90, threshold=2))
    calm = mode in ("intro", "pan")
    hype = mode in ("drop", "flicker", "push")
    if calm:
        im = ImageEnhance.Contrast(ImageEnhance.Color(im).enhance(0.55)).enhance(1.15)
    elif hype:
        im = ImageEnhance.Contrast(ImageEnhance.Color(im).enhance(1.25)).enhance(1.2)
    a = np.asarray(im).astype(np.float32)
    if calm:
        a = a * 0.85 + INTRO_TINT * 0.15 * (a.mean(2, keepdims=True) / 255 + 0.2)
    elif hype:
        a = a * 0.88 + DROP_TINT * 0.12 * (a.mean(2, keepdims=True) / 255 + 0.3)
    cache[key] = np.clip(a, 0, 255).astype(np.uint8)
    return cache[key]


yy, xx = np.mgrid[0:H, 0:W]
VIG = (1 - 0.5 * (((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2) / 2)[..., None].astype(np.float32)


def frame_from(a, fxc, fyc, z, dx=0.0, dy=0.0):
    ih, iw = a.shape[:2]
    ch = ih / 1.12 / z
    cw = ch * W / H
    if cw > iw:                                   # very tall image: limit by width
        cw = iw / z
        ch = cw * H / W
    cx = fxc * iw + dx * iw / W
    cy = fyc * ih + dy * ih / H
    x0 = min(max(cx - cw / 2, 0), iw - cw)
    y0 = min(max(cy - ch / 2, 0), ih - ch)
    return np.asarray(Image.fromarray(a).resize((W, H), Image.BILINEAR, box=(x0, y0, x0 + cw, y0 + ch)))


def rgb_split(a, off):
    o = a.copy()
    o[:, off:, 0] = a[:, :-off, 0]
    o[:, :-off, 2] = a[:, off:, 2]
    return o


font_big = ImageFont.truetype(FONT, 120)
font_small = ImageFont.truetype(FONT, 46)


def draw_title(a, alpha):
    im = Image.fromarray(a).convert("RGBA")
    layer = Image.new("RGBA", im.size, (0, 0, 0, 0))
    A = int(255 * alpha)
    band = Image.new("L", (W, 700), 0)
    bd = ImageDraw.Draw(band)
    for i in range(700):
        bd.line((0, i, W, i), fill=int(170 * min(1, i / 300)))
    dark = Image.new("RGBA", (W, 700), (0, 0, 0, 255))
    dark.putalpha(band.point(lambda v: int(v * alpha)))
    layer.alpha_composite(dark, (0, 1220))
    d = ImageDraw.Draw(layer)
    lines = cfg.get("title", [])
    for txt, y in zip(lines, (1390, 1520)):
        f = font_big
        while d.textlength(txt, font=f) > 960:
            f = ImageFont.truetype(FONT, f.size - 6)
        w = d.textlength(txt, font=f)
        d.text(((W - w) / 2, y), txt, font=f, fill=ACCENT + (A // 3,), stroke_width=10, stroke_fill=ACCENT + (A // 4,))
        d.text(((W - w) / 2, y), txt, font=f, fill=(255, 255, 255, A))
    sub = cfg.get("subtitle", "")
    if sub:
        w = d.textlength(sub, font=font_small)
        d.text(((W - w) / 2, 1680), sub, font=font_small, fill=(200, 220, 255, A))
    bx, by = W / 2, 1300
    d.polygon([(bx + 12, by - 70), (bx - 38, by + 6), (bx - 2, by + 6), (bx - 16, by + 72), (bx + 38, by - 10),
               (bx + 2, by - 10)], fill=ACCENT + (A,))
    return np.asarray(Image.alpha_composite(im, layer).convert("RGB"))


# ---------------------------------------------------------------- overlays + captions
ev = [(DROP, 4, 7, "big"), (DROP_END, 3, 9, "big")]
for j, (t, n) in enumerate(cfg.get("lightning", [])):
    ev.append((t, n, 11 + j, "normal"))
for i, k in enumerate(drop_k[1:]):
    ev.append((k, 2, 100 + i, "normal"))
if cfg.get("flicker"):
    tt, t1 = cfg["flicker"]
    while tt < t1:
        ev.append((tt, 2, int(tt * 100), "normal"))
        tt += 0.36
LIGHT = fx.Lightning(ev)
SPARKS = fx.Sparks()
fx.KEY = set(w.upper() for w in cfg.get("keywords", []))
fx.NAME = set(w.upper() for w in cfg.get("name_words", []))
CHUNKS = fx.build_timeline([(tuple(sp), ln["chunks"]) for sp, ln in zip(spans, cfg["voice"]["lines"])])

rng = np.random.default_rng(5)
crng = np.random.default_rng(11)
nframes = int(TOTAL * FPS)
size = f"{W}x{H}"
vf = ["-vf", "scale=540:960"] if PREVIEW else []
ff = subprocess.Popen(
    ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", size, "-r", str(FPS),
     "-i", "-", "-i", f"{WORK}/mix.wav", *vf, "-c:v", "libx264", "-preset", "veryfast" if PREVIEW else "medium",
     "-crf", "19", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "256k", "-shortest", "-movflags", "+faststart", OUT],
    stdin=subprocess.PIPE)

for fi in range(nframes):
    t = fi / FPS
    s0, s1, spec, mode = next(s for s in shots if s[0] <= t < s[1])
    a = src(spec, mode)
    p = (t - s0) / (s1 - s0)
    foc = spec.get("focus", 0.5)
    if isinstance(foc, list):
        e = p * p * (3 - 2 * p)
        foc = foc[0] + (foc[1] - foc[0]) * e
    fyc = spec.get("fy", 0.5)
    z, dx, dy = 1.0, 0.0, 0.0
    if mode == "intro":
        z = 1.0 + 0.1 * p
    elif mode == "pan":
        z = 1.05
    elif mode == "free":
        z = 1.0 + 0.06 * p
    elif mode == "flicker":
        z = 1.0 + 0.12 * p
    elif mode == "push":
        z = 1.0 + 0.35 * p ** 2
        dx = rng.uniform(-1, 1) * 12 * p
        dy = rng.uniform(-1, 1) * 12 * p
    elif mode == "drop":
        z = 1.06 + 0.05 * p
        dk = t - s0
        if dk < 0.3:
            amp = 1 - dk / 0.3
            z += 0.09 * amp
            dx = rng.uniform(-1, 1) * 45 * amp
            dy = rng.uniform(-1, 1) * 45 * amp
        if DROP <= t < DROP + 1.2:
            amp = 1 - (t - DROP) / 1.2
            dx += rng.uniform(-1, 1) * 80 * amp
            dy += rng.uniform(-1, 1) * 80 * amp
    elif mode == "end":
        z = 1.02 + 0.08 * p
    f = frame_from(a, foc, fyc, z, dx, dy).astype(np.float32) * VIG
    if mode == "drop" and (t - s0) < 0.18:
        f = rgb_split(f.astype(np.uint8), int(8 + 26 * (1 - (t - s0) / 0.18))).astype(np.float32)
    if mode == "flicker" and rng.random() < 0.18:
        f = f * 0.4 + 255 * 0.6 * np.array([0.75, 0.85, 1.0], np.float32)
    flash = 0.0
    if DROP <= t < DROP + 0.6:
        flash = 1 - (t - DROP) / 0.6
    elif mode == "drop" and (t - s0) < 0.1:
        flash = 0.3 * (1 - (t - s0) / 0.1)
    elif DROP_END <= t < DROP_END + 0.575:
        flash = 0.7 * (1 - (t - DROP_END) / 0.575)
    if flash > 0:
        f = f * (1 - flash) + 255 * flash

    half = np.zeros((fx.HH, fx.HW, 3), np.float32)
    sp = LIGHT.specs(t)
    if sp:
        half += fx._draw_bolts(sp, int(t * 15))
    if mode in ("drop", "end"):
        half += SPARKS.layer(t, 0.55 if mode == "drop" else 0.4, SPARK)
    elif mode in ("flicker", "push"):
        half += SPARKS.layer(t, 0.5, SPARK)
    else:
        half += SPARKS.layer(t * 0.4, 0.08, tuple(int(c) for c in INTRO_TINT + 80))
    if mode == "push":
        half += fx.speed_lines(t, 0.25 + 0.45 * p, int(t * 15))
    f = fx.add_layer(f, half)
    f = fx.grain(f, fi)
    if t < 1.2:
        f = f * (t / 1.2)
    f = np.clip(f, 0, 255).astype(np.uint8)
    f = fx.draw_captions(f, t, CHUNKS, crng)
    if t >= DROP_END + 0.475:
        f = draw_title(f, min(1, (t - DROP_END - 0.475) / 1.0))
    if t > TOTAL - 1.5:
        f = (f.astype(np.float32) * max(0, (TOTAL - t) / 1.5)).astype(np.uint8)
    ff.stdin.write(f.tobytes())
    if fi % (FPS * 10) == 0:
        print(f"{t:5.1f}s / {TOTAL}s", flush=True)

ff.stdin.close()
ff.wait()
print("done" if ff.returncode == 0 else "ffmpeg failed", OUT)
