"""Motion overlays (lightning, sparks, speed lines, grain) and kinetic captions."""
import math
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 1080, 1920
HW, HH = W // 2, H // 2
FONT = "/usr/share/fonts/opentype/inter/Inter-ExtraBold.otf"
BLUE = (90, 180, 255)

# ---------------------------------------------------------------- lightning

def _bolt(p0, p1, rng, rough=0.22, depth=6):
    pts = [p0, p1]
    disp = math.dist(p0, p1) * rough
    for _ in range(depth):
        new = [pts[0]]
        for a, b in zip(pts, pts[1:]):
            mx, my = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
            dx, dy = b[0] - a[0], b[1] - a[1]
            ln = math.hypot(dx, dy) or 1
            off = rng.uniform(-disp, disp)
            new += [(mx - dy / ln * off, my + dx / ln * off), b]
        pts = new
        disp *= 0.55
    return pts


def _draw_bolts(specs, t_key):
    """specs: list of (seed, p0, p1, intensity). Returns half-res float RGB."""
    core = Image.new("L", (HW, HH), 0)
    glow = Image.new("L", (HW, HH), 0)
    dc, dg = ImageDraw.Draw(core), ImageDraw.Draw(glow)
    for seed, p0, p1, inten in specs:
        rng = np.random.default_rng(seed * 1000 + t_key)
        pts = _bolt(p0, p1, rng)
        v = int(255 * inten)
        dg.line(pts, fill=v, width=10)
        dc.line(pts, fill=v, width=2)
        # branches
        for _ in range(3):
            i = int(rng.integers(len(pts) // 4, len(pts) - 2))
            a = pts[i]
            ang = math.atan2(p1[1] - p0[1], p1[0] - p0[0]) + rng.uniform(-1.1, 1.1)
            L = rng.uniform(40, 140)
            bp = _bolt(a, (a[0] + math.cos(ang) * L, a[1] + math.sin(ang) * L), rng, 0.3, 4)
            dc.line(bp, fill=int(v * 0.7), width=1)
            dg.line(bp, fill=int(v * 0.5), width=5)
    g = np.asarray(glow.filter(ImageFilter.GaussianBlur(9)), np.float32) / 255
    c = np.asarray(core.filter(ImageFilter.GaussianBlur(0.8)), np.float32) / 255
    col = np.array(BLUE, np.float32) / 255
    return (g[..., None] * col * 1.6 + c[..., None] * np.array([1, 1, 1], np.float32) * 1.4) * 255


class Lightning:
    def __init__(self, events):
        # events: list of (t0, n_bolts, seed, style)
        self.events = events

    def specs(self, t):
        out = []
        for t0, n, seed, style in self.events:
            dt = t - t0
            dur = 0.32 if style != "big" else 0.55
            if not (0 <= dt < dur):
                continue
            flick = [1, 0.35, 1, 0.8, 0.5, 0.9, 0.3, 0.6, 0.2, 0.1][min(9, int(dt / dur * 10))]
            rng = np.random.default_rng(seed)
            for k in range(n):
                side = rng.integers(0, 3)
                if side == 0:   # top -> middle
                    p0 = (rng.uniform(0, HW), -10)
                    p1 = (rng.uniform(HW * .2, HW * .8), rng.uniform(HH * .35, HH * .7))
                elif side == 1:  # left edge
                    p0 = (-10, rng.uniform(0, HH * .6))
                    p1 = (rng.uniform(HW * .3, HW * .7), rng.uniform(HH * .3, HH * .8))
                else:            # right edge
                    p0 = (HW + 10, rng.uniform(0, HH * .6))
                    p1 = (rng.uniform(HW * .3, HW * .7), rng.uniform(HH * .3, HH * .8))
                out.append((seed * 10 + k, p0, p1, flick))
        return out


# ---------------------------------------------------------------- sparks

class Sparks:
    def __init__(self, n=140, seed=1):
        r = np.random.default_rng(seed)
        self.x = r.uniform(0, HW, n)
        self.y0 = r.uniform(0, HH, n)
        self.v = r.uniform(60, 260, n)
        self.s = r.uniform(0.7, 2.2, n)
        self.ph = r.uniform(0, 6.28, n)

    def layer(self, t, amount, color):
        im = Image.new("L", (HW, HH), 0)
        d = ImageDraw.Draw(im)
        y = (self.y0 - self.v * t) % (HH + 40) - 20
        x = self.x + 12 * np.sin(t * 2 + self.ph)
        tw = 0.5 + 0.5 * np.sin(t * 9 + self.ph * 3)
        for xi, yi, si, ti in zip(x, y, self.s, tw):
            v = int(255 * amount * (0.4 + 0.6 * ti))
            d.ellipse((xi - si, yi - si, xi + si, yi + si), fill=v)
        a = np.asarray(im.filter(ImageFilter.GaussianBlur(1.5)), np.float32) / 255
        return a[..., None] * np.array(color, np.float32) * 1.8


def speed_lines(t, amount, seed):
    im = Image.new("L", (HW, HH), 0)
    d = ImageDraw.Draw(im)
    r = np.random.default_rng(seed)
    cx, cy = HW / 2, HH * 0.42
    for _ in range(70):
        a = r.uniform(0, 2 * math.pi)
        r0 = r.uniform(190, 300)
        r1 = r0 + r.uniform(200, 600)
        w = int(r.integers(1, 4))
        d.line((cx + math.cos(a) * r0, cy + math.sin(a) * r0, cx + math.cos(a) * r1, cy + math.sin(a) * r1),
               fill=int(255 * amount * r.uniform(0.4, 1)), width=w)
    a = np.asarray(im, np.float32) / 255
    return a[..., None] * np.array([235, 245, 255], np.float32)


_grain = [np.random.default_rng(i).normal(0, 7, (H // 2, W // 2, 1)).astype(np.float32) for i in range(6)]


def grain(f, fi):
    g = _grain[fi % 6]
    g = np.repeat(np.repeat(g, 2, 0), 2, 1)
    return f + g


def add_layer(f, half):
    up = np.asarray(Image.fromarray(np.clip(half, 0, 255).astype(np.uint8)).resize((W, H), Image.BILINEAR), np.float32)
    return f + up  # additive (screen-like) blend


# ---------------------------------------------------------------- captions

# set by render.py from the config
CAP_FONT = FONT    # caption font (Arabic needs one with Arabic glyphs, e.g. Cairo 900)
RTL = False        # right-to-left captions: first word on the right
PUNCT = ".,،…!؟?"
KEY = set()        # words drawn big, blue, with a shake
NAME = set()       # words drawn extra big (the character's name)


def build_timeline(lines):
    """lines: [((speech_start, speech_end), [chunk, ...]), ...].
    Returns chunks: dict(start, end, words=[(word, t_word)]). Word times are
    spread over the measured speech span by word length (approximate)."""
    chunks = []
    for (s, e), cks in lines:
        words = [w for c in cks for w in c.split()]
        weights = [len(w) + 1.5 for w in words]
        tot = sum(weights)
        times, acc = [], 0
        for wgt in weights:
            times.append(s + (e - s) * acc / tot)
            acc += wgt
        k = 0
        line_chunks = []
        for c in cks:
            ws = c.split()
            line_chunks.append({"words": [(w.strip(PUNCT), times[k + i]) for i, w in enumerate(ws)], "start": times[k]})
            k += len(ws)
        for i, ch in enumerate(line_chunks):
            ch["end"] = line_chunks[i + 1]["start"] if i + 1 < len(line_chunks) else e + 0.45
        chunks += line_chunks
    return chunks


_font_cache = {}
def _font(sz):
    if sz not in _font_cache:
        _font_cache[sz] = ImageFont.truetype(CAP_FONT, sz)
    return _font_cache[sz]


_word_cache = {}
def word_img(word, key, size):
    ck = (word, key, size)
    if ck in _word_cache:
        return _word_cache[ck]
    f = _font(size)
    tmp = ImageDraw.Draw(Image.new("L", (1, 1)))
    l, tp, r, b = tmp.textbbox((0, 0), word, font=f, stroke_width=8)
    pad = 40
    w, h = r - l + pad * 2, b - tp + pad * 2
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    # glow
    g = Image.new("L", (w, h), 0)
    ImageDraw.Draw(g).text((pad - l, pad - tp), word, font=f, fill=255, stroke_width=8, stroke_fill=255)
    g = g.filter(ImageFilter.GaussianBlur(14))
    gc = BLUE if key else (0, 0, 0)
    ga = 0.9 if key else 0.75
    glow = Image.new("RGBA", (w, h), gc + (0,))
    glow.putalpha(g.point(lambda v: int(v * ga)))
    im = Image.alpha_composite(im, glow)
    d = ImageDraw.Draw(im)
    if key:
        # vertical gradient fill: white -> electric blue
        mask = Image.new("L", (w, h), 0)
        ImageDraw.Draw(mask).text((pad - l, pad - tp), word, font=f, fill=255)
        grad = np.zeros((h, w, 4), np.uint8)
        yy = np.linspace(0, 1, h)[:, None]
        top, bot = np.array([255, 255, 255]), np.array(BLUE) * 0.85
        grad[..., :3] = (top * (1 - yy[..., None]) + bot * yy[..., None]).astype(np.uint8) * np.ones((1, w, 1), np.uint8)
        grad[..., 3] = np.asarray(mask)
        d.text((pad - l, pad - tp), word, font=f, fill=(0, 0, 0, 0), stroke_width=7, stroke_fill=(10, 20, 45, 255))
        im = Image.alpha_composite(im, Image.fromarray(grad, "RGBA"))
    else:
        d.text((pad - l, pad - tp), word, font=f, fill=(255, 255, 255, 255), stroke_width=7, stroke_fill=(0, 0, 0, 255))
    _word_cache[ck] = (im, pad)
    return _word_cache[ck]


CAP_Y = 1360


def draw_captions(frame, t, chunks, rng):
    act = [c for c in chunks if c["start"] - 0.02 <= t < c["end"]]
    if not act:
        return frame
    c = act[0]
    words = c["words"]
    is_name = words[0][0] in NAME
    keys = [w in KEY for w, _ in words]
    base = [150 if is_name else (122 if k else 92) for k in keys]
    imgs = [word_img(w, k, s) for (w, _), k, s in zip(words, keys, base)]
    space = 26
    widths = [im.width - 2 * pad for im, pad in imgs]
    total = sum(widths) + space * (len(words) - 1)
    shrink = min(1.0, 860 / total)
    x = (W - total * shrink) / 2
    if RTL:
        x = (W + total * shrink) / 2
    out = Image.fromarray(frame).convert("RGBA")
    exit_p = max(0.0, (t - (c["end"] - 0.1)) / 0.1)
    for (w, tw), k, (im, pad), wd in zip(words, keys, imgs, widths):
        dt = t - tw
        if RTL:
            cx = x - wd * shrink / 2
            x -= (wd + space) * shrink
        else:
            cx = x + wd * shrink / 2
            x += (wd + space) * shrink
        if dt < -0.01:
            continue
        # pop-in with overshoot
        p = min(1.0, max(0.0, dt / 0.14))
        sc = 1.25 - 0.25 * (1 - (1 - p) ** 3) + (0.08 * math.sin(p * math.pi) if p < 1 else 0)
        alpha = min(1.0, dt / 0.06) * (1 - exit_p)
        sc *= shrink * (1 - 0.15 * exit_p)
        jx = jy = 0
        if k and dt < 0.25:
            amp = (1 - dt / 0.25) * 10
            jx, jy = rng.uniform(-amp, amp), rng.uniform(-amp, amp)
        rw, rh = max(1, int(im.width * sc)), max(1, int(im.height * sc))
        wi = im.resize((rw, rh), Image.BILINEAR)
        if alpha < 1:
            a = wi.getchannel("A").point(lambda v: int(v * alpha))
            wi.putalpha(a)
        cy = CAP_Y - (40 if is_name else 0) + (-60 * (1 - (1 - p) ** 2) * 0 )
        out.alpha_composite(wi, (int(cx - rw / 2 + jx), int(cy - rh / 2 + jy)))
    return np.asarray(out.convert("RGB"))
