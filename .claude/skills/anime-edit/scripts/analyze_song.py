"""Analyse a song for an edit: energy map, tempo, drop and kick times.

usage: python3 analyze_song.py song.m4a [--from SEC] [--to SEC] > song.json
Prints a readable energy map on stderr and JSON on stdout:
  {"duration", "bpm", "drop", "kicks": [...], "energy": [[t, level], ...]}
"""
import json, subprocess, sys, tempfile, wave, os
import numpy as np

SR, HOP, WIN = 22050, 256, 1024


def load(path):
    tmp = tempfile.mktemp(suffix=".wav")
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", path, "-ac", "1", "-ar", str(SR), tmp], check=True)
    w = wave.open(tmp)
    a = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
    os.remove(tmp)
    return a


def main():
    path = sys.argv[1]
    args = sys.argv[2:]
    t_from = float(args[args.index("--from") + 1]) if "--from" in args else 0.0
    t_to = float(args[args.index("--to") + 1]) if "--to" in args else None
    a = load(path)
    dur = len(a) / SR
    t_to = min(t_to or dur, dur)
    fps = SR / HOP

    fr = np.lib.stride_tricks.sliding_window_view(a, WIN)[::HOP] * np.hanning(WIN)
    S = np.abs(np.fft.rfft(fr, axis=1))
    rms = np.sqrt((fr ** 2).mean(1))
    low = np.log1p(S[:, 1:10].sum(1))                       # < ~200 Hz: kicks / 808
    flux = np.maximum(0, np.diff(np.log1p(S), axis=0)).sum(1)

    # energy map (0.5 s bins)
    step = int(0.5 * fps)
    energy = [[round(i / fps, 2), float(rms[i:i + step].mean())] for i in range(0, len(rms), step)]
    mx = max(e for _, e in energy) or 1
    for t, e in energy:
        if t_from <= t <= t_to:
            print(f"{t:6.1f}s " + "#" * int(60 * e / mx), file=sys.stderr)

    # drop = biggest rise of 4 s average energy vs previous 4 s
    e = np.array([x for _, x in energy])
    k = 8
    best, drop = 0, None
    for i in range(k, len(e) - k):
        t = energy[i][0]
        if not (t_from + 3 <= t <= t_to - 3):
            continue
        rise = e[i:i + k].mean() - e[i - k:i].mean()
        if rise > best:
            best, drop = rise, t

    # tempo from onset autocorrelation
    o = flux - np.convolve(flux, np.ones(20) / 20, "same")
    o = np.maximum(o, 0)
    seg = o[int(t_from * fps):int(t_to * fps)]
    ac = np.correlate(seg, seg, "full")[len(seg) - 1:]
    bpm, bv = None, -1
    for b in np.arange(70, 180, 0.5):
        lag = 60 / b * fps
        v = np.interp(lag, np.arange(len(ac)), ac) + 0.5 * np.interp(2 * lag, np.arange(len(ac)), ac)
        if v > bv:
            bv, bpm = v, float(b)

    # kicks: peaks of low-band onset, >=0.3 s apart
    lo = np.maximum(0, np.diff(low))
    region = lo[int(t_from * fps):int(t_to * fps)]
    thr = np.percentile(region, 97) if len(region) else 0
    kicks, last = [], -1
    for i in range(int(t_from * fps), min(len(lo), int(t_to * fps))):
        if lo[i] > thr and lo[i] >= lo[max(0, i - 3):i + 4].max() and i / fps - last > 0.3:
            kicks.append(round(i / fps, 3))
            last = i / fps
    # snap the drop onto the strongest low-end hit within -1/+2 s of the energy rise
    if drop is not None:
        i0, i1 = int((drop - 1) * fps), int((drop + 2) * fps)
        drop = round((i0 + int(np.argmax(lo[i0:i1]))) / fps, 3)

    print(f"\nduration {dur:.1f}s  bpm~{bpm}  drop~{drop}s  kicks {len(kicks)}", file=sys.stderr)
    json.dump({"duration": round(dur, 2), "bpm": bpm, "drop": drop, "kicks": kicks, "energy": energy}, sys.stdout)


if __name__ == "__main__":
    main()
