// The engine: open the page once per scenario, stress it, measure it,
// turn raw measurements into rule findings, and take screenshots.

import { mkdir } from "node:fs/promises";
import type { Browser, BrowserContext, Page } from "playwright";
import { RULES, type Role, type RuleId } from "./rules.js";
import { SCENARIOS, type Scenario } from "./scenarios.js";
import { loadScript } from "./scripts.js";
import { launchBrowser } from "./browser.js";
import { inPage } from "./page.js";

// ---------- types ----------

interface Box { x: number; y: number; width: number; height: number }

interface RawFinding {
  kind: "page-overflow" | "spill-x" | "clip-x" | "flex-shrink" | "grid-blowout" | "fixed-height" | "img-distorted" | "tap-small" | "label-wrap" | "label-truncated" | "fixed-offscreen";
  selector: string;
  label: string;
  role: Role;
  box: Box;
  details: Record<string, number | string | boolean>;
}

interface RawImage { src: string; selector: string; label: string; width: number; height: number; box: Box; visible: boolean; around: { width: number; height: number; next: number } }

interface Unseen { frames: number; shadow: number; share: number } // share: how much of the page they cover, 0 to 1

interface Measurement { findings: RawFinding[]; images: RawImage[]; capped?: RawFinding["kind"][]; empty: boolean; unseen: Unseen; pageWidth: number; pageHeight: number; viewportWidth: number }

export interface Finding {
  id: string;
  rule: RuleId;
  selector: string;
  label: string;
  role: Role; // what the element is: picks the recommended fix
  evidence: string; // what was measured, with the numbers
  cause?: { text: string; confirmed: boolean }; // confirmed only when Caliper tested it
  scenarios: string[]; // scenario ids where it showed up
  shots: { before?: string; after?: string; missing?: "limit" | "failed" }; // why there is no screenshot
  similar: { selector: string; label: string }[]; // other elements with the same structure and the same problem
}

export interface RunOptions {
  url: string;
  outDir: string;
  scenarios?: string[];
  maxShots?: number;
  ignore?: string[]; // CSS selectors to leave out
  log?: (line: string) => void;
}

// How each scenario did. A stress scenario only counts what it newly broke:
// anything already broken as is belongs to the "As is" row alone.
export function scenarioResults(result: Pick<RunResult, "scenarios" | "findings"> & { incomplete?: RunResult["incomplete"] }) {
  return result.scenarios.map((s) => ({
    id: s.id,
    label: s.label,
    finished: !result.incomplete?.some((x) => x.scenario === s.id),
    issues: result.findings.filter((f) => f.scenarios.includes(s.id) && (s.id === "baseline" || !f.scenarios.includes("baseline"))).length,
  }));
}

export interface RunResult {
  url: string;
  testedUrl: string; // after redirects
  startedAt: string;
  durationMs: number;
  scenarios: Scenario[];
  findings: Finding[];
  // What didn't get checked, so a partial run never looks like a clean one.
  incomplete: { scenario: string; reason: string }[];
  capped: { scenario: string; rule: RuleId }[];
  unseen: Unseen; // content sealed inside iframes and shadow roots
}

// Most of the page sealed away means most of it wasn't checked.
export const mostlyUnseen = (result: Pick<RunResult, "unseen">) => result.unseen.share >= 0.5;

// Most consequential first: high severity, then already broken as is,
// then the most elements affected.
export function ordered(findings: Finding[]): Finding[] {
  const weight = (f: Finding) => [RULES[f.rule].severity === "high" ? 0 : 1, f.scenarios.includes("baseline") ? 0 : 1, -(1 + f.similar.length)] as const;
  return [...findings].sort((a, b) => {
    const wa = weight(a);
    const wb = weight(b);
    return wa[0] - wb[0] || wa[1] - wb[1] || wa[2] - wb[2];
  });
}

// ---------- turning measurements into rules ----------

function toRule(raw: RawFinding, scenario: Scenario): RuleId {
  const d = raw.details;
  switch (raw.kind) {
    case "page-overflow": return "layout/page-overflow";
    case "flex-shrink": return "layout/flex-min-size";
    case "grid-blowout": return "layout/grid-min-size";
    case "fixed-height": return "layout/fixed-size";
    case "img-distorted": return "media/distortion";
    case "tap-small": return "input/min-tap";
    case "label-wrap": return "content/label-wrap";
    case "label-truncated": return "content/label-truncated";
    case "fixed-offscreen": return "layout/fixed-offscreen";
    case "clip-x": return "content/clip";
    case "spill-x":
      return scenario.stress === "long-word" || Number(d.longestWord) > 30 ? "content/long-word" : "content/spill";
  }
}

// What was measured. Numbers only, no guesses.
function evidence(raw: RawFinding, scenario: Scenario): string {
  const d = raw.details;
  switch (raw.kind) {
    case "page-overflow":
      return `The page is ${d.pageWidth} px wide on a ${d.viewportWidth} px screen.${d.right ? ` This element reaches ${d.right} px.` : ""}`;
    case "spill-x":
      return `Its text needs ${d.contentWidth} px; the box gives ${d.boxWidth} px. ${d.gap} px runs past the edge.`;
    case "clip-x":
      return `Its text needs ${d.contentWidth} px; ${d.boxWidth} px is shown. ${d.gap} px is hidden, with no ellipsis.`;
    case "flex-shrink":
      return `Its row needs ${d.contentWidth} px; the row gives ${d.containerWidth} px. This item takes ${d.itemWidth} px.`;
    case "grid-blowout":
      return `The grid needs ${d.contentWidth} px; it has ${d.containerWidth} px.`;
    case "fixed-height":
      return `Its content needs ${d.contentHeight} px of height; the box gives ${d.boxHeight} px${d.clipped ? ", and the rest is hidden" : ""}.`;
    case "img-distorted":
      return `The image is ${d.naturalWidth} × ${d.naturalHeight} but shown at ${d.shownWidth} × ${d.shownHeight}, so its shape changes.`;
    case "tap-small":
      return `It measures ${d.width} × ${d.height} px on a ${scenario.viewport.width} px screen, with another target within 24 px.`;
    case "label-wrap":
      return `Its label breaks onto ${d.lines} lines in a ${d.width} px button. On one line it needs ${d.needed} px, and the row has ${d.available} px.`;
    case "label-truncated":
      return `Its label needs ${d.contentWidth} px; the button shows ${d.boxWidth} px and ends in an ellipsis.`;
    case "fixed-offscreen":
      return `It is ${d.height} px tall on a ${d.viewportHeight} px screen, and ${d.hidden} px of it can't be scrolled into view.`;
  }
}

// Why it happened. "confirmed" means Caliper changed the suspected property
// in the page and the problem went away; otherwise it is a likely cause, and
// labelled as such.
function cause(raw: RawFinding): { text: string; confirmed: boolean } | undefined {
  const d = raw.details;
  switch (raw.kind) {
    case "spill-x": {
      const nowrap = d.whiteSpace === "nowrap" || d.whiteSpace === "pre";
      const word = Number(d.longestWord) > 30;
      if (nowrap && d.wraps) return { text: `white-space: ${d.whiteSpace} stops the text from wrapping. With white-space: normal it fits.`, confirmed: true };
      if (word) return d.breaks ? { text: `A ${d.longestWord}-letter word has no place to break. Allowed to break, it fits.`, confirmed: true } : { text: `A ${d.longestWord}-letter word has no place to break.`, confirmed: false };
      if (nowrap) return { text: `white-space: ${d.whiteSpace} stops the text from wrapping.`, confirmed: false };
      return { text: "The box has a fixed or minimum width.", confirmed: false };
    }
    case "clip-x":
      return d.reveals
        ? { text: "overflow: hidden on the box, with no text-overflow: ellipsis. Allowed to wrap, all of it shows.", confirmed: true }
        : { text: "overflow: hidden on the box, with no text-overflow: ellipsis.", confirmed: false };
    case "flex-shrink":
      return d.confirmed
        ? { text: "Flex items won't shrink below their content (min-width: auto). With min-width: 0 the row fits.", confirmed: true }
        : { text: "Something inside the row is wider than the row. min-width: 0 alone didn't fix it.", confirmed: false };
    case "grid-blowout":
      return d.confirmed
        ? { text: "Grid tracks grow to fit their content. With min-width: 0 on the items, the grid fits.", confirmed: true }
        : { text: "A child is wider than its track. min-width: 0 alone didn't fix it.", confirmed: false };
    case "fixed-height":
      return { text: "A set height or max-height. Released, the box grows.", confirmed: true };
    case "label-wrap":
      return { text: "Its width is held below its label. Sized to the label, it fits on one line.", confirmed: true };
    case "label-truncated":
      return d.reveals
        ? { text: "text-overflow: ellipsis cuts the label. Allowed to wrap, all of it shows.", confirmed: true }
        : { text: "text-overflow: ellipsis cuts the label.", confirmed: false };
    case "fixed-offscreen":
      return d.fits
        ? { text: "position: fixed with no max-height or scrolling. With max-height: 100dvh it fits.", confirmed: true }
        : { text: "position: fixed with no max-height or scrolling.", confirmed: false };
    case "page-overflow":
      return d.right
        ? { text: "This element reaches furthest past the edge.", confirmed: false }
        : { text: "Something with no element of its own runs past the edge, such as a ::before or ::after layer.", confirmed: false };
    default:
      return undefined;
  }
}

// "ul > li:nth-of-type(3) > a" and "ul > li:nth-of-type(4) > a" are the
// same component, so they share the pattern "ul > li > a".
// Numbered ids (#faq-3, #item_12) mark copies of one component too.
const pattern = (selector: string) => selector.replace(/:nth-of-type\(\d+\)/g, "").replace(/(#[A-Za-z][\w-]*?)[-_]?\d+(?=$|[\s>.:[])/g, "$1-n");

// ---------- page helpers ----------

// Plain-English messages for the errors people actually hit.
function openError(url: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/Download is starting/i.test(message)) return `${url} is a file download, not a web page. Give Caliper the address of an HTML page.`;
  if (/ERR_INVALID_AUTH_CREDENTIALS/.test(message)) return `${url} asks for a login. Caliper can only test pages anyone can open, for now.`;
  if (/ERR_NAME_NOT_RESOLVED/.test(message)) return `Couldn't find ${url}: that domain doesn't exist. Check the spelling.`;
  if (/ERR_UNSAFE_PORT/.test(message)) return `Browsers refuse to open port ${new URL(url).port || "that port"} for safety. Run your server on another port, such as 3000.`;
  if (/ERR_CONNECTION_REFUSED/.test(message)) return `Nothing is running at ${url}. If it's your dev server, start it and try again.`;
  if (/Timeout \d+ms exceeded/.test(message)) return `${url} took longer than 30 s to respond. Check that the server is up.`;
  const code = message.match(/net::\w+/)?.[0];
  return `Couldn't open ${url}${code ? ` (${code})` : ""}. Check the address, and that the server is running.`;
}

// Why a stress scenario stopped, in plain words.
function scenarioError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/Timeout \d+ms exceeded|took longer than/i.test(message)) return "the page took longer than 30 s to load in this scenario.";
  if (/stopped responding/.test(message)) return "the page stopped responding in this scenario.";
  if (/keeps reloading/.test(message)) return "the page kept reloading in this scenario.";
  if (/Target (page|closed)|browser has been closed/i.test(message)) return "the browser tab closed unexpectedly.";
  return message.split("\n")[0]!.slice(0, 160);
}

const sameUrl = (a: string, b: string) => {
  const clean = (u: string) => u.replace(/#.*$/, "").replace(/\/$/, "");
  return clean(a) === clean(b);
};

async function openPage(browser: Browser, scenario: Scenario, url: string): Promise<{ context: BrowserContext; page: Page; finalUrl: string }> {
  const context = await browser.newContext({
    viewport: scenario.viewport,
    deviceScaleFactor: scenario.deviceScaleFactor,
    isMobile: scenario.mobile,
    hasTouch: scenario.mobile,
    reducedMotion: "reduce",
    ignoreHTTPSErrors: true, // local dev servers often use self-signed certificates
  });
  if (scenario.blockImages) {
    await context.route("**/*", (route) =>
      route.request().resourceType() === "image" ? route.abort() : route.continue(),
    );
  }
  const page = await context.newPage();
  const fail = async (message: string): Promise<never> => {
    await context.close();
    throw new Error(message);
  };

  let response;
  try {
    response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  } catch (error) {
    return fail(openError(url, error));
  }
  // Testing an error page would report the error page's layout, not yours.
  const status = response?.status() ?? 200;
  if (status === 401) {
    return fail(`${url} asks for a login (401). Caliper can only test pages anyone can open, for now.`);
  }
  if (status === 403) {
    return fail(`${url} refused access (403). It may need a login, or it blocks automated browsers.`);
  }
  if (status >= 400) return fail(`${url} answered ${status}. Check the address and try again.`);
  const type = response?.headers()["content-type"];
  if (type && !/html/i.test(type)) {
    return fail(`${url} isn't a web page (it's ${type.split(";")[0]}). Give Caliper the address of an HTML page.`);
  }

  // Wait for the page to finish: images and fonts, then the network, then
  // the DOM. Apps that render after load (React, Vue) settle in the last step.
  await page.waitForLoadState("load", { timeout: 15_000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
  await inPage(page, `(${QUIET})()`);
  if (!(await inPage<boolean>(page, "Boolean(document.body)"))) {
    return fail(`${url} has no page body to test. Give Caliper the address of an HTML page.`);
  }
  await inPage(page, `(${LAZY})()`);
  await inPage(page, `(${QUIET})()`);
  return { context, page, finalUrl: page.url() };
}

// Resolves once the DOM has had no changes for 500 ms, or after 5 s. A web
// font that never answers can't hold it up for more than 3 s.
const QUIET = `async () => {
  await Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 3000))]);
  await new Promise((resolve) => {
    let timer = setTimeout(done, 500);
    const cap = setTimeout(done, 5000);
    const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, 500); });
    observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
    function done() { observer.disconnect(); clearTimeout(timer); clearTimeout(cap); resolve(); }
  });
}`;

// Scrolls down and back so lazy images and sections load. Capped at 20
// steps, so very long pages and infinite feeds can't stall the run.
const LAZY = `async () => {
  const step = Math.max(window.innerHeight, document.documentElement.scrollHeight / 20);
  for (let i = 0, y = 0; i < 20 && y < document.documentElement.scrollHeight; i++, y += step) {
    window.scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 50));
  }
  window.scrollTo(0, 0);
  await new Promise((r) => setTimeout(r, 300));
}`;

const SETTLE = `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`;

// Outlines an element and returns the area to capture (page coordinates),
// widened to include anything that spills out of it. Null when gone.
const OUTLINE = `(selector) => {
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  el.dataset.caliperOutline = el.style.outline;
  el.style.outline = "2px solid #e5484d";
  el.style.outlineOffset = "2px";
  const right = Math.max(r.right, r.left + el.scrollWidth);
  const bottom = Math.max(r.bottom, r.top + el.scrollHeight);
  return { x: r.left + scrollX, y: r.top + scrollY, right: right + scrollX, bottom: bottom + scrollY };
}`;

const UNOUTLINE = `(selector) => {
  const el = document.querySelector(selector);
  if (!el) return;
  el.style.outline = el.dataset.caliperOutline ?? "";
  el.style.outlineOffset = "";
  delete el.dataset.caliperOutline;
}`;

// Screenshot an element with some context around it and a red outline.
async function shoot(page: Page, selector: string, file: string, pageWidth: number): Promise<boolean> {
  const arg = JSON.stringify(selector);
  const area = await inPage<{ x: number; y: number; right: number; bottom: number } | null>(page, `(${OUTLINE})(${arg})`).catch(() => null);
  if (!area) return false;
  const pad = 32;
  const x = Math.max(0, Math.floor(area.x - pad));
  const y = Math.max(0, Math.floor(area.y - pad));
  const width = Math.max(1, Math.min(Math.ceil(area.right + pad), Math.max(pageWidth, area.right)) - x);
  const height = Math.max(1, Math.min(Math.ceil(area.bottom - y + pad), 900));
  try {
    await page.screenshot({ path: file, fullPage: true, clip: { x, y, width, height }, animations: "disabled" });
    return true;
  } catch {
    return false;
  } finally {
    await inPage(page, `(${UNOUTLINE})(${arg})`).catch(() => {});
  }
}

// ---------- the run ----------

export async function run(options: RunOptions): Promise<RunResult> {
  const log = options.log ?? (() => {});
  const maxShots = options.maxShots ?? 40;
  const started = Date.now();
  const scenarios = SCENARIOS.filter((s) => s.id === "baseline" || !options.scenarios || options.scenarios.includes(s.id));
  const shotsDir = `${options.outDir}/shots`;

  const ignore = options.ignore ?? [];
  const detectSrc = await loadScript("detect.js");
  const stressSrc = await loadScript("stress.js");

  const browser = await launchBrowser(log);
  const byKey = new Map<string, Finding>();
  const incomplete: RunResult["incomplete"] = [];
  const capped: RunResult["capped"] = [];
  let shotCount = 0;

  // Scenarios open and measure in parallel (3 at a time), but merge one by
  // one in their listed order, so the report is the same on every run.
  const PARALLEL = 3;
  let slots = PARALLEL;
  const waiting: (() => void)[] = [];
  const acquire = () => (slots > 0 ? (slots--, Promise.resolve()) : new Promise<void>((r) => waiting.push(r)));
  const release = () => (waiting.length ? waiting.shift()!() : slots++);

  let testedUrl = options.url;
  let unseen: Unseen = { frames: 0, shadow: 0, share: 0 };
  try {
    // The baseline tab stays open: it provides the "before" screenshots.
    const baseline = await openPage(browser, scenarios[0]!, options.url);
    if (!sameUrl(baseline.finalUrl, options.url)) {
      testedUrl = baseline.finalUrl;
      log(`  Redirected to ${testedUrl}, so that is the page being tested`);
    }
    const invalid = await inPage<string[]>(baseline.page, `${JSON.stringify(ignore)}.filter((s) => { try { document.querySelector(s); return false; } catch { return true; } })`);
    if (invalid.length) throw new Error(`--ignore "${invalid[0]}" isn't a valid CSS selector.`);
    const measure = (page: Page, scenario: Scenario) =>
      inPage<Measurement>(page, `(${detectSrc})(${JSON.stringify({ checkTapTargets: scenario.mobile, checkLabels: scenario.labels, checkFixed: scenario.checkFixed, ignore })})`);
    const baselineMeasure = await measure(baseline.page, scenarios[0]!);
    if (baselineMeasure.empty) throw new Error(`${testedUrl} shows no text or images, so there's nothing to test. It may need a login, or it failed to render.`);
    unseen = baselineMeasure.unseen;
    // Only now: a page that can't be tested leaves no empty report folder.
    await mkdir(shotsDir, { recursive: true });

    const stressed = async (scenario: Scenario) => {
      if (scenario.id === "baseline") return { ...baseline, m: baselineMeasure };
      await acquire();
      try {
        const opened = await openPage(browser, scenario, testedUrl);
        if (scenario.stress !== "none") {
          await inPage(opened.page, `(${stressSrc})(${JSON.stringify(scenario.stress)})`);
          await inPage(opened.page, SETTLE);
        }
        return { ...opened, m: await measure(opened.page, scenario) };
      } catch (error) {
        release();
        throw error;
      }
    };
    const jobs = scenarios.map((scenario) => stressed(scenario));
    jobs.forEach((job) => job.catch(() => {})); // failures surface below, in order

    for (const [i, scenario] of scenarios.entries()) {
      log(`  ${scenario.label}`);
      const isBaseline = scenario.id === "baseline";
      let opened;
      try {
        opened = await jobs[i]!;
      } catch (error) {
        if (isBaseline) throw error;
        const reason = scenarioError(error);
        incomplete.push({ scenario: scenario.id, reason });
        log(`    Didn't finish: ${reason}`);
        continue;
      }
      const { context, page, m } = opened;
      for (const kind of m.capped ?? []) capped.push({ scenario: scenario.id, rule: toRule(m.findings.find((f) => f.kind === kind)!, scenario) });
      try {
        await merge(scenario, page, m);
      } finally {
        if (!isBaseline) {
          await context.close();
          release();
        }
      }
    }
    await baseline.context.close();

    async function merge(scenario: Scenario, page: Page, m: Measurement) {
      const isBaseline = scenario.id === "baseline";
      // `group` decides which findings share a card. Flex items that break
      // the same row are one problem, so they group by their row.
      const raws: { rule: RuleId; selector: string; label: string; role: Role; text: string; cause?: { text: string; confirmed: boolean }; group: string }[] = m.findings.map((raw) => ({
        rule: toRule(raw, scenario),
        selector: raw.selector,
        label: raw.label,
        role: raw.kind === "label-wrap" || raw.kind === "label-truncated" ? "button" : raw.role,
        text: evidence(raw, scenario),
        cause: cause(raw),
        // The page scrolling sideways is one symptom per scenario, however
        // many elements cause it: one card, the culprits listed under it.
        group: raw.kind === "flex-shrink" ? String(raw.details.container) : raw.kind === "page-overflow" ? `page@${scenario.id}` : raw.selector,
      }));

      // Broken images: compare each image's box with the baseline, matched by
      // source, since a failed image can add or remove others. It only counts
      // when what's around the image moved: a layer can shrink with no effect.
      if (scenario.blockImages) {
        const loaded = new Map<string, RawImage[]>();
        for (const img of baselineMeasure.images) loaded.set(img.src, [...(loaded.get(img.src) ?? []), img]);
        for (const img of m.images) {
          const before = loaded.get(img.src)?.shift();
          if (!before || !before.visible || before.height < 16) continue;
          const dh = Math.abs(before.height - img.height);
          const dw = Math.abs(before.width - img.width);
          const moved = Math.abs(before.around.width - img.around.width) > 2 || Math.abs(before.around.height - img.around.height) > 2 || Math.abs(before.around.next - img.around.next) > 2;
          if (moved && (dh > before.height * 0.3 || dw > before.width * 0.3)) {
            raws.push({
              rule: "media/missing",
              selector: img.selector,
              label: img.label,
              role: "box",
              cause: { text: "The image has no width and height (or aspect ratio) to hold its space.", confirmed: false },
              text: `It takes ${before.width} × ${before.height} px when loaded but ${img.width} × ${img.height} px when it fails, so the layout around it moves.`,
              group: img.selector,
            });
          }
        }
      }

      // High severity first, so the screenshot budget goes to what matters most.
      raws.sort((a, b) => (RULES[a.rule].severity === "high" ? 0 : 1) - (RULES[b.rule].severity === "high" ? 0 : 1));

      for (const raw of raws) {
        // Repeated components (list items, cards, sections) share a pattern
        // once positions are removed. One card per pattern, not per copy.
        const key = `${raw.rule}|${pattern(raw.group)}`;
        const existing = byKey.get(key);
        if (existing) {
          if (!existing.scenarios.includes(scenario.id)) existing.scenarios.push(scenario.id);
          if (raw.selector !== existing.selector && !existing.similar.some((x) => x.selector === raw.selector)) {
            existing.similar.push({ selector: raw.selector, label: raw.label });
          }
          continue;
        }
        const finding: Finding = {
          id: `f${byKey.size + 1}`,
          rule: raw.rule,
          selector: raw.selector,
          label: raw.label,
          role: raw.role,
          evidence: raw.text,
          ...(raw.cause ? { cause: raw.cause } : {}),
          scenarios: [scenario.id],
          shots: {},
          similar: [],
        };
        byKey.set(key, finding);

        // High-severity findings always get screenshots (up to twice the budget).
        const high = RULES[raw.rule].severity === "high";
        if (shotCount < maxShots || (high && shotCount < maxShots * 2)) {
          shotCount++;
          const after = `shots/${finding.id}-after.png`;
          if (await shoot(page, raw.selector, `${options.outDir}/${after}`, m.pageWidth)) finding.shots.after = after;
          if (!isBaseline) {
            const before = `shots/${finding.id}-before.png`;
            if (await shoot(baseline.page, raw.selector, `${options.outDir}/${before}`, baselineMeasure.pageWidth)) finding.shots.before = before;
          }
          if (!finding.shots.after) finding.shots.missing = "failed";
        } else {
          finding.shots.missing = "limit";
        }
      }
    }
  } finally {
    await browser.close();
  }

  const findings = ordered([...byKey.values()]);

  return { url: options.url, testedUrl, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, scenarios, findings, incomplete, capped, unseen };
}
