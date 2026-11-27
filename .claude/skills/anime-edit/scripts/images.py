"""Find, preview and download character images from wallpapers.com.

  python3 images.py find  OUTDIR --match "killua|zoldyck|gon" slug [slug ...]
                                                   # e.g. killua-zoldyck killua-4k ; pages: slug?p=3
                                                   # --match keeps only file names with these words
                                                   # (pages also list unrelated "related" images)
  python3 images.py sheet OUTDIR                   # numbered contact sheets OUTDIR/sheet_N.jpg (read them!)
  python3 images.py get   OUTDIR N [N ...]         # full-size (/images/hd/) copies -> OUTDIR/hd/N.jpg + sizes

`find` writes OUTDIR/cand.txt and thumbnails. The host must be allowed by the
session's network policy (wallpapers.com). Images are fan/official art:
for the user's private edit only, never commit them to the repo.
"""
import os, re, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
from PIL import Image, ImageDraw

UA = "Mozilla/5.0"
BASE = "https://wallpapers.com"
SKIP = re.compile(r"chibi|cute|pfp|tiktok|profile|i-love|pink|heart|kawaii|funny|comedic|lollipop|meme|happy|"
                  r"adorable|baby|kitty|pastel|sticker|minimal|quote|funko|figure", re.I)


def curl(url, out):
    return subprocess.run(["curl", "-sSL", "-A", UA, url, "-o", out], capture_output=True).returncode == 0


def find(outdir, slugs, match=None):
    os.makedirs(f"{outdir}/th", exist_ok=True)
    names = set()
    for slug in slugs:
        tmp = f"{outdir}/_page.html"
        curl(f"{BASE}/{slug}", tmp)
        html = open(tmp, errors="ignore").read()
        names |= set(re.findall(r"/images/[a-z]+/([^\"' ]+\.jpg)", html))
    names = sorted(n for n in names if not SKIP.search(n) and (not match or re.search(match, n, re.I)))
    open(f"{outdir}/cand.txt", "w").write("\n".join(names))
    with ThreadPoolExecutor(8) as ex:
        list(ex.map(lambda n: curl(f"{BASE}/images/thumbnail/{n}", f"{outdir}/th/{n}"), names))
    print(len(names), "candidates ->", f"{outdir}/cand.txt")


def sheet(outdir):
    names = [l.strip() for l in open(f"{outdir}/cand.txt") if l.strip()]
    C, R, W, H = 10, 6, 200, 150
    for s in range(0, len(names), C * R):
        sh = Image.new("RGB", (C * W, R * H), "black")
        d = ImageDraw.Draw(sh)
        for j, n in enumerate(names[s:s + C * R]):
            try:
                im = Image.open(f"{outdir}/th/{n}").convert("RGB")
            except Exception:
                continue
            im.thumbnail((W - 4, H - 18))
            x, y = (j % C) * W, (j // C) * H
            sh.paste(im, (x + 2, y + 16))
            d.text((x + 3, y + 2), str(s + j), fill="yellow")
        p = f"{outdir}/sheet_{s // (C * R)}.jpg"
        sh.save(p, quality=85)
        print(p)


def get(outdir, nums):
    names = [l.strip() for l in open(f"{outdir}/cand.txt") if l.strip()]
    os.makedirs(f"{outdir}/hd", exist_ok=True)
    for n in nums:
        p = f"{outdir}/hd/{n}.jpg"
        curl(f"{BASE}/images/hd/{names[int(n)]}", p)
        try:
            print(n, Image.open(p).size, names[int(n)][:60])
        except Exception:
            print(n, "FAILED", names[int(n)])


if __name__ == "__main__":
    cmd, outdir, *rest = sys.argv[1:]
    match = None
    if "--match" in rest:
        i = rest.index("--match")
        match = rest[i + 1]
        rest = rest[:i] + rest[i + 2:]
    {"find": lambda: find(outdir, rest, match), "sheet": lambda: sheet(outdir), "get": lambda: get(outdir, rest)}[cmd]()
