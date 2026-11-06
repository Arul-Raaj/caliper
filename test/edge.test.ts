// One small page per thing that went wrong on real sites, or could: each
// must end cleanly, catch what is really broken and leave the rest alone.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { recommend, RULES } from "../src/rules.ts";
import { mostlyUnseen, run, type RunOptions, type RunResult } from "../src/run.ts";
import { decodePng, contrast } from "../src/pixels.ts";
import { parseSteps } from "../src/steps.ts";
import { serve } from "./serve.ts";

let server: Server;
let base: string;

before(async () => {
  const s = await serve();
  server = s.server;
  base = s.url;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

const check = async (page: string, scenarios: string[] = ["narrow"], ignore?: string[], extra: Partial<RunOptions> = {}): Promise<RunResult> =>
  run({ url: `${base}edge/${page}.html`, outDir: await mkdtemp(join(tmpdir(), "caliper-edge-")), scenarios, maxShots: 0, ignore, ...extra });

const rules = (r: RunResult) => r.findings.map((f) => f.rule);
const pageCards = (r: RunResult) => r.findings.filter((f) => f.rule === "layout/page-overflow");

test("a page with more than 25 spills reports them, capped", async () => {
  const r = await check("many-spills", []);
  assert.ok(r.findings.length > 0);
  assert.deepEqual(r.capped, [{ scenario: "baseline", rule: "content/spill" }]);
});

test("a web font that never answers can't hang the run", async () => {
  const r = await check("stalled-font", []);
  assert.deepEqual(r.findings, []);
});

test("a late client-side redirect is followed", async () => {
  const r = await check("late-redirect", []);
  assert.match(r.testedUrl, /clean\.html/);
});

test("a blank page isn't called clean", async () => {
  await assert.rejects(check("blank", []), /nothing to test/);
});

test("a page sealed inside a web component says so", async () => {
  const r = await check("shadow", []);
  assert.equal(r.unseen.shadow, 1);
  assert.ok(mostlyUnseen(r));
});

for (const page of ["wide-sticky", "wide-decorative", "wide-pseudo", "wide-escaped"]) {
  test(`sideways scrolling is reported on ${page}`, async () => {
    assert.ok(pageCards(await check(page, [])).length > 0);
  });
}

test("the page card stays when the culprit has its own finding", async () => {
  const r = await check("wide-heading", []);
  assert.equal(pageCards(r).length, 1);
  assert.ok(rules(r).includes("content/long-word") || rules(r).includes("content/spill"));
});

for (const page of ["body-hidden", "body-clip"]) {
  test(`a page that can't scroll sideways isn't flagged: ${page}`, async () => {
    assert.deepEqual(pageCards(await check(page, [])), []);
  });
}

test("the page card leads with the element reaching furthest, right side only", async () => {
  const r = await check("wide-several", []);
  const [card] = pageCards(r);
  assert.match(card!.label, /div\.long/);
  assert.match(card!.evidence, /reaches 1900 px/);
  assert.ok(!card!.similar.some((s) => s.label.includes("far")));
});

test("text cut by a wrapper box is caught", async () => {
  const r = await check("wrapper-clip", []);
  assert.deepEqual(rules(r), ["content/clip"]);
});

test("a button label cut inside a span is caught", async () => {
  assert.deepEqual(rules(await check("button-span", [])), ["content/label-truncated"]);
});

test("nothing hidden is flagged: closed menus, accordions and details", async () => {
  assert.deepEqual(rules(await check("hidden-things", ["narrow"], undefined, { interact: false })), []);
});

test("what a closed details hides is measured once it is opened", async () => {
  const r = await check("hidden-things");
  assert.deepEqual(rules(r), ["input/min-tap"]);
  assert.match(r.findings[0]!.state!, /summary "More" open/);
});

test("a logo's text-indent label isn't flagged", async () => {
  assert.deepEqual(rules(await check("logo-indent", [])), []);
});

test("the gap is the text past the edge, whatever the padding", async () => {
  const [f] = (await check("padded-clip", [])).findings;
  const [, needs, shown, hidden] = f!.evidence.match(/needs (\d+) px; (\d+) px is shown. (\d+) px is hidden/)!.map(Number);
  assert.equal(needs! - shown!, hidden);
  assert.ok(hidden! > 60, f!.evidence);
});

test("utility classes don't turn a heading into a card title", async () => {
  const r = await check("tailwind-heading", ["long-word"]);
  const hero = r.findings.find((f) => f.rule === "content/long-word" && f.label.startsWith('h2 "Build'));
  assert.equal(hero?.role, "heading");
  assert.equal(recommend(RULES[hero!.rule], hero!.role).fixes[0].title, "Wrap, balance and break long words");
});

test("a heading in a nav stays a heading", async () => {
  const r = await check("tailwind-heading", ["long-word"]);
  assert.equal(r.findings.find((f) => f.label.startsWith('h2 "Resources'))?.role, "heading");
});

test("a carousel track isn't a blown-out row", async () => {
  assert.deepEqual(rules(await check("carousel")), []);
});

test("an image layer that moves nothing isn't a layout jump", async () => {
  const r = await check("image-layer", ["broken-images"]);
  assert.deepEqual(r.findings.filter((f) => f.rule === "media/missing").map((f) => f.label), ['img.flow "Flow"']);
});

test("--ignore and data-caliper-ignore cover images", async () => {
  assert.deepEqual(rules(await check("ignored-image", [], [".photo"])), []);
});

test("a bad --ignore selector stops the run with a clear message", async () => {
  await assert.rejects(check("clean", [], ["div["]), /isn't a valid CSS selector/);
});

test("every cause marked tested says what was tried", async () => {
  const r = await check("wrapper-clip", []);
  assert.match(r.findings[0]!.cause!.text, /Allowed to wrap/);
  assert.equal(r.findings[0]!.cause!.confirmed, true);
});

// ---------- every rule: one page that fails, one that passes ----------

const hasRule = (r: RunResult, rule: string) => r.findings.find((f) => f.rule === rule);

for (const [rule, fail, pass] of [
  ["scroll/bar-over-content", "bar-over-content-fail", "bar-over-content-pass"],
  ["scroll/bar-over-content", "bar-flush-fail", "bar-hidden-pass"],
  ["scroll/bar-over-content", "bar-tight-fail", "bar-clear-pass"],
  ["scroll/bar-over-content", "bar-fold-fail", "bar-fold-pass"],
  ["layout/control-past-container", "control-past-fail", "control-past-pass"],
  ["hover/fill-hugs-content", "hover-fill-fail", "hover-fill-pass"],
  ["hover/fill-hugs-content", "hover-corners-fail", "hover-corners-pass"],
  ["overlay/offscreen-x", "overlay-x-fail", "overlay-x-pass"],
  ["focus/no-visible-ring", "focus-ring-fail", "focus-ring-pass"],
  ["text/word-broken", "word-broken-fail", "word-broken-pass"],
  ["media/invisible-on-background", "media-invisible-fail", "media-invisible-pass"],
] as const) {
  test(`${rule} fires on ${fail}`, async () => {
    assert.ok(hasRule(await check(fail, []), rule));
  });
  test(`${rule} stays quiet on ${pass}`, async () => {
    const r = await check(pass, []);
    assert.deepEqual(r.findings.filter((f) => f.rule === rule).map((f) => f.evidence), []);
  });
}

// The newer checks, each with the scenario that shows it. The passing page
// is the same component built the robust way.
for (const [rule, fail, pass, scenarios] of [
  ["layout/uneven-row-spacing", "row-uneven-fail", "row-uneven-pass", []],
  ["layout/stretched-shape", "shape-stretched-fail", "shape-stretched-pass", []],
  ["layout/stretched-shape", "shape-svg-stretched-fail", "shape-stretched-pass", ["narrow"]],
  ["layout/text-touches-control", "text-touch-fail", "text-touch-pass", ["narrow"]],
  ["layout/text-touches-control", "text-under-menu-fail", "text-touch-pass", ["long-text"]],
  ["layout/text-touches-control", "var-chat-fail", "var-chat-pass", []],
  ["layout/flex-min-size", "flex-chips-fail", "flex-chips-pass", ["narrow"]],
  ["layout/flex-min-size", "flex-column-fail", "flex-min-pass", []],
  ["layout/flex-min-size", "flex-input-fail", "flex-min-pass", ["narrow"]],
  ["layout/auto-fit-stretch", "autofit-fail", "autofit-pass", []],
  ["layout/grid-min-size", "grid-fixed-fail", "grid-fixed-pass", ["narrow"]],
  ["layout/grid-min-size", "grid-code-fail", "grid-code-pass", []],
  ["layout/sticky-no-room", "sticky-room-fail", "sticky-room-pass", []],
  ["layout/fixed-offscreen", "sticky-tall-fail", "sticky-tall-pass", ["short-screen"]],
  ["layout/covered-by-pinned", "var-header-fail", "sticky-tall-pass", []],
  ["layout/pinned-cover", "bars-cover-fail", "bars-cover-pass", ["short-screen"]],
  ["layout/fixed-size", "fixed-height-fail", "fixed-sizes-pass", ["long-text"]],
  ["layout/fixed-width", "fixed-width-fail", "fixed-sizes-pass", ["narrow"]],
  ["media/distortion", "bg-size-fail", "img-cover-pass", []],
  ["media/distortion", "img-thumb-fail", "img-svg-pass", []],
  ["media/wider-than-box", "img-wide-fail", "img-wide-pass", []],
  ["media/wider-than-box", "img-card-fail", "img-wide-pass", []],
  ["media/bg-tiles", "bg-tile-fail", "bg-tile-pass", []],
  ["media/bg-tiles", "bg-mark-fail", "bg-tile-pass", []],
  ["content/unreadable-without-image", "text-photo-fail", "text-photo-pass", ["broken-images"]],
  ["content/unreadable-without-image", "text-caption-fail", "text-photo-pass", ["broken-images"]],
  ["media/edge-lost", "edge-white-fail", "edge-ring-pass", []],
  ["media/invisible-on-background", "logo-white-fail", "edge-outline-pass", []],
  ["content/clip", "pill-clip-fail", "pill-clip-pass", ["long-text"]],
  ["input/short-button", "short-button-fail", "short-button-pass", []],
  ["css/var-unresolved", "var-chat-fail", "var-chat-pass", []],
  ["css/var-unresolved", "var-icon-fail", "var-chat-pass", []],
  ["css/var-unresolved", "var-chat-fail", "var-override-pass", []],
  ["css/dropped-rule", "vendor-group-fail", "vendor-group-pass", []],
  ["scroll/chains-to-page", "chain-fail", "chain-pass", []],
  ["scroll/gutter-shift", "gutter-shift-fail", "gutter-shift-pass", []],
  ["scroll/empty-bar", "empty-bar-fail", "empty-bar-pass", []],
  ["hover/sticks-on-touch", "touch-hover-fail", "touch-hover-pass", ["narrow"]],
  ["input/focus-zoom", "zoom-field-fail", "zoom-field-pass", ["narrow"]],
] as const) {
  test(`${rule} fires on ${fail}`, async () => {
    const r = await check(fail, [...scenarios]);
    assert.ok(hasRule(r, rule), JSON.stringify(rules(r)));
  });
  test(`${rule} stays quiet on ${pass}`, async () => {
    const r = await check(pass, [...scenarios]);
    assert.deepEqual(r.findings.filter((f) => f.rule === rule).map((f) => f.evidence), []);
  });
}

test("chips that can wrap get the wrap fix first, tested in the page", async () => {
  const f = hasRule(await check("flex-chips-fail", ["narrow"]), "layout/flex-min-size");
  assert.equal(recommend(RULES[f!.rule], f!.role, f!.fixes).fixes[0].title, "Let the row wrap");
});

test("a column item that won't shrink is traced to min-height", async () => {
  const f = hasRule(await check("flex-column-fail", []), "layout/flex-min-size");
  assert.match(f!.cause!.text, /min-height/);
  assert.equal(f!.fixes?.[0]?.title, "Let the item shrink");
});

test("fixed grid columns get a breakpoint from their measured width", async () => {
  const f = hasRule(await check("grid-fixed-fail", ["narrow"]), "layout/grid-min-size");
  assert.equal(f!.fixes?.[0]?.title, "Stack the columns on small screens");
  assert.match(f!.fixes![0]!.css, /@media \(max-width: \d+px\)/);
});

test("a name pushed out of a fixed-width pill is cut by the pill", async () => {
  const f = hasRule(await check("pill-clip-fail", ["long-text"]), "content/clip");
  assert.match(f!.label, /span "Marta/);
  assert.match(f!.evidence, /div\.account/);
});

test("a round SVG avatar stretched by its row is a stretched shape, not a distorted image", async () => {
  const r = await check("shape-svg-stretched-fail", ["narrow"]);
  assert.equal(hasRule(r, "media/distortion"), undefined);
  assert.match(hasRule(r, "layout/stretched-shape")!.label, /img/);
});

test("a header that covers the first heading gives padding from its own height", async () => {
  const f = hasRule(await check("var-header-fail", []), "layout/covered-by-pinned");
  assert.match(f!.fixes?.[0]?.css ?? "", /padding-top: \d+px|scroll-padding-top: \d+px/);
});

test("a scrollbar at 383 px with content at 383 px in a 400 px panel is measured", async () => {
  const f = hasRule(await check("bar-over-content-fail", []), "scroll/bar-over-content");
  assert.match(f!.evidence, /right edge is at 383 px, 17 px inside its 400 px panel/);
});

test("scrollbars take real room, so report screenshots show them", async () => {
  const f = hasRule(await check("bar-flush-fail", []), "scroll/bar-over-content");
  assert.match(f!.evidence, /0 px from the scrollbar at 385 px/);
});

test("the rule's own gutter fix passes the rule", async () => {
  const css = RULES["scroll/bar-over-content"].fixes[1].css;
  assert.match(css, /scrollbar-gutter: stable;\s+padding-right: 4px/);
  assert.equal(hasRule(await check("bar-gutter-pass", []), "scroll/bar-over-content"), undefined);
});

test("a Send button 9 px past its composer is measured", async () => {
  const f = hasRule(await check("control-past-fail", []), "layout/control-past-container");
  assert.match(f!.evidence, /runs 9 px past the right edge/);
  assert.equal(f!.cause!.confirmed, true);
});

test("a hover fill with no padding says how tight it is", async () => {
  const f = hasRule(await check("hover-fill-fail", []), "hover/fill-hugs-content");
  assert.match(f!.evidence, /leaves 0 px between its left edge/);
});

test("square corners are measured against the rounded surface", async () => {
  const f = hasRule(await check("hover-corners-fail", []), "hover/fill-hugs-content");
  assert.match(f!.evidence, /0 px corners, \d+ px inside a surface with 12 px corners/);
});

test("a hidden tooltip and a parked sheet aren't off screen", async () => {
  assert.equal(hasRule(await check("overlay-x-closed", []), "overlay/offscreen-x"), undefined);
});

test("a missing focus ring is traced to the outline", async () => {
  const f = hasRule(await check("focus-ring-fail", []), "focus/no-visible-ring");
  assert.match(f!.evidence, /outline 0px none/);
  assert.equal(f!.cause!.confirmed, true);
});

test("a table header split mid-word names both halves", async () => {
  const f = hasRule(await check("word-broken-fail", []), "text/word-broken");
  assert.match(f!.evidence, /"Required" breaks into "\w+" and "\w+"/);
});

test("the 63-letter word never counts as a broken word", async () => {
  const r = await check("word-broken-pass", ["long-word"]);
  assert.equal(hasRule(r, "text/word-broken"), undefined);
});

test("a white logo on white and a white icon on a pale fill are both caught", async () => {
  const r = await check("media-invisible-fail", []);
  const f = r.findings.filter((x) => x.rule === "media/invisible-on-background");
  assert.deepEqual(f.map((x) => x.selector).sort(), ["body > button > svg", "body > img"]);
  assert.match(f.find((x) => x.selector === "body > button > svg")!.evidence, /#ffffff on #f2f4f7, a contrast of 1\.\d+:1/);
});

// ---------- foundations ----------

test("a phone scenario tests its own width on a page with no viewport tag", async () => {
  const r = await check("no-viewport-tag");
  assert.ok(hasRule(r, "layout/flex-min-size") || hasRule(r, "layout/page-overflow"), JSON.stringify(rules(r)));
  assert.match(r.notes.join(), /no viewport tag/);
});

test("--width adds a desktop scenario at that width", async () => {
  const r = await check("control-past-pass", [], undefined, { widths: [400] });
  assert.deepEqual(r.scenarios.map((s) => s.id), ["baseline", "width-400"]);
  assert.equal(r.scenarios[1]!.viewport.width, 400);
  assert.equal(r.scenarios[1]!.mobile, false);
});

test("a dark logo that only vanishes in dark mode is caught there alone", async () => {
  const r = await check("media-dark-only", ["dark"]);
  const f = hasRule(r, "media/invisible-on-background");
  assert.deepEqual(f?.scenarios, ["dark"]);
});

test("an opened menu is measured, and says which state it needed", async () => {
  const r = await check("menu-trigger", []);
  const f = hasRule(r, "overlay/offscreen-x");
  assert.match(f!.state!, /with button.* "Sources" open/);
  assert.equal(r.states.length, 1);
});

test("--no-interact leaves closed things closed", async () => {
  const r = await check("menu-trigger", [], undefined, { interact: false });
  assert.equal(hasRule(r, "overlay/offscreen-x"), undefined);
  assert.deepEqual(r.states, []);
});

test("a tooltip that only opens on hover is measured", async () => {
  assert.ok(hasRule(await check("tooltip-hover", []), "overlay/offscreen-x"));
});

test("--steps reaches a state behind two clicks", async () => {
  const steps = parseSteps(JSON.stringify([{ name: "Sheet", steps: [{ click: ".step-one" }, { click: ".step-two" }] }]));
  const r = await check("scripted-state", [], undefined, { steps });
  assert.equal(hasRule(r, "overlay/offscreen-x")?.state, 'in "Sheet"');
  assert.deepEqual(r.incomplete, []);
});

test("a scripted step that can't run makes the run partial", async () => {
  const steps = parseSteps(JSON.stringify([{ name: "Gone", steps: [{ click: ".not-here" }] }]));
  const r = await check("scripted-state", [], undefined, { steps });
  assert.match(r.incomplete[0]!.reason, /"Gone" stopped at/);
});

test("--no-interact still runs scripted states, and nothing else", async () => {
  const steps = parseSteps(JSON.stringify([{ name: "Sheet", steps: [{ click: ".step-one" }, { click: ".step-two" }] }]));
  const r = await check("scripted-state", [], undefined, { steps, interact: false });
  assert.equal(hasRule(r, "overlay/offscreen-x")?.state, 'in "Sheet"');
  assert.deepEqual(r.states, [{ scenario: "baseline", name: 'in "Sheet"' }]);

  const menu = parseSteps(JSON.stringify([{ name: "Waited", steps: [{ wait: 1 }] }]));
  const closed = await check("menu-trigger", [], undefined, { steps: menu, interact: false });
  assert.deepEqual(closed.states.map((s) => s.name), ['in "Waited"']);
  assert.equal(hasRule(closed, "overlay/offscreen-x"), undefined);
});

test("a bad steps file is refused with a reason", () => {
  assert.throws(() => parseSteps("not json"), /valid JSON/);
  assert.throws(() => parseSteps("[]"), /list of states/);
  assert.throws(() => parseSteps('[{"name":"A","steps":[{"jump":".x"}]}]'), /can't read/);
});

test("the PNG reader undoes every filter Playwright can write", () => {
  // Two rows of 2 RGB pixels, filtered None then Paeth, gives the same pixels twice.
  const raw = Buffer.from([0, 10, 20, 30, 40, 50, 60, 4, 0, 0, 0, 0, 0, 0]);
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(2, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const png = Buffer.concat([Buffer.alloc(8), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  assert.deepEqual([...decodePng(png).data], [10, 20, 30, 40, 50, 60, 10, 20, 30, 40, 50, 60]);
  assert.equal(Math.round(contrast([255, 255, 255], [0, 0, 0])), 21);
});
