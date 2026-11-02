#!/usr/bin/env node
// The command line: `caliper <url> [options]`.

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, readFileSync, statSync } from "node:fs";
import { NAME, PACKAGE, DISPLAY_NAME, VERSION } from "./brand.js";
import { mostlyUnseen, run, scenarioResults } from "./run.js";
import { writeReport } from "./report.js";
import { SCENARIO_IDS } from "./scenarios.js";
import { RULES } from "./rules.js";
import { parseSteps, type ScriptedState } from "./steps.js";

const HELP = `${DISPLAY_NAME} ${VERSION}: stress-test a web page and report what breaks.

Usage
  npx ${PACKAGE} <url> [options]

Options
  --out <dir>          Where to write the report (default: ./${NAME}-report)
  --only <ids>         Comma-separated scenarios to run (baseline always runs)
                       ${SCENARIO_IDS.filter((s) => s !== "baseline").join(", ")}
  --width <px>         Also test a desktop window this wide, such as a side
                       panel. Comma-separated or repeatable: --width 360,400
  --steps <file>       Also measure the states a JSON file scripts, such as
                       a sheet behind two clicks (see the README)
  --no-interact        Don't open menus, hover or press Tab. Scripted states
                       from --steps still run
  --max-shots <n>      Screenshot at most n findings (default: 40)
  --ignore <selector>  Leave out matching elements (repeatable). Elements
                       with a data-caliper-ignore attribute are always left out
  --no-fail            Exit with 0 even when issues are found
  -h, --help           Show this help
  -v, --version        Show the version

Examples
  npx ${PACKAGE} https://example.com
  npx ${PACKAGE} http://localhost:3000/pricing --only narrow,long-text
  npx ${PACKAGE} http://localhost:5173/panel --width 400 --steps states.json
`;

function readArgs() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        out: { type: "string" },
        only: { type: "string" },
        width: { type: "string", multiple: true },
        steps: { type: "string" },
        "no-interact": { type: "boolean" },
        "max-shots": { type: "string" },
        ignore: { type: "string", multiple: true },
        "no-fail": { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (error) {
    const option = (error as Error).message.match(/'(-[^' ]+)/)?.[1] ?? "That option";
    const unknown = (error as NodeJS.ErrnoException).code === "ERR_PARSE_ARGS_UNKNOWN_OPTION";
    console.error(`${unknown ? `Unknown option ${option}.` : `${option} needs a value.`} Run ${NAME} --help to see the options.`);
    process.exit(2);
  }
}

async function main() {
  const { values, positionals } = readArgs();

  if (values.version) return console.log(VERSION);
  if (values.help || positionals.length === 0) return console.log(HELP);

  // Accept a local file path, a bare domain (example.com), or a full URL.
  const input = positionals[0]!;
  let url = input;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    if (/^(mailto|tel|sms|data|blob|about|javascript):/i.test(url)) {
      console.error(`"${input}" doesn't look like a web address. Try example.com or http://localhost:3000.`);
      process.exit(2);
    }
    if (existsSync(url)) {
      // A folder means its index page.
      const path = statSync(url).isDirectory() ? resolve(url, "index.html") : resolve(url);
      if (!existsSync(path)) {
        console.error(`${url} is a folder with no index.html. Give Caliper a page, such as ${url}/about.html.`);
        process.exit(2);
      }
      url = pathToFileURL(path).href;
    } else {
      // Local dev servers speak plain http.
      const local = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|10\.|192\.168\.|[\w-]+\.local\b|[\w-]+:\d+)/i.test(url);
      url = `${local ? "http" : "https"}://${url}`;
    }
  }
  try {
    const parsed = new URL(url);
    if (!["http:", "https:", "file:"].includes(parsed.protocol)) throw new Error();
  } catch {
    console.error(`"${input}" doesn't look like a web address. Try example.com or http://localhost:3000.`);
    process.exit(2);
  }

  const maxShots = values["max-shots"] === undefined ? undefined : Number(values["max-shots"]);
  if (maxShots !== undefined && !(Number.isInteger(maxShots) && maxShots >= 0)) {
    console.error(`--max-shots takes a whole number, such as 20.`);
    process.exit(2);
  }

  const only = values.only?.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = only?.filter((s) => !SCENARIO_IDS.includes(s));
  if (unknown?.length) {
    console.error(`Unknown scenario: ${unknown.join(", ")}. Choose from ${SCENARIO_IDS.join(", ")}.`);
    process.exit(2);
  }

  const widths = [...new Set(values.width?.flatMap((w) => w.split(",")).map((w) => Number(w.trim())))];
  if (widths.some((w) => !Number.isInteger(w) || w < 200 || w > 3840)) {
    console.error(`--width takes a width in px between 200 and 3840, such as 400.`);
    process.exit(2);
  }

  let steps: ScriptedState[] | undefined;
  if (values.steps) {
    try {
      steps = parseSteps(readFileSync(values.steps, "utf8"));
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      console.error(missing ? `Couldn't find the steps file ${values.steps}.` : `The steps file ${values.steps} ${(error as Error).message}.`);
      process.exit(2);
    }
  }

  const outDir = resolve(values.out ?? `${NAME}-report`);
  console.log(`${DISPLAY_NAME} is stressing ${url}`);

  const result = await run({
    url,
    outDir,
    scenarios: only,
    maxShots,
    ignore: values.ignore,
    widths,
    steps,
    interact: !values["no-interact"],
    log: (line) => console.log(line),
  });
  await writeReport(result, outDir);

  const high = result.findings.filter((f) => RULES[f.rule].severity === "high").length;
  console.log(`\n${result.findings.length} ${result.findings.length === 1 ? "issue" : "issues"} (${high} high) in ${Math.round(result.durationMs / 1000)} s`);
  const rows = scenarioResults(result);
  const asIs = rows.find((r) => r.id === "baseline")!;
  const stress = rows.filter((r) => r.id !== "baseline" && r.finished);
  const broke = stress.filter((r) => r.issues > 0);
  if (asIs.issues) console.log(`Already broken as is: ${asIs.issues} ${asIs.issues === 1 ? "issue" : "issues"}.`);
  if (stress.length) {
    console.log(`Held up in ${stress.length - broke.length} of ${stress.length} stress tests.${broke.length ? ` Broke in: ${broke.map((r) => `${r.label} (${r.issues})`).join(", ")}` : ""}`);
  }
  // A partial run must never read like a clean one.
  const labelFor = new Map(result.scenarios.map((s) => [s.id, s.label]));
  if (result.incomplete.length) {
    const one = result.incomplete.length === 1;
    console.log(`Partial run: ${result.incomplete.length} of ${result.scenarios.length} scenarios didn't finish, so ${one ? "it wasn't" : "they weren't"} checked.`);
    for (const x of result.incomplete) console.log(`  ${labelFor.get(x.scenario)}: ${x.reason}`);
  }
  if (result.capped.length) console.log(`Some checks hit the limit of 25 findings per scenario, so there may be more.`);
  const opened = new Set(result.states.map((s) => s.name)).size;
  if (opened) console.log(`Opened and measured ${opened} ${opened === 1 ? "state" : "states"}.`);
  for (const note of result.notes) console.log(note);
  if (mostlyUnseen(result)) console.log(`Partly checked: most of this page sits inside web components or iframes, which Caliper can't see into yet.`);
  const labelOf = new Map(result.scenarios.map((s) => [s.id, s.label]));
  for (const f of result.findings.slice(0, 10)) {
    const more = f.similar.length ? ` (+${f.similar.length} like it)` : "";
    // The page scrolling sideways is reported once per scenario, so name it.
    const where = f.rule === "layout/page-overflow" ? ` (${labelOf.get(f.scenarios[0]!)})` : "";
    console.log(`  ${RULES[f.rule].severity === "high" ? "!" : "-"} ${RULES[f.rule].title}${where}: ${f.label}${more}`);
  }
  if (result.findings.length > 10) console.log(`  …and ${result.findings.length - 10} more`);
  console.log(`\nReport: ${pathToFileURL(`${outDir}/index.html`).href}`);

  if (!values["no-fail"]) {
    if (result.findings.length) process.exitCode = 1;
    else if (result.incomplete.length || mostlyUnseen(result)) process.exitCode = 2; // nothing found, but not everything was checked
  }
}

main().catch((error) => {
  const code = (error as NodeJS.ErrnoException)?.code ?? "";
  const path = (error as NodeJS.ErrnoException)?.path;
  // Everything else already reads well; a file system error doesn't.
  if (/^(EACCES|EPERM|EROFS|ENOTDIR|EEXIST|ENOSPC)$/.test(code)) console.error(`Couldn't write the report to ${path}. Pick another folder with --out.`);
  else console.error(error instanceof Error ? error.message : error);
  process.exit(2);
});
