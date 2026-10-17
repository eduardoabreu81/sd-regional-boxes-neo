// Regional Boxes for Forge Neo
// The panel's output: FLUX 3 coordinates in Black Forest Labs' exact format, Qwen-style notes and marks, and
// MOSS-Image layouts as OpenMOSS's own compiler writes them.
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

    // ---- layout JSON (MOSS-Image) ----
    "MOSS boxes: pixels from the center, in yxyx, as OpenMOSS's compiler"() {
        // exact on the grid: 2000x1000, a box over the top-left quarter's lower half
        assert.deepEqual(R.mossBox([250, 0, 1000, 500], 2000, 1000), [-250, -1000, 500, 0]);
        // the cup of OpenMOSS's layout reference (1536x1024, draft [176, 224, 800, 864] -> [-288, -592, 352, 32]),
        // from the panel's 0-1000 grid: top and left exact, bottom and right enclosed one pixel out at most
        const grid = [224 / 1024, 176 / 1536, 864 / 1024, 800 / 1536].map((v) => Math.round(v * 1000));
        assert.deepEqual(R.mossBox(grid, 1536, 1024), [-288, -592, 353, 33]);
        // drawn backwards, and past the frame
        assert.deepEqual(R.mossBox([1000, 1000, 0, 0], 1024, 1024), [-512, -512, 512, 512]);
    },

    "MOSS layout from a plain prompt: compact, in the official field order"() {
        const prompt = R.writeMoss("A minimalist travel poster with a cream background.  ", [
            {label: "text", desc: "Large dark-blue uppercase title.", text: "EXPLORE\nTHE ALPS", tgt: [0, 0, 250, 1000]},
            {label: "object", desc: "A flat blue mountain.", tgt: [500, 250, 1000, 750]},
            {label: "text", desc: "A subtitle with no words yet.", text: " ", tgt: [900, 0, 1000, 1000]},
            {label: "object", desc: "", tgt: [0, 0, 10, 10]},
            {label: "object", desc: "no box", tgt: null},
        ], 1024, 1024, {meta: ["poster"], canvas: "single"});
        assert.equal(prompt, '{"summary":{"meta":["poster"],"canvas":"single","caption":"A minimalist travel poster with a cream background."},' +
            '"items":[{"label":"text","caption":"Large dark-blue uppercase title.","text":"EXPLORE\\nTHE ALPS","bbox":[-512,-512,-256,512]},' +
            '{"label":"object","caption":"A flat blue mountain.","bbox":[0,-256,512,256]}],"bbox_coord_space":"abs_centralized","bbox_format":"yxyx"}');
    },

    "MOSS layout written again keeps its caption, meta and palette, and replaces the boxes"() {
        const first = R.writeMoss("A photo of a desk.", [{label: "object", desc: "A lamp.", tgt: [0, 0, 500, 500]}], 1024, 1024,
            {meta: ["photo"], canvas: "single"});
        const withPalette = JSON.parse(first);
        withPalette.summary.palette = ["oak", "brass"];
        const second = JSON.parse(R.writeMoss(JSON.stringify(withPalette),
            [{label: "character", desc: "A cat.", tgt: [500, 500, 1000, 1000]}], 1024, 1024, {meta: [], canvas: "collage"}));
        assert.deepEqual(second.summary, {meta: ["photo"], canvas: "collage", caption: "A photo of a desk.", palette: ["oak", "brass"]});
        assert.deepEqual(second.items, [{label: "character", caption: "A cat.", bbox: [0, 0, 512, 512]}]);
    },

    "MOSS layout without boxes turns back into its caption"() {
        const layout = R.writeMoss("A quiet lake.", [{label: "object", desc: "A boat.", tgt: [1, 1, 500, 500]}], 1024, 1024, {});
        assert.equal(R.writeMoss(layout, [], 1024, 1024, {}), "A quiet lake.");
        assert.equal(R.writeMoss("A quiet lake.", [], 1024, 1024, {}), "A quiet lake.");
        assert.equal(R.mossCaption(layout), "A quiet lake.");
        assert.equal(JSON.parse(layout).summary.canvas, "single");
    },

    "reads OpenMOSS's travel poster example back"() {
        const example = '{"summary": {"meta": ["poster"], "canvas": "single", "caption": "A minimalist travel poster."}, "items": [' +
            '{"label": "text", "caption": "Large dark-blue uppercase title centered at the top.", "text": "EXPLORE", "bbox": [-416, -384, -288, 384]}, ' +
            '{"label": "object", "caption": "A flat blue mountain illustration in the lower center.", "bbox": [-192, -288, 384, 288]}], ' +
            '"bbox_coord_space": "abs_centralized", "bbox_format": "yxyx"}';
        const read = R.readMoss(example, 1024, 1024);
        assert.equal(read.meta, "poster");
        assert.equal(read.canvas, "single");
        assert.deepEqual(read.elements.map((e) => [e.label, e.text, e.tgt]),
            [["text", "EXPLORE", [93.75, 125, 218.75, 875]], ["object", "", [312.5, 218.75, 875, 781.25]]]);
        // Read then Write gives the same layout back, pixel for pixel, however many times
        let prompt = example;
        for (let n = 0; n < 3; n++) {
            const again = R.readMoss(prompt, 1024, 1024);
            prompt = R.writeMoss(prompt, again.elements, 1024, 1024, {meta: R.parseMeta(again.meta), canvas: again.canvas});
        }
        assert.deepEqual(JSON.parse(prompt), JSON.parse(example));
        // and on a size that does not divide the grid
        const poster = R.writeMoss("A poster.", [{label: "object", desc: "A fox.", tgt: [227, 115, 833, 901]}], 832, 1248, {});
        const reread = R.readMoss(poster, 832, 1248);
        assert.equal(R.writeMoss(poster, reread.elements, 832, 1248, {}), poster);
    },

    "MOSS: LoRA tags stay out of the layout, after it"() {
        const box = [{label: "object", desc: "A fox.", tgt: [0, 0, 500, 500]}];
        const once = R.writeMoss("A snowy field. <lora:moss_sft_8step_dmd:1>", box, 1024, 1024, {});
        assert.ok(once.endsWith("} <lora:moss_sft_8step_dmd:1>"), once);
        assert.equal(JSON.parse(once.slice(0, once.lastIndexOf("}") + 1)).summary.caption, "A snowy field.");
        assert.equal(R.mossCaption(once), "A snowy field.");
        assert.equal(R.readMoss(once, 1024, 1024).elements.length, 1);
        // a tag added after the first Write is kept too, and without boxes the caption comes back with the tags
        const twice = R.writeMoss(`<lora:style:0.5> ${once}`, box, 1024, 1024, {});
        assert.ok(twice.endsWith("} <lora:style:0.5> <lora:moss_sft_8step_dmd:1>"), twice);
        assert.equal(R.writeMoss(twice, [], 1024, 1024, {}), "A snowy field. <lora:style:0.5> <lora:moss_sft_8step_dmd:1>");
    },

    "MOSS: a new size moves the panel's boxes, there and back without drift"() {
        const els = [{label: "text", desc: "Title.", text: "WINTER FOX", tgt: [80, 80, 200, 920]},
            {label: "object", desc: "A fox.", tgt: [280, 120, 840, 880]}];
        const written = R.writeMoss("A poster. <lora:moss_sft_8step_dmd:1>", els, 832, 1248, {meta: ["poster"]});
        const square = R.rescaleMoss(written, els, [832, 1248], [1024, 1024]);
        assert.deepEqual(JSON.parse(square.slice(0, square.lastIndexOf("}") + 1)).items.map((o) => o.bbox),
            els.map((e) => R.mossBox(e.tgt, 1024, 1024)));
        assert.ok(square.endsWith("} <lora:moss_sft_8step_dmd:1>"), square);
        assert.equal(R.rescaleMoss(square, els, [1024, 1024], [832, 1248]), written);
        // a caption or the words changed by hand in the prompt are kept
        const edited = written.replace("WINTER FOX", "SNOW FOX").replace('"A fox."', '"A sleepy fox."');
        const moved = R.rescaleMoss(edited, els, [832, 1248], [1024, 1024]);
        assert.ok(moved.includes('"text":"SNOW FOX"') && moved.includes('"caption":"A sleepy fox."'), moved);
    },

    "MOSS: boxes changed by hand, or another layout, are not moved"() {
        const els = [{label: "object", desc: "A fox.", tgt: [280, 120, 840, 880]}];
        const written = R.writeMoss("A poster.", els, 832, 1248, {});
        const byHand = written.replace(/"bbox":\[[^\]]*\]/, '"bbox":[-100,-100,100,100]');
        assert.equal(R.rescaleMoss(byHand, els, [832, 1248], [1024, 1024]), null);
        assert.equal(R.rescaleMoss(written, [...els, {label: "object", desc: "A tree.", tgt: [0, 0, 100, 100]}], [832, 1248], [1024, 1024]), null);
        assert.equal(R.rescaleMoss(written, els, [1024, 1024], [832, 1248]), null);
        assert.equal(R.rescaleMoss("A poster.", els, [832, 1248], [1024, 1024]), null);
    },

    "img2img Resize by: the size from Forge's preview"() {
        assert.deepEqual(R.resizeByTarget("resize: from 1024x768 to 1536x1152"), [1536, 1152]);
        assert.deepEqual(R.resizeByTarget("resize: from 832x1248 to 832x1248"), [832, 1248]);
        assert.equal(R.resizeByTarget("no image selected"), null);
        assert.equal(R.resizeByTarget(undefined), null);
    },

    "MOSS: only a layout is read, and boxes past the picture are noticed"() {
        for (const prompt of ["A cat on a sofa.", '{"summary": ', '[{"id": "a", "bbox": [0, 0, 9, 9], "desc": ""}]', '{"items": []}', ""]) {
            assert.equal(R.parseMoss(prompt), null, prompt);
            assert.equal(R.readMoss(prompt, 1024, 1024), null, prompt);
        }
        const layout = R.writeMoss("A street.", [{label: "object", desc: "A car.", tgt: [0, 0, 1000, 1000]}], 832, 1248, {});
        assert.equal(R.mossOutOfBounds(layout, 832, 1248), false);
        assert.equal(R.mossOutOfBounds(layout, 1024, 1024), true);
        assert.equal(R.mossOutOfBounds("A street.", 512, 512), false);
        assert.deepEqual(R.parseMeta(" poster,, flat illustration ,"), ["poster", "flat illustration"]);
    },

    // ---- auto format ----
    "auto: coordinates for FLUX 3, marks for Qwen-Image 2.1, layout JSON for MOSS-Image, nothing for the others"() {
        for (const [preset, ckpt] of [["moss", "anything.safetensors"], ["sd", "MOSS\\moss_image_sft_int8_convrot.safetensors"],
            ["xl", "moss-image-base-bf16.safetensors"]]) {
            assert.equal(R.resolveFormat("auto", preset, ckpt), "moss", ckpt);
        }
        assert.equal(R.resolveFormat("moss", "krea", ""), "moss");
        assert.equal(R.resolveFormat("auto", "flux3", "anything"), "coords");
        assert.equal(R.resolveFormat("auto", "klein", "flux3_image_klein_sd_int8_convrot.safetensors"), "coords");
        for (const ckpt of ["Qwen 2.1\qwen_image_2.1_turbo_int8_convrot.safetensors", "Qwen 2.1\qwenImage21Turbo8_v10.safetensors",
            "qwen21Finalcut66GB25_v10.safetensors"]) {
            assert.equal(R.resolveFormat("auto", "sd", ckpt), "marks", ckpt);
        }
        assert.equal(R.resolveFormat("auto", "qwen21", "noctQUncensoredRealism_int8.safetensors"), "marks");
        for (const [preset, ckpt] of [["krea", "Krea\museByStableYogi_v35Int8Extended.safetensors"], ["anima", "anima_baseV10.safetensors"],
            ["klein", "flux-2-klein-9b.safetensors"], ["qwen", "Qwen-Image-Edit-2509.safetensors"], ["xl", ""]]) {
            assert.equal(R.resolveFormat("auto", preset, ckpt), "none", ckpt);
        }
        assert.equal(R.resolveFormat("marks", "krea", ""), "marks");
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
