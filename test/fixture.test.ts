// End to end: run every scenario against the fixture page. Each fragile
// component must be caught by its rule, and nothing robust may be flagged.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { run, type RunResult } from "../src/run.ts";
import { writeReport } from "../src/report.ts";
import { serve } from "./serve.ts";

let server: Server;
let result: RunResult;
let outDir: string;

before(async () => {
  const s = await serve();
  server = s.server;
  outDir = await mkdtemp(join(tmpdir(), "caliper-test-"));
  result = await run({ url: `${s.url}fragile.html`, outDir, maxShots: 5 });
  await writeReport(result, outDir);
});

after(() => server.close());

// Every flagged element: the main one on each card plus the similar ones.
const flagged = () =>
  result.findings.flatMap((f) => [{ rule: f.rule, selector: f.selector, label: f.label }, ...f.similar.map((s) => ({ rule: f.rule, ...s }))]);

const found = (rule: string, selectorPart: string) =>
  flagged().some((f) => f.rule === rule && (f.selector.includes(selectorPart) || f.label.includes(selectorPart)));

const expectations: [string, string][] = [
  ["content/spill", "f-title"],
  ["content/clip", "f-tag"],
  ["layout/flex-min-size", "role"],
  ["layout/grid-min-size", "f-grid"],
  ["layout/fixed-size", "f-banner"],
  ["layout/page-overflow", "f-wide"],
  ["media/distortion", "f-photo"],
  ["media/missing", "f-thumb"],
  ["input/min-tap", "f-icon"],
  ["content/label-wrap", "f-pay"],
  ["content/label-truncated", "f-cut"],
  ["content/spill", "f-clipline"],
  ["layout/fixed-offscreen", "f-sheet"],
];

for (const [rule, part] of expectations) {
  test(`catches ${rule} on ${part}`, () => {
    assert.ok(found(rule, part), `expected ${rule} on ${part}\n${JSON.stringify(flagged().map((f) => [f.rule, f.label]), null, 1)}`);
  });
}

test("flags nothing in the robust section", () => {
  const robust = flagged().filter((f) => f.selector.includes("section:nth-of-type(2)") || /\.r-/.test(f.label));
  assert.deepEqual(robust.map((f) => `${f.rule} ${f.label}`), []);
});

test("writes a JSON and an HTML report", async () => {
  const json = JSON.parse(await readFile(join(outDir, "report.json"), "utf8"));
  assert.equal(json.findings.length, result.findings.length);
  for (const f of json.findings) {
    // Three fixes, the first recommended, and a prompt that carries it.
    assert.equal(f.fixes.length, 3);
    assert.deepEqual(f.fixes.map((x: { recommended: boolean }) => x.recommended), [true, false, false]);
    assert.ok(f.prompt.includes(f.fixes[0].css), `${f.id} prompt is missing its fix`);
  }
  // Fixes follow what the element is: a button never truncates, a card title clamps.
  const rec = (part: string) => json.findings.find((f: { label: string }) => f.label.includes(part))?.fixes[0].title;
  assert.equal(rec("f-pay"), "Size to the label, wrap only if it must");
  assert.equal(rec("f-title"), "Clamp to two lines");
  const html = await readFile(join(outDir, "index.html"), "utf8");
  assert.match(html, /Caliper report/);
  // Each card offers the three fixes plus "Write your own".
  assert.equal((html.match(/name="[^"]+-choice"/g) ?? []).length, result.findings.length * 4);
  // Two script tags (data and code): page text can't close one early.
  assert.equal((html.match(/<\/script>/g) ?? []).length, 2);
});

test("a partial run says so and never reads as clean", async () => {
  const partialDir = join(outDir, "partial");
  await mkdir(partialDir, { recursive: true });
  await writeReport({ ...result, findings: [], incomplete: [{ scenario: "narrow", reason: "the page took too long to load in this scenario." }], capped: [] }, partialDir);
  const html = await readFile(join(partialDir, "index.html"), "utf8");
  assert.match(html, /Partial run/);
  assert.match(html, /didn't finish/);
  assert.doesNotMatch(html, /held up in every scenario/);
});
