# Regional Boxes for Forge Neo
# Entry point: the Regional Boxes panel in txt2img and img2img. The panel itself runs in the browser
# (javascript/regional_boxes.js) and writes the prompt; the script only draws the boxes into the img2img input when
# the panel is in "Marks on image" mode and the loaded model is Qwen-Image 2.1. Nothing of Forge Neo is patched.

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import gradio as gr
from modules import scripts

from lib_regional_boxes import marks

INFOTEXT = "Regional boxes"


class RegionalBoxesScript(scripts.Script):
    sorting_priority = 11
    create_group = False

    def title(self):
        return "Regional Boxes"

    def show(self, is_img2img):
        return scripts.AlwaysVisible

    def ui(self, is_img2img):
        tab = "img2img" if is_img2img else "txt2img"
        with gr.Accordion("Regional Boxes", open=False, elem_id=f"regional_boxes_{tab}_accordion"):
            gr.HTML(f'<div class="regional-boxes" data-tab="{tab}"></div>')
            # the boxes for "Marks on image", filled by the panel; hidden by CSS (a hidden Gradio component is not
            # rendered at all, and the panel could not write it)
            data = gr.Textbox(value="", show_label=False, container=False, elem_id=f"regional_boxes_{tab}_data",
                              elem_classes=["regional-boxes-data"])
        return [data]

    def before_process_init_images(self, p, pp, data="", *args, **kwargs):
        # img2img only, once the model is loaded (before_process runs before Forge loads a newly picked checkpoint) and
        # before Forge resizes and encodes the input: the marks become part of the picture the model edits
        boxes = marks.parse(data)
        init_images = getattr(p, "init_images", None)
        if not boxes or not init_images or not marks.is_qwen21(getattr(p, "sd_model", None)):
            return
        p.init_images = [marks.draw(image, boxes) for image in init_images]
        p.extra_generation_params[INFOTEXT] = f"marks ({marks.describe(boxes)})"
