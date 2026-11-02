// Writes the results as report.json (for agents and CI) and index.html
// (for people). The HTML is one self-contained file plus the screenshots.

import { writeFile } from "node:fs/promises";
import { DISPLAY_NAME, VERSION } from "./brand.js";
import { fixText, prompt, promptParts } from "./prompt.js";
import { recommend, ROLE_NAMES, RULES } from "./rules.js";
import { mostlyUnseen, ordered, scenarioResults, type Finding, type RunResult } from "./run.js";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function writeReport(result: RunResult, outDir: string) {
  const json = {
    tool: DISPLAY_NAME,
    version: VERSION,
    ...result,
    findings: ordered(result.findings).map((f) => {
      const rule = RULES[f.rule];
      const rec = recommend(rule, f.role);
      return {
        ...f,
        title: rule.title,
        severity: rule.severity,
        why: rule.why,
        recommendation: { confidence: rec.confidence, basis: rec.basis },
        fixes: rec.fixes.map((fix, i) => ({ ...fix, recommended: i === 0 })),
        prompt: prompt(result, f), // with the recommended fix
      };
    }),
  };
  await writeFile(`${outDir}/report.json`, JSON.stringify(json, null, 2));
  await writeFile(`${outDir}/index.html`, html(result));
}

function html(result: RunResult): string {
  const label = new Map(result.scenarios.map((s) => [s.id, s.label]));
  const phrase = new Map(result.scenarios.map((s) => [s.id, s.phrase]));
  const findings = ordered(result.findings);
  const high = findings.filter((f) => RULES[f.rule].severity === "high");
  const medium = findings.filter((f) => RULES[f.rule].severity !== "high");
  const affected = findings.reduce((n, f) => n + 1 + f.similar.length, 0);
  const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

  const mostly = mostlyUnseen(result);
  const partial = result.incomplete.length > 0 || mostly;
  const sealed = [result.unseen.frames ? plural(result.unseen.frames, "iframe") : "", result.unseen.shadow ? plural(result.unseen.shadow, "web component") : ""].filter(Boolean).join(" and ");
  const verdict = findings.length
    ? `${plural(findings.length, "issue")} on this page${high.length ? `, ${high.length} high severity` : ""}.`
    : partial
      ? "No issues in the scenarios that finished."
      : "Nothing broke. This page held up in every scenario.";
  const notice = (mostly ? `<div class="notice" role="note"><p><span class="dot dot-unfinished" aria-hidden="true"></span><b>Partly checked.</b> Most of this page sits inside ${sealed}, which Caliper can't see into yet.</p></div>` : "") + (result.incomplete.length
    ? `<div class="notice" role="note"><p><span class="dot dot-unfinished" aria-hidden="true"></span><b>Partial run.</b> ${plural(result.incomplete.length, "scenario")} of ${result.scenarios.length} didn't finish, so ${result.incomplete.length === 1 ? "it wasn't" : "they weren't"} checked. Run Caliper again, or retry with <code>--only</code>.</p><ul>${result.incomplete.map((x) => `<li>${esc(label.get(x.scenario) ?? x.scenario)}: ${esc(x.reason)}</li>`).join("")}</ul></div>`
    : "");
  const cappedNote = result.capped.length
    ? `<p class="capnote">Some checks stopped at 25 findings in a scenario (${[...new Set(result.capped.map((c) => RULES[c.rule].title.toLowerCase()))].join("; ")}), so there may be more.</p>`
    : "";
  const opened = [...new Set(result.states.map((s) => s.name))].length;
  const statesNote = opened ? `<p class="capnote">Caliper also opened ${plural(opened, "state")} on this page and measured ${opened === 1 ? "it" : "each one"}.</p>` : "";
  const notes = result.notes.map((n) => `<p class="capnote">${esc(n)}</p>`).join("");
  const sealedNote = result.unseen.share >= 0.1 && !mostly ? `<p class="capnote">Caliper can't see inside ${sealed} on this page, so ${result.unseen.frames + result.unseen.shadow === 1 ? "it wasn't" : "they weren't"} checked.</p>` : "";

  const scenarioRows = scenarioResults(result)
    .map((s) => {
      const n = s.issues;
      const state = !s.finished ? "unfinished" : n ? "broke" : "held";
      const what = !s.finished ? "Didn't finish" : s.id === "baseline" ? (n ? `${n} already broken` : "Nothing broken") : n ? plural(n, "new issue") : "Held up";
      return `<li><span class="dot dot-${state}" aria-hidden="true"></span><span class="sc-name">${esc(s.label)}</span><span class="sc-result">${what}</span></li>`;
    })
    .join("");

  // One page-overflow card per scenario, so name the scenario in its title.
  const titleOf = (f: Finding) => RULES[f.rule].title + (f.rule === "layout/page-overflow" ? ` ${phrase.get(f.scenarios[0]!) ?? ""}` : "");
  const indexRow = (f: Finding) =>
    `<li><a href="#${f.id}"><span class="dot dot-${RULES[f.rule].severity}" aria-hidden="true"></span><span class="ix-title">${esc(titleOf(f))}</span><span class="ix-el">${esc(f.label)}${f.similar.length ? ` +${f.similar.length}` : ""}</span></a></li>`;

  const card = (f: Finding) => {
    const rule = RULES[f.rule];
    const rec = recommend(rule, f.role);
    const where = [...f.scenarios.map((s) => label.get(s) ?? s), ...(f.state ? [f.state] : [])];
    // The role only shows where it picked the fix.
    const kicker = ["roles" in rule && f.role !== "box" ? ROLE_NAMES[f.role][0]!.toUpperCase() + ROLE_NAMES[f.role].slice(1) : "", where.join(", ")].filter(Boolean).join(" · ");
    const shot = (src: string | undefined, caption: string) =>
      src ? `<figure><a href="${src}" target="_blank" rel="noopener" class="frame"><img src="${src}" alt="${esc(caption)}: ${esc(f.label)}" loading="lazy"></a><figcaption>${esc(caption)}</figcaption></figure>` : "";
    const shots =
      f.shots.after || f.shots.before
        ? `<div class="shots${f.shots.before && f.shots.after ? " two" : ""}">${shot(f.shots.before, `Before · ${label.get("baseline")}`)}${shot(f.shots.after, f.scenarios[0] === "baseline" ? "As is" : `After · ${label.get(f.scenarios[0]!) ?? ""}`)}</div>`
        : `<p class="noshot">${f.shots.missing === "limit" ? "No screenshot: the screenshot limit was reached. Raise it with --max-shots." : "No screenshot: the element couldn't be captured. It may have moved or been off screen."}</p>`;
    const noAfter = f.shots.before && !f.shots.after ? `<p class="noshot">No After screenshot: the element couldn't be captured in this scenario.</p>` : "";
    const options = rec.fixes
      .map(
        (fix, i) => `<label class="option"><input type="radio" name="${f.id}-choice" value="${i}"${i === 0 ? " checked" : ""}><span><span class="opt-title">${esc(fix.title)}${i === 0 ? `<span class="rec">Recommended</span>` : ""}</span><span class="opt-when">${esc(fix.when)}</span></span></label>`,
      )
      .join("");
    return `<article class="card" id="${f.id}" aria-labelledby="${f.id}-title">
      <header>
        <p class="kicker"><span class="sev sev-${rule.severity}">${rule.severity === "high" ? "High" : "Medium"}</span>${kicker ? ` · ${esc(kicker)}` : ""}</p>
        <h3 id="${f.id}-title">${esc(titleOf(f))}</h3>
      </header>
      ${shots}${noAfter}
      <dl class="facts">
        <dt>Measured</dt><dd class="measured">${esc(f.evidence)}</dd>
        ${f.cause ? `<dt>${f.cause.confirmed ? "Cause" : "Likely cause"}</dt><dd>${esc(f.cause.text)}${f.cause.confirmed ? `<span class="tested">Tested in the page</span>` : ""}</dd>` : ""}
        <dt>Element</dt><dd><code class="el">${esc(f.label)}</code> <button type="button" class="link" data-copy-selector="${esc(f.selector)}">Copy selector</button><span class="status" role="status"></span>
          ${f.similar.length ? `<details class="similar"><summary>${plural(f.similar.length, "more element")} like this</summary><ul>${f.similar.map((x) => `<li><code>${esc(x.label)}</code></li>`).join("")}</ul></details>` : ""}
        </dd>
      </dl>
      <section class="fix" aria-label="Fix">
        <p class="fix-kicker"><span class="fix-label">Recommended fix</span><span class="conf conf-${rec.confidence}">${rec.confidence === "high" ? "High confidence" : "Check it fits"}</span></p>
        <p class="fix-title">${esc(rec.fixes[0].title)}</p>
        <p class="fix-when">${esc(rec.fixes[0].when)}</p>
        <pre class="css"><code>${esc(rec.fixes[0].css)}</code></pre>
        <textarea class="own" rows="3" aria-label="Your own fix" placeholder="For example: keep the price on one line and move the payee name above the button." hidden></textarea>
        <div class="actions">
          <button type="button" class="copy" data-copy="${f.id}">Copy prompt</button>
          <span class="status" role="status"></span>
        </div>
        <details class="more">
          <summary>Other options</summary>
          <fieldset class="options" data-finding="${f.id}">
            <legend class="visually-hidden">Choose a fix</legend>
            ${options}
            <label class="option"><input type="radio" name="${f.id}-choice" value="own"><span><span class="opt-title">Write your own</span><span class="opt-when">Describe the fix in your words. The prompt carries it.</span></span></label>
          </fieldset>
          <p class="basis">${esc(rec.basis)}</p>
        </details>
      </section>
      <details class="why"><summary>Why this breaks</summary><p>${esc(rule.why)}</p><p class="rule-id">${esc(rule.id)}</p></details>
    </article>`;
  };

  const group = (key: string, list: Finding[]) =>
    list.length ? `<section class="group" aria-labelledby="g-${key}"><h2 id="g-${key}">${key === "high" ? "High severity" : "Medium severity"}<span class="count">${list.length}</span></h2><div class="cards">${list.map(card).join("\n")}</div></section>` : "";

  // What the page script needs to build each prompt. "<" is escaped so the
  // JSON can't close its own script tag.
  const data = JSON.stringify(
    Object.fromEntries(
      findings.map((f) => {
        const rec = recommend(RULES[f.rule], f.role);
        return [f.id, { ...promptParts(result, f), fixes: rec.fixes.map(fixText), css: rec.fixes.map((x) => x.css), titles: rec.fixes.map((x) => x.title), whens: rec.fixes.map((x) => x.when) }];
      }),
    ),
  ).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${DISPLAY_NAME} report: ${esc(result.testedUrl)}</title>
<style>${STYLES}</style>
</head>
<body>
<main>
  <header class="hero">
    <p class="brand">${DISPLAY_NAME}</p>
    <h1>${findings.length ? `${plural(findings.length, "issue")} found` : partial ? "No issues so far" : "Nothing broke"}</h1>
    <p class="lede">${findings.length ? `${high.length ? `${high.length} high severity, ` : ""}${plural(affected, "element")} affected` : partial ? (result.incomplete.length ? "in the scenarios that finished" : "in the parts Caliper can see") : `Held up in all ${result.scenarios.length} scenarios`} on <a href="${esc(result.testedUrl)}">${esc(result.testedUrl.replace(/^https?:\/\//, "").replace(/\/$/, ""))}</a>.</p>
    <p class="meta">${result.testedUrl !== result.url ? `Redirected from ${esc(result.url)} · ` : ""}${esc(new Date(result.startedAt).toUTCString().replace(/:\d\d GMT$/, " GMT"))} · ${Math.round(result.durationMs / 1000)} s</p>
  </header>
  ${notice}
  <section class="panel scenarios-panel" aria-labelledby="sc-h">
    <h2 id="sc-h" class="panel-title">Scenarios</h2>
    <ul class="scenarios">${scenarioRows}</ul>
    ${cappedNote}${sealedNote}${statesNote}${notes}
  </section>
  ${
    findings.length
      ? `<section class="panel" aria-labelledby="ix-h">
    <div class="panel-head"><h2 id="ix-h" class="panel-title">Issues</h2><span class="actions inline"><button type="button" class="link strong" data-copy="all">Copy all prompts</button><span class="status" role="status"></span></span></div>
    <ol class="index">${findings.map(indexRow).join("")}</ol>
  </section>
  ${group("high", high)}
  ${group("medium", medium)}`
      : ""
  }
  <footer>${DISPLAY_NAME} ${VERSION} measures pages in a real browser. It uses no AI.</footer>
</main>
<script type="application/json" id="caliper-data">${data}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

const STYLES = `
  :root {
    --bg: #f5f5f7; --surface: #ffffff; --inset: #f5f5f7; --code: #ffffff;
    --fg: #1d1d1f; --soft: #424245; --muted: #6e6e73; --hover: #f5f5f7;
    --accent: #0066cc; --button: #0071e3; --on-button: #ffffff;
    --high: #d70015; --medium: #b64400; --ok: #248a3d;
    --shadow: 0 1px 2px rgba(0, 0, 0, 0.04), 0 6px 20px rgba(0, 0, 0, 0.06);
    --chevron: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'%3E%3Cpath d='M1.5 3.5 5 7l3.5-3.5' fill='none' stroke='black' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace;
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #000000; --surface: #1c1c1e; --inset: #2c2c2e; --code: #1c1c1e;
      --fg: #f5f5f7; --soft: #d1d1d6; --muted: #98989d; --hover: #2c2c2e;
      --accent: #2997ff; --button: #0a84ff; --on-button: #ffffff;
      --high: #ff6961; --medium: #ffb340; --ok: #30d158;
      --shadow: none;
      color-scheme: dark;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 17px/1.47 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; -webkit-font-smoothing: antialiased; }
  main { max-width: 880px; margin: 0 auto; padding: 72px 24px 96px; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; text-underline-offset: 3px; }
  p { margin: 0; }
  .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 6px; }

  .hero { margin-bottom: 40px; }
  .brand { font-size: 15px; font-weight: 600; color: var(--muted); letter-spacing: 0; }
  h1 { font-size: 48px; line-height: 1.08; font-weight: 700; letter-spacing: -0.03em; margin: 8px 0 0; }
  .lede { font-size: 21px; line-height: 1.38; color: var(--soft); margin-top: 12px; overflow-wrap: anywhere; letter-spacing: -0.015em; }
  .meta { font-size: 14px; color: var(--muted); margin-top: 12px; overflow-wrap: anywhere; letter-spacing: 0; }

  .panel { background: var(--surface); border-radius: 22px; padding: 24px 28px; margin-top: 16px; box-shadow: var(--shadow); }
  .panel-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .panel-title { font-size: 17px; line-height: 24px; font-weight: 600; margin: 0; }
  .scenarios { list-style: none; padding: 0; margin: 16px 0 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 18px 24px; }
  .scenarios li { display: grid; grid-template-columns: 14px minmax(0, 1fr); align-items: baseline; align-content: start; }
  .sc-name { font-size: 15px; line-height: 20px; }
  .sc-result { grid-column: 2; font-size: 13px; line-height: 18px; color: var(--muted); margin-top: 2px; letter-spacing: 0; }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: none; transform: translateY(-1px); }
  .dot-held { background: var(--ok); }
  .dot-broke, .dot-high { background: var(--high); }
  .dot-medium, .dot-unfinished { background: var(--medium); }
  .capnote { font-size: 13px; color: var(--muted); margin-top: 16px; letter-spacing: 0; }
  .notice { background: var(--surface); border-radius: 18px; padding: 18px 22px; margin-bottom: 16px; box-shadow: var(--shadow); font-size: 15px; }
  .notice .dot { margin-right: 10px; }
  .notice ul { margin: 8px 0 0 18px; padding: 0; color: var(--soft); }
  .notice code { font: 14px var(--mono); }

  .index { list-style: none; padding: 0; margin: 12px -12px 0; }
  .index a { display: grid; grid-template-columns: 8px minmax(0, 1.1fr) minmax(0, 1fr); gap: 14px; align-items: baseline; padding: 9px 12px; border-radius: 10px; color: var(--fg); }
  .index a:hover { background: var(--hover); text-decoration: none; }
  .ix-title { font-size: 15px; line-height: 20px; font-weight: 500; }
  .ix-el { font: 13px/20px var(--mono); color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; letter-spacing: 0; }

  .group { margin-top: 56px; }
  .group h2 { font-size: 28px; line-height: 1.14; font-weight: 700; letter-spacing: -0.02em; margin: 0 0 20px; }
  .group .count { color: var(--muted); font-weight: 500; margin-left: 10px; }
  .cards { display: grid; gap: 20px; }
  .card { background: var(--surface); border-radius: 22px; padding: 32px; min-width: 0; scroll-margin-top: 24px; box-shadow: var(--shadow); }
  .kicker { font-size: 13px; line-height: 18px; color: var(--muted); letter-spacing: 0; }
  .sev { font-weight: 600; }
  .sev-high { color: var(--high); }
  .sev-medium { color: var(--medium); }
  .card h3 { font-size: 24px; line-height: 1.17; font-weight: 600; letter-spacing: -0.02em; margin: 6px 0 0; }

  .shots { display: grid; gap: 16px; margin-top: 24px; }
  .shots.two { grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr)); }
  .shots.two figure { display: grid; grid-template-rows: 1fr auto; }
  figure { margin: 0; min-width: 0; }
  .frame { display: flex; align-items: center; justify-content: center; background: var(--inset); border-radius: 16px; padding: 20px; }
  .frame img { display: block; max-width: 100%; height: auto; max-height: 520px; object-fit: contain; border-radius: 6px; background: #fff; box-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.12), 0 2px 8px rgba(0, 0, 0, 0.08); }
  figcaption { font-size: 13px; color: var(--muted); margin-top: 8px; letter-spacing: 0; }
  .noshot { font-size: 14px; color: var(--muted); margin-top: 20px; }

  .facts { display: grid; grid-template-columns: 112px minmax(0, 1fr); gap: 10px 20px; margin: 24px 0 0; }
  .facts dt { font-size: 13px; line-height: 24px; color: var(--muted); letter-spacing: 0; }
  .facts dd { margin: 0; font-size: 15px; line-height: 24px; color: var(--soft); min-width: 0; }
  .facts .measured { color: var(--fg); font-weight: 500; }
  .tested { display: block; font-size: 13px; line-height: 20px; color: var(--ok); letter-spacing: 0; }
  code.el, .similar code { font: 13px/24px var(--mono); color: var(--soft); overflow-wrap: anywhere; letter-spacing: 0; }
  .link { font: inherit; font-size: 14px; color: var(--accent); background: none; border: 0; padding: 0; margin-left: 8px; cursor: pointer; letter-spacing: 0; }
  .link:hover { text-decoration: underline; text-underline-offset: 3px; }
  .link.strong { margin-left: 0; font-size: 15px; }
  .status { font-size: 13px; color: var(--muted); margin-left: 8px; letter-spacing: 0; }
  details summary { cursor: pointer; list-style: none; }
  details summary::-webkit-details-marker { display: none; }
  details summary::after { content: ""; display: inline-block; width: 10px; height: 10px; margin-left: 6px; vertical-align: 0; background: currentColor; -webkit-mask: var(--chevron) center / contain no-repeat; mask: var(--chevron) center / contain no-repeat; transition: transform 0.2s ease; }
  details[open] > summary::after { transform: rotate(180deg); }
  .similar { margin-top: 4px; }
  .similar summary { font-size: 14px; color: var(--muted); }
  .similar ul { list-style: none; margin: 6px 0 0; padding: 0; }

  .fix { background: var(--inset); border-radius: 18px; padding: 24px; margin-top: 28px; }
  .fix-kicker { font-size: 13px; line-height: 18px; letter-spacing: 0; display: flex; gap: 8px; flex-wrap: wrap; }
  .fix-label { font-weight: 600; color: var(--fg); }
  .conf { color: var(--muted); }
  .conf-high { color: var(--ok); }
  .conf[hidden] { display: none; }
  .fix-title { font-size: 19px; line-height: 1.3; font-weight: 600; letter-spacing: -0.015em; margin-top: 8px; }
  .fix-when { font-size: 15px; line-height: 1.47; color: var(--soft); margin-top: 4px; }
  pre { background: var(--code); border-radius: 12px; padding: 16px 18px; margin: 16px 0 0; overflow-x: auto; font: 13px/20px var(--mono); letter-spacing: 0; }
  pre[hidden], .own[hidden] { display: none; }
  .own { display: block; width: 100%; margin-top: 16px; font: inherit; font-size: 15px; color: var(--fg); background: var(--code); border: 0; border-radius: 12px; padding: 14px 16px; resize: vertical; }
  .own:focus-visible { outline: 2px solid var(--accent); outline-offset: 0; }
  .actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 4px; margin-top: 16px; }
  .actions.inline { margin-top: 0; }
  .copy { font: inherit; font-size: 15px; font-weight: 500; letter-spacing: -0.01em; color: var(--on-button); background: var(--button); border: 0; border-radius: 980px; padding: 9px 20px; cursor: pointer; transition: filter 0.15s ease; }
  .copy:hover { filter: brightness(1.08); }
  .copy:active { filter: brightness(0.95); }
  .more { margin-top: 20px; }
  .more > summary { font-size: 15px; color: var(--accent); }
  .options { border: 0; padding: 0; margin: 12px 0 0; display: grid; gap: 4px; min-width: 0; }
  .option { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 12px; align-items: start; padding: 12px 14px; border-radius: 12px; cursor: pointer; transition: background-color 0.15s ease; }
  .option:hover { background: color-mix(in srgb, var(--code) 50%, transparent); }
  .option:has(input:checked) { background: var(--code); }
  .option:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }
  .option input { margin: 4px 0 0; accent-color: var(--button); }
  .option > span { display: grid; min-width: 0; }
  .opt-title { font-size: 15px; line-height: 22px; font-weight: 600; }
  .rec { font-size: 12px; font-weight: 600; color: var(--ok); margin-left: 8px; letter-spacing: 0; white-space: nowrap; }
  .opt-when { font-size: 14px; line-height: 20px; color: var(--muted); letter-spacing: 0; }
  .basis { font-size: 13px; color: var(--muted); margin-top: 12px; padding: 0 14px; letter-spacing: 0; }
  .why { margin-top: 20px; }
  .why summary { font-size: 14px; color: var(--muted); }
  .why p { font-size: 15px; color: var(--soft); margin-top: 8px; }
  .rule-id { font: 13px var(--mono) !important; color: var(--muted) !important; letter-spacing: 0; }
  footer { font-size: 13px; color: var(--muted); margin-top: 64px; text-align: center; letter-spacing: 0; }

  @media (prefers-reduced-motion: reduce) {
    * { transition: none !important; }
  }
  @media (max-width: 720px) {
    .scenarios { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @media (max-width: 560px) {
    main { padding: 40px 16px 72px; }
    h1 { font-size: 36px; }
    .lede { font-size: 19px; }
    .panel { padding: 20px; border-radius: 18px; }
    .card { padding: 22px 20px; border-radius: 18px; }
    .card h3 { font-size: 21px; }
    .fix { padding: 18px; }
    .frame { padding: 12px; }
    .index a { grid-template-columns: 8px minmax(0, 1fr); row-gap: 2px; }
    .ix-el { grid-column: 2; }
    .facts { grid-template-columns: minmax(0, 1fr); gap: 2px; }
    .facts dd { margin-bottom: 10px; }
    .group h2 { font-size: 24px; }
  }
`;

// Runs in the report. Plain JavaScript as a string, so the report stays one
// file. It reads the chosen option and copies the matching prompt.
const SCRIPT = `
(() => {
  const data = JSON.parse(document.getElementById("caliper-data").textContent);
  const card = (id) => document.getElementById(id);
  const choice = (id) => {
    const picked = card(id).querySelector("input[type=radio]:checked");
    return picked ? picked.value : "0";
  };
  const fixPart = (id) => {
    const c = choice(id);
    if (c !== "own") return data[id].fixes[Number(c)];
    const text = card(id).querySelector(".own").value.trim();
    return text ? "Fix to apply, in my own words: " + text : null;
  };
  const promptFor = (id) => {
    const fix = fixPart(id);
    return fix && data[id].head + fix + "\\n" + data[id].tail;
  };
  const copy = async (text) => {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch {}
    area.remove();
    return ok;
  };
  const say = (button, text) => {
    const status = button.parentElement.querySelector(".status");
    status.textContent = text;
    clearTimeout(status.timer);
    status.timer = setTimeout(() => (status.textContent = ""), 4000);
  };

  document.addEventListener("change", (event) => {
    const input = event.target;
    if (input.type !== "radio") return;
    const id = input.closest(".options").dataset.finding;
    const el = card(id);
    const own = input.value === "own";
    const area = el.querySelector(".own");
    const pre = el.querySelector(".css");
    area.hidden = !own;
    pre.hidden = own;
    el.querySelector(".fix-label").textContent = own ? "Your fix" : input.value === "0" ? "Recommended fix" : "Alternative fix";
    el.querySelector(".conf").hidden = input.value !== "0";
    if (own) {
      el.querySelector(".fix-title").textContent = "Your own fix";
      el.querySelector(".fix-when").textContent = "Describe it below. The prompt carries your words.";
      area.focus();
    } else {
      const i = Number(input.value);
      el.querySelector(".fix-title").textContent = data[id].titles[i];
      el.querySelector(".fix-when").textContent = data[id].whens[i];
      pre.querySelector("code").textContent = data[id].css[i];
    }
  });

  document.addEventListener("click", async (event) => {
    const sel = event.target.closest("[data-copy-selector]");
    if (!sel) return;
    say(sel, (await copy(sel.dataset.copySelector)) ? "Copied" : "Couldn't copy");
  });

  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-copy]");
    if (!button) return;
    const target = button.dataset.copy;
    if (target === "all") {
      const ids = Object.keys(data);
      const missing = ids.filter((id) => !fixPart(id));
      if (missing.length) {
        card(missing[0]).querySelector(".own").focus();
        return say(button, "Describe your own fix first, or pick another option.");
      }
      const text = ids.map((id, i) => "## Issue " + (i + 1) + " of " + ids.length + "\\n\\n" + promptFor(id)).join("\\n\\n");
      return say(button, (await copy(text)) ? "Copied " + ids.length + " prompts as one." : "Couldn't copy. Select the text in report.json instead.");
    }
    const text = promptFor(target);
    if (!text) {
      card(target).querySelector(".own").focus();
      return say(button, "Describe your own fix first.");
    }
    say(button, (await copy(text)) ? "Copied." : "Couldn't copy. Use report.json instead.");
  });
})();
`;
