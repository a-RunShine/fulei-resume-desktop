"""Build the Windows icon set from the supplied desktop logo.

The artwork draws "Resume" with a text element in Arial Black, which is not on
every Windows machine, so the glyphs are baked to path outlines here and the
icons never depend on a font being installed.

Two variants come out of this: the tile with FL and Resume for 48px and up, and
the tile with FL alone for 16-32px, where the Resume line and the three rules
collapse into a smear.

Run from the repo root:

    python apps/desktop/scripts/build-icons.py

Then render the PNG and ICO files with scripts/render-icons.mjs.
"""

import sys
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

FONT = r"C:\Windows\Fonts\ariblk.ttf"
TILE = 512.0
TILE_INSET = 32.0
TILE_SIDE = TILE - TILE_INSET * 2
TILE_RADIUS = 96.0
PAPER = "#F8F7F3"
INK = "#111111"

FL_PATHS = [
    "M106 84 H147 V313 H106 Z",
    "M147 84 H298 L287 98 H147 Z",
    "M147 230 H261 L250 244 H147 Z",
    "M313 84 H354 V313 H313 Z",
    "M313 292 H406 L395 313 H313 Z",
]

FL_BOX = (106.0, 84.0, 406.0, 313.0)

RESUME_SIZE = 82
RESUME_TRACKING = 5.6
RESUME_GAP = 24


def resume_path():
    font = TTFont(FONT)
    glyph_set = font.getGlyphSet()
    upem = font["head"].unitsPerEm
    cmap = font.getBestCmap()
    hmtx = font["hmtx"]
    cap_ratio = font["OS/2"].sCapHeight / upem
    scale = RESUME_SIZE / upem
    text = "Resume"

    advances = [hmtx[cmap[ord(char)]][0] * scale for char in text]
    width = sum(advances) + RESUME_TRACKING * (len(text) - 1)
    cursor = FL_BOX[2] - (FL_BOX[2] - FL_BOX[0]) / 2 - width / 2
    baseline = FL_BOX[3] + RESUME_GAP + cap_ratio * RESUME_SIZE

    commands = []
    for index, char in enumerate(text):
        glyph_name = cmap[ord(char)]
        pen = SVGPathPen(glyph_set, ntos=lambda value: f"{value:.2f}")
        glyph_set[glyph_name].draw(TransformPen(pen, (scale, 0, 0, -scale, cursor, baseline)))
        drawing = pen.getCommands()
        if drawing:
            commands.append(drawing)
        cursor += advances[index]
        if index < len(text) - 1:
            cursor += RESUME_TRACKING

    return " ".join(commands)


def tile():
    return (
        f'  <rect x="{TILE_INSET:g}" y="{TILE_INSET:g}" width="{TILE_SIDE:g}" '
        f'height="{TILE_SIDE:g}" rx="{TILE_RADIUS:g}" fill="{PAPER}"/>'
    )


def large():
    lines = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">',
        tile(),
        f'  <g fill="{INK}">',
        *[f'    <path d="{d}"/>' for d in FL_PATHS],
        f'    <path d="{resume_path()}"/>',
        "  </g>",
        "</svg>",
        "",
    ]
    return "\n".join(lines)


def small():
    x0, y0, x1, y1 = FL_BOX
    scale = (TILE_SIDE * 0.78) / (x1 - x0)
    width = (x1 - x0) * scale
    height = (y1 - y0) * scale
    dx = (TILE / 2) - (width / 2) - x0 * scale
    dy = (TILE / 2) - (height / 2) - y0 * scale

    lines = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">',
        tile(),
        f'  <g transform="translate({dx:.2f} {dy:.2f}) scale({scale:.4f})" fill="{INK}">',
        *[f'    <path d="{d}"/>' for d in FL_PATHS],
        "  </g>",
        "</svg>",
        "",
    ]
    return "\n".join(lines)


def main(root):
    out = Path(root) / "apps" / "desktop" / "icons-src"
    out.mkdir(parents=True, exist_ok=True)
    for name, markup in (("desktop-large.svg", large()), ("desktop-small.svg", small())):
        target = out / name
        target.write_text(markup, encoding="utf-8", newline="\n")
        print(f"wrote {target.relative_to(root)} ({len(markup)} bytes)")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else ".")
