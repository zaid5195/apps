"""Find usable moments in anime clips the user sends (screen recordings, episodes).

  python3 clips.py scenes VIDEO OUTDIR [--thr 0.3]
      Detects hard cuts, measures motion per scene, writes OUTDIR/scenes.json and
      numbered contact sheets OUTDIR/scenes_N.jpg (index, start time, length, motion).
      Read the sheets, then use a scene in the config as
      {"video": "<file>", "from": <start + offset>, "speed": 1.0, "focus": 0.5}
  python3 clips.py probe VIDEO            # size, fps, duration

We never download episodes or clips: the user records or cuts them and sends them.
Screen recordings often include phone UI (status bar, subtitles, black bars):
check the sheet and use "fy"/"focus" or pick another moment.
"""
import json, os, re, subprocess, sys
import numpy as np
from PIL import Image, ImageDraw


def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                          "stream=width,height,r_frame_rate:format=duration", "-of", "json", path],
                         capture_output=True, text=True).stdout
    d = json.loads(out)
    st = d["streams"][0]
    n, m = st["r_frame_rate"].split("/")
    return {"width": st["width"], "height": st["height"], "fps": round(int(n) / int(m), 3),
            "duration": float(d["format"]["duration"])}


def cuts(path, thr):
    r = subprocess.run(["ffmpeg", "-i", path, "-an", "-vf", f"select='gt(scene,{thr})',showinfo", "-f", "null", "-"],
                       capture_output=True, text=True)
    return [float(x) for x in re.findall(r"pts_time:([0-9.]+)", r.stderr)]


def motion(path, start, end, fps=6):
    """Mean frame-to-frame change (0..255) on a small grey version of the scene."""
    r = subprocess.run(["ffmpeg", "-loglevel", "error", "-ss", str(start), "-t", str(max(0.2, end - start)), "-i", path,
                        "-an", "-vf", f"fps={fps},scale=96:54,format=gray", "-f", "rawvideo", "-"], capture_output=True)
    a = np.frombuffer(r.stdout, np.uint8)
    if len(a) < 2 * 96 * 54:
        return 0.0
    a = a[: len(a) // (96 * 54) * 96 * 54].reshape(-1, 54, 96).astype(np.float32)
    return float(np.abs(np.diff(a, axis=0)).mean())


def thumb(path, t, w=192):
    r = subprocess.run(["ffmpeg", "-loglevel", "error", "-ss", str(t), "-i", path, "-frames:v", "1",
                        "-vf", f"scale={w}:-2", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True)
    info = probe(path)
    h = int(round(info["height"] * w / info["width"] / 2)) * 2
    if len(r.stdout) < w * h * 3:
        return Image.new("RGB", (w, h))
    return Image.frombuffer("RGB", (w, h), r.stdout[: w * h * 3])


def scenes(path, outdir, thr=0.3):
    os.makedirs(outdir, exist_ok=True)
    info = probe(path)
    cs = [0.0] + [c for c in cuts(path, thr) if c > 0.2] + [info["duration"]]
    sc = []
    for a, b in zip(cs, cs[1:]):
        if b - a < 0.4:          # flashes / very short cuts
            continue
        sc.append({"i": len(sc), "start": round(a, 2), "end": round(b, 2), "len": round(b - a, 2),
                   "motion": round(motion(path, a, b), 2)})
    json.dump({"video": os.path.basename(path), **info, "scenes": sc}, open(f"{outdir}/scenes.json", "w"), indent=1)
    C, R, TW = 6, 6, 192
    TH = int(round(info["height"] * TW / info["width"] / 2)) * 2
    mx = max([s["motion"] for s in sc] or [1]) or 1
    for p in range(0, len(sc), C * R):
        page = sc[p:p + C * R]
        sh = Image.new("RGB", (C * (TW + 8), ((len(page) - 1) // C + 1) * (TH + 30)), "black")
        d = ImageDraw.Draw(sh)
        for j, s in enumerate(page):
            x, y = (j % C) * (TW + 8), (j // C) * (TH + 30)
            sh.paste(thumb(path, (s["start"] + s["end"]) / 2, TW), (x, y + 26))
            d.text((x + 2, y + 2), f"{s['i']}  {s['start']:.1f}s  {s['len']:.1f}s", fill="yellow")
            d.rectangle((x + 2, y + 16, x + 2 + int((TW - 4) * s["motion"] / mx), y + 22), fill=(255, 90, 90))
        sh.save(f"{outdir}/scenes_{p // (C * R)}.jpg", quality=85)
        print(f"{outdir}/scenes_{p // (C * R)}.jpg")
    top = sorted(sc, key=lambda s: -s["motion"])[:10]
    print(f"{len(sc)} scenes, {info['duration']:.1f}s {info['width']}x{info['height']}. Most action:",
          ", ".join(f"#{s['i']}@{s['start']}s" for s in top))


if __name__ == "__main__":
    cmd, path, *rest = sys.argv[1:]
    if cmd == "probe":
        print(probe(path))
    else:
        thr = float(rest[rest.index("--thr") + 1]) if "--thr" in rest else 0.3
        scenes(path, rest[0], thr)
