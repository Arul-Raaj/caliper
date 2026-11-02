// The interaction pass: Caliper's hands. It opens what the page keeps closed,
// runs the scripted states, hovers rows and tabs through controls, and has
// each state measured while it is on screen. It only opens things: it clicks
// menu, sheet and accordion triggers, never ordinary buttons or links.

import type { Page } from "playwright";
import { describeStep, runStep, type ScriptedState } from "./steps.js";

export interface Seen<Raw> { findings: Raw[]; images: never[]; pageWidth: number }
interface Target { selector: string; label: string; kind?: "row" | "icon" }

export interface Driver<Raw, M> {
  page: Page;
  url: string;
  opens: boolean; // find and open menus and sheets
  full: boolean; // hover and Tab as well as opening things
  scripted: ScriptedState[];
  probe: <T>(request: Record<string, unknown>) => Promise<T>;
  measure: () => Promise<M>; // measure the whole page as it is now
  record: (m: M | Seen<Raw>, state?: string) => Promise<void>; // runs while the state is on screen
  reload: () => Promise<void>;
}

export interface Exercised {
  opened: string[]; // the states Caliper reached
  failed: string[]; // scripted states that couldn't run
  skipped: number; // triggers left out by the limit
}

const MAX_TRIGGERS = 12;
const MAX_ROWS = 24;
const MAX_ICONS = 8;
const MAX_TABS = 40;
const TOOLTIP_DELAY_MS = 400;
const CLICK_LIMIT_MS = 1_500;

// "ul > li:nth-of-type(3) > a" and "ul > li:nth-of-type(4) > a" are the
// same component, so they share the pattern "ul > li > a".
// Numbered ids (#faq-3, #item_12) mark copies of one component too.
export const pattern = (selector: string) => selector.replace(/:nth-of-type\(\d+\)/g, "").replace(/(#[A-Za-z][\w-]*?)[-_]?\d+(?=$|[\s>.:[])/g, "$1-n");

// Two frames so a transition can start, then until it has finished. An endless
// animation never finishes, so it doesn't count. A sheet may take a while to
// slide in, but a hover or a Tab runs dozens of times, so it waits less: on a
// page that never stops moving, that would add up to minutes.
const still = (limitMs: number) => `(async () => {
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const moving = document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity);
  await Promise.race([Promise.allSettled(moving.map((a) => a.finished)), new Promise((r) => setTimeout(r, ${limitMs}))]);
})()`;

// One of each component: thirty accordion rows open the same way.
const fresh = <T extends { selector: string }>(targets: T[], seen: Set<string>) =>
  targets.filter((t) => {
    const key = pattern(t.selector);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

export async function exercise<Raw, M>(d: Driver<Raw, M>, inPage: (expression: string) => Promise<unknown>): Promise<Exercised> {
  const { page } = d;
  const opening = () => inPage(still(1_000));
  const touching = () => inPage(still(300));
  const count = () => d.probe<number>({ op: "count" });
  const hovered = new Set<string>();

  async function hoverAround(state?: string) {
    await page.mouse.move(0, 0);
    await d.probe({ op: "rest" });
    const targets = fresh(await d.probe<Target[]>({ op: "hoverTargets" }), hovered);
    const chosen = [...targets.filter((t) => t.kind === "row").slice(0, MAX_ROWS), ...targets.filter((t) => t.kind === "icon").slice(0, MAX_ICONS)];
    for (const target of chosen) {
      const spot = page.locator(target.selector).first();
      await spot.scrollIntoViewIfNeeded({ timeout: CLICK_LIMIT_MS }).catch(() => {});
      const box = await spot.boundingBox({ timeout: CLICK_LIMIT_MS }).catch(() => null);
      if (!box) continue;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await touching();
      // Tooltips wait a moment before opening; rows have nothing to wait for.
      if (target.kind === "icon") await page.waitForTimeout(TOOLTIP_DELAY_MS);
      const seen = await d.probe<Seen<Raw>>({ op: "hover", selector: target.selector });
      if (seen.findings.length) await d.record(seen, state);
    }
    await page.mouse.move(0, 0);
    await touching();
  }

  async function tabThrough(state?: string) {
    await d.probe({ op: "rest" });
    const visited = new Set<string>();
    for (let i = 0; i < MAX_TABS; i++) {
      await page.keyboard.press("Tab");
      await touching();
      const seen = await d.probe<Seen<Raw> & { done: boolean; selector?: string }>({ op: "focus" });
      if (seen.findings.length) await d.record(seen, state);
      // Back at the start, or held in a focus trap: every stop has been seen.
      if (seen.done || visited.has(seen.selector!)) break;
      visited.add(seen.selector!);
    }
    await d.probe({ op: "rest" }); // lets go of focus
  }

  const opened: string[] = [];
  if (d.full) {
    await hoverAround();
    await tabThrough();
  }

  const triggers = d.opens ? fresh(await d.probe<Target[]>({ op: "triggers" }), new Set()) : [];
  const resting = await count();
  for (const trigger of triggers.slice(0, MAX_TRIGGERS)) {
    const clicked = await page.locator(trigger.selector).first().click({ timeout: CLICK_LIMIT_MS }).then(() => true, () => false);
    if (!clicked) continue;
    await opening();
    // A trigger that navigates has left the page being tested.
    if (page.url() !== d.url) {
      await d.reload();
      continue;
    }
    if ((await count()) === resting) continue;
    const state = `with ${trigger.label} open`;
    opened.push(state);
    await d.record(await d.measure(), state);
    if (d.full) await hoverAround(state);
    await page.keyboard.press("Escape");
    await opening();
    if ((await count()) !== resting) await page.locator(trigger.selector).first().click({ timeout: CLICK_LIMIT_MS }).catch(() => {});
    await opening();
    if ((await count()) !== resting) await d.reload();
  }

  const failed: string[] = [];
  for (const { name, steps } of d.scripted) {
    let failedStep: string | undefined;
    for (const step of steps) {
      const ok = await runStep(page, step).then(() => true, () => false);
      if (!ok) {
        failedStep = describeStep(step);
        break;
      }
      await opening();
    }
    if (failedStep) failed.push(`"${name}" stopped at ${failedStep}`);
    else {
      const state = `in "${name}"`;
      opened.push(state);
      await d.record(await d.measure(), state);
      if (d.full) {
        await hoverAround(state);
        await tabThrough(state);
      }
    }
    await d.reload();
  }

  await page.mouse.move(0, 0);
  if (!d.scripted.length && (await count()) !== resting) await d.reload();
  return { opened, failed, skipped: Math.max(0, triggers.length - MAX_TRIGGERS) };
}
