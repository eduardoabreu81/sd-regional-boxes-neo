# Regional Boxes for Forge Neo
# The marks drawn into the img2img input, from the panel's payload, and the panel's JS through Node.

import json
import shutil
import subprocess
import unittest
from pathlib import Path

from PIL import Image

from lib_regional_boxes import marks

NODE = shutil.which("node")
JS_TEST = Path(__file__).parent / "js" / "regional_boxes_test.js"
JS_PANEL = Path(__file__).parents[1] / "javascript" / "regional_boxes.js"


def payload(boxes, draw=True, fmt="marks"):
    return json.dumps({"format": fmt, "draw": draw, "boxes": [{"color": c, "bbox": b} for c, b in boxes]})


class TestParse(unittest.TestCase):
    def test_reads_the_boxes(self):
        self.assertEqual(marks.parse(payload([("red", [550, 620, 850, 850])])), [("red", (550, 620, 850, 850))])

    def test_nothing_to_draw(self):
        for data in ("", "{}", "not json", payload([("red", [1, 1, 9, 9])], draw=False),
                     payload([("red", [1, 1, 9, 9])], fmt="coords"), payload([("teal", [1, 1, 9, 9])]),
                     payload([("red", [9, 9, 1, 1])]), json.dumps({"format": "marks", "draw": True, "boxes": [{"color": "red"}]})):
            self.assertEqual(marks.parse(data), [], data)

    def test_clamps_to_the_grid(self):
        self.assertEqual(marks.parse(payload([("blue", [-5, 0, 1200, 1000])])), [("blue", (0, 0, 1000, 1000))])


class TestDraw(unittest.TestCase):
    def test_outline_in_its_color_inside_left_alone(self):
        image = Image.new("RGB", (1000, 500), (128, 128, 128))
        out = marks.draw(image, [("red", (200, 100, 800, 600))])
        width = marks.line_width(out.size)
        top, left, bottom, right = 100, 100, 400, 600  # the box in pixels
        self.assertEqual(out.getpixel((left + 1, (top + bottom) // 2)), marks.PALETTE["red"])
        self.assertEqual(out.getpixel(((left + right) // 2, top + 1)), marks.PALETTE["red"])
        self.assertEqual(out.getpixel(((left + right) // 2, (top + bottom) // 2)), (128, 128, 128))
        self.assertEqual(out.getpixel((left - width - 2, top - width - 2)), (128, 128, 128))
        self.assertEqual(image.getpixel((left + 1, top + 1)), (128, 128, 128), "the input stays untouched")

    def test_width_scales_with_the_picture(self):
        self.assertEqual(marks.line_width((1024, 1024)), 8)
        self.assertEqual(marks.line_width((256, 256)), 3)

    def test_keeps_transparency_and_mode(self):
        rgba = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
        out = marks.draw(rgba, [("green", (0, 0, 1000, 1000))])
        self.assertEqual(out.mode, "RGBA")
        self.assertEqual(out.getpixel((0, 0)), (*marks.PALETTE["green"], 255))
        self.assertEqual(out.getpixel((32, 32))[3], 0)
        self.assertEqual(marks.draw(Image.new("L", (64, 64)), [("red", (0, 0, 1000, 1000))]).mode, "L")

    def test_no_boxes_is_the_same_picture(self):
        image = Image.new("RGB", (8, 8))
        self.assertIs(marks.draw(image, []), image)

    def test_palette_matches_the_panel(self):
        source = JS_PANEL.read_text(encoding="utf-8")
        for name in marks.PALETTE:
            self.assertIn(f'["{name}", ', source)


@unittest.skipIf(NODE is None, "node not installed")
class TestPanel(unittest.TestCase):
    def test_panel_output(self):
        result = subprocess.run([NODE, str(JS_TEST)], capture_output=True, text=True, timeout=60, check=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
