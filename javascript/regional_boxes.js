// Regional Boxes for Forge Neo
// Draw boxes on a frame shaped like the picture, and hand them to the model in the format it was trained on:
//
//   Coordinates (FLUX 3 Image Klein): a JSON list at the end of the prompt (Black Forest Labs' bounding box guide)
//     layout:    {"id", "bbox": [top, left, bottom, right], "desc"}
//     box edit:  {"id", "from": "target" | "ref_image_N", "src_bbox", "tgt_bbox" (null removes), "desc"}
//   Marks on image (Qwen-Image 2.1): the boxes drawn into the img2img input in named colors
//     (scripts/regional_boxes.py), and a note per box in the prompt: "Inside the red box: ...".
//   Layout JSON (MOSS-Image): the whole prompt becomes OpenMOSS's layout, the prompt's text as the scene caption
//     {"summary", "items": [{"label", "caption", "text", "bbox"}]}, boxes in pixels from the picture's center.
//
// Only these models: the others tested (Krea 2, Anima) do not follow boxes in any of these forms.
//
// Boxes are on a 0-1000 grid of the picture. The pure functions at the top are shared with the tests
// (tests/js/regional_boxes_test.js).

(function () {
    "use strict";

    const KINDS = {
        place: "place",       // layout: where it goes in a new picture
        add: "add",           // box edit: something new, at tgt_bbox
        ref: "ref",           // box edit: from a reference, src_bbox -> tgt_bbox (move, keep, replace)
        remove: "remove",     // box edit: from a reference, src_bbox -> gone
    };
    const FORMATS = {auto: "auto", coords: "coords", marks: "marks", moss: "moss", none: "none"};
    // the same names and order as PALETTE in lib_regional_boxes/marks.py: the note names the color the box is drawn in
    const PALETTE = [
        ["red", "#ff0000"], ["blue", "#0050ff"], ["green", "#00b400"], ["yellow", "#ffd400"],
        ["magenta", "#ff00ff"], ["orange", "#ff8000"], ["cyan", "#00d0ff"], ["purple", "#8000ff"],
    ];
    const NOTES_BLOCK = /Inside the [a-z]+ box:[\s\S]*?Keep everything else exactly as it is\./;

    function clamp(v) {
        return Math.max(0, Math.min(1000, Math.round(v)));
    }

    function normBox(box) {
        if (!box) return null;
        const [a, b, c, d] = box.map(clamp);
        return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
    }

    // ---- Coordinates (FLUX 3) ----

    function elementJson(el) {
        const id = String(el.id || "").trim();
        const desc = String(el.desc || "").trim();
        if (el.kind === KINDS.place) return {id, bbox: normBox(el.tgt), desc};
        const from = el.kind === KINDS.add ? "target" : `ref_image_${el.ref || 0}`;
        const src = el.kind === KINDS.add ? null : normBox(el.src);
        const tgt = el.kind === KINDS.remove ? null : normBox(el.tgt);
        return {id, from, src_bbox: src, tgt_bbox: tgt, desc};
    }

    function isComplete(el) {
        if (!String(el.id || "").trim()) return false;
        if (el.kind === KINDS.place || el.kind === KINDS.add) return !!el.tgt;
        if (el.kind === KINDS.remove) return !!el.src;
        return !!el.src && !!el.tgt;
    }

    // Black Forest Labs' own style: {"id": "obj_1", "bbox": [80, 60, 480, 380], "desc": "..."}
    function formatValue(v) {
        if (Array.isArray(v)) return `[${v.join(", ")}]`;
        return JSON.stringify(v);
    }

    function buildLayout(elements) {
        const items = elements.filter(isComplete).map(elementJson);
        if (!items.length) return "";
        return `[${items.map((o) => `{${Object.entries(o).map(([k, v]) => `${JSON.stringify(k)}: ${formatValue(v)}`).join(", ")}}`).join(", ")}]`;
    }

    // the [ ... ] span of a layout list in the prompt (intact, or with the braces sd-dynamic-prompts strips)
    function findLayoutSpan(text) {
        const re = /\[\s*\{?\s*"id"\s*:/g;
        let match, last = null;
        while ((match = re.exec(text)) !== null) last = match.index;
        if (last === null) return null;
        let depth = 0, inString = false, escaped = false;
        for (let i = last; i < text.length; i++) {
            const c = text[i];
            if (inString) {
                if (escaped) escaped = false;
                else if (c === "\\") escaped = true;
                else if (c === '"') inString = false;
            } else if (c === '"') inString = true;
            else if (c === "[") depth++;
            else if (c === "]" && --depth === 0) return [last, i + 1];
        }
        return null;
    }

    function replaceSpan(prompt, span, text) {
        if (span) {
            const before = prompt.slice(0, span[0]).replace(/\s+$/, "");
            const after = prompt.slice(span[1]);
            return text ? `${before}${before ? " " : ""}${text}${after}` : `${before}${after}`;
        }
        if (!text) return prompt;
        return prompt.replace(/\s+$/, "") + (prompt.trim() ? " " : "") + text;
    }

    function writeLayout(prompt, json) {
        return replaceSpan(prompt, findLayoutSpan(prompt), json);
    }

    function readLayout(prompt) {
        const span = findLayoutSpan(prompt);
        if (!span) return [];
        let list;
        try {
            list = JSON.parse(prompt.slice(span[0], span[1]));
        } catch (e) {
            return [];
        }
        return list.filter((o) => o && typeof o === "object").map((o, i) => {
            const base = {id: o.id, desc: o.desc || "", color: i % PALETTE.length, ref: 0, src: null, tgt: null};
            if ("bbox" in o) return {...base, kind: KINDS.place, tgt: o.bbox};
            const from = String(o.from || "target");
            if (from === "target") return {...base, kind: KINDS.add, tgt: o.tgt_bbox};
            const ref = parseInt(from.replace("ref_image_", ""), 10) || 0;
            return {...base, kind: o.tgt_bbox ? KINDS.ref : KINDS.remove, tgt: o.tgt_bbox || null, src: o.src_bbox || null, ref};
        });
    }

    // ---- Marks on image (Qwen-Image 2.1) ----

    function colorName(el) {
        return PALETTE[(el.color || 0) % PALETTE.length][0];
    }

    function isMarked(el) {
        return !!el.tgt && !!String(el.desc || "").trim();
    }

    function joinNames(names) {
        if (names.length < 2) return names.join("");
        return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
    }

    // "Inside the red box: add a beanie. ... Remove the red and blue box outlines from the image. Keep ..."
    function buildNotes(elements) {
        const marked = elements.filter(isMarked);
        if (!marked.length) return "";
        const notes = marked.map((e) => `Inside the ${colorName(e)} box: ${String(e.desc).trim().replace(/[.\s]+$/, "")}.`);
        const names = [...new Set(marked.map(colorName))];
        const outline = names.length > 1 ? "box outlines" : "box outline";
        return `${notes.join(" ")} Remove the ${joinNames(names)} ${outline} from the image. Keep everything else exactly as it is.`;
    }

    function writeNotes(prompt, notes) {
        const match = NOTES_BLOCK.exec(prompt);
        return replaceSpan(prompt, match ? [match.index, match.index + match[0].length] : null, notes);
    }

    function marksPayload(elements, draw) {
        return JSON.stringify({
            format: FORMATS.marks,
            draw: !!draw,
            boxes: elements.filter(isMarked).map((e) => ({color: colorName(e), bbox: normBox(e.tgt)})),
        });
    }

    // ---- Layout JSON (MOSS-Image) ----
    // The whole prompt becomes OpenMOSS's layout: {"summary": {"meta", "canvas", "caption"}, "items": [{"label", "caption",
    // "text", "bbox"}], "bbox_coord_space": "abs_centralized", "bbox_format": "yxyx"}, with boxes in pixels from the
    // center of the picture. The conversion is the one of OpenMOSS's own compile_prompt.py (moss-image-prompt-enhancer
    // skill): top and left floored, bottom and right ceiled, then the center subtracted; compact JSON on one line.

    const MOSS_LABELS = ["object", "character", "text"];
    const MOSS_CANVASES = ["single", "multi_panel", "collage"];

    function edge(v, round) {
        return round(Number(v.toFixed(9)));
    }

    // normBox without the rounding: a layout read from the prompt keeps its exact pixels through Read and Write
    function exactBox(box) {
        const [a, b, c, d] = box.map((v) => Math.max(0, Math.min(1000, Number(v))));
        return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
    }

    // 0-1000 grid [top, left, bottom, right] -> [y_min, x_min, y_max, x_max] in pixels from the center of a w x h picture
    function mossBox(box, w, h) {
        const [t, l, b, r] = exactBox(box);
        const cy = Math.floor(h / 2), cx = Math.floor(w / 2);
        return [edge(t * h / 1000, Math.floor) - cy, edge(l * w / 1000, Math.floor) - cx,
            edge(b * h / 1000, Math.ceil) - cy, edge(r * w / 1000, Math.ceil) - cx];
    }

    function gridBox(bbox, w, h) {
        const cy = Math.floor(h / 2), cx = Math.floor(w / 2);
        const [y1, x1, y2, x2] = bbox.map(Number);
        return exactBox([(y1 + cy) / h * 1000, (x1 + cx) / w * 1000, (y2 + cy) / h * 1000, (x2 + cx) / w * 1000]);
    }

    function mossLabel(el) {
        return MOSS_LABELS.includes(el.label) ? el.label : "object";
    }

    function isMossComplete(el) {
        if (!el.tgt || !String(el.desc || "").trim()) return false;
        return mossLabel(el) !== "text" || !!String(el.text || "").trim();
    }

    function mossItem(el, w, h) {
        const label = mossLabel(el);
        const item = {label, caption: String(el.desc).trim()};
        if (label === "text") item.text = String(el.text);
        item.bbox = mossBox(el.tgt, w, h);
        return item;
    }

    // Forge's extra network tags (<lora:name:1>) stay out of the layout, after it, where Forge still finds them
    const NETWORK_TAG = /<[a-z_]+:[^<>]+>/gi;

    function splitTags(prompt) {
        const text = String(prompt || "");
        return {text: text.replace(NETWORK_TAG, "").replace(/[ 	]{2,}/g, " ").trim(), tags: text.match(NETWORK_TAG) || []};
    }

    // the layout the prompt holds, or null when the prompt is not one
    function parseMoss(prompt) {
        const text = splitTags(prompt).text;
        if (!text.startsWith("{")) return null;
        try {
            const o = JSON.parse(text);
            return o && Array.isArray(o.items) && o.summary && typeof o.summary === "object" ? o : null;
        } catch (e) {
            return null;
        }
    }

    // the scene caption: the summary's when the prompt already is a layout, else the prompt itself
    function mossCaption(prompt) {
        const current = parseMoss(prompt);
        return current ? String(current.summary.caption || "").trim() : splitTags(prompt).text;
    }

    function parseMeta(text) {
        return String(text || "").split(",").map((s) => s.trim()).filter(Boolean);
    }

    // the prompt with the boxes as a layout; without boxes, a layout turns back into its caption
    function writeMoss(prompt, elements, w, h, options) {
        const current = parseMoss(prompt);
        const caption = mossCaption(prompt);
        const items = elements.filter(isMossComplete).map((e) => mossItem(e, w, h));
        const tags = splitTags(prompt).tags.join(" ");
        if (!items.length) return current ? [caption, tags].filter(Boolean).join(" ") : prompt;
        const before = current ? current.summary : {};
        const meta = options && options.meta && options.meta.length ? options.meta : before.meta;
        const summary = {};
        if (Array.isArray(meta) && meta.length) summary.meta = meta;
        summary.canvas = MOSS_CANVASES.includes(options && options.canvas) ? options.canvas : before.canvas || "single";
        summary.caption = caption;
        if (before.palette) summary.palette = before.palette;
        return [JSON.stringify({summary, items, bbox_coord_space: "abs_centralized", bbox_format: "yxyx"}), tags].filter(Boolean).join(" ");
    }

    // the panel's elements, meta and canvas from a layout in the prompt, on a w x h picture; null when there is none
    function readMoss(prompt, w, h) {
        const layout = parseMoss(prompt);
        if (!layout) return null;
        const elements = layout.items.filter((o) => o && typeof o === "object" && Array.isArray(o.bbox) && o.bbox.length === 4)
            .map((o, i) => ({id: `obj_${i + 1}`, kind: KINDS.place, label: MOSS_LABELS.includes(o.label) ? o.label : "object",
                desc: String(o.caption || ""), text: o.text === undefined ? "" : String(o.text), tgt: gridBox(o.bbox, w, h),
                src: null, ref: 0, color: i % PALETTE.length}));
        const meta = Array.isArray(layout.summary.meta) ? layout.summary.meta.join(", ") : "";
        return {elements, meta, canvas: MOSS_CANVASES.includes(layout.summary.canvas) ? layout.summary.canvas : "single"};
    }

    // whether a layout's boxes go past a w x h picture (written for another size)
    function mossOutOfBounds(prompt, w, h) {
        const layout = parseMoss(prompt);
        if (!layout) return false;
        const cy = Math.floor(h / 2), cx = Math.floor(w / 2);
        return layout.items.some((o) => Array.isArray(o && o.bbox) && o.bbox.length === 4 &&
            (o.bbox[0] < -cy || o.bbox[1] < -cx || o.bbox[2] > h - cy || o.bbox[3] > w - cx));
    }

    // Auto: coordinates for FLUX 3, marks for Qwen-Image 2.1, layout JSON for MOSS-Image, nothing for the other models
    function resolveFormat(choice, preset, checkpoint) {
        if (choice === FORMATS.coords || choice === FORMATS.marks || choice === FORMATS.moss) return choice;
        const loaded = `${preset || ""} ${checkpoint || ""}`;
        if (/flux[-_.]?3/i.test(loaded)) return FORMATS.coords;
        if (preset === "qwen21" || /qwen[\s_.-]*(image)?[\s_.-]*2[\s_.]?1/i.test(checkpoint || "")) return FORMATS.marks;
        if (preset === "moss" || /moss/i.test(checkpoint || "")) return FORMATS.moss;
        return FORMATS.none;
    }

    const api = {KINDS, FORMATS, PALETTE, buildLayout, writeLayout, readLayout, findLayoutSpan, elementJson, isComplete,
        buildNotes, writeNotes, marksPayload, MOSS_LABELS, MOSS_CANVASES, mossBox, gridBox, isMossComplete, parseMoss,
        mossCaption, parseMeta, writeMoss, readMoss, mossOutOfBounds, resolveFormat};
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
        return;
    }
    window.RegionalBoxes = api;

    // ---- the panel ----

    const LABELS = {place: "place", add: "add new", ref: "from reference", remove: "remove"};
    const FORMAT_LABELS = {auto: "Auto (by the loaded model)", coords: "FLUX 3 Image Klein (coordinates in the prompt)", marks: "Qwen-Image 2.1 (marks on the picture)",
        moss: "MOSS-Image (layout JSON in the prompt)"};

    function el(tag, attrs, ...children) {
        const node = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs || {})) {
            if (k === "class") node.className = v;
            else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
            else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? "" : v);
        }
        for (const c of children) node.append(c);
        return node;
    }

    function setValue(textarea, value) {
        if (!textarea || textarea.value === value) return;
        textarea.value = value;
        textarea.dispatchEvent(new Event("input", {bubbles: true}));
    }

    function numberOf(root, id, fallback) {
        const input = root.querySelector(`#${id} input[type=number]`);
        const v = input ? parseFloat(input.value) : NaN;
        return v > 0 ? v : fallback;
    }

    function initPanel(host) {
        const tab = host.dataset.tab;
        const app = gradioApp();
        // armed: {i, which} for the next drag; color: palette index, kept for life so a note's color never changes
        // written: the [Width, Height] the MOSS layout in the prompt was written or read at
        const state = {elements: [], selected: -1, armed: null, counter: 0, format: FORMATS.auto, draw: true,
            meta: "", canvas: "single", written: null};
        let listedSize = "";

        const formatSelect = el("select", {class: "regional-boxes-format", onchange: (ev) => { state.format = ev.target.value; render(); }},
            ...Object.keys(FORMAT_LABELS).map((k) => el("option", {value: k}, FORMAT_LABELS[k])));
        const drawToggle = el("input", {type: "checkbox", checked: true, onchange: (ev) => { state.draw = ev.target.checked; syncData(); }});
        const drawLabel = el("label", {class: "regional-boxes-draw"}, drawToggle, " Draw the boxes on the input picture when generating");
        const resolved = el("span", {class: "regional-boxes-resolved"});
        const metaInput = el("input", {type: "text", class: "regional-boxes-meta", placeholder: "poster, flat illustration...",
            title: "Medium and genre of the picture, separated by commas (summary.meta)", oninput: (ev) => { state.meta = ev.target.value; }});
        const canvasSelect = el("select", {title: "One picture, panels, or a collage (summary.canvas)", onchange: (ev) => { state.canvas = ev.target.value; }},
            ...MOSS_CANVASES.map((k) => el("option", {value: k}, k.replace("_", " "))));
        const mossOptions = el("span", {class: "regional-boxes-moss"}, "Meta ", metaInput, " Canvas ", canvasSelect);
        const top = el("div", {class: "regional-boxes-top"}, el("span", {}, "Format "), formatSelect, resolved, tab === "img2img" ? drawLabel : "", mossOptions);

        const frame = el("div", {class: "regional-boxes-frame"});
        const background = el("img", {class: "regional-boxes-bg", draggable: "false", alt: ""});
        const layer = el("div", {class: "regional-boxes-boxes"});
        frame.append(background, layer);
        const hint = el("div", {class: "regional-boxes-hint"});
        const warning = el("div", {class: "regional-boxes-warning"});
        const list = el("div", {class: "regional-boxes-list"});
        const readButton = el("button", {class: "lg secondary gradio-button", onclick: () => read()}, "Read from prompt");
        const writeButton = el("button", {class: "lg secondary gradio-button", onclick: () => write()}, "Write to prompt");
        const buttons = el("div", {class: "regional-boxes-buttons"},
            writeButton,
            readButton,
            el("button", {class: "lg secondary gradio-button", onclick: () => clear()}, "Clear"));
        host.append(top, hint, warning, frame, list, buttons);

        const prompt = () => app.querySelector(`#${tab}_prompt textarea`);
        const dataBox = () => app.querySelector(`#regional_boxes_${tab}_data textarea`);
        const format = () => resolveFormat(state.format,
            app.querySelector("#forge_ui_preset input")?.value, app.querySelector("#setting_sd_model_checkpoint input")?.value);

        const size = () => [numberOf(app, `${tab}_width`, 1024), numberOf(app, `${tab}_height`, 1024)];

        // MOSS boxes are pixels of the Width x Height they were written at: say so when the size has changed since
        function checkSize() {
            const ta = prompt();
            const [w, h] = size();
            let text = "";
            if (format() === FORMATS.moss && ta && parseMoss(ta.value)) {
                const [ww, wh] = state.written || [];
                if (state.written && (ww !== w || wh !== h)) {
                    text = `⚠ The layout in the prompt was written for ${ww}x${wh}, and the picture is now ${w}x${h}: click Write to prompt again so the boxes match.`;
                } else if (mossOutOfBounds(ta.value, w, h)) {
                    text = `⚠ The layout in the prompt has boxes past the ${w}x${h} picture: it was written for another size. Set that size, or Read it and Write to prompt again.`;
                }
            }
            warning.textContent = text;
            warning.style.display = text ? "" : "none";
        }

        function syncData() {
            // only "Marks on image" in img2img draws anything; anything else clears the boxes the script would draw
            const marks = format() === FORMATS.marks && tab === "img2img";
            setValue(dataBox(), marks ? marksPayload(state.elements, state.draw) : "");
        }

        function fitFrame() {
            const [w, h] = size();
            frame.style.aspectRatio = `${w} / ${h}`;
            // a tall picture hits the frame's max-height (640px, style.css) first: narrow it too, or it would lose its shape
            frame.style.maxWidth = `min(512px, ${Math.round(640 * w / h)}px)`;
            // the MOSS rows show pixels of the current size: rebuild them when it changes (only then, or the focus of the
            // field being clicked would be lost)
            if (`${w}x${h}` !== listedSize && format() === FORMATS.moss) renderList();
            checkSize();
            const img = tab === "img2img" ? app.querySelector("#img2img_image img.forge-image") : null;
            const src = img && img.getAttribute("src");
            if (src) {
                background.src = src;
                background.style.display = "";
            } else {
                background.removeAttribute("src");
                background.style.display = "none";
            }
        }

        function colorOf(e) {
            return PALETTE[e.color % PALETTE.length][1];
        }

        function nextColor() {
            const used = new Set(state.elements.map((e) => e.color % PALETTE.length));
            for (let i = 0; i < PALETTE.length; i++) if (!used.has(i)) return i;
            return state.elements.length;
        }

        function updateHint() {
            const fmt = format();
            resolved.textContent = state.format !== FORMATS.auto ? ""
                : fmt === FORMATS.coords ? "→ FLUX 3: coordinates" : fmt === FORMATS.marks ? "→ Qwen-Image 2.1: marks"
                    : fmt === FORMATS.moss ? "→ MOSS-Image: layout JSON" : "→ this model reads no boxes";
            drawLabel.style.display = fmt === FORMATS.marks ? "" : "none";
            mossOptions.style.display = fmt === FORMATS.moss ? "" : "none";
            readButton.style.display = fmt === FORMATS.coords || fmt === FORMATS.moss ? "" : "none";
            writeButton.disabled = fmt === FORMATS.none;
            const armed = state.armed && state.elements[state.armed.i];
            if (fmt === FORMATS.none) {
                hint.textContent = "Regional Boxes works with FLUX 3 Image Klein, Qwen-Image 2.1 and MOSS-Image: load one of them, or pick its format above.";
            } else if (fmt === FORMATS.marks && tab !== "img2img") {
                hint.textContent = "Marks are drawn on an input picture: use them in img2img. For a new picture, pick a model that reads coordinates (FLUX 3).";
            } else if (!armed && fmt === FORMATS.moss) {
                hint.textContent = "Describe the whole scene in the prompt, then drag on the frame to place each thing or text. "
                    + "Write to prompt turns it all into a MOSS-Image layout for the current Width and Height.";
            } else if (!armed && fmt === FORMATS.marks) {
                hint.textContent = "Drag over the input picture to draw a box, and say what to do inside it. Write to prompt adds one note per box.";
            } else if (!armed) {
                hint.textContent = "Drag on the frame to draw a box: each one becomes an element below. Name it, describe it, then Write to prompt.";
            } else if (state.armed.which === "src") {
                hint.textContent = `Drag where "${armed.id}" is now, in reference image ${Number(armed.ref) + 1}.`;
            } else {
                hint.textContent = `Drag where "${armed.id}" should go.`;
            }
        }

        function renderBoxes() {
            const fmt = format();
            const marks = fmt === FORMATS.marks, moss = fmt === FORMATS.moss;
            layer.replaceChildren();
            state.elements.forEach((e, i) => {
                for (const which of ["src", "tgt"]) {
                    const b = e[which];
                    const hidden = marks || moss ? which === "src"
                        : (which === "tgt" && e.kind === KINDS.remove) || (which === "src" && (e.kind === KINDS.place || e.kind === KINDS.add));
                    if (!b || hidden) continue;
                    const [t, l, bo, r] = normBox(b);
                    const label = marks ? colorName(e) : moss ? `${i + 1} ${mossLabel(e)}` : which === "src" ? `${e.id} (from)` : e.id;
                    const box = el("div", {class: `regional-boxes-box ${which}${i === state.selected ? " selected" : ""}`}, el("span", {}, label));
                    Object.assign(box.style, {top: `${t / 10}%`, left: `${l / 10}%`, height: `${(bo - t) / 10}%`, width: `${(r - l) / 10}%`, borderColor: colorOf(e)});
                    box.querySelector("span").style.background = colorOf(e);
                    layer.append(box);
                }
            });
        }

        function renderList() {
            const fmt = format();
            const marks = fmt === FORMATS.marks;
            listedSize = size().join("x");
            list.replaceChildren();
            state.elements.forEach((e, i) => {
                const deleteButton = el("button", {class: "secondary gradio-button", title: "Delete", onclick: () => remove(i)}, "✕");
                const swatch = el("span", {class: "regional-boxes-swatch", title: colorName(e), onclick: () => { state.selected = i; render(); }});
                swatch.style.background = colorOf(e);
                if (fmt === FORMATS.moss) {
                    list.append(mossRow(e, i, swatch, deleteButton));
                    return;
                }
                if (marks) {
                    // typing updates the state in place: rebuilding the list would drop the focus and the next click
                    const row = el("div", {class: `regional-boxes-row${i === state.selected ? " selected" : ""}${isMarked(e) ? "" : " incomplete"}`},
                        swatch, el("span", {class: "regional-boxes-color"}, colorName(e)),
                        el("input", {type: "text", class: "regional-boxes-desc", value: e.desc, placeholder: "What to do inside the box: add a red beanie, change the shirt to denim, remove it...",
                            oninput: (ev) => { e.desc = ev.target.value; row.classList.toggle("incomplete", !isMarked(e)); syncData(); }}),
                        el("button", {class: "secondary gradio-button", title: "Draw the box again", onclick: () => arm(i, "tgt")}, "Redraw"),
                        deleteButton);
                    list.append(row);
                    return;
                }
                const kind = el("select", {onchange: (ev) => {
                    e.kind = ev.target.value;
                    if ((e.kind === KINDS.ref || e.kind === KINDS.remove) && !e.src) arm(i, "src");
                    render();
                }}, ...Object.keys(LABELS).map((k) => el("option", {value: k}, LABELS[k])));
                kind.value = e.kind;
                const ref = el("select", {onchange: (ev) => { e.ref = parseInt(ev.target.value, 10); render(); }},
                    ...Array.from({length: 10}, (_, n) => el("option", {value: String(n)}, `ref ${n + 1}`)));
                ref.value = String(e.ref || 0);
                ref.style.display = e.kind === KINDS.ref || e.kind === KINDS.remove ? "" : "none";
                const needsSrc = e.kind === KINDS.ref || e.kind === KINDS.remove;
                const tagButton = el("button", {class: "secondary gradio-button", title: "Insert <name> at the cursor in the prompt", onclick: () => insertTag(e.id)}, `<${e.id}>`);
                const row = el("div", {class: `regional-boxes-row${i === state.selected ? " selected" : ""}${isComplete(e) ? "" : " incomplete"}`},
                    swatch,
                    el("input", {type: "text", value: e.id, title: "Name: the caption mentions it as <name>", oninput: (ev) => {
                        e.id = ev.target.value.trim().replace(/[\s<>"]+/g, "_");
                        tagButton.textContent = `<${e.id}>`;
                        row.classList.toggle("incomplete", !isComplete(e));
                        renderBoxes();
                    }}),
                    el("input", {type: "text", class: "regional-boxes-desc", value: e.desc, placeholder: "Short description: look, colors, material", oninput: (ev) => { e.desc = ev.target.value; }}),
                    kind, ref,
                    needsSrc ? el("button", {class: "secondary gradio-button", title: "Draw where it is in the reference", onclick: () => arm(i, "src")}, e.src ? "Redraw from" : "Draw from") : "",
                    e.kind !== KINDS.remove ? el("button", {class: "secondary gradio-button", title: "Draw where it goes", onclick: () => arm(i, "tgt")}, e.tgt ? "Redraw" : "Draw") : "",
                    tagButton, deleteButton);
                list.append(row);
            });
        }

        function mossRow(e, i, swatch, deleteButton) {
            // typing updates the state in place, as in the marks list: rebuilding the list would drop the focus
            const row = el("div", {class: `regional-boxes-row${i === state.selected ? " selected" : ""}${isMossComplete(e) ? "" : " incomplete"}`});
            const touch = () => row.classList.toggle("incomplete", !isMossComplete(e));
            const text = el("textarea", {class: "regional-boxes-text", rows: "1", placeholder: "The exact words to write (Enter for a new line)",
                oninput: (ev) => { e.text = ev.target.value; touch(); }});
            text.value = e.text || "";
            const label = el("select", {title: "What the box holds", onchange: (ev) => {
                e.label = ev.target.value;
                text.style.display = e.label === "text" ? "" : "none";
                touch();
                renderBoxes();
            }}, ...MOSS_LABELS.map((k) => el("option", {value: k}, k)));
            label.value = mossLabel(e);
            text.style.display = label.value === "text" ? "" : "none";
            row.append(swatch, el("span", {class: "regional-boxes-number"}, String(i + 1)), label,
                el("input", {type: "text", class: "regional-boxes-desc", value: e.desc,
                    placeholder: "How it looks: a flat blue mountain, a large dark-blue uppercase title...",
                    oninput: (ev) => { e.desc = ev.target.value; touch(); }}),
                text,
                el("button", {class: "secondary gradio-button", title: "Draw the box again", onclick: () => arm(i, "tgt")}, "Redraw"),
                deleteButton);
            if (e.tgt) row.append(mossCoords(e));
            return row;
        }

        // the box as the layout writes it, [top, left, bottom, right] in pixels from the picture's center; typing a value
        // moves that edge
        function mossCoords(e) {
            const [w, h] = size();
            const names = ["top", "left", "bottom", "right"];
            // text fields, not number ones: Gradio's theme stretches every number input to the full width
            const inputs = names.map((name) => el("input", {type: "text", inputmode: "numeric", class: "regional-boxes-coord",
                title: `${name}, in pixels from the center of the picture`,
                onchange: () => {
                    const values = inputs.map((input) => parseFloat(input.value));
                    if (values.some((v) => !Number.isFinite(v))) return show();
                    e.tgt = gridBox(values, w, h);
                    show();
                    renderBoxes();
                }}));
            function show() {
                mossBox(e.tgt, w, h).forEach((v, k) => { inputs[k].value = String(v); });
            }
            show();
            const cy = Math.floor(h / 2), cx = Math.floor(w / 2);
            return el("div", {class: "regional-boxes-coords", title: `On ${w}x${h}: y from ${-cy} to ${h - cy}, x from ${-cx} to ${w - cx}`},
                ...names.flatMap((name, k) => [el("span", {}, name), inputs[k]]),
                el("span", {class: "regional-boxes-coords-size"}, `px from the center, ${w}x${h}`));
        }

        function render() {
            shown = format();
            renderBoxes();
            renderList();
            updateHint();
            checkSize();
            syncData();
        }

        function arm(i, which) {
            state.selected = i;
            state.armed = {i, which};
            render();
        }

        function remove(i) {
            state.elements.splice(i, 1);
            state.selected = -1;
            state.armed = null;
            render();
        }

        function clear() {
            state.elements = [];
            state.selected = -1;
            state.armed = null;
            render();
        }

        function insertTag(id) {
            const ta = prompt();
            if (!ta) return;
            const tag = `<${id}>`;
            const at = ta.selectionStart ?? ta.value.length;
            setValue(ta, ta.value.slice(0, at) + tag + ta.value.slice(ta.selectionEnd ?? at));
            ta.focus();
            ta.selectionStart = ta.selectionEnd = at + tag.length;
        }

        function write() {
            const ta = prompt();
            if (!ta) return;
            const fmt = format();
            if (fmt === FORMATS.marks) setValue(ta, writeNotes(ta.value, buildNotes(state.elements)));
            else if (fmt === FORMATS.coords) setValue(ta, writeLayout(ta.value, buildLayout(state.elements)));
            else if (fmt === FORMATS.moss) {
                if (state.elements.some(isMossComplete) && !mossCaption(ta.value)) {
                    warning.textContent = "⚠ Describe the whole scene in the prompt first: it becomes the layout's caption.";
                    warning.style.display = "";
                    return;
                }
                const [w, h] = size();
                setValue(ta, writeMoss(ta.value, state.elements, w, h, {meta: parseMeta(state.meta), canvas: state.canvas}));
                state.written = parseMoss(ta.value) ? [w, h] : null;
                checkSize();
            }
            syncData();
        }

        function read() {
            const ta = prompt();
            if (!ta) return;
            if (format() === FORMATS.moss) {
                const [w, h] = size();
                const layout = readMoss(ta.value, w, h);
                state.elements = layout ? layout.elements : [];
                state.meta = metaInput.value = layout ? layout.meta : "";
                state.canvas = canvasSelect.value = layout ? layout.canvas : "single";
                state.written = layout ? [w, h] : null;
            } else {
                state.elements = readLayout(ta.value);
            }
            state.counter = state.elements.length;
            state.selected = -1;
            state.armed = null;
            render();
        }

        function point(ev) {
            const r = frame.getBoundingClientRect();
            return [clamp(((ev.clientY - r.top) / r.height) * 1000), clamp(((ev.clientX - r.left) / r.width) * 1000)];
        }

        let start = null, ghost = null;
        frame.addEventListener("mousedown", (ev) => {
            if (ev.button !== 0) return;
            ev.preventDefault();
            fitFrame();
            start = point(ev);
            ghost = el("div", {class: "regional-boxes-box ghost"});
            layer.append(ghost);
        });
        window.addEventListener("mousemove", (ev) => {
            if (!start || !ghost) return;
            const [t, l, b, r] = normBox([...start, ...point(ev)]);
            Object.assign(ghost.style, {top: `${t / 10}%`, left: `${l / 10}%`, height: `${(b - t) / 10}%`, width: `${(r - l) / 10}%`});
        });
        window.addEventListener("mouseup", (ev) => {
            if (!start) return;
            const box = normBox([...start, ...point(ev)]);
            start = null;
            if (ghost) ghost.remove();
            ghost = null;
            if (box[2] - box[0] < 10 || box[3] - box[1] < 10) {
                // a click, not a drag: select the smallest box under it (or nothing), and disarm
                const [y, x] = [box[0], box[1]];
                let best = -1, area = Infinity;
                state.elements.forEach((e, i) => {
                    for (const b of [e.tgt, e.src]) {
                        if (!b) continue;
                        const [t, l, bo, r] = normBox(b);
                        if (y >= t && y <= bo && x >= l && x <= r && (bo - t) * (r - l) < area) {
                            best = i;
                            area = (bo - t) * (r - l);
                        }
                    }
                });
                state.selected = best;
                state.armed = null;
                render();
                return;
            }
            const armed = state.armed && state.elements[state.armed.i];
            if (armed) {
                armed[state.armed.which] = box;
                // an element from a reference still needs where it goes, unless it is removed
                const next = state.armed.which === "src" && armed.kind === KINDS.ref && !armed.tgt ? "tgt" : null;
                state.armed = next ? {i: state.armed.i, which: next} : null;
            } else {
                state.counter += 1;
                state.elements.push({id: `obj_${state.counter}`, desc: "", kind: tab === "img2img" ? KINDS.add : KINDS.place,
                    tgt: box, src: null, ref: 0, color: nextColor(), label: "object", text: ""});
                state.selected = state.elements.length - 1;
            }
            render();
        });

        for (const id of [`${tab}_width`, `${tab}_height`]) {
            const node = app.querySelector(`#${id}`);
            if (node) node.addEventListener("input", fitFrame);
        }
        prompt()?.addEventListener("input", checkSize);
        // in Auto the format follows the loaded model: the list is rebuilt only when the effective format changes, since
        // rebuilding it on every click would drop the focus of the field being clicked
        let shown = null;
        function refreshFormat() {
            if (format() !== shown) render();
        }
        for (const id of ["forge_ui_preset", "setting_sd_model_checkpoint"]) {
            const node = app.querySelector(`#${id}`);
            if (node) node.addEventListener("change", () => setTimeout(refreshFormat, 100));
        }
        host.closest(".gradio-accordion, .block")?.addEventListener("click", () => setTimeout(() => { fitFrame(); refreshFormat(); }, 50));
        fitFrame();
        render();
    }

    onUiLoaded(() => {
        gradioApp().querySelectorAll(".regional-boxes[data-tab]").forEach((host) => {
            if (!host.dataset.ready) {
                host.dataset.ready = "1";
                initPanel(host);
            }
        });
    });
})();
