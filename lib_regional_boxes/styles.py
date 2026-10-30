# Regional Boxes for Forge Neo
# Styles and MOSS-Image layouts: Forge adds a style after the prompt, or wraps it ("{prompt}"), so with a layout as the
# prompt the style's words land outside the JSON, after it. Here they go into the layout's caption instead, the way
# Forge would have applied them to a plain prompt describing the scene.
#
# Forge's own way of applying styles is passed in (style): no Forge imports, so the CPU tests run it as it is.

import json


# the MOSS-Image layout at the start of text and where it ends, or None when text does not start with one
def layout_at_start(text):
    if not text.startswith("{"):
        return None
    try:
        layout, end = json.JSONDecoder().raw_decode(text)
    except ValueError:
        return None
    if not isinstance(layout, dict) or not isinstance(layout.get("items"), list) or not isinstance(layout.get("summary"), dict):
        return None
    return layout, end


# the prompt with style(caption) as its layout's caption, or None when the prompt is not a layout
def style_caption(prompt, style):
    text = prompt.strip()
    found = layout_at_start(text)
    if not found:
        return None
    layout, end = found
    summary = layout["summary"]
    summary["caption"] = style(str(summary.get("caption", "")))
    # compact, on one line, as the panel and OpenMOSS's compiler write it; what followed the layout stays after it
    return json.dumps(layout, ensure_ascii=False, separators=(",", ":")) + text[end:]
