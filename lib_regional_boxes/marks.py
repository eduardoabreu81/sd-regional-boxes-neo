# Regional Boxes for Forge Neo
# "Marks on image": the boxes drawn into the img2img input, in named colors, for the edit models that read marks
# drawn on the picture plus a note in the prompt ("Inside the red box: ..."), such as Qwen-Image 2.1.
#
# The panel (javascript/regional_boxes.js) sends the boxes as JSON in a hidden textbox; this module reads them and
# draws them on a copy of each input picture. No Forge imports: the CPU tests run it as it is.

import json

from PIL import Image, ImageDraw

# the panel's palette, by name: the note names the color the box is drawn in, so both come from here and from the
# same list in regional_boxes.js (COLORS), in the same order
PALETTE = {
    "red": (255, 0, 0),
    "blue": (0, 80, 255),
    "green": (0, 180, 0),
    "yellow": (255, 212, 0),
    "magenta": (255, 0, 255),
    "orange": (255, 128, 0),
    "cyan": (0, 208, 255),
    "purple": (128, 0, 255),
}

FORMAT_MARKS = "marks"


def parse(data: str) -> list[tuple[str, tuple[int, int, int, int]]]:
    """The (color, [top, left, bottom, right]) boxes to draw, or [] when the panel is not in marks mode or off."""
    try:
        payload = json.loads(data or "{}")
    except ValueError:
        return []
    if not isinstance(payload, dict) or payload.get("format") != FORMAT_MARKS or not payload.get("draw", False):
        return []
    boxes = []
    for item in payload.get("boxes") or []:
        try:
            color = str(item["color"])
            top, left, bottom, right = (max(0, min(1000, int(v))) for v in item["bbox"])
        except (KeyError, TypeError, ValueError):
            continue
        if color in PALETTE and bottom > top and right > left:
            boxes.append((color, (top, left, bottom, right)))
    return boxes


def line_width(size: tuple[int, int]) -> int:
    # 8 px at 1024: the width of the sketch-mark tests on Qwen-Image 2.1
    return max(3, round(min(size) / 128))


def draw(image: Image.Image, boxes) -> Image.Image:
    """A copy of image with each box outlined in its color; coordinates are on a 0-1000 grid of the picture."""
    if not boxes:
        return image
    mode = image.mode
    out = image.convert("RGBA" if "A" in mode else "RGB").copy()
    w, h = out.size
    pen = ImageDraw.Draw(out)
    width = line_width(out.size)
    for color, (top, left, bottom, right) in boxes:
        rgb = PALETTE[color]
        fill = (*rgb, 255) if out.mode == "RGBA" else rgb
        pen.rectangle([left * w / 1000, top * h / 1000, right * w / 1000 - 1, bottom * h / 1000 - 1], outline=fill, width=width)
    return out.convert(mode) if mode not in ("RGB", "RGBA") else out


def describe(boxes) -> str:
    """Infotext value: the colors drawn, in order."""
    return ", ".join(color for color, _ in boxes)
