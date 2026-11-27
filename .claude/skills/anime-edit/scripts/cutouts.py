"""Cut the character out of images with the anime-trained isnet-anime model.

  python3 cutouts.py IMGDIR id [id ...]      # IMGDIR/hd/<id>.jpg -> IMGDIR/cut/<id>_mask.png
  python3 cutouts.py IMGDIR --sheet id ...   # also IMGDIR/cuts.jpg: each cut on magenta (Read it!)

Setup (once): pip install rembg ; model from GitHub releases:
  mkdir -p ~/.u2net && curl -sSL -o ~/.u2net/isnet-anime.onnx \
    https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-anime.onnx
Prints the share of the frame covered by the mask: ~0.05 = it failed to find anyone,
~0.9 = close-up face (cut useless). Images of the character on a plain background cut best.
"""
import os, sys
import numpy as np
from PIL import Image


def main():
    d, *ids = sys.argv[1:]
    sheet = "--sheet" in ids
    ids = [i for i in ids if i != "--sheet"]
    from rembg import new_session, remove
    s = new_session("isnet-anime")
    os.makedirs(f"{d}/cut", exist_ok=True)
    for i in ids:
        im = Image.open(f"{d}/hd/{i}.jpg").convert("RGB")
        if max(im.size) > 1600:
            im.thumbnail((1600, 1600))
        m = remove(im, session=s, only_mask=True)
        m.save(f"{d}/cut/{i}_mask.png")
        print(i, round(np.asarray(m).mean() / 255, 2))
    if sheet:
        c = Image.new("RGB", (6 * 240, ((len(ids) - 1) // 6 + 1) * 150), "black")
        for j, i in enumerate(ids):
            im = Image.open(f"{d}/hd/{i}.jpg").convert("RGB")
            m = Image.open(f"{d}/cut/{i}_mask.png").resize(im.size)
            bg = Image.new("RGB", im.size, (255, 0, 140))
            bg.paste(im, (0, 0), m)
            bg.thumbnail((236, 146))
            c.paste(bg, ((j % 6) * 240, (j // 6) * 150))
        c.save(f"{d}/cuts.jpg")
        print(f"{d}/cuts.jpg")


if __name__ == "__main__":
    main()
