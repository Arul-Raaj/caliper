// The published file is a minified bundle, not the source the other test
// runs. Build it, run it on the fixture, and check it finds the same issues.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { run } from "../src/run.ts";
import { serve } from "./serve.ts";

let server: Server;
let url: string;

before(async () => {
  const s = await serve();
  server = s.server;
  url = `${s.url}fragile.html`;
  execFileSync(process.execPath, ["scripts/bundle.mjs"], { stdio: "ignore" });
});

after(() => server.close());

test("the bundle finds the same issues as the source", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "caliper-bundle-"));
  // Run it asynchronously: the fixture server lives in this process.
  const exitCode = await promisify(execFile)(process.execPath, ["dist/caliper.js", url, "--out", outDir, "--max-shots", "0"])
    .then(() => 0, (error: { code?: number; stderr?: string }) => {
      if (error.code !== 1) throw error;
      return 1;
    });
  assert.equal(exitCode, 1);
  const bundled = JSON.parse(await readFile(join(outDir, "report.json"), "utf8"));

  const source = await run({ url, outDir: await mkdtemp(join(tmpdir(), "caliper-source-")), maxShots: 0 });
  const key = (f: { rule: string; selector: string }) => `${f.rule} ${f.selector}`;
  assert.deepEqual(bundled.findings.map(key).sort(), source.findings.map(key).sort());
});
