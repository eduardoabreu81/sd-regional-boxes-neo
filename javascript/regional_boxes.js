// Regional Boxes for Forge Neo
// Draw boxes on a frame shaped like the picture, and hand them to the model in the format it was trained on:
//
//   Coordinates (FLUX 3 Image Klein): a JSON list at the end of the prompt (Black Forest Labs' bounding box guide)
//     layout:    {"id", "bbox": [top, left, bottom, right], "desc"}
//     box edit:  {"id", "from": "target" | "ref_image_N", "src_bbox", "tgt_bbox" (null removes), "desc"}
//   Marks on image (Qwen-Image 2.1 and edit models that read marks): the boxes drawn into the img2img input in
//     named colors (scripts/regional_boxes.py), and a note per box in the prompt: "Inside the red box: ...".
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
    const FORMATS = {auto: "auto", coords: "coords", marks: "marks"};
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

    // Auto: FLUX 3 reads coordinates; the other models get marks
    function resolveFormat(choice, preset, checkpoint) {
        if (choice === FORMATS.coords || choice === FORMATS.marks) return choice;
        return /flux[-_.]?3/i.test(`${preset || ""} ${checkpoint || ""}`) ? FORMATS.coords : FORMATS.marks;
    }

    const api = {KINDS, FORMATS, PALETTE, buildLayout, writeLayout, readLayout, findLayoutSpan, elementJson, isComplete,
        buildNotes, writeNotes, marksPayload, resolveFormat};
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
        return;
    }
    window.RegionalBoxes = api;

    // ---- the panel ----

    const LABELS = {place: "place", add: "add new", ref: "from reference", remove: "remove"};
    const FORMAT_LABELS = {auto: "Auto (by the loaded model)", coords: "Coordinates in the prompt (FLUX 3)", marks: "Marks on the image (Qwen-Image 2.1)"};

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
        const state = {elements: [], selected: -1, armed: null, counter: 0, format: FORMATS.auto, draw: true};

        const formatSelect = el("select", {class: "regional-boxes-format", onchange: (ev) => { state.format = ev.target.value; render(); }},
            ...Object.keys(FORMAT_LABELS).map((k) => el("option", {value: k}, FORMAT_LABELS[k])));
        const drawToggle = el("input", {type: "checkbox", checked: true, onchange: (ev) => { state.draw = ev.target.checked; syncData(); }});
        const drawLabel = el("label", {class: "regional-boxes-draw"}, drawToggle, " Draw the boxes on the input picture when generating");
        const resolved = el("span", {class: "regional-boxes-resolved"});
        const top = el("div", {class: "regional-boxes-top"}, el("span", {}, "Format "), formatSelect, resolved, tab === "img2img" ? drawLabel : "");

        const frame = el("div", {class: "regional-boxes-frame"});
        const background = el("img", {class: "regional-boxes-bg", draggable: "false", alt: ""});
        const layer = el("div", {class: "regional-boxes-boxes"});
        frame.append(background, layer);
        const hint = el("div", {class: "regional-boxes-hint"});
        const list = el("div", {class: "regional-boxes-list"});
        const readButton = el("button", {class: "lg secondary gradio-button", onclick: () => read()}, "Read from prompt");
        const buttons = el("div", {class: "regional-boxes-buttons"},
            el("button", {class: "lg secondary gradio-button", onclick: () => write()}, "Write to prompt"),
            readButton,
            el("button", {class: "lg secondary gradio-button", onclick: () => clear()}, "Clear"));
        host.append(top, hint, frame, list, buttons);

        const prompt = () => app.querySelector(`#${tab}_prompt textarea`);
        const dataBox = () => app.querySelector(`#regional_boxes_${tab}_data textarea`);
        const format = () => resolveFormat(state.format,
            app.querySelector("#forge_ui_preset input")?.value, app.querySelector("#setting_sd_model_checkpoint input")?.value);

        function syncData() {
            // only "Marks on image" in img2img draws anything; anything else clears the boxes the script would draw
            const marks = format() === FORMATS.marks && tab === "img2img";
            setValue(dataBox(), marks ? marksPayload(state.elements, state.draw) : "");
        }

        function fitFrame() {
            const w = numberOf(app, `${tab}_width`, 1024), h = numberOf(app, `${tab}_height`, 1024);
            frame.style.aspectRatio = `${w} / ${h}`;
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
            resolved.textContent = state.format === FORMATS.auto ? `→ ${fmt === FORMATS.coords ? "coordinates" : "marks"}` : "";
            drawLabel.style.display = fmt === FORMATS.marks ? "" : "none";
            readButton.style.display = fmt === FORMATS.coords ? "" : "none";
            const armed = state.armed && state.elements[state.armed.i];
            if (fmt === FORMATS.marks && tab !== "img2img") {
                hint.textContent = "Marks are drawn on an input picture: use them in img2img. For a new picture, pick a model that reads coordinates (FLUX 3).";
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
            const marks = format() === FORMATS.marks;
            layer.replaceChildren();
            state.elements.forEach((e, i) => {
                for (const which of ["src", "tgt"]) {
                    const b = e[which];
                    const hidden = marks ? which === "src"
                        : (which === "tgt" && e.kind === KINDS.remove) || (which === "src" && (e.kind === KINDS.place || e.kind === KINDS.add));
                    if (!b || hidden) continue;
                    const [t, l, bo, r] = normBox(b);
                    const label = marks ? colorName(e) : which === "src" ? `${e.id} (from)` : e.id;
                    const box = el("div", {class: `regional-boxes-box ${which}${i === state.selected ? " selected" : ""}`}, el("span", {}, label));
                    Object.assign(box.style, {top: `${t / 10}%`, left: `${l / 10}%`, height: `${(bo - t) / 10}%`, width: `${(r - l) / 10}%`, borderColor: colorOf(e)});
                    box.querySelector("span").style.background = colorOf(e);
                    layer.append(box);
                }
            });
        }

        function renderList() {
            const marks = format() === FORMATS.marks;
            list.replaceChildren();
            state.elements.forEach((e, i) => {
                const deleteButton = el("button", {class: "secondary gradio-button", title: "Delete", onclick: () => remove(i)}, "✕");
                const swatch = el("span", {class: "regional-boxes-swatch", title: colorName(e), onclick: () => { state.selected = i; render(); }});
                swatch.style.background = colorOf(e);
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

        function render() {
            shown = format();
            renderBoxes();
            renderList();
            updateHint();
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
            if (format() === FORMATS.marks) setValue(ta, writeNotes(ta.value, buildNotes(state.elements)));
            else setValue(ta, writeLayout(ta.value, buildLayout(state.elements)));
            syncData();
        }

        function read() {
            const ta = prompt();
            if (!ta) return;
            state.elements = readLayout(ta.value);
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
                    tgt: box, src: null, ref: 0, color: nextColor()});
                state.selected = state.elements.length - 1;
            }
            render();
        });

        for (const id of [`${tab}_width`, `${tab}_height`]) {
            const node = app.querySelector(`#${id}`);
            if (node) node.addEventListener("input", fitFrame);
        }
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
