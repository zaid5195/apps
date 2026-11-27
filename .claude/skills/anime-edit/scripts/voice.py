"""Narration + music mix for an edit.

usage: python3 voice.py config.json WORKDIR
Reads config["voice"], config["song"], config["duration"], config["drop"].
Writes WORKDIR/tts/lineN.wav, WORKDIR/spans.json (measured speech span per
line) and WORKDIR/mix.wav (song ducked under the voice until the drop).

Voice engine: Kokoro (free, runs locally). Model files are fetched once from
GitHub releases into ~/.cache/kokoro. If the user has ElevenLabs credits and
the connector is available, a better trailer voice can be generated there
instead; put each line's audio at WORKDIR/tts/lineN.wav and run with
--skip-tts so only the measuring and mixing happen.
"""
import json, os, subprocess, sys
import numpy as np

CACHE = os.path.expanduser("~/.cache/kokoro")
REL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
FILES = ["kokoro-v1.0.int8.onnx", "voices-v1.0.bin"]


def ensure_model():
    os.makedirs(CACHE, exist_ok=True)
    for f in FILES:
        p = os.path.join(CACHE, f)
        if not os.path.exists(p):
            subprocess.run(["curl", "-sSL", "-o", p, REL + f], check=True)
    try:
        import kokoro_onnx  # noqa
    except ImportError:
        subprocess.run([sys.executable, "-m", "pip", "install", "-q", "kokoro-onnx", "soundfile"], check=True)


def main():
    cfg = json.load(open(sys.argv[1]))
    work = sys.argv[2]
    skip = "--skip-tts" in sys.argv
    v = cfg["voice"]
    os.makedirs(f"{work}/tts", exist_ok=True)
    import soundfile as sf

    if not skip:
        ensure_model()
        from kokoro_onnx import Kokoro
        k = Kokoro(f"{CACHE}/{FILES[0]}", f"{CACHE}/{FILES[1]}")
        for i, ln in enumerate(v["lines"]):
            a, sr = k.create(ln["text"], voice=v.get("voice", "am_onyx"), speed=ln.get("speed", v.get("speed", 0.82)),
                             lang="en-us")
            sf.write(f"{work}/tts/line{i}.wav", a, sr)

    # place lines and measure real speech spans
    SR = 24000
    total = cfg["duration"] + 1
    track = np.zeros(int(SR * total))
    spans = []
    for i, ln in enumerate(v["lines"]):
        a, sr = sf.read(f"{work}/tts/line{i}.wav")
        if a.ndim > 1:
            a = a.mean(1)
        if sr != SR:
            a = np.interp(np.arange(0, len(a), sr / SR), np.arange(len(a)), a)
        env = np.convolve(np.abs(a), np.ones(480) / 480, "same")
        on = np.where(env > 0.02 * max(1e-6, np.abs(a).max() / 0.6))[0]
        s0, s1 = (on[0], on[-1]) if len(on) else (0, len(a))
        t = ln["at"]
        j = int(t * SR)
        track[j:j + len(a)] += a[: max(0, len(track) - j)]
        spans.append([round(t + s0 / SR, 3), round(t + s1 / SR, 3)])
        print(f"line{i}: {spans[-1][0]:6.2f} -> {spans[-1][1]:6.2f}  {ln['text']}")
    json.dump(spans, open(f"{work}/spans.json", "w"))
    sf.write(f"{work}/vo_raw.wav", track / (np.abs(track).max() or 1) * 0.9, SR)

    # deep "trailer" voice: pitch down ~1.4 semitones, warm low end, compression, short room echo
    pitch = v.get("pitch", 0.92)
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", f"{work}/vo_raw.wav", "-af",
                    f"asetrate=24000*{pitch},aresample=44100,atempo={1 / pitch:.4f},"
                    "equalizer=f=110:t=q:w=1:g=5,equalizer=f=3500:t=q:w=1:g=2,"
                    "acompressor=threshold=0.1:ratio=4:attack=5:release=120,"
                    "aecho=0.8:0.5:70|140:0.22|0.12,volume=1.6", f"{work}/vo.wav"], check=True)

    dur, drop = cfg["duration"], cfg["drop"]
    duck = v.get("duck", 0.2)        # music level while the narrator talks (before the drop)
    gain = v.get("gain", 3.4)        # voice level; check with volumedetect, voice should sit ~3 dB over music
    ss = cfg.get("song_start", 0)
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-ss", str(ss), "-i", cfg["song"], "-i", f"{work}/vo.wav",
                    "-filter_complex",
                    f"[0:a]atrim=0:{dur},volume='if(lt(t,{drop - 0.2}),{duck},1.0)':eval=frame,"
                    f"afade=t=out:st={dur - 1.5}:d=1.5[m];[1:a]atrim=0:{dur},volume={gain}[v];"
                    "[m][v]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[o]",
                    "-map", "[o]", "-ar", "44100", "-ac", "2", f"{work}/mix.wav"], check=True)
    print("wrote", f"{work}/mix.wav")


if __name__ == "__main__":
    main()
