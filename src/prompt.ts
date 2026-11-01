// Builds the prompt a person pastes into an AI assistant to apply a fix.
// Caliper itself never calls an AI: it only writes the text.

import { DISPLAY_NAME, PACKAGE } from "./brand.js";
import { recommend, ROLE_NAMES, RULES, type Fix } from "./rules.js";
import type { Finding, RunResult } from "./run.js";

const MAX_SIMILAR = 10;

// The text before and after the chosen fix. The report stitches the fix in
// between, so the same words appear in report.json and on the page.
export function promptParts(result: RunResult, f: Finding): { head: string; tail: string } {
  const rule = RULES[f.rule];
  const label = new Map(result.scenarios.map((s) => [s.id, s.label]));
  const similar = f.similar.slice(0, MAX_SIMILAR).map((s) => `  - ${s.label}`);
  if (f.similar.length > MAX_SIMILAR) similar.push(`  - and ${f.similar.length - MAX_SIMILAR} more`);
  const lines = [
    `Fix this layout issue that ${DISPLAY_NAME} found on ${result.testedUrl}`,
    "",
    `Issue: ${rule.title} (${rule.id}, ${rule.severity} severity)`,
    `Element: ${f.label}${"roles" in rule && f.role !== "box" ? ` (a ${ROLE_NAMES[f.role]})` : ""}`,
    `Path: ${f.selector}`,
    ...(similar.length ? ["Same problem in:", ...similar] : []),
    `Seen in: ${f.scenarios.map((s) => label.get(s) ?? s).join(", ")}`,
    `Measured: ${f.evidence}`,
    ...(f.cause ? [`${f.cause.confirmed ? "Cause (tested)" : "Likely cause (not tested)"}: ${f.cause.text}`] : []),
    `Why: ${rule.why}`,
    "",
    "",
  ];
  const tail = [
    "",
    "Find the component in this codebase that renders this element and apply the fix there, using the project's existing tokens and conventions rather than a global override. Keep the change as small as the fix needs.",
    `Then run \`npx ${PACKAGE} ${result.testedUrl}\` again to confirm the issue is gone.`,
  ];
  return { head: lines.join("\n"), tail: tail.join("\n") };
}

export function fixText(fix: Fix): string {
  return `Fix to apply: ${fix.title}\n${fix.css}`;
}

export function ownFixText(text: string): string {
  return `Fix to apply, in my own words: ${text.trim()}`;
}

export function prompt(result: RunResult, f: Finding, fix: Fix = recommend(RULES[f.rule], f.role).fixes[0]): string {
  const { head, tail } = promptParts(result, f);
  return `${head}${fixText(fix)}\n${tail}`;
}
