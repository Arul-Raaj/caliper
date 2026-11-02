// Scripted states: the screens Caliper can't reach by opening menus, such as a
// signed-in view or a form half filled in. A steps file is a JSON list:
//
//   [{ "name": "Deep Dive", "steps": [{ "click": ".mode" }, { "click": ".deep" }] }]

import type { Page } from "playwright";

export type Step =
  | { click: string }
  | { hover: string }
  | { fill: string; value: string }
  | { press: string }
  | { waitFor: string }
  | { wait: number };

export interface ScriptedState {
  name: string;
  steps: Step[];
}

const LIMIT_MS = 5_000; // a step that can't happen should say so, not hang
const STEP_KEYS = "click, hover, fill (with value), press, waitFor or wait";

const isStep = (step: unknown): step is Step => {
  if (typeof step !== "object" || step === null) return false;
  const s = step as Record<string, unknown>;
  const text = (key: string) => typeof s[key] === "string" && s[key] !== "";
  return text("click") || text("hover") || text("press") || text("waitFor") || (text("fill") && typeof s.value === "string") || (typeof s.wait === "number" && s.wait >= 0);
};

export function parseSteps(text: string): ScriptedState[] {
  let states: unknown;
  try {
    states = JSON.parse(text);
  } catch {
    throw new Error("isn't valid JSON");
  }
  if (!Array.isArray(states) || !states.length) throw new Error(`should be a list of states, such as [{ "name": "Menu open", "steps": [{ "click": ".menu" }] }]`);
  for (const state of states) {
    if (typeof state?.name !== "string" || !state.name.trim()) throw new Error("has a state with no name");
    if (!Array.isArray(state.steps) || !state.steps.length) throw new Error(`has no steps for "${state.name}"`);
    if (!state.steps.every(isStep)) throw new Error(`has a step Caliper can't read in "${state.name}". Each step is one of ${STEP_KEYS}`);
  }
  return states;
}

export async function runStep(page: Page, step: Step): Promise<void> {
  if ("click" in step) await page.locator(step.click).first().click({ timeout: LIMIT_MS });
  else if ("hover" in step) await page.locator(step.hover).first().hover({ timeout: LIMIT_MS });
  else if ("fill" in step) await page.locator(step.fill).first().fill(step.value, { timeout: LIMIT_MS });
  else if ("press" in step) await page.keyboard.press(step.press);
  else if ("waitFor" in step) await page.locator(step.waitFor).first().waitFor({ timeout: LIMIT_MS });
  else await page.waitForTimeout(step.wait);
}

export const describeStep = (step: Step): string => JSON.stringify(step);
