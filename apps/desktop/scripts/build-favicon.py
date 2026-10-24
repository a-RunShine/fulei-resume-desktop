"""Write the browser favicon from the small desktop mark.

The tab strip draws at 16px, where the Resume line and the three rules become an
unreadable smear, so the favicon uses the FL-only tile. It keeps an opaque
background because a transparent mark disappears in a dark tab strip.

Run from the repo root, after build-icons.py:

    python apps/desktop/scripts/build-favicon.py
"""

import sys
from pathlib import Path

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


def main(root):
    x0, y0, x1, y1 = FL_BOX
    scale = (TILE_SIDE * 0.78) / (x1 - x0)
    width = (x1 - x0) * scale
    height = (y1 - y0) * scale
    dx = (TILE / 2) - (width / 2) - x0 * scale
    dy = (TILE / 2) - (height / 2) - y0 * scale

    lines = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" '
        'role="img" aria-label="Fulei Resume">',
        f'  <rect x="{TILE_INSET:g}" y="{TILE_INSET:g}" width="{TILE_SIDE:g}" '
        f'height="{TILE_SIDE:g}" rx="{TILE_RADIUS:g}" fill="{PAPER}"/>',
        f'  <g transform="translate({dx:.2f} {dy:.2f}) scale({scale:.4f})" fill="{INK}">',
        *[f'    <path d="{d}"/>' for d in FL_PATHS],
        "  </g>",
        "</svg>",
        "",
    ]

    target = Path(root) / "apps" / "web" / "public" / "favicon.svg"
    markup = "\n".join(lines)
    target.write_text(markup, encoding="utf-8", newline="\n")
    print(f"wrote {target.relative_to(root)} ({len(markup)} bytes)")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else ".")
