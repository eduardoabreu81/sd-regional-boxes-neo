# 🔲 Regional Boxes for Forge Neo

<div align="center">

[![Forge Neo](https://img.shields.io/badge/Forge-Neo-blue)](https://github.com/Haoming02/sd-webui-forge-classic/tree/neo)
[![Gradio](https://img.shields.io/badge/Gradio-4.40.0-orange)](https://gradio.app/)
[![Version](https://img.shields.io/badge/Version-0.1.0-brightgreen)](https://github.com/eduardoabreu81/sd-regional-boxes-neo)
[![License](https://img.shields.io/badge/License-AGPL--3.0-green.svg)](LICENSE)

> **Extension for [Stable Diffusion WebUI Forge - Neo](https://github.com/Haoming02/sd-webui-forge-classic/tree/neo)**

</div>

Draw boxes with the mouse to tell the model where things go - and the panel hands them to the model in the format it was trained on: **coordinates in the prompt** for FLUX 3 Image Klein, **boxes drawn on the picture** for Qwen-Image 2.1. No coordinates to type, no image editor needed.

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

### v0.1.0 - First Release

- **Regional Boxes panel** in txt2img and img2img - draw, name and describe boxes on a frame shaped like your picture.
- **Coordinates** for FLUX 3 Image Klein - layouts and box edits, written into the prompt.
- **Marks on the image** for Qwen-Image 2.1 - the boxes are drawn on the input picture when you generate, with a note per box in the prompt.
- **Auto** format - picks the right one for the loaded model.

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
- When you generate, the boxes are drawn on a copy of the input picture in their colors; your file is not touched
- Up to 8 boxes, each in its own named color (red, blue, green, yellow, magenta, orange, cyan, purple)

### 🛡️ Safe by Design

- Changes no Forge Neo file and adds no generation setting of its own
- Works with **sd-dynamic-prompts** installed
- The infotext records which boxes were drawn

---

## 🤖 Which Models

<p align="center"><img src=".github/images/models.jpg" alt="Coordinates and marks on FLUX 3, Qwen-Image 2.1, Krea 2 and Anima" width="720"></p>

Each model understands boxes in its own way - or not at all. Tested on an 8 GB RTX 2070:

| Model | Coordinates | Marks on the image |
| :--- | :--- | :--- |
| **FLUX 3 Image Klein** | ✅ | ❌ the box becomes part of the picture |
| **Qwen-Image 2.1** | ❌ ignored | ✅ |
| **Krea 2** | ❌ ignored | ⚠️ follows the box loosely, keeps the outline |
| **Anima** | ❌ ignored | - edits only with an Edit LoRA |

**Auto** uses coordinates for FLUX 3 and marks for every other model. FLUX.1 Kontext is documented to follow marks drawn on the picture, but it was not tested here. For models without boxes of their own, region tools that steer the model's attention work instead: [Forge Couple](https://github.com/Haoming02/sd-forge-couple) (SD 1.5, SDXL, Anima) and [Regional Prompter](https://github.com/hako-mikan/sd-webui-regional-prompter) (also Z-Image and Krea 2).

---

## 📦 Installation

1. Open Forge Neo WebUI
2. Go to **Extensions** → **Install from URL**
3. Paste: `https://github.com/eduardoabreu81/sd-regional-boxes-neo`
4. Click **Install** and restart the WebUI

---

## 🖱️ How to Use

1. Open **Regional Boxes** in txt2img or img2img - the format follows the loaded model, or pick it yourself
2. Drag on the frame to draw a box; in img2img the input picture shows behind it
3. Describe each box - what it is (coordinates) or what to do inside it (marks)
4. Click **Write to prompt**, then **Generate**

For edits, use img2img with **Denoising strength** 1 and the model's reference option on (**[Qwen 2.1] Enable Reference**, **[Klein] Enable Reference**).

---

## 💡 Tips

- Boxes guide placement and size; they are not a mask, and the model may draw a little past them
- Marks work best with a box drawn a bit larger than the thing to change
- Click a box without dragging to select it; **Redraw** draws it again; ✕ deletes it
- Writing again replaces the boxes already in the prompt, so draw, adjust and write as often as you like
- The frame takes the shape of your **Width** and **Height**

---

## 📄 Credits

- **[Forge Neo](https://github.com/Haoming02/sd-webui-forge-classic/tree/neo)** by Haoming02
- **[FLUX 3 Image Klein](https://huggingface.co/black-forest-labs/flux-3-image-klein)** by Black Forest Labs - the bounding box format, and the mug photo of the examples
- **[Qwen-Image 2.1](https://huggingface.co/Qwen)** by the Qwen team - edits guided by marks on the picture

---

## 📜 License

AGPL-3.0 - see [LICENSE](LICENSE)

---

<div align="center">

Made with ❤️ for the Stable Diffusion community

**[Report Bug](https://github.com/eduardoabreu81/sd-regional-boxes-neo/issues)** • **[Request Feature](https://github.com/eduardoabreu81/sd-regional-boxes-neo/issues)** • **[☕ Ko-fi](https://ko-fi.com/eduardoabreu81)**

</div>
