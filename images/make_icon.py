#!/usr/bin/env python3
"""Draws images/icon.png, the Marketplace icon: two side-by-side panes with a removed and an added block.

Needs Pillow (pip install Pillow). Run it from any folder: python3 images/make_icon.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 256
SCALE = 4  # Draw large, then shrink, for smooth edges.

BACKGROUND = (36, 41, 47)
PANE = (246, 248, 250)
TEXT = (175, 184, 193)
REMOVED = (207, 34, 46)
REMOVED_BAND = (255, 220, 224)
ADDED = (26, 127, 55)
ADDED_BAND = (218, 251, 225)


def px(value):
    return round(value * SCALE)


def draw_pane(draw, left, top, right, bottom, band, mark):
    draw.rounded_rectangle((px(left), px(top), px(right), px(bottom)), radius=px(12), fill=PANE)
    rows = [top + 18 + row * 25 for row in range(6)]
    draw.rectangle((px(left), px(rows[2] - 7), px(right), px(rows[3] + 17)), fill=band)
    widths = (0.80, 0.55, 0.70, 0.62, 0.78, 0.45)
    for row, (y, width) in enumerate(zip(rows, widths)):
        x_end = left + 14 + (right - left - 28) * width
        color = mark if row in (2, 3) else TEXT
        draw.rounded_rectangle((px(left + 14), px(y), px(x_end), px(y + 10)), radius=px(5), fill=color)


def main():
    image = Image.new("RGBA", (px(SIZE), px(SIZE)), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((0, 0, px(SIZE) - 1, px(SIZE) - 1), radius=px(48), fill=BACKGROUND)
    draw_pane(draw, 26, 46, 124, 210, REMOVED_BAND, REMOVED)
    draw_pane(draw, 132, 46, 230, 210, ADDED_BAND, ADDED)
    image = image.resize((SIZE, SIZE), Image.LANCZOS)
    image.save(Path(__file__).with_name("icon.png"), optimize=True)


if __name__ == "__main__":
    main()
