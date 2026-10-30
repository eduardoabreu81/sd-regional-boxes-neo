# Regional Boxes for Forge Neo
# Entry point: the Regional Boxes panel in txt2img and img2img. The panel itself runs in the browser
# (javascript/regional_boxes.js) and writes the prompt; the script draws the boxes into the img2img input when the
# panel is in "Marks on image" mode and the loaded model is Qwen-Image 2.1, and moves the Styles picked into the caption
# of a MOSS-Image layout. Nothing of Forge Neo is patched.

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import gradio as gr
from modules import scripts, shared

from lib_regional_boxes import marks
from lib_regional_boxes.styles import style_caption

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

    def before_process(self, p, data="", *args, **kwargs):
        # with a MOSS-Image layout as the prompt, the Styles' words go into its caption, where the model reads them as
        # part of the scene, instead of after the layout or around it; Forge is then left no style to apply. Done before
        # Forge applies them (setup_prompts) and before sd-dynamic-prompts takes the layout's braces off (process)
        styles = shared.prompt_styles
        names = [name for name in (getattr(p, "styles", None) or []) if name in styles.styles]
        if not any(styles.styles[name].prompt for name in names):
            return

        def fold(prompt):
            return style_caption(prompt, lambda caption: styles.apply_styles_to_prompt(caption, names))

        prompts = p.prompt if isinstance(p.prompt, list) else [p.prompt]
        folded = [fold(prompt) if isinstance(prompt, str) else None for prompt in prompts]
        if any(out is None for out in folded):
            return
        p.prompt = folded if isinstance(p.prompt, list) else folded[0]
        # hires fix takes the prompt when its own is empty; one of its own gets the styles as Forge would apply them
        if isinstance(getattr(p, "hr_prompt", None), str) and p.hr_prompt:
            p.hr_prompt = fold(p.hr_prompt) or styles.apply_styles_to_prompt(p.hr_prompt, names)
        for attr in ("negative_prompt", "hr_negative_prompt"):
            value = getattr(p, attr, None)
            if isinstance(value, str) and (value or attr == "negative_prompt"):
                setattr(p, attr, styles.apply_negative_styles_to_prompt(value, names))
            elif isinstance(value, list):
                setattr(p, attr, [styles.apply_negative_styles_to_prompt(v, names) for v in value])
        p.styles = []
        p.extra_generation_params["Regional boxes styles"] = ", ".join(names)

    def before_process_init_images(self, p, pp, data="", *args, **kwargs):
        # img2img only, once the model is loaded (before_process runs before Forge loads a newly picked checkpoint) and
        # before Forge resizes and encodes the input: the marks become part of the picture the model edits
        boxes = marks.parse(data)
        init_images = getattr(p, "init_images", None)
        if not boxes or not init_images or not marks.is_qwen21(getattr(p, "sd_model", None)):
            return
        p.init_images = [marks.draw(image, boxes) for image in init_images]
        p.extra_generation_params[INFOTEXT] = f"marks ({marks.describe(boxes)})"
