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

    // ---- JSON that sd-dynamic-prompts went through ----
    // It reads every {...} in the prompt as a choice of one and drops the braces, so a layout reaches the model, and
    // the prompt Forge saves, as "summary":"canvas":"single",...,"items":["label":...,"bbox":[...],"label":...],...
    // The keys are still there to put the braces back: in a list, the list's first key starting again (or a key seen
    // twice) begins the next object; a key with another key right after it opens an object of its own.

    const NESTED = {};

    // a reader of stripped JSON at text[at]: pairs() reads "key": value pairs until something else comes (a value is
    // NESTED where an object begins), list() a [ ... ] list, end() where it got to. Both throw on anything malformed
    function strippedReader(text, at) {
        let i = at;
        const fail = () => { throw new Error("not stripped JSON"); };
        const space = () => { while (i < text.length && /\s/.test(text[i])) i++; };
        const string = () => {
            const start = i++;
            while (i < text.length) {
                if (text[i] === "\\") i += 2;
                else if (text[i++] === '"') return JSON.parse(text.slice(start, i));
            }
            return fail();
        };
        const isKey = () => {
            if (text[i] !== '"') return false;
            const from = i;
            try {
                string();
                space();
                return text[i] === ":";
            } catch (e) {
                return false;
            } finally {
                i = from;
            }
        };
        function pairs() {
            const out = [];
            for (;;) {
                space();
                while (text[i] === ",") { i++; space(); }
                if (!isKey()) return out;
                const key = string();
                space();
                i++;
                space();
                out.push([key, isKey() ? NESTED : value()]);
            }
        }
        function value() {
            if (text[i] === '"') return string();
            if (text[i] === "[") return list();
            const m = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
            if (!m) fail();
            i += m[0].length;
            return JSON.parse(m[0]);
        }
        function list() {
            if (text[i] !== "[") fail();
            i++;
            space();
            const out = [];
            if (isKey()) {
                let item = null, first = null;
                for (const [key, v] of pairs()) {
                    if (first === null) first = key;
                    if (!item || key === first || key in item) out.push(item = {});
                    item[key] = v;
                }
            } else {
                for (;;) {
                    space();
                    if (text[i] === ",") { i++; continue; }
                    if (text[i] === "]" || i >= text.length) break;
                    out.push(value());
                }
            }
            space();
            if (text[i] !== "]") fail();
            i++;
            return out;
        }
        return {pairs, list, end: () => i};
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
            try {
                list = strippedReader(prompt, span[0]).list();
            } catch (e2) {
                return [];
            }
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

    function isLayout(o) {
        return !!o && typeof o === "object" && Array.isArray(o.items) && !!o.summary && typeof o.summary === "object" && !Array.isArray(o.summary);
    }

    // where the JSON object at the start of text ends, strings skipped; -1 when it never closes
    function objectEnd(text) {
        let depth = 0, inString = false, escaped = false;
        for (let i = 0; i < text.length; i++) {
            const c = text[i];
            if (inString) {
                if (escaped) escaped = false;
                else if (c === "\\") escaped = true;
                else if (c === '"') inString = false;
            } else if (c === '"') inString = true;
            else if (c === "{") depth++;
            else if (c === "}" && --depth === 0) return i + 1;
        }
        return -1;
    }

    const MOSS_ROOT_KEYS = ["summary", "items", "bbox_coord_space", "bbox_format"];

    // the prompt split into its layout (null when it holds none), the words after the layout and Forge's tags. The layout
    // may be intact, have lost its braces to sd-dynamic-prompts (stripped), or have its parentheses escaped as \( \) for
    // Forge's emphasis, the way Forge's own JSON Builder writes it
    function mossParts(prompt) {
        const {text, tags} = splitTags(prompt);
        const parts = (layout, end, stripped) => ({layout, stripped, tags,
            rest: layout ? text.slice(end).replace(/^[\s,]+|[\s,]+$/g, "").replace(/\s*,[\s,]*/g, ", ") : ""});
        if (text.startsWith("{")) {
            const end = objectEnd(text);
            try {
                const o = JSON.parse(text.slice(0, end).replace(/(?<!\\)((?:\\\\)*)\\([()])/g, "$1$2"));
                if (end > 0 && isLayout(o)) return parts(o, end, false);
            } catch (e) {
                // not JSON: the prompt is a plain scene
            }
        } else if (/^"(summary|items)"\s*:/.test(text)) {
            // the summary's keys follow "summary": until a root key closes it again
            try {
                const reader = strippedReader(text, 0);
                const layout = {};
                let into = layout;
                for (const [key, v] of reader.pairs()) {
                    if (v === NESTED) into = layout[key] = {};
                    else if (MOSS_ROOT_KEYS.includes(key)) (into = layout)[key] = v;
                    else into[key] = v;
                }
                if (isLayout(layout)) return parts(layout, reader.end(), true);
            } catch (e) {
                // a scene that only starts like a layout
            }
        }
        return parts(null, 0, false);
    }

    // whether the prompt holds a layout, of either format, that has lost its braces
    function layoutStripped(prompt) {
        if (mossParts(prompt).stripped) return true;
        const span = findLayoutSpan(prompt);
        if (!span) return false;
        try {
            JSON.parse(prompt.slice(span[0], span[1]));
            return false;
        } catch (e) {
            try {
                return strippedReader(prompt, span[0]).list().length > 0;
            } catch (e2) {
                return false;
            }
        }
    }

    // the layout the prompt holds, or null when the prompt is not one
    function parseMoss(prompt) {
        return mossParts(prompt).layout;
    }

    // the layout as the prompt holds it, then the words that came after it and Forge's tags
    function joinMoss(json, parts) {
        return [json, parts.rest, parts.tags.join(" ")].filter(Boolean).join(" ");
    }

    // the scene caption: the summary's when the prompt already is a layout, else the prompt itself
    function mossCaption(prompt) {
        const current = parseMoss(prompt);
        return current ? String(current.summary.caption || "").trim() : splitTags(prompt).text;
    }

    function parseMeta(text) {
        return String(text || "").split(",").map((s) => s.trim()).filter(Boolean);
    }

    // the prompt with the boxes as a layout; without boxes, a layout turns back into its caption. options.caption stands in
    // for a prompt with no scene in it
    function writeMoss(prompt, elements, w, h, options) {
        const parts = mossParts(prompt);
        const current = parts.layout;
        const caption = mossCaption(prompt) || String((options && options.caption) || "").trim();
        const items = elements.filter(isMossComplete).map((e) => mossItem(e, w, h));
        if (!items.length) return current ? joinMoss(caption, parts) : prompt;
        const before = current ? current.summary : {};
        const meta = options && options.meta && options.meta.length ? options.meta : before.meta;
        const summary = {};
        if (Array.isArray(meta) && meta.length) summary.meta = meta;
        summary.canvas = MOSS_CANVASES.includes(options && options.canvas) ? options.canvas : before.canvas || "single";
        summary.caption = caption;
        if (before.palette) summary.palette = before.palette;
        return joinMoss(JSON.stringify({summary, items, bbox_coord_space: "abs_centralized", bbox_format: "yxyx"}), parts);
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

    // the layout with the panel's boxes moved to a to = [w, h] picture, or null when its boxes are not the ones the panel
    // wrote for from = [w, h] (edited by hand, or another layout): the boxes are recomputed from the panel's own, so going
    // back and forth between sizes never drifts, and anything else in the layout (captions, words) is kept as it is
    function rescaleMoss(prompt, elements, from, to) {
        const parts = mossParts(prompt);
        const layout = parts.layout;
        const done = elements.filter(isMossComplete);
        if (!layout || done.length !== layout.items.length) return null;
        const ours = layout.items.every((o, i) => Array.isArray(o && o.bbox) &&
            JSON.stringify(o.bbox) === JSON.stringify(mossBox(done[i].tgt, from[0], from[1])));
        if (!ours) return null;
        layout.items.forEach((o, i) => { o.bbox = mossBox(done[i].tgt, to[0], to[1]); });
        return joinMoss(JSON.stringify(layout), parts);
    }

    // ---- moving and resizing a drawn box (0-1000 grid) ----

    // the box moved by [dy, dx], kept whole inside the picture
    function moveBox(box, dy, dx) {
        const [t, l, b, r] = exactBox(box);
        const y = Math.max(-t, Math.min(1000 - b, dy)), x = Math.max(-l, Math.min(1000 - r, dx));
        return [t + y, l + x, b + y, r + x];
    }

    // the box with one corner ("nw", "ne", "sw", "se") dragged to [y, x]; a box too thin to see keeps its old shape
    function resizeBox(box, corner, [y, x]) {
        let [t, l, b, r] = exactBox(box);
        if (corner.includes("n")) t = y; else b = y;
        if (corner.includes("w")) l = x; else r = x;
        const next = exactBox([t, l, b, r]);
        return next[2] - next[0] < 10 || next[3] - next[1] < 10 ? exactBox(box) : next;
    }

    // the box centered across ("x") or down ("y") a w x h picture, its size kept; worked out in the layout's pixels, so
    // a MOSS-Image box comes out symmetric around the center (left = -right, one pixel apart at most for an odd width)
    function centerBox(box, axis, w, h) {
        const [y1, x1, y2, x2] = mossBox(box, w, h);
        const [a, b] = axis === "x" ? [x1, x2] : [y1, y2];
        const start = -Math.floor((b - a) / 2);
        const pixels = axis === "x" ? [y1, start, y2, start + b - a] : [start, x1, start + b - a, x2];
        const grid = gridBox(pixels, w, h);
        const kept = exactBox(box);
        return axis === "x" ? [kept[0], grid[1], kept[2], grid[3]] : [grid[0], kept[1], grid[2], kept[3]];
    }

    // img2img's "Resize by" size, from Forge's own preview: "resize: from 1024x768 to 1536x1152"
    function resizeByTarget(preview) {
        const m = /to\s*(\d+)\s*x\s*(\d+)/.exec(String(preview || ""));
        return m && +m[1] > 0 && +m[2] > 0 ? [+m[1], +m[2]] : null;
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
        mossParts, layoutStripped, mossCaption, parseMeta, writeMoss, readMoss, mossOutOfBounds, rescaleMoss, moveBox, resizeBox, centerBox, resizeByTarget,
        resolveFormat};
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
        // alert: why the last Write to prompt did nothing, shown until the prompt changes
        // caption: the scene of the last layout written or read, for when the prompt has been cleared since
        // last: txt2img shows its last picture behind the boxes
        const state = {elements: [], selected: -1, armed: null, counter: 0, format: FORMATS.auto, draw: true,
            meta: "", canvas: "single", written: null, note: "", alert: "", caption: "", last: true};
        let listedSize = "";

        const formatSelect = el("select", {class: "regional-boxes-format", onchange: (ev) => { state.format = ev.target.value; render(); }},
            ...Object.keys(FORMAT_LABELS).map((k) => el("option", {value: k}, FORMAT_LABELS[k])));
        const drawToggle = el("input", {type: "checkbox", checked: true, onchange: (ev) => { state.draw = ev.target.checked; syncData(); }});
        const drawLabel = el("label", {class: "regional-boxes-draw"}, drawToggle, " Draw the boxes on the input picture when generating");
        const lastToggle = el("input", {type: "checkbox", checked: true, onchange: (ev) => { state.last = ev.target.checked; showBackground(); }});
        const lastLabel = el("label", {class: "regional-boxes-draw", title: "Stretched to the current Width and Height"},
            lastToggle, " Show the last picture behind the boxes");
        const resolved = el("span", {class: "regional-boxes-resolved"});
        const metaInput = el("input", {type: "text", class: "regional-boxes-meta", placeholder: "poster, flat illustration...",
            title: "Medium and genre of the picture, separated by commas (summary.meta)", oninput: (ev) => { state.meta = ev.target.value; }});
        const canvasSelect = el("select", {title: "One picture, panels, or a collage (summary.canvas)", onchange: (ev) => { state.canvas = ev.target.value; }},
            ...MOSS_CANVASES.map((k) => el("option", {value: k}, k.replace("_", " "))));
        const mossOptions = el("span", {class: "regional-boxes-moss"}, "Meta ", metaInput, " Canvas ", canvasSelect);
        const top = el("div", {class: "regional-boxes-top"}, el("span", {}, "Format "), formatSelect, resolved, tab === "img2img" ? drawLabel : lastLabel, mossOptions);

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

        // the size of the picture to make: Width x Height, or in img2img's "Resize by" tab the size Forge shows it will be
        function size() {
            if (tab === "img2img" && /resize by/i.test(app.querySelector("#img2img_tabs_resize button.selected")?.textContent || "")) {
                const by = resizeByTarget(app.querySelector("#img2img_scale_resolution_preview")?.textContent);
                if (by) return by;
            }
            return [numberOf(app, `${tab}_width`, 1024), numberOf(app, `${tab}_height`, 1024)];
        }

        // a new size: the MOSS layout in the prompt follows it, when its boxes are still the panel's
        function rescale() {
            const ta = prompt();
            const [w, h] = size();
            if (format() !== FORMATS.moss || !ta || !state.written || (state.written[0] === w && state.written[1] === h)) return;
            const next = rescaleMoss(ta.value, state.elements, state.written, [w, h]);
            if (!next) return;
            state.note = `The layout's boxes were moved to fit the new size, ${w}x${h}.`;
            state.written = [w, h];
            setValue(ta, next);
        }

        // sd-dynamic-prompts' own switch in this tab: on, it drops the braces of the layout before the model reads it
        const dynamicPrompts = () => app.querySelector(`#tab_${tab} #sddp-dynamic-prompts-enabled input[type=checkbox]`);

        // the warnings the formats that write JSON share, then MOSS's own about the size
        function checkSize() {
            const lines = [];
            if ((format() === FORMATS.coords || format() === FORMATS.moss) && dynamicPrompts()?.checked) {
                lines.push("⚠ Dynamic Prompts is on: it removes the layout's { } before the model reads it, so the boxes are lost. "
                    + "Turn off Dynamic Prompts enabled in its accordion below.");
            }
            const ta = prompt();
            if (ta && (format() === FORMATS.coords || format() === FORMATS.moss) && layoutStripped(ta.value)) {
                lines.push("⚠ The layout in the prompt lost its { }: click Read from prompt, then Write to prompt, to put them back.");
            }
            lines.push(mossWarning());
            const text = lines.filter(Boolean).join("\n");
            warning.textContent = text;
            warning.style.display = text ? "" : "none";
        }

        // MOSS boxes are pixels of the Width x Height they were written at: say so when the size has changed since
        function mossWarning() {
            const ta = prompt();
            const [w, h] = size();
            let text = format() === FORMATS.moss ? state.alert : "";
            if (!text && format() === FORMATS.moss && ta && parseMoss(ta.value)) {
                const [ww, wh] = state.written || [];
                if (state.written && (ww !== w || wh !== h)) {
                    text = `⚠ The layout in the prompt was written for ${ww}x${wh}, and the picture is now ${w}x${h}; its boxes were changed by hand, so they were not moved: click Write to prompt again so they match.`;
                } else if (mossOutOfBounds(ta.value, w, h)) {
                    text = `⚠ The layout in the prompt has boxes past the ${w}x${h} picture: it was written for another size. Set that size, or Read it and Write to prompt again.`;
                } else if (state.written && !rescaleMoss(ta.value, state.elements, state.written, state.written)) {
                    text = "⚠ The boxes in the panel are not the ones in the prompt any more: click Write to prompt to update the layout.";
                }
            }
            if (!text && state.note && format() === FORMATS.moss && ta && parseMoss(ta.value)) text = `✓ ${state.note}`;
            return text;
        }

        function syncData() {
            // only "Marks on image" in img2img draws anything; anything else clears the boxes the script would draw
            const marks = format() === FORMATS.marks && tab === "img2img";
            setValue(dataBox(), marks ? marksPayload(state.elements, state.draw) : "");
        }

        function fitFrame() {
            rescale();
            const [w, h] = size();
            frame.style.aspectRatio = `${w} / ${h}`;
            // a tall picture hits the frame's max-height (640px, style.css) first: narrow it too, or it would lose its shape
            frame.style.maxWidth = `min(512px, ${Math.round(640 * w / h)}px)`;
            // the MOSS rows show pixels of the current size: rebuild them when it changes (only then, or the focus of the
            // field being clicked would be lost)
            if (`${w}x${h}` !== listedSize && format() === FORMATS.moss) renderList();
            checkSize();
            showBackground();
        }

        // the picture behind the boxes: img2img's input, or in txt2img the picture the gallery shows (the selected one,
        // else the first), never the live preview of a generation still running
        function backgroundImage() {
            if (tab === "img2img") return app.querySelector("#img2img_image img.forge-image");
            if (!state.last) return null;
            const gallery = app.querySelector("#txt2img_gallery");
            if (!gallery) return null;
            const pick = (selector) => Array.from(gallery.querySelectorAll(selector)).find((img) => !img.closest(".livePreview"));
            return pick("[data-testid='detailed-image']") || pick(".thumbnail-item.selected img") || pick(".thumbnail-item img");
        }

        function showBackground() {
            const img = backgroundImage();
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
                    // the name tag moves the box and the corners of the selected box resize it; the rest of the box stays
                    // free, so a box can be drawn inside another
                    const tag = el("span", {class: "regional-boxes-tag", title: "Drag to move the box",
                        onmousedown: (ev) => grab(ev, i, which, "move")}, label);
                    const box = el("div", {class: `regional-boxes-box ${which}${i === state.selected ? " selected" : ""}`}, tag);
                    Object.assign(box.style, {top: `${t / 10}%`, left: `${l / 10}%`, height: `${(bo - t) / 10}%`, width: `${(r - l) / 10}%`, borderColor: colorOf(e)});
                    tag.style.background = colorOf(e);
                    if (i === state.selected) {
                        for (const corner of ["nw", "ne", "sw", "se"]) {
                            const handle = el("div", {class: `regional-boxes-handle ${corner}`, title: "Drag to resize the box",
                                onmousedown: (ev) => grab(ev, i, which, corner)});
                            handle.style.borderColor = colorOf(e);
                            box.append(handle);
                        }
                    }
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
                        ...centerButtons(e),
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
                    ...(e.kind !== KINDS.remove ? centerButtons(e) : []), tagButton, deleteButton);
                list.append(row);
            });
        }

        // centers the box across or down the picture, keeping its size
        function centerButtons(e) {
            if (!e.tgt) return [];
            const go = (axis) => {
                const [w, h] = size();
                e.tgt = centerBox(e.tgt, axis, w, h);
                render();
            };
            return [el("button", {class: "secondary gradio-button regional-boxes-center", title: "Center the box across the picture",
                onclick: () => go("x")}, "⇔"),
            el("button", {class: "secondary gradio-button regional-boxes-center", title: "Center the box down the picture",
                onclick: () => go("y")}, "⇕")];
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
                el("span", {class: "regional-boxes-coords-size"}, `px from the center, ${w}x${h}`), ...centerButtons(e));
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
                const reused = !mossCaption(ta.value) && state.caption;
                // through checkSize, which the click on the panel runs right after and would otherwise clear it
                if (state.elements.some(isMossComplete) && !mossCaption(ta.value) && !reused) {
                    state.alert = "⚠ Describe the whole scene in the prompt first: it becomes the layout's caption.";
                    checkSize();
                    return;
                }
                state.alert = "";
                const [w, h] = size();
                setValue(ta, writeMoss(ta.value, state.elements, w, h, {meta: parseMeta(state.meta), canvas: state.canvas, caption: state.caption}));
                state.written = parseMoss(ta.value) ? [w, h] : null;
                if (state.written) state.caption = mossCaption(ta.value);
                state.note = state.written && reused ? "The prompt had no scene, so the layout keeps the last one: edit its caption to change it." : "";
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
                if (layout) state.caption = mossCaption(ta.value);
                state.note = "";
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
        // a box taken by its tag (mode "move") or by a corner ("nw", "ne", "sw", "se"): {i, which, mode, from, box}
        let held = null;

        function rawPoint(ev) {
            const r = frame.getBoundingClientRect();
            return [((ev.clientY - r.top) / r.height) * 1000, ((ev.clientX - r.left) / r.width) * 1000];
        }

        function grab(ev, i, which, mode) {
            if (ev.button !== 0) return;
            // the frame below would start a new box
            ev.preventDefault();
            ev.stopPropagation();
            state.selected = i;
            state.armed = null;
            held = {i, which, mode, from: rawPoint(ev), box: state.elements[i][which]};
            renderBoxes();
        }
        frame.addEventListener("mousedown", (ev) => {
            if (ev.button !== 0) return;
            ev.preventDefault();
            fitFrame();
            start = point(ev);
            ghost = el("div", {class: "regional-boxes-box ghost"});
            layer.append(ghost);
        });
        window.addEventListener("mousemove", (ev) => {
            if (held) {
                const [y, x] = rawPoint(ev);
                state.elements[held.i][held.which] = held.mode === "move"
                    ? moveBox(held.box, Math.round(y - held.from[0]), Math.round(x - held.from[1]))
                    : resizeBox(held.box, held.mode, [clamp(y), clamp(x)]);
                renderBoxes();
                return;
            }
            if (!start || !ghost) return;
            const [t, l, b, r] = normBox([...start, ...point(ev)]);
            Object.assign(ghost.style, {top: `${t / 10}%`, left: `${l / 10}%`, height: `${(b - t) / 10}%`, width: `${(r - l) / 10}%`});
        });
        window.addEventListener("mouseup", (ev) => {
            if (held) {
                held = null;
                render();
                return;
            }
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
        prompt()?.addEventListener("input", () => { state.alert = ""; checkSize(); });
        dynamicPrompts()?.addEventListener("change", checkSize);
        if (tab === "img2img") {
            // "Resize to" / "Resize by", the scale and the input picture all change the size Forge's preview shows
            app.querySelector("#img2img_tabs_resize")?.addEventListener("click", () => setTimeout(fitFrame, 100));
            const preview = app.querySelector("#img2img_scale_resolution_preview");
            if (preview) new MutationObserver(() => fitFrame()).observe(preview, {childList: true, subtree: true, characterData: true});
        } else {
            // a new picture, or another one picked in the gallery
            const gallery = app.querySelector("#txt2img_gallery");
            if (gallery) new MutationObserver(showBackground).observe(gallery, {childList: true, subtree: true, attributes: true, attributeFilter: ["src", "class"]});
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
