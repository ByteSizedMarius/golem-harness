"""Builds the flower-head Claude skins (Minecraft 1.7.10, 64x32) and their previews."""
from pathlib import Path

from PIL import Image

OUT = Path(__file__).resolve().parent
SCALE = 12
TEXTURE_SCALE = 8


def rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5)) + (255,)


def shade(c, f):
    return tuple(min(255, round(v * f)) for v in c[:3]) + (255,)


# Colours sampled from the reference drawings.
PETAL = rgb("#D87556")
WHITE = rgb("#FFFFFF")
INK = rgb("#151515")
BLUE = rgb("#94C7D8")
LILAC = rgb("#CAA9D8")
SHOE_BROWN = rgb("#532D22")
CLEAR = (0, 0, 0, 0)

HEAD_KEYS = {
    "P": PETAL,
    "D": shade(PETAL, 0.78),
    "L": shade(PETAL, 1.12),
    "C": shade(PETAL, 0.6),
    "W": WHITE,
    "K": INK,
    ".": CLEAR,
}

FRONT = [
    "PPDPPDPP",
    "PPWWWWPP",
    "PKWWWWKP",
    "KWKWWKWK",
    "PWWWWWWP",
    "PWKWWKWP",
    "PPWKKWPP",
    "PPDPPDPP",
]
# Petal tips at the corners and edge middles, over the front.
HAT_FRONT = [
    "LP.PP.PL",
    "PP....PP",
    "P......P",
    "........",
    "P......P",
    "P......P",
    "PP....PP",
    "LP.PP.PL",
]

# The left side face, front edge at column 0. The right side is its mirror.
SIDE = [
    "PPPPPPPP",
    "PPPDDDDD",
    "DDDPPPPP",
    "PPLLLLPP",
    "PPLLLLPP",
    "DDDPPPPP",
    "PPPDDDDD",
    "PPPPPPPP",
]
# Row 7 meets the front face.
TOP = [
    "PDPLLPDP",
    "PDPLLPDP",
    "PDPLLPDP",
    "PDPLLPDP",
    "PPDLLDPP",
    "PPDPPDPP",
    "PPDPPDPP",
    "PPDPPDPP",
]
BOTTOM = [
    "PPDPPDPP",
    "PPDPPDPP",
    "PPDLLDPP",
    "PPDLLDPP",
    "PPDLLDPP",
    "PPDLLDPP",
    "PPDPPDPP",
    "PPDPPDPP",
]
# Petal tips around a dark centre, notched between the tips.
BACK = [
    "LLDLLDLL",
    "LPPPPPPL",
    "DPPDDPPD",
    "LPDCCDPL",
    "LPDCCDPL",
    "DPPDDPPD",
    "LPPPPPPL",
    "LLDLLDLL",
]

HAT_SIDE = [
    "PP.P..P.",
    "P.......",
    "........",
    "P.......",
    "P.......",
    "........",
    "P.......",
    "PP.P..P.",
]
HAT_TOP = [
    ".P....P.",
    "P......P",
    "........",
    "P......P",
    "........",
    "P......P",
    "P......P",
    "LP.PP.PL",
]
HAT_BOTTOM = [
    "LP.PP.PL",
    "P......P",
    "........",
    "P......P",
    "P......P",
    "........",
    "P......P",
    "LP.PP.PL",
]
HAT_BACK = [
    ".P....P.",
    "P......P",
    "........",
    "........",
    "........",
    "........",
    "P......P",
    ".P....P.",
]


def mirror(rows):
    return [r[::-1] for r in rows]


def grid(img, x, y, rows, keys):
    for j, row in enumerate(rows):
        for i, ch in enumerate(row):
            img.putpixel((x + i, y + j), keys[ch])


def rect(img, x, y, w, h, c):
    for j in range(h):
        for i in range(w):
            img.putpixel((x + i, y + j), c)


def limb(img, x, y, rows_by_face, top, bottom):
    """Paints a 4x4x12 limb whose UV block starts at (x, y)."""
    rect(img, x + 4, y, 4, 4, top)
    rect(img, x + 8, y, 4, 4, bottom)
    for n, face in enumerate(("right", "front", "left", "back")):
        for j, c in enumerate(rows_by_face[face]):
            rect(img, x + 4 * n, y + 4 + j, 4, 1, c)
    # Darker inner edge on the front and back faces.
    for px in (x + 7, x + 12):
        for py in range(y + 4, y + 16):
            img.putpixel((px, py), side_shade(img.getpixel((px, py))))


def column(side, bands):
    """Per-row colours of a limb, bands as (row count, colour) pairs."""
    rows = []
    for count, c in bands:
        rows += [c] * count
    return {
        "front": rows,
        "back": rows,
        "right": [side(c) for c in rows],
        "left": [side(c) for c in rows],
    }


def side_shade(c):
    return shade(c, 0.87) if c[3] else c


def build(v):
    img = Image.new("RGBA", (64, 32), CLEAR)
    k = HEAD_KEYS

    # Head.
    grid(img, 8, 0, TOP, k)
    grid(img, 16, 0, BOTTOM, k)
    grid(img, 0, 8, mirror(SIDE), k)
    grid(img, 8, 8, FRONT, k)
    grid(img, 16, 8, SIDE, k)
    grid(img, 24, 8, BACK, k)

    # Hat layer.
    grid(img, 40, 0, HAT_TOP, k)
    grid(img, 48, 0, HAT_BOTTOM, k)
    grid(img, 32, 8, mirror(HAT_SIDE), k)
    grid(img, 40, 8, HAT_FRONT, k)
    grid(img, 48, 8, HAT_SIDE, k)
    grid(img, 56, 8, HAT_BACK, k)

    # Body.
    top = v["top"]
    collar = shade(top, 0.82)
    rect(img, 20, 16, 8, 4, top)
    rect(img, 28, 16, 8, 4, v["trousers"])
    rect(img, 20, 20, 8, 12, top)
    rect(img, 32, 20, 8, 12, top)
    rect(img, 16, 20, 4, 12, side_shade(top))
    rect(img, 28, 20, 4, 12, side_shade(top))
    rect(img, 20, 20, 8, 1, collar)
    rect(img, 32, 20, 8, 1, collar)

    # Arm: sleeve, then three rows of hand.
    arm = column(side_shade, [(9, top), (3, PETAL)])
    limb(img, 40, 16, arm, top, PETAL)

    # Leg: trousers, then the shoe bands.
    leg = column(side_shade, v["leg"])
    limb(img, 0, 16, leg, v["trousers"], v["leg"][-1][1])
    return img


OUTFIT = {
    "top": LILAC,
    "trousers": BLUE,
    "leg": [(10, BLUE), (2, SHOE_BROWN)],
}


def crop(skin, x, y, w, h, flip=False):
    face = skin.crop((x, y, x + w, y + h))
    return face.transpose(Image.FLIP_LEFT_RIGHT) if flip else face


def put(canvas, face, ux, uy, ox, oy, hat=False, scale=SCALE):
    """Draws a face at skin unit (ux, uy) of the view at pixel origin (ox, oy)."""
    w, h = face.size
    if hat:
        size = (w * scale * 9 // 8, h * scale * 9 // 8)
        px, py = ox + ux * scale - w * scale // 16, oy + uy * scale - h * scale // 16
    else:
        size = (w * scale, h * scale)
        px, py = ox + ux * scale, oy + uy * scale
    big = face.resize(size, Image.NEAREST)
    canvas.alpha_composite(big, (px, py))


def front(canvas, skin, ox, oy, scale=SCALE):
    """Draws the 16x32-unit front view, the player's right limbs on the viewer's left."""
    put(canvas, crop(skin, 8, 8, 8, 8), 4, 0, ox, oy, scale=scale)
    put(canvas, crop(skin, 20, 20, 8, 12), 4, 8, ox, oy, scale=scale)
    put(canvas, crop(skin, 44, 20, 4, 12), 0, 8, ox, oy, scale=scale)
    put(canvas, crop(skin, 44, 20, 4, 12, True), 12, 8, ox, oy, scale=scale)
    put(canvas, crop(skin, 4, 20, 4, 12), 4, 20, ox, oy, scale=scale)
    put(canvas, crop(skin, 4, 20, 4, 12, True), 8, 20, ox, oy, scale=scale)
    put(canvas, crop(skin, 40, 8, 8, 8), 4, 0, ox, oy, hat=True, scale=scale)


def preview(skin):
    margin = 2 * SCALE
    view_w = [16, 16, 8]
    width = sum(w * SCALE for w in view_w) + margin * (len(view_w) + 1)
    canvas = Image.new("RGBA", (width, 32 * SCALE + 2 * margin), rgb("#BFC4C9"))
    oy = margin
    ox = margin

    front(canvas, skin, ox, oy)

    # Back.
    ox += 16 * SCALE + margin
    put(canvas, crop(skin, 24, 8, 8, 8), 4, 0, ox, oy)
    put(canvas, crop(skin, 32, 20, 8, 12), 4, 8, ox, oy)
    put(canvas, crop(skin, 52, 20, 4, 12, True), 0, 8, ox, oy)
    put(canvas, crop(skin, 52, 20, 4, 12), 12, 8, ox, oy)
    put(canvas, crop(skin, 12, 20, 4, 12, True), 4, 20, ox, oy)
    put(canvas, crop(skin, 12, 20, 4, 12), 8, 20, ox, oy)
    put(canvas, crop(skin, 56, 8, 8, 8), 4, 0, ox, oy, hat=True)

    # Left side, front edge on the viewer's left.
    ox += 16 * SCALE + margin
    put(canvas, crop(skin, 16, 8, 8, 8), 0, 0, ox, oy)
    put(canvas, crop(skin, 28, 20, 4, 12), 2, 8, ox, oy)
    put(canvas, crop(skin, 40, 20, 4, 12, True), 2, 8, ox, oy)
    put(canvas, crop(skin, 0, 20, 4, 12, True), 2, 20, ox, oy)
    put(canvas, crop(skin, 48, 8, 8, 8), 0, 0, ox, oy, hat=True)
    return canvas


def texture(skin):
    s = TEXTURE_SCALE
    board = Image.new("RGBA", (64 * s, 32 * s), rgb("#FFFFFF"))
    check = rgb("#E2E2E2")
    for y in range(0, 32 * s, s // 2):
        for x in range(0, 64 * s, s // 2):
            if (x // (s // 2) + y // (s // 2)) % 2:
                board.paste(check, (x, y, x + s // 2, y + s // 2))
    board.alpha_composite(skin.resize((64 * s, 32 * s), Image.NEAREST))
    return board


def main():
    skin = build(OUTFIT)
    skin.save(OUT / "claude.png")
    preview(skin).save(OUT / "preview-claude.png")
    texture(skin).save(OUT / "texture-claude.png")
    check = Image.open(OUT / "claude.png")
    print(f"claude.png {check.size[0]}x{check.size[1]} {check.mode}")


if __name__ == "__main__":
    main()
