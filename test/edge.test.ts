// One small page per thing that went wrong on real sites, or could: each
// must end cleanly, catch what is really broken and leave the rest alone.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { recommend, RULES } from "../src/rules.ts";
import { mostlyUnseen, run, type RunResult } from "../src/run.ts";
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

const check = async (page: string, scenarios: string[] = ["narrow"], ignore?: string[]): Promise<RunResult> =>
  run({ url: `${base}edge/${page}.html`, outDir: await mkdtemp(join(tmpdir(), "caliper-edge-")), scenarios, maxShots: 0, ignore });

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
  assert.deepEqual(rules(await check("hidden-things")), []);
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
