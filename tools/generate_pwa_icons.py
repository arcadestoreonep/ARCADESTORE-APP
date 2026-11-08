"""Rasterize the Arcade Store mark geometry for PWA and Apple home-screen icons."""
from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "icons"
SCALE = 4


def mix(start, end, amount):
    return tuple(round(a + (b - a) * amount) for a, b in zip(start, end))


def render_icon(size: int, maskable: bool = False) -> Image.Image:
    px = size * SCALE
    image = Image.new("RGBA", (px, px), "#101016")
    draw = ImageDraw.Draw(image)
    # The maskable artwork stays inside the center safe zone; regular icons use
    # the same rounded square and A-shaped mark as assets/arcade-mark.svg.
    side = round(size * (0.66 if maskable else 0.91)) * SCALE
    left = (px - side) // 2
    top = (px - side) // 2
    unit = side / 64
    radius = round(19 * unit)
    draw.rounded_rectangle(
        (left + 3 * unit, top + 3 * unit, left + 61 * unit, top + 61 * unit),
        radius=radius,
        fill="#0b1710",
        outline=(165, 239, 117, 118),
        width=max(1, round(unit * 0.75)),
    )

    # Build the source SVG's lime gradient once, then clip it to its A path.
    gradient = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    grad = gradient.load()
    c0 = (215, 255, 166)
    c1 = (112, 217, 138)
    for y in range(top, top + side):
        for x in range(left, left + side):
            t = ((x - left) + (y - top)) / max(1, 2 * side)
            grad[x, y] = (*mix(c0, c1, t), 255)

    mask = Image.new("L", (px, px), 0)
    md = ImageDraw.Draw(mask)
    point = lambda x, y: (left + x * unit, top + y * unit)
    md.polygon([point(32, 12), point(49, 48), point(39, 48), point(36, 41), point(27, 41), point(24, 48), point(14, 48)], fill=255)
    md.polygon([point(32, 28), point(28.4, 36), point(35.6, 36)], fill=0)
    image.alpha_composite(Image.composite(gradient, Image.new("RGBA", (px, px)), mask))

    circle_radius = 3 * unit
    draw = ImageDraw.Draw(image)
    draw.ellipse(
        (left + 47 * unit, top + 14 * unit, left + (47 + 2 * circle_radius / unit) * unit, top + (14 + 2 * circle_radius / unit) * unit),
        fill="#d7ffa6",
    )
    return image.resize((size, size), Image.Resampling.LANCZOS)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    render_icon(192).save(OUT / "icon-192.png", optimize=True)
    render_icon(512).save(OUT / "icon-512.png", optimize=True)
    render_icon(512, maskable=True).save(OUT / "icon-maskable-512.png", optimize=True)
    render_icon(180).save(OUT / "apple-touch-icon.png", optimize=True)


if __name__ == "__main__":
    main()
