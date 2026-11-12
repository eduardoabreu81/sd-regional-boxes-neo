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
//   World-state caption (PAN 2): the whole prompt becomes PAN 2's JSON description of a clip; instead of the frame,
//     a timeline of events, camera moves and the actions of each subject.
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
    const FORMATS = {auto: "auto", coords: "coords", marks: "marks", moss: "moss", pan2: "pan2", none: "none"};
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

    // the boxes drawn as marks: the described ones, one per color. The palette has 8 colors: a box sharing one with an
    // earlier box (more than 8, from another format or read from a prompt) is left out, or "Inside the red box" would
    // name two boxes
    function marksOf(elements) {
        const seen = new Set();
        return elements.filter((e) => {
            if (!isMarked(e) || seen.has(colorName(e))) return false;
            seen.add(colorName(e));
            return true;
        });
    }

    function joinNames(names) {
        if (names.length < 2) return names.join("");
        return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
    }

    // "Inside the red box: add a beanie. ... Remove the red and blue box outlines from the image. Keep ..."
    function buildNotes(elements) {
        const marked = marksOf(elements);
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
            boxes: marksOf(elements).map((e) => ({color: colorName(e), bbox: normBox(e.tgt)})),
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

    // the box's tag on the frame: its number and what it holds (a text box's words, else its caption), shortened; only
    // its label while it holds nothing yet. Shown only: the layout has no name for an item
    function mossTag(el, i) {
        const words = String((mossLabel(el) === "text" && String(el.text || "").trim()) || el.desc || "").replace(/\s+/g, " ").trim();
        const shown = words.length > 24 ? `${words.slice(0, 23).trimEnd()}…` : words;
        return `${i + 1} ${shown || mossLabel(el)}`;
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

    // splitTags for a prompt that holds a layout: a tag inside one of its strings (a box's caption) is the box's own and
    // stays there, where Forge still finds it; only the tags around the layout are taken out
    function splitOuterTags(prompt) {
        const text = String(prompt || "");
        const tag = new RegExp(NETWORK_TAG.source, "iy");
        let out = "", inString = false, escaped = false;
        const tags = [];
        for (let i = 0; i < text.length; i++) {
            const c = text[i];
            if (inString) {
                if (escaped) escaped = false;
                else if (c === "\\") escaped = true;
                else if (c === '"') inString = false;
            } else if (c === '"') inString = true;
            else if (c === "<") {
                tag.lastIndex = i;
                const m = tag.exec(text);
                if (m) {
                    tags.push(m[0]);
                    i += m[0].length - 1;
                    continue;
                }
            }
            out += c;
        }
        return {text: out.replace(/[ 	]{2,}/g, " ").trim(), tags};
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
        const found = findMoss(splitOuterTags(prompt));
        return found.layout ? found : {layout: null, stripped: false, tags: splitTags(prompt).tags, rest: ""};
    }

    function findMoss({text, tags}) {
        // a tag repeated after the layout, or already in one of its captions, is there once
        const outer = tags.filter((t, i) => tags.indexOf(t) === i);
        const parts = (layout, end, stripped) => ({layout, stripped,
            tags: layout ? outer.filter((t) => !text.slice(0, end).includes(t)) : outer,
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
    // A tag a box's caption already holds is not written again after it: Forge would load that LoRA once more
    function joinMoss(json, parts) {
        const inside = (t) => json.includes(t);
        const rest = String(parts.rest || "").replace(NETWORK_TAG, (t) => (inside(t) ? "" : t)).replace(/[ 	]{2,}/g, " ").trim();
        const tags = parts.tags.filter((t, i) => !inside(t) && parts.tags.indexOf(t) === i && !rest.includes(t));
        return [json, rest, tags.join(" ")].filter(Boolean).join(" ");
    }

    // the scene caption: the summary's when the prompt already is a layout, else the prompt itself
    function mossCaption(prompt) {
        const current = parseMoss(prompt);
        return current ? String(current.summary.caption || "").trim() : splitTags(prompt).text;
    }

    function parseMeta(text) {
        return String(text || "").split(",").map((s) => s.trim()).filter(Boolean);
    }

    // what follows the layout in the prompt: the words after it, then Forge's tags (the panel's Additional prompt)
    function mossExtra(prompt) {
        const parts = mossParts(prompt);
        return [parts.rest, parts.tags.join(" ")].filter(Boolean).join(" ");
    }

    // the prompt with the boxes as a layout; without boxes, a layout turns back into its caption.
    // options.caption is the panel's Scene: a scene typed as the plain prompt comes first, then it, then the caption of
    // the layout already there. options.extra, when given, replaces what follows the layout; a Forge tag the prompt has
    // and it lacks (one added from the LoRA tab since) is kept after it
    function writeMoss(prompt, elements, w, h, options) {
        const parts = mossParts(prompt);
        const current = parts.layout;
        const scene = String((options && options.caption) || "").trim();
        const caption = (!current && splitTags(prompt).text) || scene || mossCaption(prompt);
        if (options && typeof options.extra === "string") {
            const extra = options.extra.trim();
            const missing = parts.tags.filter((tag) => !extra.includes(tag));
            Object.assign(parts, {rest: extra, tags: missing});
        }
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

    // the box with a corner ("nw", "ne", "sw", "se") or a side ("n", "s", "e", "w") dragged to [y, x]; with keep (Shift)
    // it keeps its shape. A box too thin to see keeps its old shape
    function resizeBox(box, handle, [y, x], keep = false) {
        const old = exactBox(box);
        let [t, l, b, r] = old;
        if (keep && b > t && r > l) return keptShape(old, handle, [y, x]);
        if (handle.includes("n")) t = y; else if (handle.includes("s")) b = y;
        if (handle.includes("w")) l = x; else if (handle.includes("e")) r = x;
        const next = exactBox([t, l, b, r]);
        return next[2] - next[0] < 10 || next[3] - next[1] < 10 ? old : next;
    }

    // resizeBox with the shape kept: a corner grows the box from the opposite corner, a side from the opposite side and
    // around the box's middle the other way; the box shrinks to fit when it would leave the picture
    function keptShape(old, handle, [y, x]) {
        const [t, l, b, r] = old;
        const ratio = (b - t) / (r - l);
        const vertical = /[ns]/.test(handle), horizontal = /[we]/.test(handle);
        // the point that stays: the opposite corner, or the middle of the opposite side
        const ay = handle.includes("n") ? b : handle.includes("s") ? t : (t + b) / 2;
        const ax = handle.includes("w") ? r : handle.includes("e") ? l : (l + r) / 2;
        let height = Math.abs(y - ay), width = Math.abs(x - ax);
        if (!horizontal || (vertical && height > width * ratio)) width = height / ratio;
        else height = width * ratio;
        if (height < 10 || width < 10) return old;
        // which way it grows from there: toward the pointer, or both ways around the middle
        const sy = vertical ? (y < ay ? -1 : 1) : 0, sx = horizontal ? (x < ax ? -1 : 1) : 0;
        const room = (s, a) => (s < 0 ? a : s > 0 ? 1000 - a : 2 * Math.min(a, 1000 - a));
        const scale = Math.min(1, room(sy, ay) / height, room(sx, ax) / width);
        height *= scale;
        width *= scale;
        if (height < 10 || width < 10) return old;
        const top = sy < 0 ? ay - height : sy > 0 ? ay : ay - height / 2;
        const left = sx < 0 ? ax - width : sx > 0 ? ax : ax - width / 2;
        return exactBox([top, left, top + height, left + width].map(Math.round));
    }

    // ---- undo and redo ----
    // the panel's states before each change, newest last; a change with the same key as the one just before it (the
    // same field typed into, the same box moved with the arrow keys) is part of it
    function createHistory(limit = 100) {
        let past = [], future = [], lastKey = null;
        return {
            remember(snapshot, key = null) {
                if (key !== null && key === lastKey) return;
                past.push(snapshot);
                if (past.length > limit) past.shift();
                future = [];
                lastKey = key;
            },
            undo(current) {
                if (!past.length) return null;
                future.push(current);
                lastKey = null;
                return past.pop();
            },
            redo(current) {
                if (!future.length) return null;
                past.push(current);
                lastKey = null;
                return future.pop();
            },
            get canUndo() { return past.length > 0; },
            get canRedo() { return future.length > 0; },
        };
    }

    // ---- composition guides over the frame: where the lines cross it, as a share of its width and of its height ----
    const GUIDES = {off: [], thirds: [1 / 3, 2 / 3], center: [1 / 2], golden: [0.382, 0.618]};
    const GUIDE_LABELS = {off: "None", thirds: "Rule of thirds", center: "Center", golden: "Golden ratio"};

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

    // ---- World-state caption (PAN 2) ----
    // PAN 2 does not place things in the picture: it follows a scene through time. The whole prompt becomes its caption,
    // a JSON object with exactly these keys in this order (PAN 2's own prompt guide, inference/pan-prompt-rewriter):
    //   video_style, lighting, perspective_view, subjects_lifecycle [{subject_id, display_name, subject_attribute}],
    //   init_frame_visual_description, events [{event_index, time_range_sec, event_description,
    //   camera_motion [{time_range_sec, camera_motion: [tags]}], contained_actions [{time_range_sec, action}]}],
    //   quality {video_quality, text_logos_overlays, artifacts: null}
    // Events cover the clip from 0 to its end one after another, and so do the camera moves inside each event; an action
    // lies inside its event and starts with the subject's ID. Times are "a to b" in seconds with one decimal at most.
    //
    // The panel keeps times in tenths of a second (whole numbers): an event or camera move holds its end, the next one
    // starts there; an action holds its start and end. Subjects are numbered by their order: <|Subject1|>, <|Subject2|>...

    const PAN2_FPS = 24;
    const PAN2_CAMERA = ["static", "pan_left", "pan_right", "tilt_up", "tilt_down", "track_left", "track_right", "dolly_forward",
        "dolly_backward", "dolly_up", "dolly_down", "zoom_in", "zoom_out", "roll_clockwise", "roll_counterclockwise", "unstable"];
    // the prompt guide's ceiling for the first frame and for each event, in words
    const PAN2_MAX_WORDS = 200;
    const PAN2_ID = /^\s*<\|Subject(\d+)\|>\s*/;

    function pan2Id(i) {
        return `<|Subject${i + 1}|>`;
    }

    // the clip's length in tenths of a second, from Forge's Frames (first frame to last, at 24 fps)
    function pan2Duration(frames) {
        return Math.max(1, Math.round((Number(frames) - 1) / PAN2_FPS * 10));
    }

    function pan2Time(tenths) {
        return String(tenths / 10);
    }

    function pan2Range(a, b) {
        return `${pan2Time(a)} to ${pan2Time(b)}`;
    }

    // "2.5 to 6" -> [25, 60] in tenths; null for anything else
    function parsePan2Range(text) {
        const m = /^\s*(\d+(?:\.\d+)?)\s*to\s*(\d+(?:\.\d+)?)\s*$/.exec(String(text || ""));
        return m ? [Math.round(Number(m[1]) * 10), Math.round(Number(m[2]) * 10)] : null;
    }

    function pan2Event(end, tags) {
        return {end, desc: "", camera: [{end, tags: tags ? [...tags] : ["static"]}], actions: []};
    }

    // an empty description for a clip of duration tenths: one event, a static camera
    function newPan2(duration) {
        return {style: "", lighting: "", view: "", firstFrame: "", quality: "", overlays: "", subjects: [], events: [pan2Event(duration)]};
    }

    function pan2Start(model, k) {
        return k > 0 ? model.events[k - 1].end : 0;
    }

    function trimmed(v) {
        return String(v || "").trim();
    }

    // the caption as an object, keys in PAN 2's order
    function pan2Object(model) {
        const events = model.events.map((e, k) => {
            let from = pan2Start(model, k);
            const camera = e.camera.map((c) => {
                const out = {time_range_sec: pan2Range(from, c.end), camera_motion: [...c.tags]};
                from = c.end;
                return out;
            });
            const actions = e.actions.map((a) => ({time_range_sec: pan2Range(a.start, a.end),
                action: `${pan2Id(a.subject)} ${trimmed(a.text).replace(PAN2_ID, "")}`.trim()}));
            return {event_index: k, time_range_sec: pan2Range(pan2Start(model, k), e.end), event_description: trimmed(e.desc),
                camera_motion: camera, contained_actions: actions};
        });
        return {
            video_style: trimmed(model.style),
            lighting: trimmed(model.lighting),
            perspective_view: trimmed(model.view),
            subjects_lifecycle: model.subjects.map((s, i) => ({subject_id: pan2Id(i), display_name: trimmed(s.name),
                subject_attribute: trimmed(s.attribute)})),
            init_frame_visual_description: trimmed(model.firstFrame),
            events,
            quality: {video_quality: trimmed(model.quality), text_logos_overlays: trimmed(model.overlays) || null, artifacts: null},
        };
    }

    // compact JSON on one line, as PAN 2's rewriter serializes it
    function buildPan2(model) {
        return JSON.stringify(pan2Object(model));
    }

    function isPan2(o) {
        return !!o && typeof o === "object" && !Array.isArray(o) && Array.isArray(o.events) && "video_style" in o;
    }

    // the prompt split into its caption (null when it holds none), the words after it and Forge's tags
    function pan2Parts(prompt) {
        const {text, tags} = splitOuterTags(prompt);
        const outer = tags.filter((t, i) => tags.indexOf(t) === i);
        if (text.startsWith("{")) {
            const end = objectEnd(text);
            try {
                const caption = end > 0 ? JSON.parse(text.slice(0, end)) : null;
                if (isPan2(caption)) {
                    return {caption, tags: outer.filter((t) => !text.slice(0, end).includes(t)), rest: text.slice(end).trim()};
                }
            } catch (e) {
                // not JSON: a plain prompt
            }
        }
        return {caption: null, tags: splitTags(prompt).tags, rest: ""};
    }

    function parsePan2(prompt) {
        return pan2Parts(prompt).caption;
    }

    // what follows the caption in the prompt: words, then Forge's tags (the panel's Additional prompt)
    function pan2Extra(prompt) {
        const parts = pan2Parts(prompt);
        return [parts.rest, parts.tags.join(" ")].filter(Boolean).join(" ");
    }

    // the panel's description from a caption in the prompt, times as written; null when the prompt holds none
    function readPan2(prompt) {
        const o = parsePan2(prompt);
        if (!o) return null;
        const subjects = (Array.isArray(o.subjects_lifecycle) ? o.subjects_lifecycle : []).filter((s) => s && typeof s === "object");
        // actions name their subject by ID: the subjects are renumbered by their order
        const byId = new Map(subjects.map((s, i) => [String(s.subject_id || "").trim(), i]));
        const quality = o.quality && typeof o.quality === "object" ? o.quality : {};
        const model = {
            style: trimmed(o.video_style), lighting: trimmed(o.lighting), view: trimmed(o.perspective_view),
            firstFrame: trimmed(o.init_frame_visual_description), quality: trimmed(quality.video_quality),
            overlays: quality.text_logos_overlays ? trimmed(quality.text_logos_overlays) : "",
            subjects: subjects.map((s) => ({name: trimmed(s.display_name), attribute: trimmed(s.subject_attribute)})),
            events: [],
        };
        const events = o.events.filter((e) => e && typeof e === "object" && parsePan2Range(e.time_range_sec))
            .sort((a, b) => parsePan2Range(a.time_range_sec)[0] - parsePan2Range(b.time_range_sec)[0]);
        for (const e of events) {
            const [, end] = parsePan2Range(e.time_range_sec);
            const camera = (Array.isArray(e.camera_motion) ? e.camera_motion : [])
                .filter((c) => c && parsePan2Range(c.time_range_sec))
                .map((c) => ({end: parsePan2Range(c.time_range_sec)[1],
                    tags: (Array.isArray(c.camera_motion) ? c.camera_motion : []).map(String)}));
            const actions = (Array.isArray(e.contained_actions) ? e.contained_actions : [])
                .filter((a) => a && parsePan2Range(a.time_range_sec)).map((a) => {
                    const text = String(a.action || "");
                    const m = PAN2_ID.exec(text);
                    const id = m ? `<|Subject${m[1]}|>` : "";
                    const [start, stop] = parsePan2Range(a.time_range_sec);
                    return {subject: byId.has(id) ? byId.get(id) : 0, start, end: stop, text: m ? text.slice(m[0].length) : text};
                });
            model.events.push({end, desc: trimmed(e.event_description), camera: camera.length ? camera : [{end, tags: ["static"]}], actions});
        }
        if (!model.events.length) model.events.push(pan2Event(10));
        return model;
    }

    // the description fitted to a clip of duration tenths: the times keep their share of the clip, events and camera moves
    // stay one after another with at least a tenth each, and every action stays inside its event
    function fitPan2(model, duration) {
        const old = model.events[model.events.length - 1].end || duration;
        const scale = (t) => Math.round(t * duration / old);
        const fitted = {...model, subjects: model.subjects.map((s) => ({...s})), events: []};
        const n = model.events.length;
        let start = 0;
        model.events.forEach((e, k) => {
            const end = k === n - 1 ? duration : Math.min(Math.max(scale(e.end), start + 1), duration - (n - 1 - k));
            let from = start;
            const camera = e.camera.map((c, j) => {
                const last = j === e.camera.length - 1;
                const stop = last ? end : Math.min(Math.max(scale(c.end), from + 1), end - (e.camera.length - 1 - j));
                from = stop;
                return {end: stop, tags: [...c.tags]};
            });
            const actions = e.actions.map((a) => {
                const s = Math.min(Math.max(scale(a.start), start), end - 1);
                return {...a, start: s, end: Math.min(Math.max(scale(a.end), s + 1), end)};
            });
            fitted.events.push({...e, end, camera, actions});
            start = end;
        });
        return fitted;
    }

    function wordCount(text) {
        return trimmed(text).split(/\s+/).filter(Boolean).length;
    }

    // what PAN 2's prompt guide asks that the description does not do yet, one line each
    function checkPan2(model) {
        const out = [];
        const need = [["style", "Video style"], ["lighting", "Lighting"], ["view", "Perspective"], ["firstFrame", "First frame"]];
        for (const [key, name] of need) if (!trimmed(model[key])) out.push(`${name} is empty.`);
        if (wordCount(model.firstFrame) > PAN2_MAX_WORDS) out.push(`First frame has more than ${PAN2_MAX_WORDS} words.`);
        if (/<\|Subject\d+\|>/.test(model.firstFrame)) out.push("First frame names a subject by its ID: describe it in words; IDs belong in actions.");
        model.subjects.forEach((s, i) => {
            if (!trimmed(s.name) || !trimmed(s.attribute)) out.push(`${pan2Id(i)} needs a name and how it looks.`);
        });
        model.events.forEach((e, k) => {
            const name = `Event ${k + 1}`;
            const start = pan2Start(model, k);
            if (!trimmed(e.desc)) out.push(`${name} has no description.`);
            if (wordCount(e.desc) > PAN2_MAX_WORDS) out.push(`${name} has more than ${PAN2_MAX_WORDS} words.`);
            if (/<\|Subject\d+\|>/.test(e.desc)) out.push(`${name} names a subject by its ID: say it in words; IDs belong in actions.`);
            e.camera.forEach((c, j) => {
                const label = e.camera.length > 1 ? `${name}, camera ${j + 1}` : `${name}'s camera`;
                if (!c.tags.length) out.push(`${label} has no move: pick at least one (static for none).`);
                if (c.tags.includes("static") && c.tags.length > 1) out.push(`${label} is static and moving at once.`);
                const unknown = c.tags.filter((t) => !PAN2_CAMERA.includes(t));
                if (unknown.length) out.push(`${label} has moves PAN 2 does not know: ${unknown.join(", ")}.`);
            });
            e.actions.forEach((a, j) => {
                const label = `${name}, action ${j + 1}`;
                if (!model.subjects[a.subject]) out.push(`${label} belongs to no subject.`);
                if (!trimmed(a.text).replace(PAN2_ID, "")) out.push(`${label} says nothing.`);
                if (a.start < start || a.end > e.end || a.end <= a.start) out.push(`${label} is not inside its event (${pan2Range(start, e.end)} s).`);
            });
        });
        return out;
    }

    // the prompt with the description as PAN 2's caption, then options.extra (else what followed it already) and the
    // Forge tags the prompt has that the extra lacks
    function writePan2(prompt, model, options) {
        const parts = pan2Parts(prompt);
        if (options && typeof options.extra === "string") {
            const extra = options.extra.trim();
            Object.assign(parts, {rest: extra, tags: parts.tags.filter((tag) => !extra.includes(tag))});
        } else if (!parts.caption) {
            // a plain prompt is replaced: only its tags stay
            parts.rest = "";
        }
        return joinMoss(buildPan2(model), parts);
    }

    // Auto: coordinates for FLUX 3, marks for Qwen-Image 2.1, layout JSON for MOSS-Image, a world-state caption for PAN 2,
    // nothing for the other models
    function resolveFormat(choice, preset, checkpoint) {
        if (choice === FORMATS.coords || choice === FORMATS.marks || choice === FORMATS.moss || choice === FORMATS.pan2) return choice;
        const loaded = `${preset || ""} ${checkpoint || ""}`;
        if (preset === "pan2" || /(?<![a-z])pan[\s_.-]?2(?!\d)/i.test(checkpoint || "")) return FORMATS.pan2;
        if (/flux[-_.]?3/i.test(loaded)) return FORMATS.coords;
        if (preset === "qwen21" || /qwen[\s_.-]*(image)?[\s_.-]*2[\s_.]?1/i.test(checkpoint || "")) return FORMATS.marks;
        if (preset === "moss" || /moss/i.test(checkpoint || "")) return FORMATS.moss;
        return FORMATS.none;
    }

    const api = {KINDS, FORMATS, PALETTE, buildLayout, writeLayout, readLayout, findLayoutSpan, elementJson, isComplete,
        buildNotes, writeNotes, marksPayload, marksOf, MOSS_LABELS, MOSS_CANVASES, mossBox, gridBox, isMossComplete, mossTag, parseMoss,
        mossParts, mossExtra, layoutStripped, mossCaption, parseMeta, writeMoss, readMoss, mossOutOfBounds, rescaleMoss, moveBox, resizeBox, centerBox, resizeByTarget, createHistory, GUIDES,
        PAN2_CAMERA, pan2Id, pan2Duration, pan2Range, parsePan2Range, newPan2, pan2Object, buildPan2, parsePan2, pan2Parts, pan2Extra, readPan2,
        fitPan2, checkPan2, writePan2, resolveFormat};
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
        return;
    }
    window.RegionalBoxes = api;

    // ---- the panel ----

    const LABELS = {place: "place", add: "add new", ref: "from reference", remove: "remove"};
    const FORMAT_LABELS = {auto: "Auto (by the loaded model)", coords: "FLUX 3 Image Klein (coordinates in the prompt)", marks: "Qwen-Image 2.1 (marks on the picture)",
        moss: "MOSS-Image (layout JSON in the prompt)", pan2: "PAN 2 (timeline of the clip in the prompt)"};

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

    // a field Tag Autocomplete may complete, in a box of its own: its results are placed from the field's offset in
    // its container, which is right only when the field starts at the container's left edge
    function suggesting(field) {
        return el("span", {class: "regional-boxes-ac-wrap"}, field);
    }

    function setValue(textarea, value) {
        if (!textarea || textarea.value === value) return;
        textarea.value = value;
        textarea.dispatchEvent(new Event("input", {bubbles: true}));
    }

    const GUIDES_KEY = "regional-boxes-guides";

    function savedGuides() {
        try {
            const saved = localStorage.getItem(GUIDES_KEY);
            return saved in GUIDES ? saved : "off";
        } catch (e) {
            return "off";
        }
    }

    function numberOf(root, id, fallback) {
        const input = root.querySelector(`#${id} input[type=number]`);
        const v = input ? parseFloat(input.value) : NaN;
        return v > 0 ? v : fallback;
    }

    // ---- the PAN 2 editor: the description's fields, its subjects and a timeline of events, camera moves and actions ----
    // ctx: prompt() the prompt's textarea, duration() the clip's length in tenths (from Frames), picture() the img2img
    // input picture's element or null, changed() after anything that may change the warnings

    const PAN2_SHORT = {static: "static", pan_left: "pan ←", pan_right: "pan →", tilt_up: "tilt ↑", tilt_down: "tilt ↓",
        track_left: "track ←", track_right: "track →", dolly_forward: "dolly in", dolly_backward: "dolly out", dolly_up: "dolly ↑",
        dolly_down: "dolly ↓", zoom_in: "zoom in", zoom_out: "zoom out", roll_clockwise: "roll ↻", roll_counterclockwise: "roll ↺",
        unstable: "shaky"};

    function createPan2Editor(ctx) {
        // model: the description; selected: the event shown below the timeline; action: the action selected in it
        // written: the caption the panel last wrote or read, to tell when the prompt was edited by hand
        // note: what the panel did on its own (times fitted to a new length), shown until the prompt changes
        // extra / extraEdited: the Additional prompt field, and whether it was typed into since the last Write or Read
        const st = {model: newPan2(ctx.duration()), selected: 0, action: -1, written: null, note: "", extra: "", extraEdited: false};
        const node = el("div", {class: "regional-boxes-pan2"});
        let held = null;

        const D = () => st.model.events[st.model.events.length - 1].end;
        const startOf = (k) => pan2Start(st.model, k);
        const color = (i) => PALETTE[i % PALETTE.length][1];
        const seconds = (t) => `${pan2Time(t)} s`;

        function field(label, key, attrs) {
            const multi = attrs && attrs.rows;
            const input = el(multi ? "textarea" : "input", {type: multi ? undefined : "text", class: "regional-boxes-pan2-input", ...attrs,
                oninput: (ev) => { st.model[key] = ev.target.value; ctx.changed(); }});
            input.value = st.model[key] || "";
            return el("label", {class: `regional-boxes-pan2-field${multi ? " wide" : ""}`}, el("span", {}, label), input);
        }

        function words(text, max) {
            const n = wordCount(text);
            return `${n} word${n === 1 ? "" : "s"}${n > max ? ` - over ${max}` : ""}`;
        }

        function render() {
            if (st.selected >= st.model.events.length) st.selected = st.model.events.length - 1;
            node.replaceChildren(fields(), subjects(), timeline(), eventEditor());
        }

        // ---- the scene: look, light, framing, first frame, quality ----
        function fields() {
            const extra = el("input", {type: "text", class: "regional-boxes-pan2-input regional-boxes-ac", placeholder: "<lora:...> tags, after the description",
                title: "Written after the description, outside it: LoRA tags. Any words here reach the model too.",
                oninput: (ev) => { st.extra = ev.target.value; st.extraEdited = true; }});
            extra.value = st.extra;
            const first = field("First frame", "firstFrame", {rows: "3",
                placeholder: "The opening picture, as a still: who and what is where, how it looks, the light and the framing. No IDs here.",
                title: "init_frame_visual_description: one still-state paragraph, up to 200 words"});
            const count = el("span", {class: "regional-boxes-pan2-count"}, words(st.model.firstFrame, PAN2_MAX_WORDS));
            first.querySelector("textarea").addEventListener("input", (ev) => { count.textContent = words(ev.target.value, PAN2_MAX_WORDS); });
            first.append(count);
            const picture = ctx.picture();
            if (picture && picture.getAttribute("src")) {
                first.prepend(el("img", {class: "regional-boxes-pan2-picture", src: picture.getAttribute("src"), alt: "", title: "The img2img picture: describe it here"}));
            }
            return el("div", {class: "regional-boxes-pan2-fields"},
                field("Video style", "style", {placeholder: "realistic handheld footage, one continuous shot", title: "video_style: the medium and look; say once that it is one continuous shot"}),
                field("Lighting", "lighting", {placeholder: "soft overcast daylight from the left", title: "lighting: the light and color of the scene"}),
                field("Perspective", "view", {placeholder: "eye-level medium shot", title: "perspective_view: viewpoint and framing"}),
                field("Quality", "quality", {placeholder: "sharp natural detail", title: "quality.video_quality: the finish, in a few words"}),
                field("Text and logos", "overlays", {placeholder: "none", title: "quality.text_logos_overlays: on-screen text, logos or overlays; empty for none"}),
                el("label", {class: "regional-boxes-pan2-field"}, el("span", {}, "Additional prompt"), suggesting(extra)),
                first);
        }

        // ---- subjects: the people and moving things, <|Subject1|>, <|Subject2|>... by their order ----
        function subjects() {
            const rows = st.model.subjects.map((s, i) => {
                const swatch = el("span", {class: "regional-boxes-swatch"});
                swatch.style.background = color(i);
                const name = el("input", {type: "text", class: "regional-boxes-pan2-input", placeholder: "name: potter, red car...",
                    title: "display_name", oninput: (ev) => { s.name = ev.target.value; renderLaneLabels(); ctx.changed(); }});
                name.value = s.name;
                const look = el("input", {type: "text", class: "regional-boxes-pan2-input regional-boxes-pan2-grow", placeholder: "how it looks, and stays: a woman in a clay-stained apron",
                    title: "subject_attribute: the appearance that stays the same through the clip", oninput: (ev) => { s.attribute = ev.target.value; ctx.changed(); }});
                look.value = s.attribute;
                return el("div", {class: "regional-boxes-pan2-subject"}, swatch, el("code", {}, pan2Id(i)), name, look,
                    el("button", {class: "secondary gradio-button", title: "Delete the subject and its actions", onclick: () => removeSubject(i)}, "✕"));
            });
            return el("div", {class: "regional-boxes-pan2-section"},
                el("div", {class: "regional-boxes-pan2-heading"}, el("b", {}, "Subjects"),
                    el("span", {}, "People and things that move or change; incidental scenery stays out"),
                    el("button", {class: "secondary gradio-button", onclick: () => {
                        st.model.subjects.push({name: "", attribute: ""});
                        render();
                        ctx.changed();
                    }}, "+ Subject")),
                ...rows);
        }

        function removeSubject(i) {
            st.model.subjects.splice(i, 1);
            for (const e of st.model.events) {
                e.actions = e.actions.filter((a) => a.subject !== i);
                for (const a of e.actions) if (a.subject > i) a.subject -= 1;
            }
            st.action = -1;
            render();
            ctx.changed();
        }

        // ---- the timeline ----
        let track = null, laneLabels = [];

        function at(ev) {
            const r = track.getBoundingClientRect();
            return Math.round(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * D());
        }

        function place(seg, from, to) {
            seg.style.left = `${from / D() * 100}%`;
            seg.style.width = `${(to - from) / D() * 100}%`;
            return seg;
        }

        function edgeHandle(left, onDown, title) {
            const h = el("div", {class: "regional-boxes-pan2-edge", title, onpointerdown: (ev) => {
                if (ev.button !== 0 || !ev.isPrimary) return;
                ev.preventDefault();
                ev.stopPropagation();
                onDown(ev);
            }});
            h.style.left = `${left / D() * 100}%`;
            return h;
        }

        function ruler() {
            const r = el("div", {class: "regional-boxes-pan2-ruler"});
            const total = D() / 10;
            const step = total > 20 ? 5 : total > 8 ? 2 : 1;
            for (let s = 0; s <= total + 1e-9; s += step) {
                const tick = el("span", {}, `${s}s`);
                tick.style.left = `${s * 10 / D() * 100}%`;
                r.append(tick);
            }
            return r;
        }

        function lane(label, cls, ...children) {
            const body = el("div", {class: `regional-boxes-pan2-track ${cls}`}, ...children);
            const name = el("div", {class: "regional-boxes-pan2-lane-label"}, label);
            return [el("div", {class: "regional-boxes-pan2-lane"}, name, body), body, name];
        }

        function timeline() {
            const m = st.model;
            const events = m.events.map((e, k) => place(el("div", {class: `regional-boxes-pan2-seg event${k === st.selected ? " selected" : ""}`,
                title: `Event ${k + 1}: ${pan2Range(startOf(k), e.end)} s`, onpointerdown: (ev) => select(ev, k, -1)},
            el("span", {}, `${k + 1} ${trimmed(e.desc).slice(0, 40)}`)), startOf(k), e.end));
            const eventEdges = m.events.slice(0, -1).map((e, k) => edgeHandle(e.end, () => { held = {type: "event", k}; }, "Drag to move the change of event"));
            const [eventLane, eventTrack] = lane("Events", "events", ...events, ...eventEdges);
            track = eventTrack;

            const cams = [], camEdges = [];
            m.events.forEach((e, k) => {
                let from = startOf(k);
                e.camera.forEach((c, j) => {
                    cams.push(place(el("div", {class: `regional-boxes-pan2-seg camera${k === st.selected ? " selected" : ""}`,
                        title: `${pan2Range(from, c.end)} s: ${c.tags.join(", ") || "no move"}`, onpointerdown: (ev) => select(ev, k, -1)},
                    el("span", {}, c.tags.map((t) => PAN2_SHORT[t] || t).join(" + ") || "?")), from, c.end));
                    if (j < e.camera.length - 1) camEdges.push(edgeHandle(c.end, () => { held = {type: "camera", k, j}; }, "Drag to move the change of camera move"));
                    from = c.end;
                });
            });
            const [cameraLane] = lane("Camera", "camera", ...cams, ...camEdges);

            laneLabels = [];
            const subjectLanes = m.subjects.map((s, i) => {
                const segs = [];
                m.events.forEach((e, k) => e.actions.forEach((a, j) => {
                    if (a.subject !== i) return;
                    const chosen = k === st.selected && j === st.action;
                    const seg = place(el("div", {class: `regional-boxes-pan2-seg action${chosen ? " selected" : ""}`,
                        title: `${pan2Range(a.start, a.end)} s: ${trimmed(a.text)}`, onpointerdown: (ev) => select(ev, k, j)},
                    el("span", {}, trimmed(a.text) || "…")), a.start, a.end);
                    seg.style.background = color(i);
                    segs.push(seg);
                    if (chosen) {
                        segs.push(edgeHandle(a.start, () => { held = {type: "action", k, j, side: "start"}; }, "Drag to change when it starts"));
                        segs.push(edgeHandle(a.end, () => { held = {type: "action", k, j, side: "end"}; }, "Drag to change when it ends"));
                    }
                }));
                const [row, body, name] = lane(s.name || pan2Id(i), "subject", ...segs);
                name.style.borderLeftColor = color(i);
                laneLabels.push(name);
                // a drag on the empty lane adds an action, inside the event where it starts
                body.addEventListener("pointerdown", (ev) => {
                    if (ev.target !== body || ev.button !== 0 || !ev.isPrimary) return;
                    ev.preventDefault();
                    const t = at(ev);
                    const k = Math.max(0, m.events.findIndex((e) => t < e.end));
                    held = {type: "new", subject: i, k, from: Math.max(startOf(k), Math.min(t, m.events[k].end - 1))};
                });
                return row;
            });
            return el("div", {class: "regional-boxes-pan2-section"},
                el("div", {class: "regional-boxes-pan2-heading"}, el("b", {}, "Timeline"),
                    el("span", {}, `${seconds(D())} - drag the lines to change the times, and drag on a subject's lane to add what it does`)),
                el("div", {class: "regional-boxes-pan2-timeline"},
                    el("div", {class: "regional-boxes-pan2-lane"}, el("div", {class: "regional-boxes-pan2-lane-label"}), ruler()),
                    eventLane, cameraLane, ...subjectLanes));
        }

        function renderLaneLabels() {
            laneLabels.forEach((name, i) => { name.textContent = st.model.subjects[i]?.name || pan2Id(i); });
        }

        function select(ev, k, j) {
            if (ev.button !== 0 || !ev.isPrimary) return;
            ev.stopPropagation();
            st.selected = k;
            st.action = j;
            render();
        }

        // drags of the lines between events, camera moves, the ends of an action, or a new action
        window.addEventListener("pointermove", (ev) => {
            if (!held || !ev.isPrimary || !track) return;
            const m = st.model, t = at(ev);
            if (held.type === "event") {
                const k = held.k, e = m.events[k], next = m.events[k + 1];
                const low = Math.max(startOf(k) + 1, ...(e.camera.length > 1 ? [e.camera[e.camera.length - 2].end + 1] : []));
                const high = next.camera.length > 1 ? next.camera[0].end - 1 : next.end - 1;
                const end = Math.max(low, Math.min(high, t));
                e.end = e.camera[e.camera.length - 1].end = end;
                for (const a of e.actions) { a.end = Math.min(a.end, end); a.start = Math.min(a.start, end - 1); }
                for (const a of next.actions) { a.start = Math.max(a.start, end); a.end = Math.max(a.end, a.start + 1); }
            } else if (held.type === "camera") {
                const e = m.events[held.k], j = held.j;
                const low = (j > 0 ? e.camera[j - 1].end : startOf(held.k)) + 1;
                e.camera[j].end = Math.max(low, Math.min(e.camera[j + 1].end - 1, t));
            } else if (held.type === "action") {
                const a = m.events[held.k].actions[held.j], from = startOf(held.k), to = m.events[held.k].end;
                if (held.side === "start") a.start = Math.max(from, Math.min(a.end - 1, t));
                else a.end = Math.min(to, Math.max(a.start + 1, t));
            } else if (held.type === "new") {
                const e = m.events[held.k], from = startOf(held.k);
                if (!held.action) {
                    held.action = {subject: held.subject, start: held.from, end: held.from + 1, text: ""};
                    e.actions.push(held.action);
                    st.selected = held.k;
                    st.action = e.actions.length - 1;
                }
                const lo = Math.max(from, Math.min(held.from, t)), hi = Math.min(e.end, Math.max(held.from, t));
                held.action.start = lo;
                held.action.end = Math.max(lo + 1, hi);
            }
            render();
        });
        window.addEventListener("pointerup", () => {
            if (!held) return;
            if (held.type === "new" && !held.action) {
                // a click on the lane, not a drag: an action over the rest of the event
                const e = st.model.events[held.k];
                e.actions.push({subject: held.subject, start: held.from, end: e.end, text: ""});
                st.selected = held.k;
                st.action = e.actions.length - 1;
            }
            const created = held.type === "new";
            held = null;
            render();
            ctx.changed();
            if (created) node.querySelector(".regional-boxes-pan2-action.selected input.regional-boxes-pan2-grow")?.focus();
        });
        window.addEventListener("pointercancel", () => { held = null; });

        // ---- the selected event: what happens, its camera moves and the subjects' actions ----
        function eventEditor() {
            const m = st.model, k = st.selected, e = m.events[k], from = startOf(k);
            const desc = el("textarea", {class: "regional-boxes-pan2-input", rows: "3",
                placeholder: "What changes in this part of the clip and what it leads to, in plain words (no IDs), with any camera move that explains the picture",
                title: "event_description: up to 200 words"});
            desc.value = e.desc;
            const count = el("span", {class: "regional-boxes-pan2-count"}, words(e.desc, PAN2_MAX_WORDS));
            desc.addEventListener("input", (ev) => {
                e.desc = ev.target.value;
                count.textContent = words(e.desc, PAN2_MAX_WORDS);
                const seg = node.querySelectorAll(".regional-boxes-pan2-seg.event")[k]?.querySelector("span");
                if (seg) seg.textContent = `${k + 1} ${trimmed(e.desc).slice(0, 40)}`;
                ctx.changed();
            });
            const tools = el("div", {class: "regional-boxes-pan2-tools"},
                el("b", {}, `Event ${k + 1}`), el("span", {}, `${pan2Range(from, e.end)} s`),
                el("button", {class: "secondary gradio-button", disabled: e.end - from < 2, title: "Split this event in two at its middle", onclick: () => splitEvent(k)}, "Split"),
                el("button", {class: "secondary gradio-button", disabled: k === m.events.length - 1, title: "Join this event with the next one", onclick: () => mergeEvent(k)}, "Merge with next"),
                el("button", {class: "secondary gradio-button", disabled: m.events.length === 1, title: "Delete this event; the one before (or after) takes its time", onclick: () => deleteEvent(k)}, "Delete"));
            let cf = from;
            const cameras = e.camera.map((c, j) => {
                const start = cf;
                cf = c.end;
                const chips = PAN2_CAMERA.map((tag) => el("button", {class: `regional-boxes-pan2-chip${c.tags.includes(tag) ? " on" : ""}`, title: tag,
                    onclick: () => {
                        if (tag === "static") c.tags = c.tags.includes("static") ? [] : ["static"];
                        else c.tags = c.tags.includes(tag) ? c.tags.filter((t) => t !== tag) : [...c.tags.filter((t) => t !== "static"), tag];
                        render();
                        ctx.changed();
                    }}, PAN2_SHORT[tag]));
                return el("div", {class: "regional-boxes-pan2-camera"},
                    el("span", {class: "regional-boxes-pan2-range"}, `${pan2Range(start, c.end)} s`), ...chips,
                    el("button", {class: "secondary gradio-button", disabled: c.end - start < 2, title: "Split this camera move in two", onclick: () => splitCamera(k, j)}, "Split"),
                    e.camera.length > 1 ? el("button", {class: "secondary gradio-button", title: "Delete this camera move", onclick: () => deleteCamera(k, j)}, "✕") : "");
            });
            const actions = e.actions.map((a, j) => {
                const who = el("select", {title: "Who does it", onchange: (ev) => { a.subject = parseInt(ev.target.value, 10); render(); ctx.changed(); }},
                    ...m.subjects.map((s, i) => el("option", {value: String(i)}, `${pan2Id(i)} ${s.name}`)));
                who.value = String(a.subject);
                const time = (side) => {
                    const input = el("input", {type: "text", inputmode: "decimal", class: "regional-boxes-coord", title: side === "start" ? "Starts at (seconds)" : "Ends at (seconds)",
                        onchange: (ev) => {
                            const v = Math.round(parseFloat(ev.target.value) * 10);
                            if (Number.isFinite(v)) {
                                if (side === "start") a.start = Math.max(from, Math.min(a.end - 1, v));
                                else a.end = Math.min(e.end, Math.max(a.start + 1, v));
                            }
                            render();
                            ctx.changed();
                        }});
                    input.value = pan2Time(a[side]);
                    return input;
                };
                const text = el("input", {type: "text", class: "regional-boxes-pan2-input regional-boxes-pan2-grow",
                    placeholder: "what it does: shapes the clay into a cylinder", title: "The action; the subject's ID goes before it",
                    oninput: (ev) => {
                        a.text = ev.target.value;
                        ctx.changed();
                    }});
                text.value = a.text;
                return el("div", {class: `regional-boxes-pan2-action${j === st.action ? " selected" : ""}`,
                    onfocusin: () => {
                        if (st.action === j) return;
                        st.action = j;
                        node.querySelectorAll(".regional-boxes-pan2-action").forEach((r, n) => r.classList.toggle("selected", n === j));
                    }},
                who, time("start"), el("span", {}, "to"), time("end"), el("span", {}, "s"), text,
                el("button", {class: "secondary gradio-button", title: "Delete the action", onclick: () => { e.actions.splice(j, 1); st.action = -1; render(); ctx.changed(); }}, "✕"));
            });
            const addAction = el("button", {class: "secondary gradio-button", disabled: !m.subjects.length,
                title: m.subjects.length ? "An action of the first subject over the whole event" : "Add a subject first",
                onclick: () => {
                    e.actions.push({subject: 0, start: from, end: e.end, text: ""});
                    st.action = e.actions.length - 1;
                    render();
                    ctx.changed();
                }}, "+ Action");
            return el("div", {class: "regional-boxes-pan2-section regional-boxes-pan2-event"}, tools,
                el("label", {class: "regional-boxes-pan2-field wide"}, el("span", {}, "What happens"), desc, count),
                el("div", {class: "regional-boxes-pan2-heading"}, el("b", {}, "Camera")), ...cameras,
                el("div", {class: "regional-boxes-pan2-heading"}, el("b", {}, "Actions"), addAction), ...actions);
        }

        function splitEvent(k) {
            const m = st.model, e = m.events[k], from = startOf(k);
            const mid = Math.round((from + e.end) / 2);
            let cf = from;
            const first = [], second = [];
            for (const c of e.camera) {
                if (c.end <= mid) first.push({end: c.end, tags: [...c.tags]});
                else {
                    if (cf < mid) first.push({end: mid, tags: [...c.tags]});
                    second.push({end: c.end, tags: [...c.tags]});
                }
                cf = c.end;
            }
            const before = e.actions.filter((a) => a.start < mid).map((a) => ({...a, end: Math.min(a.end, mid)}));
            const after = e.actions.filter((a) => a.start >= mid);
            m.events.splice(k, 1, {end: mid, desc: e.desc, camera: first, actions: before}, {end: e.end, desc: "", camera: second, actions: after});
            st.selected = k + 1;
            st.action = -1;
            render();
            ctx.changed();
        }

        function mergeEvent(k) {
            const m = st.model, e = m.events[k], next = m.events[k + 1];
            m.events.splice(k, 2, {end: next.end, desc: [trimmed(e.desc), trimmed(next.desc)].filter(Boolean).join(" "),
                camera: [...e.camera, ...next.camera], actions: [...e.actions, ...next.actions]});
            st.selected = k;
            st.action = -1;
            render();
            ctx.changed();
        }

        function deleteEvent(k) {
            const m = st.model;
            if (k > 0) {
                const prev = m.events[k - 1];
                prev.end = prev.camera[prev.camera.length - 1].end = m.events[k].end;
            }
            m.events.splice(k, 1);
            st.selected = Math.max(0, k - 1);
            st.action = -1;
            render();
            ctx.changed();
        }

        function splitCamera(k, j) {
            const e = st.model.events[k], from = j > 0 ? e.camera[j - 1].end : startOf(k);
            e.camera.splice(j, 0, {end: Math.round((from + e.camera[j].end) / 2), tags: [...e.camera[j].tags]});
            render();
            ctx.changed();
        }

        function deleteCamera(k, j) {
            const e = st.model.events[k];
            if (j > 0) e.camera[j - 1].end = e.camera[j].end;
            e.camera.splice(j, 1);
            render();
            ctx.changed();
        }

        // ---- the prompt ----

        // the clip's length changed (Frames): the times keep their share of it; a description the panel wrote follows in
        // the prompt, one changed by hand is left for the warning
        function fit() {
            const duration = ctx.duration();
            if (D() === duration) return;
            const before = D();
            st.model = fitPan2(st.model, duration);
            const ta = ctx.prompt();
            if (ta && st.written && parsePan2(ta.value) && buildPan2(readPan2(ta.value)) === st.written) {
                st.written = buildPan2(st.model);
                setValue(ta, writePan2(ta.value, st.model));
                st.note = `The description's times were fitted to the new length: ${seconds(before)} → ${seconds(duration)}.`;
            }
            render();
        }

        function write() {
            const ta = ctx.prompt();
            if (!ta) return;
            st.model = fitPan2(st.model, ctx.duration());
            const current = parsePan2(ta.value);
            const extra = st.extraEdited || !current ? st.extra : undefined;
            setValue(ta, writePan2(ta.value, st.model, {extra}));
            st.written = buildPan2(st.model);
            st.extra = pan2Extra(ta.value);
            st.extraEdited = false;
            st.note = "";
            render();
        }

        function read() {
            const ta = ctx.prompt();
            if (!ta) return;
            const model = readPan2(ta.value);
            st.note = "";
            if (model) {
                const length = model.events[model.events.length - 1].end;
                st.model = fitPan2(model, ctx.duration());
                if (length !== ctx.duration()) {
                    st.note = `The description in the prompt was for ${seconds(length)}; its times were fitted to the clip's ${seconds(ctx.duration())}. Write to prompt to update it.`;
                }
                st.written = buildPan2(model);
            } else {
                st.model = newPan2(ctx.duration());
                st.written = null;
            }
            st.extra = pan2Extra(ta.value);
            st.extraEdited = false;
            st.selected = 0;
            st.action = -1;
            render();
        }

        function clear() {
            st.model = newPan2(ctx.duration());
            st.selected = 0;
            st.action = -1;
            render();
        }

        // the warnings of the PAN 2 format: the prompt against the panel, then what the prompt guide asks
        function warnings() {
            const ta = ctx.prompt();
            const lines = [];
            const inPrompt = ta && parsePan2(ta.value);
            if (inPrompt && st.written && buildPan2(readPan2(ta.value)) !== st.written) {
                lines.push("⚠ The description in the prompt was changed by hand since the panel wrote it: Read from prompt to edit it here, or Write to prompt to replace it.");
            } else if (inPrompt && st.written && st.written !== buildPan2(fitPan2(st.model, ctx.duration()))) {
                lines.push("The panel has changes the prompt does not have yet: Write to prompt.");
            }
            if (st.note && inPrompt) lines.push(`✓ ${st.note}`);
            const problems = checkPan2(st.model);
            if (problems.length) lines.push(`Before you generate: ${problems.join(" ")}`);
            return lines;
        }

        function forgetNote() {
            st.note = "";
        }

        render();
        return {node, render, fit, write, read, clear, warnings, forgetNote};
    }

    function initPanel(host) {
        const tab = host.dataset.tab;
        const app = gradioApp();
        // armed: {i, which} for the next drag; color: palette index, kept for life so a note's color never changes
        // written: the [Width, Height] the MOSS layout in the prompt was written or read at
        // alert: why the last Write to prompt did nothing, shown until the prompt changes
        // caption, extra: the Scene and Additional prompt fields, the layout's caption and what follows the layout; edited: which of
        // them were typed into since the last Write or Read (the others follow the prompt)
        // last: txt2img shows its last picture behind the boxes; hidden: the boxes are hidden, to see the picture whole
        // which: the selected element's box the arrow keys move ("tgt", or "src" where it is in a reference)
        // guides: the composition guides over the frame (a key of GUIDES), remembered by the browser
        const state = {elements: [], selected: -1, armed: null, counter: 0, format: FORMATS.auto, draw: true,
            meta: "", canvas: "single", written: null, note: "", alert: "", caption: "", extra: "",
            edited: {caption: false, extra: false}, last: true, hidden: false, which: "tgt", guides: savedGuides()};
        let listedSize = "";
        const history = createHistory();

        const formatSelect = el("select", {class: "regional-boxes-format", onchange: (ev) => { state.format = ev.target.value; render(); }},
            ...Object.keys(FORMAT_LABELS).map((k) => el("option", {value: k}, FORMAT_LABELS[k])));
        const drawToggle = el("input", {type: "checkbox", checked: true, onchange: (ev) => { state.draw = ev.target.checked; syncData(); }});
        const drawLabel = el("label", {class: "regional-boxes-draw"}, drawToggle, " Draw the boxes on the input picture when generating");
        const lastToggle = el("input", {type: "checkbox", checked: true, onchange: (ev) => { state.last = ev.target.checked; showBackground(); }});
        const lastLabel = el("label", {class: "regional-boxes-draw", title: "Stretched to the current Width and Height"},
            lastToggle, " Show the last picture behind the boxes");
        const hideToggle = el("input", {type: "checkbox", onchange: (ev) => {
            state.hidden = ev.target.checked;
            frame.classList.toggle("boxes-hidden", state.hidden);
        }});
        const hideLabel = el("label", {class: "regional-boxes-draw", title: "The picture behind them, whole; no box can be drawn meanwhile"},
            hideToggle, " Hide the boxes");
        const resolved = el("span", {class: "regional-boxes-resolved"});
        const metaInput = el("input", {type: "text", class: "regional-boxes-meta", placeholder: "poster, flat illustration...",
            title: "Medium and genre of the picture, separated by commas (summary.meta)", oninput: (ev) => { state.meta = ev.target.value; }});
        const canvasSelect = el("select", {title: "One picture, panels, or a collage (summary.canvas)", onchange: (ev) => { state.canvas = ev.target.value; }},
            ...MOSS_CANVASES.map((k) => el("option", {value: k}, k.replace("_", " "))));
        const mossOptions = el("span", {class: "regional-boxes-moss"}, "Meta ", metaInput, " Canvas ", canvasSelect);
        const guideSelect = el("select", {title: "Lines over the frame to help place the boxes", onchange: (ev) => {
            state.guides = ev.target.value;
            showGuides();
            try {
                localStorage.setItem(GUIDES_KEY, state.guides);
            } catch (e) {
                // no storage (a private window): the choice lasts until the page is reloaded
            }
        }}, ...Object.keys(GUIDE_LABELS).map((k) => el("option", {value: k}, GUIDE_LABELS[k])));
        guideSelect.value = state.guides;
        const guideLabel = el("label", {class: "regional-boxes-draw"}, "Guides ", guideSelect);
        const top = el("div", {class: "regional-boxes-top"}, el("span", {}, "Format "), formatSelect, resolved, tab === "img2img" ? drawLabel : lastLabel, hideLabel, guideLabel, mossOptions);
        const sceneInput = el("textarea", {class: "regional-boxes-scene-text regional-boxes-ac", rows: "2",
            placeholder: "The whole picture in a sentence or two: who is there, doing what, where, in what light...",
            title: "The scene, the layout's caption (summary.caption)",
            oninput: (ev) => { state.caption = ev.target.value; state.edited.caption = true; state.alert = ""; checkSize(); }});
        const extraInput = el("input", {type: "text", class: "regional-boxes-extra regional-boxes-ac", placeholder: "<lora:...>, trigger words, anything else",
            title: "Written after the layout, outside it: LoRA tags, trigger words or any other words",
            oninput: (ev) => { state.extra = ev.target.value; state.edited.extra = true; }});
        const sceneRow = el("div", {class: "regional-boxes-scene"},
            el("label", {}, "Scene", suggesting(sceneInput)), el("label", {}, "Additional prompt", suggesting(extraInput)));

        const frame = el("div", {class: "regional-boxes-frame", title: "Drag to draw a box. The selected box: drag its tag to move it "
            + "and its handles to resize it (Shift keeps its shape); the arrow keys move it, Delete removes it, Ctrl+D duplicates it, "
            + "Esc lets it go. Ctrl+Z and Ctrl+Y undo and redo. Double-click a box to describe it."});
        const background = el("img", {class: "regional-boxes-bg", draggable: "false", alt: ""});
        const guidesLayer = el("div", {class: "regional-boxes-guides"});
        const layer = el("div", {class: "regional-boxes-boxes"});
        frame.append(background, guidesLayer, layer);
        const hint = el("div", {class: "regional-boxes-hint"});
        const warning = el("div", {class: "regional-boxes-warning"});
        const list = el("div", {class: "regional-boxes-list"});
        const readButton = el("button", {class: "lg secondary gradio-button", onclick: () => read()}, "Read from prompt");
        const writeButton = el("button", {class: "lg secondary gradio-button", onclick: () => write()}, "Write to prompt");
        const undoButton = el("button", {class: "lg secondary gradio-button", title: "Undo the last change to the boxes (Ctrl+Z)",
            onclick: () => undo()}, "↶ Undo");
        const redoButton = el("button", {class: "lg secondary gradio-button", title: "Redo it (Ctrl+Y)", onclick: () => redo()}, "↷ Redo");
        const buttons = el("div", {class: "regional-boxes-buttons"},
            writeButton,
            readButton,
            el("button", {class: "lg secondary gradio-button", onclick: () => clear()}, "Clear"),
            undoButton,
            redoButton);
        host.append(top, sceneRow, hint, warning, frame, list, buttons);

        // Tag Autocomplete, when installed, on the fields that describe things: hooked on their first focus, since the
        // rows are rebuilt and Tag Autocomplete only finds the fields that are there when the page loads
        host.addEventListener("focusin", (ev) => {
            if (!ev.target.classList.contains("regional-boxes-ac") || typeof window.addAutocompleteToArea !== "function") return;
            try {
                window.addAutocompleteToArea(ev.target);
            } catch (e) {
                // not set up yet: the next focus tries again
            }
        });

        const prompt = () => app.querySelector(`#${tab}_prompt textarea`);
        const dataBox = () => app.querySelector(`#regional_boxes_${tab}_data textarea`);
        const format = () => resolveFormat(state.format,
            app.querySelector("#forge_ui_preset input")?.value, app.querySelector("#setting_sd_model_checkpoint input")?.value);

        // PAN 2: the timeline takes the frame's place; the clip's length is Forge's Frames (the batch size slider)
        const pan2 = createPan2Editor({
            prompt,
            duration: () => pan2Duration(numberOf(app, `${tab}_batch_size`, 241)),
            picture: () => (tab === "img2img" ? app.querySelector("#img2img_image img.forge-image") : null),
            changed: () => checkSize(),
        });
        host.insertBefore(pan2.node, frame);

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
                lines.push("⚠ Dynamic Prompts is on: it removes the layout's { } before the model reads it, and the boxes can be lost. "
                    + "Turn off Dynamic Prompts enabled in its accordion below.");
            }
            const ta = prompt();
            if (ta && (format() === FORMATS.coords || format() === FORMATS.moss) && layoutStripped(ta.value)) {
                lines.push("⚠ The layout in the prompt lost its { }: click Read from prompt, then Write to prompt, to put them back.");
            }
            if (format() === FORMATS.marks) lines.push(marksWarning());
            // PAN 2 and Dynamic Prompts: the PAN 2 extension uses the description as written, so nothing to warn about
            if (format() === FORMATS.pan2) lines.push(...pan2.warnings());
            lines.push(mossWarning());
            const text = lines.filter(Boolean).join("\n");
            warning.textContent = text;
            warning.style.display = text ? "" : "none";
        }

        // marks have one color per box, 8 in all: no 9th box is drawn, and a box sharing a color with an earlier one
        // (drawn in another format, or read from a prompt) is left out of the notes and the picture
        function marksWarning() {
            const shared = state.elements.filter((e, i) => state.elements.findIndex((o) => colorName(o) === colorName(e)) < i).length;
            if (shared) {
                return `⚠ Marks have ${PALETTE.length} colors, one per box: ${shared === 1 ? "1 box shares its color" : `${shared} boxes share their color`} `
                    + `with an earlier one and ${shared === 1 ? "is" : "are"} left out of the prompt and the picture. Delete ${shared === 1 ? "it" : "them"}.`;
            }
            return state.elements.length >= PALETTE.length ? `All ${PALETTE.length} colors are in use: delete a box to draw another.` : "";
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
            frame.classList.toggle("has-picture", !!src);
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
                    : fmt === FORMATS.moss ? "→ MOSS-Image: layout JSON" : fmt === FORMATS.pan2 ? "→ PAN 2: timeline" : "→ this model reads no boxes";
            const timeline = fmt === FORMATS.pan2;
            drawLabel.style.display = fmt === FORMATS.marks ? "" : "none";
            mossOptions.style.display = fmt === FORMATS.moss ? "" : "none";
            sceneRow.style.display = fmt === FORMATS.moss ? "" : "none";
            // PAN 2 places nothing in the picture: its timeline takes the place of the frame and the boxes
            for (const node of [frame, list]) node.style.display = timeline ? "none" : "";
            for (const node of [lastLabel, hideLabel, guideLabel, undoButton, redoButton]) node.style.display = timeline ? "none" : "";
            pan2.node.style.display = timeline ? "" : "none";
            readButton.style.display = fmt === FORMATS.coords || fmt === FORMATS.moss || timeline ? "" : "none";
            writeButton.disabled = fmt === FORMATS.none;
            const armed = state.armed && state.elements[state.armed.i];
            if (fmt === FORMATS.none) {
                hint.textContent = "Regional Boxes works with FLUX 3 Image Klein, Qwen-Image 2.1, MOSS-Image and PAN 2: load one of them, or pick its format above.";
            } else if (timeline) {
                hint.textContent = "Describe the look and the first frame, add who or what moves under Subjects, then build the clip on the timeline: "
                    + "split it into events and drag the lines between them, pick the camera moves, and drag on a subject's lane to add what it does. "
                    + "Write to prompt turns it all into PAN 2's description for the clip's length (Frames).";
            } else if (fmt === FORMATS.marks && tab !== "img2img") {
                hint.textContent = "Marks are drawn on an input picture: use them in img2img. For a new picture, pick a model that reads coordinates (FLUX 3).";
            } else if (!armed && fmt === FORMATS.moss) {
                hint.textContent = "Describe the whole picture in Scene (or as the prompt), then drag on the frame to place each thing or text. "
                    + "Write to prompt turns it all into a MOSS-Image layout for the current Width and Height, with the Additional prompt after it.";
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
                    const label = marks ? colorName(e) : moss ? mossTag(e, i) : which === "src" ? `${e.id} (from)` : e.id;
                    // the name tag moves the box and the handles of the selected box (corners and sides) resize it; the
                    // rest of the box stays free, so a box can be drawn inside another
                    const tag = el("span", {class: "regional-boxes-tag", title: "Drag to move the box",
                        onpointerdown: (ev) => grab(ev, i, which, "move")}, label);
                    const box = el("div", {class: `regional-boxes-box ${which}${i === state.selected ? " selected" : ""}`}, tag);
                    Object.assign(box.style, {top: `${t / 10}%`, left: `${l / 10}%`, height: `${(bo - t) / 10}%`, width: `${(r - l) / 10}%`, borderColor: colorOf(e)});
                    tag.style.background = colorOf(e);
                    if (i === state.selected) {
                        for (const side of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
                            const handle = el("div", {class: `regional-boxes-handle ${side}`, title: "Drag to resize the box (Shift keeps its shape)",
                                onpointerdown: (ev) => grab(ev, i, which, side)});
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
                const copyButton = el("button", {class: "secondary gradio-button", title: "Duplicate the box (Ctrl+D)",
                    disabled: marks && state.elements.length >= PALETTE.length, onclick: () => duplicate(i)}, "⧉");
                const deleteButton = el("button", {class: "secondary gradio-button", title: "Delete (Delete)", onclick: () => remove(i)}, "✕");
                const actions = [copyButton, deleteButton];
                const swatch = el("span", {class: "regional-boxes-swatch", title: colorName(e), onclick: () => { state.selected = i; render(); }});
                swatch.style.background = colorOf(e);
                if (fmt === FORMATS.moss) {
                    list.append(mossRow(e, i, swatch, actions));
                    return;
                }
                if (marks) {
                    // typing updates the state in place: rebuilding the list would drop the focus and the next click
                    const row = el("div", {class: `regional-boxes-row${i === state.selected ? " selected" : ""}${marksOf(state.elements).includes(e) ? "" : " incomplete"}`},
                        swatch, el("span", {class: "regional-boxes-color"}, colorName(e)),
                        suggesting(el("input", {type: "text", class: "regional-boxes-desc regional-boxes-ac", value: e.desc, placeholder: "What to do inside the box: add a red beanie, change the shirt to denim, remove it...",
                            oninput: (ev) => { e.desc = ev.target.value; row.classList.toggle("incomplete", !marksOf(state.elements).includes(e)); syncData(); }})),
                        ...centerButtons(e),
                        el("button", {class: "secondary gradio-button", title: "Draw the box again", onclick: () => arm(i, "tgt")}, "Redraw"),
                        ...actions);
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
                    suggesting(el("input", {type: "text", class: "regional-boxes-desc regional-boxes-ac", value: e.desc, placeholder: "Short description: look, colors, material", oninput: (ev) => { e.desc = ev.target.value; }})),
                    kind, ref,
                    needsSrc ? el("button", {class: "secondary gradio-button", title: "Draw where it is in the reference", onclick: () => arm(i, "src")}, e.src ? "Redraw from" : "Draw from") : "",
                    e.kind !== KINDS.remove ? el("button", {class: "secondary gradio-button", title: "Draw where it goes", onclick: () => arm(i, "tgt")}, e.tgt ? "Redraw" : "Draw") : "",
                    ...(e.kind !== KINDS.remove ? centerButtons(e) : []), tagButton, ...actions);
                list.append(row);
            });
        }

        // centers the box across or down the picture, keeping its size
        function centerButtons(e) {
            if (!e.tgt) return [];
            const go = (axis) => {
                const [w, h] = size();
                remember();
                e.tgt = centerBox(e.tgt, axis, w, h);
                render();
            };
            return [el("button", {class: "secondary gradio-button regional-boxes-center", title: "Center the box across the picture",
                onclick: () => go("x")}, "⇔"),
            el("button", {class: "secondary gradio-button regional-boxes-center", title: "Center the box down the picture",
                onclick: () => go("y")}, "⇕")];
        }

        function mossRow(e, i, swatch, actions) {
            // typing updates the state in place, as in the marks list: rebuilding the list would drop the focus
            const row = el("div", {class: `regional-boxes-row${i === state.selected ? " selected" : ""}${isMossComplete(e) ? "" : " incomplete"}`});
            const touch = () => row.classList.toggle("incomplete", !isMossComplete(e));
            const text = el("textarea", {class: "regional-boxes-text", rows: "1", placeholder: "The exact words to write (Enter for a new line)",
                oninput: (ev) => { e.text = ev.target.value; touch(); renderBoxes(); }});
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
                suggesting(el("input", {type: "text", class: "regional-boxes-desc regional-boxes-ac", value: e.desc,
                    placeholder: "How it looks: a flat blue mountain, a large dark-blue uppercase title...",
                    oninput: (ev) => { e.desc = ev.target.value; touch(); renderBoxes(); }})),
                text,
                el("button", {class: "secondary gradio-button", title: "Draw the box again", onclick: () => arm(i, "tgt")}, "Redraw"),
                ...actions);
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
            if (shown === FORMATS.pan2) pan2.fit();
            renderBoxes();
            renderList();
            updateHint();
            checkSize();
            syncData();
            showHistory();
        }

        // ---- undo and redo: the boxes, their rows, and MOSS-Image's Meta and Canvas ----

        function snapshot() {
            return {elements: JSON.parse(JSON.stringify(state.elements)), selected: state.selected, counter: state.counter,
                which: state.which, meta: state.meta, canvas: state.canvas};
        }

        // before a change: key joins it to the change just before with the same key (see createHistory)
        function remember(key = null) {
            history.remember(snapshot(), key);
            showHistory();
        }

        function restore(saved) {
            if (!saved) return;
            if (held) held = null;
            Object.assign(state, saved, {armed: null});
            metaInput.value = state.meta;
            canvasSelect.value = state.canvas;
            render();
        }

        function undo() {
            restore(history.undo(snapshot()));
        }

        function redo() {
            restore(history.redo(snapshot()));
        }

        function showHistory() {
            undoButton.disabled = !history.canUndo;
            redoButton.disabled = !history.canRedo;
        }

        // typing in a row, or in Meta and Canvas: one step of undo for each field, taken before its first change
        host.addEventListener("input", (ev) => {
            if (list.contains(ev.target) || mossOptions.contains(ev.target)) remember(ev.target);
        }, true);

        // a copy of the box right after it, a little lower and to the right (a box from a reference keeps where it is
        // in the reference, and moves only where it goes)
        function duplicate(i) {
            const e = state.elements[i];
            if (!e || (format() === FORMATS.marks && state.elements.length >= PALETTE.length)) return;
            remember();
            const copy = JSON.parse(JSON.stringify(e));
            state.counter += 1;
            copy.id = `obj_${state.counter}`;
            copy.color = nextColor();
            const which = copy.tgt ? "tgt" : "src";
            if (copy[which]) {
                const moved = moveBox(copy[which], 30, 30);
                copy[which] = moved.every((v, k) => v === exactBox(copy[which])[k]) ? moveBox(copy[which], -30, -30) : moved;
            }
            state.elements.splice(i + 1, 0, copy);
            state.selected = i + 1;
            state.which = which;
            state.armed = null;
            render();
        }

        // the arrow keys move the selected box a thousandth of the picture, Shift ten
        function nudge(key, step) {
            const e = state.elements[state.selected];
            const which = format() === FORMATS.coords && e?.[state.which] ? state.which : "tgt";
            const [dy, dx] = {arrowup: [-step, 0], arrowdown: [step, 0], arrowleft: [0, -step], arrowright: [0, step]}[key];
            if (!e?.[which]) return;
            remember(`nudge:${state.selected}:${which}`);
            e[which] = moveBox(e[which], dy, dx);
            render();
        }

        // Esc: a box being drawn or dragged goes back, and nothing stays selected
        function letGo() {
            if (held) {
                state.elements[held.i][held.which] = held.box;
                held = null;
            }
            start = null;
            if (ghost) ghost.remove();
            ghost = null;
            state.selected = -1;
            state.armed = null;
            render();
        }

        // the keys work after a click in the panel, until a click elsewhere, and not while typing in a field
        let engaged = false;
        document.addEventListener("pointerdown", (ev) => { engaged = host.contains(ev.target); }, true);
        document.addEventListener("keydown", (ev) => {
            if (!engaged || !host.offsetParent || format() === FORMATS.pan2) return;
            const target = ev.target;
            if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
            const ctrl = ev.ctrlKey || ev.metaKey, key = ev.key.toLowerCase();
            const selected = state.selected >= 0 && state.selected < state.elements.length;
            if (ctrl && key === "z" && !ev.shiftKey) undo();
            else if (ctrl && (key === "y" || (key === "z" && ev.shiftKey))) redo();
            else if (ctrl && key === "d" && selected) duplicate(state.selected);
            else if (ctrl || ev.altKey) return;
            else if ((key === "delete" || key === "backspace") && selected) remove(state.selected);
            else if (key === "escape") letGo();
            else if (key.startsWith("arrow") && selected) nudge(key, ev.shiftKey ? 10 : 1);
            else return;
            ev.preventDefault();
        });

        // a double click (or tap) on a box takes the cursor to its description
        let lastTap = null;
        function tap(i) {
            const now = Date.now();
            if (lastTap && lastTap.i === i && now - lastTap.time < 400) {
                lastTap = null;
                const field = list.children[i]?.querySelector(".regional-boxes-desc");
                if (field) {
                    field.focus();
                    field.scrollIntoView({block: "nearest"});
                }
                return;
            }
            lastTap = {i, time: now};
        }

        function showGuides() {
            guidesLayer.replaceChildren(...(GUIDES[state.guides] || []).flatMap((share) => {
                const across = el("div", {class: "regional-boxes-guide down"}), along = el("div", {class: "regional-boxes-guide across"});
                across.style.left = `${share * 100}%`;
                along.style.top = `${share * 100}%`;
                return [across, along];
            }));
        }
        showGuides();

        function arm(i, which) {
            state.selected = i;
            state.armed = {i, which};
            render();
        }

        function remove(i) {
            remember();
            state.elements.splice(i, 1);
            state.selected = -1;
            state.armed = null;
            render();
        }

        function clear() {
            if (format() === FORMATS.pan2) {
                pan2.clear();
                checkSize();
                return;
            }
            if (state.elements.length) remember();
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
            if (format() === FORMATS.pan2) {
                pan2.write();
                checkSize();
                return;
            }
            const fmt = format();
            if (fmt === FORMATS.marks) setValue(ta, writeNotes(ta.value, buildNotes(state.elements)));
            else if (fmt === FORMATS.coords) setValue(ta, writeLayout(ta.value, buildLayout(state.elements)));
            else if (fmt === FORMATS.moss) {
                const current = parseMoss(ta.value);
                const scene = (!current && splitTags(ta.value).text) || state.caption.trim() || (current ? mossCaption(ta.value) : "");
                // through checkSize, which the click on the panel runs right after and would otherwise clear it
                if (state.elements.some(isMossComplete) && !scene) {
                    state.alert = "⚠ Describe the whole picture in Scene first: it becomes the layout's caption.";
                    checkSize();
                    return;
                }
                state.alert = "";
                const [w, h] = size();
                // without a layout in the prompt (cleared, or a new scene typed there), the Additional prompt is what still remembers the
                // words and tags that followed the last one
                const extra = state.edited.extra || !current ? state.extra : undefined;
                setValue(ta, writeMoss(ta.value, state.elements, w, h, {meta: parseMeta(state.meta), canvas: state.canvas,
                    caption: state.caption, extra}));
                state.written = parseMoss(ta.value) ? [w, h] : null;
                state.note = "";
                syncFields(true);
                checkSize();
            }
            syncData();
        }

        // Scene and the Additional prompt from the layout in the prompt: all of it after a Write or Read (force), else only the field not
        // typed into since, so a LoRA added from Forge's tab or a caption changed by hand shows up in the panel
        function syncFields(force) {
            const ta = prompt();
            const current = ta && parseMoss(ta.value);
            if (!current) return;
            if (force || !state.edited.caption) state.caption = sceneInput.value = mossCaption(ta.value);
            if (force || !state.edited.extra) state.extra = extraInput.value = mossExtra(ta.value);
            if (force) state.edited = {caption: false, extra: false};
        }

        function read() {
            const ta = prompt();
            if (!ta) return;
            if (format() === FORMATS.pan2) {
                pan2.read();
                checkSize();
                return;
            }
            remember();
            if (format() === FORMATS.moss) {
                const [w, h] = size();
                const layout = readMoss(ta.value, w, h);
                state.elements = layout ? layout.elements : [];
                state.meta = metaInput.value = layout ? layout.meta : "";
                state.canvas = canvasSelect.value = layout ? layout.canvas : "single";
                state.written = layout ? [w, h] : null;
                syncFields(true);
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
        // a box taken by its tag (mode "move") or by a handle ("nw", "n", "ne", "e", "se", "s", "sw", "w"):
        // {i, which, mode, from, box, before}, before being the panel as it was, for undo
        let held = null;

        function rawPoint(ev) {
            const r = frame.getBoundingClientRect();
            return [((ev.clientY - r.top) / r.height) * 1000, ((ev.clientX - r.left) / r.width) * 1000];
        }

        function grab(ev, i, which, mode) {
            // a second finger on a touch screen is not primary: it would take a box while another is held
            if (ev.button !== 0 || !ev.isPrimary) return;
            // the frame below would start a new box
            ev.preventDefault();
            ev.stopPropagation();
            state.selected = i;
            state.which = which;
            state.armed = null;
            held = {i, which, mode, from: rawPoint(ev), box: state.elements[i][which], before: snapshot()};
            renderBoxes();
        }
        frame.addEventListener("pointerdown", (ev) => {
            if (ev.button !== 0 || !ev.isPrimary || state.hidden) return;
            ev.preventDefault();
            fitFrame();
            start = point(ev);
            ghost = el("div", {class: "regional-boxes-box ghost"});
            layer.append(ghost);
        });
        window.addEventListener("pointermove", (ev) => {
            if (!ev.isPrimary) return;
            if (held) {
                const [y, x] = rawPoint(ev);
                state.elements[held.i][held.which] = held.mode === "move"
                    ? moveBox(held.box, Math.round(y - held.from[0]), Math.round(x - held.from[1]))
                    : resizeBox(held.box, held.mode, [clamp(y), clamp(x)], ev.shiftKey);
                renderBoxes();
                return;
            }
            if (!start || !ghost) return;
            const [t, l, b, r] = normBox([...start, ...point(ev)]);
            Object.assign(ghost.style, {top: `${t / 10}%`, left: `${l / 10}%`, height: `${(b - t) / 10}%`, width: `${(r - l) / 10}%`});
        });
        // the browser or the system took the touch (a gesture, a notification): no pointerup follows, so the box
        // held goes back to where it was and a box being drawn is dropped
        window.addEventListener("pointercancel", (ev) => {
            if (!ev.isPrimary) return;
            if (held) {
                state.elements[held.i][held.which] = held.box;
                held = null;
                render();
                return;
            }
            start = null;
            if (ghost) ghost.remove();
            ghost = null;
        });
        window.addEventListener("pointerup", (ev) => {
            if (!ev.isPrimary) return;
            if (held) {
                const {i, which, box, before} = held;
                const changed = JSON.stringify(state.elements[i][which]) !== JSON.stringify(box);
                if (changed) {
                    history.remember(before);
                    lastTap = null;
                }
                held = null;
                render();
                if (!changed) tap(i);
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
                let best = -1, bestWhich = "tgt", area = Infinity;
                state.elements.forEach((e, i) => {
                    for (const which of ["tgt", "src"]) {
                        if (!e[which]) continue;
                        const [t, l, bo, r] = normBox(e[which]);
                        if (y >= t && y <= bo && x >= l && x <= r && (bo - t) * (r - l) < area) {
                            best = i;
                            bestWhich = which;
                            area = (bo - t) * (r - l);
                        }
                    }
                });
                state.selected = best;
                state.which = bestWhich;
                state.armed = null;
                render();
                if (best >= 0) tap(best);
                else lastTap = null;
                return;
            }
            const armed = state.armed && state.elements[state.armed.i];
            const full = !armed && format() === FORMATS.marks && state.elements.length >= PALETTE.length;
            if (!full) remember();
            lastTap = null;
            if (armed) {
                armed[state.armed.which] = box;
                // an element from a reference still needs where it goes, unless it is removed
                const next = state.armed.which === "src" && armed.kind === KINDS.ref && !armed.tgt ? "tgt" : null;
                state.armed = next ? {i: state.armed.i, which: next} : null;
            } else if (full) {
                // no color left for a new box: the warning says to delete one first
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
        // PAN 2: Frames is the clip's length, and the timeline follows it
        app.querySelector(`#${tab}_batch_size`)?.addEventListener("input", () => {
            if (format() !== FORMATS.pan2) return;
            pan2.fit();
            checkSize();
        });
        prompt()?.addEventListener("input", () => {
            state.alert = "";
            if (format() === FORMATS.moss) syncFields(false);
            if (format() === FORMATS.pan2) pan2.forgetNote();
            checkSize();
        });
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
        syncFields(true);
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
