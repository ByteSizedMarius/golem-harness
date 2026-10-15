"""Builds the orange sparkle cape texture (Minecraft 1.7.10, 64x32) and its back-view preview."""
from pathlib import Path

from PIL import Image

import make_skin as ms

OUT = Path(__file__).resolve().parent
SCALE = 8

ORANGE = ms.rgb("#D97757")
DARK = ms.rgb("#B85C3C")
LIGHT = ms.rgb("#F2C2A8")
CLEAR = ms.CLEAR

FACE_W, FACE_H = 10, 16
# (x, y, w, h) of each face in the 22x17 cape UV region.
TOP = (1, 0, 10, 1)
BOTTOM = (11, 0, 10, 1)
LEFT = (0, 1, 1, 16)
OUTER = (1, 1, 10, 16)
RIGHT = (11, 1, 1, 16)
INNER = (12, 1, 10, 16)

# Light pixels of the sparkle on a 10x16 face: 8 rays (four 2-wide arms, four diagonals) around a 2x2 core.
SPARKLE = [
    "..........",
    "..........",
    "..........",
    "..........",
    ".L..LL..L.",
    "..L.LL.L..",
    "...LLLL...",
    ".LLLLLLLL.",
    ".LLLLLLLL.",
    "...LLLL...",
    "..L.LL.L..",
    ".L..LL..L.",
    "..........",
    "..........",
    "..........",
    "..........",
]


def face_pattern():
    """The 10x16 face as a grid of ORANGE/DARK/LIGHT, trimmed with a 1 px dark border."""
    face = [[ORANGE] * FACE_W for _ in range(FACE_H)]
    for y, row in enumerate(SPARKLE):
        for x, ch in enumerate(row):
            if ch == "L":
                face[y][x] = LIGHT
    for x in range(FACE_W):
        face[0][x] = face[FACE_H - 1][x] = DARK
    for y in range(FACE_H):
        face[y][0] = face[y][FACE_W - 1] = DARK
    return face


def paint_face(img, region, face):
    x, y, w, h = region
    for j in range(h):
        for i in range(w):
            img.putpixel((x + i, y + j), face[j][i])


def build():
    img = Image.new("RGBA", (64, 32), CLEAR)
    face = face_pattern()
    paint_face(img, OUTER, face)
    paint_face(img, INNER, face)
    for region in (TOP, BOTTOM):
        ms.rect(img, *region, DARK)
    for region in (LEFT, RIGHT):
        ms.rect(img, *region, DARK)
    return img


def back_view(skin, cape):
    """Draws the 16x32-unit back view of the skin with the cape hanging in front of the body."""
    s = SCALE
    ox = oy = 2 * s
    canvas = Image.new("RGBA", (16 * s + 2 * ox, 32 * s + 2 * oy), ms.rgb("#BFC4C9"))
    ms.put(canvas, ms.crop(skin, 32, 20, 8, 12), 4, 8, ox, oy, scale=s)
    ms.put(canvas, ms.crop(skin, 52, 20, 4, 12, True), 0, 8, ox, oy, scale=s)
    ms.put(canvas, ms.crop(skin, 52, 20, 4, 12), 12, 8, ox, oy, scale=s)
    ms.put(canvas, ms.crop(skin, 12, 20, 4, 12, True), 4, 20, ox, oy, scale=s)
    ms.put(canvas, ms.crop(skin, 12, 20, 4, 12), 8, 20, ox, oy, scale=s)
    ms.put(canvas, cape.crop((1, 1, 11, 17)), 3, 8, ox, oy, scale=s)
    ms.put(canvas, ms.crop(skin, 24, 8, 8, 8), 4, 0, ox, oy, scale=s)
    ms.put(canvas, ms.crop(skin, 56, 8, 8, 8), 4, 0, ox, oy, hat=True, scale=s)
    return canvas


def main():
    skin = Image.open(OUT / "claude.png").convert("RGBA")
    cape = build()
    cape.save(OUT / "cape.png")
    back_view(skin, cape).save(OUT / "preview-cape.png")

    check = Image.open(OUT / "cape.png")
    alpha = check.getchannel("A")
    region = sum(1 for x in range(22) for y in range(17) if alpha.getpixel((x, y)))
    total = sum(1 for x in range(64) for y in range(32) if alpha.getpixel((x, y)))
    print(f"cape.png {check.size[0]}x{check.size[1]} {check.mode} "
          f"region {region} of {22 * 17} (total opaque {total})")


if __name__ == "__main__":
    main()
