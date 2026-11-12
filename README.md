# 🔲 Regional Boxes for Forge Neo

<div align="center">

[![Forge Neo](https://img.shields.io/badge/Forge-Neo-blue)](https://github.com/Haoming02/sd-webui-forge-classic/tree/neo)
[![Gradio](https://img.shields.io/badge/Gradio-4.40.0-orange)](https://gradio.app/)
[![Version](https://img.shields.io/badge/Version-0.3.0-brightgreen)](https://github.com/eduardoabreu81/sd-regional-boxes-neo)
[![License](https://img.shields.io/badge/License-AGPL--3.0-green.svg)](LICENSE)

> **Extension for [Stable Diffusion WebUI Forge - Neo](https://github.com/Haoming02/sd-webui-forge-classic/tree/neo)**

</div>

Draw boxes with the mouse, or a finger on a touch screen, to tell **FLUX 3 Image Klein**, **Qwen-Image 2.1** or **MOSS-Image** where things go - the panel hands them to each model in the format it was trained on: **coordinates in the prompt** for FLUX 3, **boxes drawn on the picture** for Qwen-Image 2.1, a **layout prompt** for MOSS-Image. No coordinates to type, no image editor needed.

For the **PAN 2** video model, the panel becomes a **timeline of the clip**: lay out what happens, the camera moves and what each subject does, and it writes PAN 2's structured description for you.

> [!Important]
> This extension requires an up-to-date **Forge Neo** (the `neo` branch). It only writes the prompt and, for Qwen-style edits, draws the boxes on the input picture - nothing of Forge Neo is changed.

---

## 📋 Table of Contents

- [What's New](#-whats-new)
- [Features](#-features)
- [Which Models](#-which-models)
- [Installation](#-installation)
- [How to Use](#%EF%B8%8F-how-to-use)
- [Tips](#-tips)
- [Credits](#-credits)

---

## 🆕 What's New

### v0.3.0 - PAN 2 Timeline, Undo and Shortcuts

- **PAN 2 format** - a timeline of the clip instead of the frame: events, camera moves and each subject's actions, written as [PAN 2](https://huggingface.co/IFM/PAN2)'s structured description for the [PAN 2 extension](https://github.com/eduardoabreu81/pan2-forge-neo) (work in progress); **Auto** picks it with the **pan2** preset or a PAN 2 checkpoint
- **Undo and Redo** for the boxes - ↶ and ↷, or Ctrl+Z and Ctrl+Y; a description typed in one go, or a box nudged several times, undoes as one step
- **Side handles** on the selected box, and **Shift** keeps its shape while you resize it
- **⧉ Duplicate** a box, or Ctrl+D - the copy lands a little below and to the right, with its own color
- **Keys** - Delete removes the selected box, Esc lets it go, the arrow keys move it (Shift for bigger steps), and a double-click jumps to its description
- **Guides** over the frame - rule of thirds, center or golden ratio, kept for the next time

### v0.2.7 - Additional Prompt and Fixes

- MOSS-Image's **Extra** field is now **Additional prompt**: it takes LoRA tags, trigger words or any other words, after the layout
- A LoRA written in a box's description is no longer copied after the layout again on every **Write to prompt**; a prompt left with copies comes back clean on the next one
- Marks keep one box per color: the panel draws no 9th box, and a box that shares a color with another (from another format, or read from a prompt) is left out of the notes, with a warning

### v0.2.6 - Touch Screens

- **Draw, move and resize boxes with a finger** - on a phone, a tablet or a touch screen, the frame works as it does with the mouse; a drag on it no longer scrolls or zooms the page (thanks to [1243a-alt](https://github.com/1243a-alt))
- A touch the system takes away in the middle of a drag, such as a gesture or a notification, puts the box back where it was instead of leaving it stuck to the finger
- A second finger on the frame is ignored while the first one draws or moves a box

### v0.2.5 - Styles, Box Tags, Hide the Boxes and Autocomplete

- **Styles go into the layout's caption** - with a MOSS-Image layout as the prompt, the Styles you pick no longer land after the layout, outside it: their words are added to the scene caption, the way Forge Neo would apply them to a plain prompt, also a style with `{prompt}`
- **Box tags say what each box holds** - with MOSS-Image, a box on the frame is tagged with its words or the start of its description, *1 WINTER FOX*, *2 a red fox sitting…*, instead of only *1 text*, *2 character*; only the panel shows it, the layout is the same
- **Hide the boxes** - see the picture behind them whole, at full strength, and turn them back on to keep drawing
- **Tag Autocomplete in the panel** - Scene, Additional prompt and each box's description complete tags, LoRAs and wildcards as the prompt does, with [Tag Autocomplete](https://github.com/DominikDoom/a1111-sd-webui-tagcomplete) installed

### v0.2.4 - Scene and Extra

- **Scene** - with MOSS-Image, the whole picture is described in the panel, and becomes the layout's caption; it stays there when you clear the prompt, and a scene typed as the prompt still fills it
- **Extra** - LoRA tags and their trigger words, written after the layout, outside it; a LoRA you add from Forge Neo's LoRA tab after writing is kept too
- Both follow the prompt: **Read from prompt** fills them, and a caption or tag changed by hand in the prompt shows up in them

### v0.2.3 - Last Picture and Dynamic Prompts

- **The last picture behind the boxes** in txt2img - the one the gallery shows, so you can place the next boxes over what came out; **Show the last picture behind the boxes** turns it off
- **A warning while sd-dynamic-prompts is on**, with FLUX 3 and MOSS-Image - it removes the layout's `{ }` before the model reads it
- **Read from prompt reads a layout that lost its braces** - from a prompt Forge saved, or pasted from PNG Info - and **Write to prompt** puts them back
- Words after a MOSS-Image layout, such as a LoRA's trigger word, are kept after it and no longer stop **Read from prompt**
- Reads the layouts of Forge Neo's own **JSON Builder**, also with parentheses in their captions
- With MOSS-Image, **Write to prompt** on a cleared prompt reuses the scene of the last layout, and says so; the warning asking for a scene stays until you edit the prompt

### v0.2.2 - Move and Resize Boxes

- **Drag a box by its name tag** to move it, and by the corners of the selected box to resize it - with every format
- Dragging anywhere else still draws a new box, also inside another one
- **⇔ and ⇕** center a box across or down the picture, keeping its size
- With MOSS-Image, a warning when the boxes in the panel are no longer the ones written in the prompt

### v0.2.1 - Layouts Follow the Picture Size

- **MOSS-Image layouts follow the size** - change **Width** and **Height**, or switch img2img to **Resize by**, and the boxes in the prompt move to fit the new size on their own
- In img2img, the size is the one Forge Neo will really use, also with **Resize by**

### v0.2.0 - MOSS-Image

- **Layout prompts** for MOSS-Image - draw boxes for things and for text, and the panel writes the whole prompt as MOSS-Image's layout
- **Each box's position in pixels**, under its row - type a number to move an edge exactly where you want it
- **Read from prompt** loads a MOSS-Image layout back into the panel, to adjust it
- A warning when **Width** or **Height** changes after the layout was written
- The frame keeps the shape of tall pictures

### v0.1.0 - First Release

- **Regional Boxes panel** in txt2img and img2img - draw, name and describe boxes on a frame shaped like your picture.
- **Coordinates** for FLUX 3 Image Klein - layouts and box edits, written into the prompt.
- **Marks on the image** for Qwen-Image 2.1 - the boxes are drawn on the input picture when you generate, with a note per box in the prompt.
- **Auto** format - picks the right one for the loaded model, FLUX 3 or Qwen-Image 2.1.

---

## 🎯 Features

### 📐 Coordinates (FLUX 3 Image Klein)

<p align="center"><img src=".github/images/coordinates.jpg" alt="The panel with a teapot box and a vase box, and the FLUX 3 picture made from them" width="720"></p>

- Each box becomes an element of the JSON list FLUX 3 reads at the end of the prompt, in [Black Forest Labs' format](https://docs.bfl.ai/flux_3/flux3_image_bounding_boxes)
- **place** things in a new picture, or edit one: **add new**, take it **from reference** (where it is, then where it goes) or **remove** it
- The **`<name>`** button puts each box's tag at the cursor in your caption; **Read from prompt** loads a list back to adjust it
- Needs the [FLUX 3 Image Klein extension](https://github.com/eduardoabreu81/flux3-image-forge-neo)

### 🖍️ Marks on the Image (Qwen-Image 2.1)

<p align="center"><img src=".github/images/marks.jpg" alt="A mug photo; the same photo with a red box drawn by the extension; the result with a cactus in the box and the box gone" width="720"></p>

- Draw over the img2img picture and say what to do inside each box: *add a cactus*, *change the shirt to denim*, *remove it*
- **Write to prompt** adds one note per box - *"Inside the red box: ..."* - and asks the model to remove the outlines
- When you generate, the boxes are drawn on a copy of the input picture in their colors - only with Qwen-Image 2.1 loaded; your file is not touched
- Works with Forge Neo's own Qwen-Image 2.1 support and with the [Qwen-Image 2.1 extension](https://github.com/eduardoabreu81/qwen2.1-forge-neo)
- Up to 8 boxes, each in its own named color (red, blue, green, yellow, magenta, orange, cyan, purple)

### 🧩 Layout Prompts (MOSS-Image)

<p align="center"><img src=".github/images/panel_moss.jpg" alt="The Regional Boxes panel with a MOSS-Image layout: a title, a fox and a subtitle box over the input poster, each row with its pixels and the center buttons" width="760"></p>

- Describe the whole picture in **Scene** (or as the prompt), then draw a box for each thing and each piece of text
- For each box, choose what it holds - **object**, **character** or **text** - and say how it looks; a text box also takes the exact words to write, with Enter for a new line
- **Meta** says what kind of picture it is (*poster, flat illustration*, *product photo*...), and **Canvas** whether it is one picture, panels or a collage
- **Write to prompt** turns it all into [MOSS-Image's layout](https://github.com/OpenMOSS/MOSS-Image/blob/main/USERGUIDE.md#layout-prompts-experimental), the way OpenMOSS's own tools write it; Scene becomes the layout's caption
- Under each box, its edges in pixels from the center of the picture, as the layout uses them - type a number to set an edge exactly
- **Read from prompt** loads a layout back, yours or one you pasted, to adjust it
- **Additional prompt** holds what goes outside the layout - LoRA tags such as `<lora:name:1>`, their trigger words, any other words: they go after the layout, where Forge Neo still finds them, and tags already in the prompt are kept
- **Styles** picked under Generate go into the scene caption when you generate, not after the layout, also with sd-dynamic-prompts on; their negative part goes to the negative prompt as usual, and the infotext names them under *Regional boxes styles*
- Change the size and the layout follows: the boxes in the prompt are moved to fit, and the panel says so
- In img2img, draw over the input picture and describe the new version: things keep their place, while captions and words can change
- Works in txt2img and img2img; needs the [MOSS-Image extension](https://github.com/eduardoabreu81/moss-image-forge-neo) 0.1.2 or newer, which keeps the layout whole with sd-dynamic-prompts installed

<p align="center"><img src=".github/images/moss_txt2img.jpg" alt="The MOSS-Image poster made in txt2img: WINTER FOX, a red fox, FORGE NEO" width="300"> <img src=".github/images/moss_img2img.jpg" alt="The same poster in img2img with the same boxes: ARCTIC FOX and a white arctic fox" width="300"></p>
<p align="center"><sub>txt2img, then the same boxes in img2img with a new title and an arctic fox - 8-step LoRA, RTX 2070</sub></p>

### 🎬 Timeline of the Clip (PAN 2)

- PAN 2 does not place things in the picture: it follows a scene through time. The frame gives way to a **timeline** as long as the clip - the **Frames** you set
- Describe the look in **Video style**, **Lighting** and **Perspective**, and the opening picture in **First frame** (in img2img, the input picture)
- Under **Subjects**, add the people and things that move, each with a name and how it looks - PAN 2 knows them by IDs such as `<|Subject1|>`
- Split the clip into **events** and drag the lines between them; each event says what happens and has its **camera moves**, from PAN 2's own list (static, pan, tilt, track, dolly, zoom, roll, unstable)
- Drag on a subject's lane to add what it does, and drag an action's edges to change when it starts and ends
- **Write to prompt** turns it all into PAN 2's JSON description; **Read from prompt** loads one back, and fits its times to the clip if its length was different
- Before you generate, the panel lists what PAN 2's prompt guide asks that the description does not do yet - an empty field, an action outside its event, a description too long
- **Additional prompt** holds what goes outside the description, such as LoRA tags
- Needs the [PAN 2 extension](https://github.com/eduardoabreu81/pan2-forge-neo), which uses the description as written even with sd-dynamic-prompts on

### ✏️ Editing the Boxes

- **↶ Undo** and **↷ Redo** (Ctrl+Z, Ctrl+Y) for drawing, moving, resizing, deleting and the fields of each box
- Resize the selected box by its corners or sides; hold **Shift** to keep its shape
- **⧉** duplicates a box (Ctrl+D); Delete removes it, Esc lets it go, the arrow keys move it one step (ten with Shift)
- Double-click a box to jump to its description
- **Guides** draw the thirds, the center or the golden ratio over the frame

### 🛡️ Safe by Design

- Changes no Forge Neo file and adds no generation setting of its own
- Works with **sd-dynamic-prompts** installed, and warns while it is on with FLUX 3 and MOSS-Image, since it breaks their layouts
- The infotext records which boxes were drawn

---

## 🤖 Which Models

<p align="center"><img src=".github/images/models.jpg" alt="Top: the teapot and vase layout as coordinates, on FLUX 3 and on Qwen-Image 2.1. Bottom: the cactus box drawn on the picture, on FLUX 3 and on Qwen-Image 2.1" width="560"></p>

Regional Boxes works with four models, each in the format it was trained on. Tested on an 8 GB RTX 2070:

| Model | Format | |
| :--- | :--- | :--- |
| **FLUX 3 Image Klein** | Coordinates in the prompt | ✅ top left: things land in their boxes |
| **Qwen-Image 2.1** | Marks on the picture | ✅ bottom right: the cactus in the box, the outline gone |
| **MOSS-Image** | Layout prompt | ✅ the poster above: title, fox and subtitle in their boxes |
| **PAN 2** | Timeline of the clip | 🚧 work in progress, like the [PAN 2 extension](https://github.com/eduardoabreu81/pan2-forge-neo) |

FLUX 3 and Qwen-Image 2.1 do not follow each other's format (top right, bottom left), so **Auto** picks the format by the loaded model. With any other model the panel says so and writes nothing. For SD 1.5, SDXL, Anima, Z-Image and Krea 2, region tools that steer the model's attention work instead: [Forge Couple](https://github.com/Haoming02/sd-forge-couple) and [Regional Prompter](https://github.com/hako-mikan/sd-webui-regional-prompter).

---

## 📦 Installation

1. Open Forge Neo WebUI
2. Go to **Extensions** → **Install from URL**
3. Paste: `https://github.com/eduardoabreu81/sd-regional-boxes-neo`
4. Click **Install** and restart the WebUI

---

## 🖱️ How to Use

1. Load FLUX 3 Image Klein, Qwen-Image 2.1 or MOSS-Image, and open **Regional Boxes** in txt2img or img2img - the format follows the loaded model, or pick it yourself
2. Set **Width** and **Height** first, then drag on the frame to draw a box; in img2img the input picture shows behind it, and in txt2img the last picture you made (turn it off with **Show the last picture behind the boxes**)
3. Describe each box - what it is (coordinates, layout) or what to do inside it (marks)
4. Click **Write to prompt**, then **Generate**

With PAN 2, set **Frames** first, then fill in the fields and the timeline instead of drawing boxes.

For edits, use img2img with **Denoising strength** 1 and the model's reference option on (**[Qwen 2.1] Enable Reference**, **[Klein] Enable Reference**).

---

## 💡 Tips

- Boxes guide placement and size; they are not a mask, and the model may draw a little past them
- Marks work best with a box drawn a bit larger than the thing to change
- Drag a box by its name tag to move it, and by the corners or sides of the selected box to resize it (Shift keeps its shape); dragging anywhere else draws a new box, even inside another one
- Made a mistake? Ctrl+Z undoes it, Ctrl+Y brings it back. The keys work after a click on the panel, and not while you type in a field
- **⇔** and **⇕** center a box across or down the picture, keeping its size
- **Hide the boxes** shows the picture behind them whole; no box can be drawn until you turn them back on
- With MOSS-Image, each box's tag on the frame shows its words or the start of its description, so you can tell the boxes apart over the last picture
- With Tag Autocomplete installed, the panel's description fields complete tags, LoRAs and wildcards too
- Click a box without dragging to select it; **Redraw** draws it again; ✕ deletes it
- On a touch screen, drag with one finger as you would with the mouse; to scroll the page, swipe outside the frame
- Writing again replaces the boxes already in the prompt, so draw, adjust and write as often as you like
- The frame takes the shape of your **Width** and **Height**
- MOSS-Image layouts are in pixels of the picture's size, so a new size moves the boxes in the prompt with it; if you changed the boxes' numbers by hand in the prompt, they are left as they are and the panel asks you to **Write to prompt** again
- With MOSS-Image, write the scene description in English for the best results, and give text boxes room for their words
- Turn off **Dynamic Prompts enabled** (sd-dynamic-prompts) when you use FLUX 3 or MOSS-Image layouts: it removes the layout's `{ }` before the model reads it, and the boxes are lost. The panel warns you while it is on; **Read from prompt** still reads a layout that lost its braces, and **Write to prompt** puts them back

---

## 📄 Credits

- **[Forge Neo](https://github.com/Haoming02/sd-webui-forge-classic/tree/neo)** by Haoming02
- **[FLUX 3 Image Klein](https://huggingface.co/black-forest-labs/flux-3-image-klein)** by Black Forest Labs - the bounding box format, and the mug photo of the examples
- **[Qwen-Image 2.1](https://huggingface.co/Qwen)** by the Qwen team - edits guided by marks on the picture
- **[MOSS-Image](https://github.com/OpenMOSS/MOSS-Image)** by OpenMOSS - the layout prompt format
- **[PAN 2](https://huggingface.co/IFM/PAN2)** by the Institute of Foundation Models (IFM), MBZUAI - the structured description and its prompt guide
- **[BBox Studio](https://github.com/Haoming02/sd-webui-forge-classic/discussions/1625)** - the ideas for undo, side handles, duplicate, keys and guides

---

## 📜 License

AGPL-3.0 - see [LICENSE](LICENSE)

---

<div align="center">

Made with ❤️ for the Stable Diffusion community

**[Report Bug](https://github.com/eduardoabreu81/sd-regional-boxes-neo/issues)** • **[Request Feature](https://github.com/eduardoabreu81/sd-regional-boxes-neo/issues)** • **[☕ Ko-fi](https://ko-fi.com/eduardoabreu81)**

</div>
