# Regional Boxes for Forge Neo
# Styles moved into a MOSS-Image layout's caption, with Forge's own way of applying them.

import json
import unittest

from lib_regional_boxes.styles import layout_at_start, style_caption


# modules/styles.py of Forge Neo, as it applies a style to a prompt
def apply_styles_to_prompt(prompt, styles):
    for style in styles:
        if "{prompt}" in style:
            prompt = style.replace("{prompt}", prompt)
        else:
            prompt = ", ".join(filter(None, (prompt.strip(), style.strip())))
    return prompt


def fold(prompt, styles):
    return style_caption(prompt, lambda caption: apply_styles_to_prompt(caption, styles))


LAYOUT = ('{"summary":{"meta":["poster"],"canvas":"single","caption":"A red fox in the snow."},'
          '"items":[{"label":"text","caption":"a large title","text":"WINTER FOX","bbox":[-400,-300,-250,300]}],'
          '"bbox_coord_space":"abs_centralized","bbox_format":"yxyx"}')


def caption(prompt):
    return layout_at_start(prompt)[0]["summary"]["caption"]


class TestStyleCaption(unittest.TestCase):
    def test_a_style_after_the_prompt_goes_after_the_caption(self):
        out = fold(LAYOUT, ["cinematic, film grain"])
        self.assertEqual(caption(out), "A red fox in the snow., cinematic, film grain")
        self.assertTrue(out.endswith("}"))

    def test_a_style_around_the_prompt_wraps_the_caption(self):
        out = fold(LAYOUT, ["analog photo of {prompt}, 35mm"])
        self.assertEqual(caption(out), "analog photo of A red fox in the snow., 35mm")
        self.assertTrue(out.startswith('{"summary"'))

    def test_several_styles_in_order(self):
        out = fold(LAYOUT, ["masterpiece, {prompt}", "film grain"])
        self.assertEqual(caption(out), "masterpiece, A red fox in the snow., film grain")

    def test_the_rest_of_the_layout_is_left_as_it_was(self):
        before, after = json.loads(LAYOUT), json.loads(fold(LAYOUT, ["film grain"]))
        before["summary"]["caption"] = after["summary"]["caption"]
        self.assertEqual(after, before)

    def test_compact_json_as_the_panel_writes_it(self):
        out = fold(LAYOUT, ["film grain"])
        self.assertEqual(out, LAYOUT.replace("the snow.", "the snow., film grain"))

    def test_words_and_tags_after_the_layout_stay_after_it(self):
        out = fold(LAYOUT + " foxstyle <lora:fox:0.8>", ["film grain"])
        self.assertTrue(out.endswith("} foxstyle <lora:fox:0.8>"))
        self.assertEqual(caption(out), "A red fox in the snow., film grain")

    def test_chinese_text_is_kept_as_it_is(self):
        out = fold(LAYOUT.replace("WINTER FOX", "冬狐"), ["film grain"])
        self.assertIn('"text":"冬狐"', out)

    def test_plain_prompts_are_left_alone(self):
        self.assertIsNone(fold("a red fox in the snow", ["film grain"]))
        self.assertIsNone(fold('[{"id": "obj_1", "bbox": [1, 2, 3, 4], "desc": "a fox"}]', ["film grain"]))
        self.assertIsNone(fold('{"summary":"canvas":"single"', ["film grain"]))

    def test_spaces_around_the_layout_go(self):
        self.assertEqual(fold("  " + LAYOUT + "  ", ["film grain"]), LAYOUT.replace("the snow.", "the snow., film grain"))


if __name__ == "__main__":
    unittest.main()
