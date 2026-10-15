// Regional Boxes for Forge Neo
// The panel's output: FLUX 3 coordinates in Black Forest Labs' exact format, and Qwen-style notes and marks.
// Run by tests/test_panel.py (node tests/js/regional_boxes_test.js).

const assert = require("node:assert/strict");
const path = require("node:path");
const R = require(path.join(__dirname, "..", "..", "javascript", "regional_boxes.js"));

const tests = {
    // ---- coordinates (FLUX 3) ----
    "layout element in Black Forest Labs' style"() {
        const json = R.buildLayout([{id: "obj_1", desc: "a red balloon", kind: "place", tgt: [80, 60, 480, 380]}]);
        assert.equal(json, '[{"id": "obj_1", "bbox": [80, 60, 480, 380], "desc": "a red balloon"}]');
    },

    "box edit as the official cactus example"() {
        const json = R.buildLayout([
            {id: "obj_1", desc: "a small potted cactus", kind: "add", tgt: [550, 620, 850, 850]},
            {id: "mug_1", desc: "the white mug", kind: "ref", ref: 0, src: [354, 283, 768, 755], tgt: [354, 283, 768, 755]},
        ]);
        assert.equal(json, '[{"id": "obj_1", "from": "target", "src_bbox": null, "tgt_bbox": [550, 620, 850, 850], ' +
            '"desc": "a small potted cactus"}, {"id": "mug_1", "from": "ref_image_0", "src_bbox": [354, 283, 768, 755], ' +
            '"tgt_bbox": [354, 283, 768, 755], "desc": "the white mug"}]');
    },

    "remove has a null target and keeps the reference index"() {
        const [o] = JSON.parse(R.buildLayout([{id: "lamp", desc: "", kind: "remove", ref: 2, src: [1, 2, 300, 400], tgt: [5, 5, 50, 50]}]));
        assert.deepEqual(o, {id: "lamp", from: "ref_image_2", src_bbox: [1, 2, 300, 400], tgt_bbox: null, desc: ""});
    },

    "incomplete elements are left out, and drags drawn backwards are normalized"() {
        const json = R.buildLayout([
            {id: "a", desc: "", kind: "place", tgt: null},
            {id: "b", desc: "", kind: "ref", ref: 0, src: [1, 1, 9, 9], tgt: null},
            {id: "c", desc: "", kind: "place", tgt: [900, 800, 100, 1200]},
        ]);
        assert.deepEqual(JSON.parse(json), [{id: "c", bbox: [100, 800, 900, 1000], desc: ""}]);
        assert.equal(R.buildLayout([]), "");
    },

    "descriptions keep quotes, commas and brackets"() {
        const desc = 'a sign reading "OPEN, 24h" [neon]';
        const [o] = JSON.parse(R.buildLayout([{id: "sign", desc, kind: "place", tgt: [0, 0, 10, 10]}]));
        assert.equal(o.desc, desc);
    },

    "writes at the end, then replaces the same list"() {
        const caption = "A still life <a_1>.";
        const once = R.writeLayout(caption, '[{"id": "a_1", "bbox": [0, 0, 500, 500], "desc": ""}]');
        assert.equal(once, 'A still life <a_1>. [{"id": "a_1", "bbox": [0, 0, 500, 500], "desc": ""}]');
        const twice = R.writeLayout(once, '[{"id": "a_1", "bbox": [1, 1, 2, 2], "desc": ""}]');
        assert.equal(twice, 'A still life <a_1>. [{"id": "a_1", "bbox": [1, 1, 2, 2], "desc": ""}]');
        assert.equal(R.writeLayout(twice, ""), caption);
    },

    "replaces a list sd-dynamic-prompts stripped"() {
        const stripped = 'Caption <a_1>. ["id": "a_1", "bbox": [0, 0, 500, 500], "desc": "x"] and more';
        assert.equal(R.writeLayout(stripped, '[{"id": "a_1", "bbox": [0, 0, 9, 9], "desc": "x"}]'),
            'Caption <a_1>. [{"id": "a_1", "bbox": [0, 0, 9, 9], "desc": "x"}] and more');
    },

    "leaves prompt editing syntax alone"() {
        assert.equal(R.findLayoutSpan("a [red:blue:0.5] car"), null);
        assert.equal(R.writeLayout("a [red:blue:0.5] car", ""), "a [red:blue:0.5] car");
    },

    "reads the official cactus prompt back"() {
        const prompt = 'Add a small potted cactus <obj_1>. [{"id": "obj_1", "from": "target", "src_bbox": null, ' +
            '"tgt_bbox": [550, 620, 850, 850], "desc": "A small potted cactus."}, {"id": "mug_1", "from": "ref_image_0", ' +
            '"src_bbox": [354, 283, 768, 755], "tgt_bbox": null, "desc": "A mug."}]';
        const els = R.readLayout(prompt);
        assert.equal(els.length, 2);
        assert.equal(els[0].kind, "add");
        assert.equal(els[1].kind, "remove");
        assert.deepEqual(JSON.parse(R.buildLayout(els)), JSON.parse(prompt.slice(prompt.indexOf("["))));
    },

    // ---- marks (Qwen-Image 2.1) ----
    "notes in the validated sketch-mark wording"() {
        const notes = R.buildNotes([
            {desc: "add a red knitted beanie that fits his head", tgt: [40, 300, 380, 700], color: 1},
            {desc: "change the t-shirt to a light blue denim shirt.", tgt: [750, 220, 1000, 820], color: 0},
        ]);
        assert.equal(notes, "Inside the blue box: add a red knitted beanie that fits his head. " +
            "Inside the red box: change the t-shirt to a light blue denim shirt. " +
            "Remove the blue and red box outlines from the image. Keep everything else exactly as it is.");
    },

    "one box, and boxes without a note or a box are left out"() {
        assert.equal(R.buildNotes([{desc: "add a cactus", tgt: [1, 1, 9, 9], color: 0}, {desc: "", tgt: [1, 1, 9, 9], color: 1},
            {desc: "x", tgt: null, color: 2}]),
            "Inside the red box: add a cactus. Remove the red box outline from the image. Keep everything else exactly as it is.");
        assert.equal(R.buildNotes([]), "");
        assert.equal(R.buildNotes([{desc: "a", tgt: [1, 1, 9, 9], color: 0}, {desc: "b", tgt: [1, 1, 9, 9], color: 1},
            {desc: "c", tgt: [1, 1, 9, 9], color: 2}]).includes("Remove the red, blue and green box outlines"), true);
    },

    "notes are written once and then replaced"() {
        const caption = "A photo of a man.";
        const first = R.buildNotes([{desc: "add a beanie", tgt: [1, 1, 9, 9], color: 0}]);
        const once = R.writeNotes(caption, first);
        assert.equal(once, `${caption} ${first}`);
        const second = R.buildNotes([{desc: "add a cap", tgt: [1, 1, 9, 9], color: 1}]);
        assert.equal(R.writeNotes(once, second), `${caption} ${second}`);
        assert.equal(R.writeNotes(once, ""), caption);
        assert.equal(R.writeNotes("", first), first);
    },

    "the payload the script draws from"() {
        const payload = JSON.parse(R.marksPayload([{desc: "add a cactus", tgt: [850, 850, 550, 620], color: 0},
            {desc: "", tgt: [1, 1, 9, 9], color: 1}], true));
        assert.deepEqual(payload, {format: "marks", draw: true, boxes: [{color: "red", bbox: [550, 620, 850, 850]}]});
        assert.equal(JSON.parse(R.marksPayload([], false)).draw, false);
    },

    "palette names match the Python side's order"() {
        assert.deepEqual(R.PALETTE.map(([n]) => n), ["red", "blue", "green", "yellow", "magenta", "orange", "cyan", "purple"]);
    },

    // ---- auto format ----
    "auto picks coordinates for FLUX 3 and marks for the others"() {
        assert.equal(R.resolveFormat("auto", "flux3", "anything"), "coords");
        assert.equal(R.resolveFormat("auto", "klein", "flux3_image_klein_sd_int8_convrot.safetensors"), "coords");
        assert.equal(R.resolveFormat("auto", "qwen21", "Qwen 2.1\\qwen_image_2.1_turbo_int8_convrot.safetensors"), "marks");
        assert.equal(R.resolveFormat("auto", "klein", "flux-2-klein-9b.safetensors"), "marks");
        assert.equal(R.resolveFormat("marks", "flux3", ""), "marks");
        assert.equal(R.resolveFormat("coords", "qwen21", ""), "coords");
    },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
    try {
        fn();
        console.log(`ok   ${name}`);
    } catch (e) {
        failed++;
        console.log(`FAIL ${name}\n${e.message}`);
    }
}
console.log(`${Object.keys(tests).length - failed}/${Object.keys(tests).length} passed`);
process.exit(failed ? 1 : 0);
