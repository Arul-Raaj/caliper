// The engine: open the page once per scenario, stress it, measure it,
// turn raw measurements into rule findings, and take screenshots.

import { mkdir } from "node:fs/promises";
import type { Browser, BrowserContext, Page } from "playwright";
import { RULES, type Fixes, type Role, type RuleId } from "./rules.js";
import { fixesFor } from "./fixes.js";
import { SCENARIOS, widthScenario, type Scenario } from "./scenarios.js";
import { loadScript } from "./scripts.js";
import { launchBrowser } from "./browser.js";
import { inPage } from "./page.js";
import { exercise, pattern, type Seen } from "./interact.js";
import { commonColor, contrast, decodePng, edgeOf, inkIn } from "./pixels.js";
import type { ScriptedState } from "./steps.js";

// ---------- types ----------

interface Box { x: number; y: number; width: number; height: number }

export interface RawFinding {
  kind:
    | "page-overflow" | "spill-x" | "clip-x" | "flex-shrink" | "flex-column" | "fixed-width" | "grid-blowout" | "fixed-height" | "img-distorted"
    | "tap-small" | "label-wrap" | "label-truncated" | "short-button" | "fixed-offscreen" | "pinned-cover" | "covered-by-pinned" | "sticky-no-room"
    | "bar-over-content" | "empty-bar" | "gutter-shift" | "chains-to-page" | "control-past" | "text-touches-control" | "uneven-row" | "auto-fit-stretch"
    | "stretched-shape" | "wider-than-box" | "bg-tiles" | "edge-lost" | "unreadable-without-image" | "hover-hug" | "sticks-on-touch" | "focus-zoom"
    | "overlay-offscreen-x" | "no-focus-ring" | "word-broken" | "invisible-media" | "var-unresolved" | "dropped-rule";
  selector: string;
  label: string;
  role: Role;
  box: Box;
  details: Record<string, number | string | boolean>;
}

type RawMedia = Pick<RawFinding, "selector" | "label" | "role" | "box">;

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
  state?: string; // the opened state it needed, such as "with button "Menu" open"
  shots: { before?: string; after?: string; missing?: "limit" | "failed" }; // why there is no screenshot
  similar: { selector: string; label: string }[]; // other elements with the same structure and the same problem
  fixes?: Fixes; // fixes built from what was measured, recommended first; otherwise the rule's own
}

export interface RunOptions {
  url: string;
  outDir: string;
  scenarios?: string[];
  maxShots?: number;
  ignore?: string[]; // CSS selectors to leave out
  widths?: number[]; // extra desktop widths to test, for side panels
  steps?: ScriptedState[]; // scripted states to measure
  interact?: boolean; // open menus, hover and tab (default: true)
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
  states: { scenario: string; name: string }[]; // what the interaction pass opened
  notes: string[]; // anything else that shaped the result
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
    case "flex-column": return "layout/flex-min-size";
    case "fixed-width": return "layout/fixed-width";
    case "short-button": return "input/short-button";
    case "pinned-cover": return "layout/pinned-cover";
    case "covered-by-pinned": return "layout/covered-by-pinned";
    case "sticky-no-room": return "layout/sticky-no-room";
    case "empty-bar": return "scroll/empty-bar";
    case "gutter-shift": return "scroll/gutter-shift";
    case "chains-to-page": return "scroll/chains-to-page";
    case "text-touches-control": return "layout/text-touches-control";
    case "uneven-row": return "layout/uneven-row-spacing";
    case "auto-fit-stretch": return "layout/auto-fit-stretch";
    case "stretched-shape": return "layout/stretched-shape";
    case "wider-than-box": return "media/wider-than-box";
    case "bg-tiles": return "media/bg-tiles";
    case "edge-lost": return "media/edge-lost";
    case "unreadable-without-image": return "content/unreadable-without-image";
    case "sticks-on-touch": return "hover/sticks-on-touch";
    case "focus-zoom": return "input/focus-zoom";
    case "var-unresolved": return "css/var-unresolved";
    case "dropped-rule": return "css/dropped-rule";
    case "grid-blowout": return "layout/grid-min-size";
    case "fixed-height": return "layout/fixed-size";
    case "img-distorted": return "media/distortion";
    case "tap-small": return "input/min-tap";
    case "label-wrap": return "content/label-wrap";
    case "label-truncated": return "content/label-truncated";
    case "fixed-offscreen": return "layout/fixed-offscreen";
    case "bar-over-content": return "scroll/bar-over-content";
    case "control-past": return "layout/control-past-container";
    case "hover-hug": return "hover/fill-hugs-content";
    case "overlay-offscreen-x": return "overlay/offscreen-x";
    case "no-focus-ring": return "focus/no-visible-ring";
    case "word-broken": return "text/word-broken";
    case "invisible-media": return "media/invisible-on-background";
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
      return `The page is ${d.pageWidth} px wide on a ${d.viewportWidth} px screen.${d.right ? ` This element reaches ${d.right} px.` : ""}${d.width ? ` Its width is set to ${d.width}.` : ""}`;
    case "spill-x":
      return `Its text needs ${d.contentWidth} px; the box gives ${d.boxWidth} px. ${d.gap} px runs past the edge.`;
    case "clip-x":
      return d.by
        ? `Its text needs ${d.contentWidth} px; ${d.by} shows ${d.boxWidth} px of it. ${d.gap} px is hidden, with no ellipsis.`
        : `Its text needs ${d.contentWidth} px; ${d.boxWidth} px is shown. ${d.gap} px is hidden, with no ellipsis.`;
    case "flex-shrink":
      return `Its row needs ${d.contentWidth} px; the row gives ${d.containerWidth} px. This item takes ${d.itemWidth} px${d.side === "left" ? ", and the row runs out past its left edge, where nobody can scroll" : ""}.`;
    case "flex-column":
      return `Its column has ${d.containerHeight} px of height and needs ${d.contentHeight} px. This item takes ${d.itemHeight} px and won't shrink, so nothing inside it scrolls.`;
    case "fixed-width":
      return `Its row needs ${d.contentWidth} px; the row gives ${d.containerWidth} px. This item holds a set ${d.itemWidth} px and won't shrink.`;
    case "grid-blowout":
      return Number(d.fixedSum)
        ? `The grid needs ${d.contentWidth} px; it has ${d.containerWidth} px. Its fixed columns (${String(d.fixed).split(" ").filter((t) => t !== "flex").join(", ")}) take ${d.fixedSum} px of it.`
        : `The grid needs ${d.contentWidth} px; it has ${d.containerWidth} px.`;
    case "fixed-height":
      return `Its content needs ${d.contentHeight} px of height; the box gives ${d.boxHeight} px${d.clipped ? ", and the rest is hidden" : ""}.`;
    case "img-distorted":
      return d.background
        ? `The background image is ${d.naturalWidth} × ${d.naturalHeight} but drawn at ${d.shownWidth} × ${d.shownHeight}, so its shape changes.`
        : `The image is ${d.naturalWidth} × ${d.naturalHeight} but shown at ${d.shownWidth} × ${d.shownHeight}, so its shape changes.`;
    case "stretched-shape":
      return `On its own it is ${d.ownWidth} × ${d.ownHeight} px; the row stretches it to ${d.width} × ${d.height} px, so its ${d.round ? "circle becomes a pill" : "square becomes a bar"}.`;
    case "wider-than-box":
      return `It is ${d.width} px wide in a box with ${d.room} px of room, so ${d.past} px ${d.clipped ? "is cut off" : "runs past the edge"}.`;
    case "bg-tiles":
      return Number(d.wideAt)
        ? `Its background image is ${d.tileWidth} px wide and repeats: on screens wider than ${d.wideAt} px it starts to tile.`
        : `Its background image is drawn at ${d.tileWidth} × ${d.tileHeight} px in a ${d.areaWidth} × ${d.areaHeight} px box and repeats ${d.axis === "both" ? "both ways" : d.axis === "x" ? "sideways" : "downwards"}, so a second copy shows.`;
    case "edge-lost":
      return `${d.lost}% of its outline has under 1.1:1 contrast with what is around it, so its edge disappears.`;
    case "unreadable-without-image":
      return `With the image missing, its ${d.color} text sits on ${d.back}, a contrast of ${d.contrast}:1 (it needs ${d.needed}:1).`;
    case "tap-small":
      return `It measures ${d.width} × ${d.height} px on a ${scenario.viewport.width} px screen, with another target within 24 px.`;
    case "label-wrap":
      return `Its label breaks onto ${d.lines} lines in a ${d.width} px button. On one line it needs ${d.needed} px, and the row has ${d.available} px.`;
    case "label-truncated":
      return `Its label needs ${d.contentWidth} px; the button shows ${d.boxWidth} px and ends in an ellipsis.`;
    case "short-button":
      return `With the label "${d.text}" it is ${d.width} × ${d.height} px, narrower than 44 px or than it is tall.`;
    case "fixed-offscreen":
      return d.sticky
        ? `It sticks at ${d.top} px and is ${d.height} px tall on a ${d.viewportHeight} px screen, so its last ${d.hidden} px only come into view when its container ends.`
        : `It is ${d.height} px tall on a ${d.viewportHeight} px screen, and ${d.hidden} px of it can't be scrolled into view.`;
    case "pinned-cover":
      return `${d.bars === 1 ? "This bar takes" : `${d.bars} pinned bars take`} ${d.covered} px of a ${d.viewportHeight} px screen (${d.share}%), so the page shows through a slot.`;
    case "covered-by-pinned":
      return d.side === "top"
        ? `At the top of the page it sits under ${d.layer} (${d.position}, ${d.height} px tall), and it never scrolls out from under it.`
        : `At the end of the page it sits under ${d.layer} (${d.position}, ${d.height} px tall), and it never scrolls out from under it.`;
    case "sticky-no-room":
      return `It is position: sticky and ${d.height} px tall, and its ${d.layout} parent is exactly as tall (${d.parentHeight} px), so it has no room to stick and scrolls away.`;
    case "bar-over-content": {
      const inset = Number(d.inset) ? `Its right edge is at ${d.right} px, ${d.inset} px inside its ${d.panelRight} px panel.` : "";
      const near = Number(d.gap) >= 0 ? `Its content reaches ${d.contentRight} px, ${d.gap} px from the scrollbar at ${d.edge} px.` : "";
      return [inset, near].filter(Boolean).join(" ");
    }
    case "empty-bar":
      return `It draws a ${d.bar} px scrollbar ${d.axis === "both" ? "on both sides" : d.axis === "y" ? "down its side" : "along its bottom"} with nothing to scroll.`;
    case "gutter-shift":
      return `Its content fills ${d.fill}% of its height. Once it runs longer, the scrollbar appears and moves the content ${d.shift} px sideways.`;
    case "chains-to-page":
      return "Scrolled to its end, one more turn of the wheel scrolls the page behind it.";
    case "control-past":
      return `It runs ${d.past} px past the ${d.side} edge of ${d.container}${d.clipped ? ", which cuts it off" : ""}.`;
    case "text-touches-control":
      return d.under
        ? `Its text runs ${-Number(d.gap)} px under ${d.part}, which is laid over it.`
        : Number(d.gap) < 0
          ? `Its text runs ${-Number(d.gap)} px into ${d.part}, with no gap between them.`
          : `Its text ends ${d.gap} px from ${d.part}, with no gap set between them.`;
    case "uneven-row":
      return `Its items wrap onto ${d.lines} lines spaced unevenly: ${d.gap} px between items on one line, ${d.widest} px on another.`;
    case "auto-fit-stretch":
      return `It has room for ${d.tracks} columns of ${d.trackWidth} px, but ${d.items === 1 ? "its one item stretches" : `its ${d.items} items stretch`} to ${d.itemWidth} px: ${d.empty} empty ${Number(d.empty) === 1 ? "column collapses" : "columns collapse"}.`;
    case "hover-hug":
      return d.corners
        ? `Its ${d.fill} hover fill has 0 px corners, ${d.inset} px inside a surface with ${d.radius} px corners.`
        : `Its ${d.fill} hover fill leaves ${d.gap} px between its ${d.side} edge and the content.`;
    case "sticks-on-touch":
      return d.revealed
        ? "On a touch screen a tap leaves it in its hover state, and parts that only show on hover appear and stay."
        : d.change === "fill"
          ? "On a touch screen a tap leaves its hover fill on, and it stays until you tap somewhere else."
          : "On a touch screen a tap leaves it lifted in its hover state, and it stays until you tap somewhere else.";
    case "focus-zoom":
      return `Its text is ${d.size} px when it has focus. iOS Safari zooms into any field under 16 px, and the page stays zoomed in.`;
    case "overlay-offscreen-x":
      return `It is ${d.width} px wide and runs ${d.past} px past the ${d.side} edge of a ${d.viewportWidth} px screen.`;
    case "no-focus-ring":
      return `Tab reaches it with outline ${d.outline} and box-shadow ${d.shadow === "none" ? "none" : "unchanged"}. All ${d.compared} style properties Caliper compares match its unfocused state.`;
    case "word-broken":
      return `"${d.word}" breaks into "${d.head}" and "${d.tail}". The word needs ${d.wordWidth} px; the box gives ${d.room} px.`;
    case "invisible-media":
      return `It is ${d.ink} on ${d.back}, a contrast of ${d.contrast}:1. ${d.visible}% of its pixels stand out from what is behind them.`;
    case "var-unresolved":
      return `${d.property} uses var(${d.variable}) with no fallback (in "${d.rule}"), and ${d.variable} isn't set here, so the browser drops the whole value.`;
    case "dropped-rule":
      return `The rule "${d.selector}" (${d.sheet}, line ${d.line}) groups ${d.unsupported}, which this browser doesn't know, so it drops the whole rule.`;
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
      if (d.by) {
        return d.reveals
          ? { text: `${d.by} has overflow: hidden and a set width, and the text can't wrap or end in an ellipsis. Allowed to wrap, all of it shows.`, confirmed: true }
          : { text: `${d.by} has overflow: hidden, and the text inside it has no ellipsis.`, confirmed: false };
      }
      return d.reveals
        ? { text: "overflow: hidden on the box, with no text-overflow: ellipsis. Allowed to wrap, all of it shows.", confirmed: true }
        : { text: "overflow: hidden on the box, with no text-overflow: ellipsis.", confirmed: false };
    case "flex-shrink":
      if (d.confirmed) return { text: "Flex items won't shrink below their content (min-width: auto). With min-width: 0 the row fits, and every item's text stays inside it.", confirmed: true };
      if (d.wraps) return { text: "The row can't wrap (flex-wrap: nowrap), and its items can't shrink without their text spilling. With flex-wrap: wrap it fits.", confirmed: true };
      return { text: "Something inside the row is wider than the row. Neither min-width: 0 nor flex-wrap: wrap fixed it.", confirmed: false };
    case "flex-column":
      return { text: "Flex items won't shrink below their content height (min-height: auto), so the column grows past its box instead of letting the inside scroll. With min-height: 0 it fits.", confirmed: true };
    case "fixed-width":
      return { text: "A set width with flex-shrink: 0 (or flex: none). Allowed to shrink, the row fits.", confirmed: true };
    case "grid-blowout":
      if (Number(d.fixedSum)) {
        return d.stacks
          ? { text: "Its fixed columns are wider than the room a small screen has. Stacked in one column, the grid fits.", confirmed: true }
          : { text: "Its fixed columns are wider than the room a small screen has.", confirmed: false };
      }
      return d.confirmed
        ? { text: "Grid tracks grow to fit their content. With min-width: 0 on the items, the grid fits and nothing in it pushes the page wider.", confirmed: true }
        : { text: "A child is wider than its track. min-width: 0 alone didn't fix it.", confirmed: false };
    case "fixed-height":
      return { text: "A set height or max-height. Released, the box grows.", confirmed: true };
    case "img-distorted":
      if (d.background) return { text: "background-size gives two lengths whose shape isn't the image's own.", confirmed: false };
      return d.stretched
        ? { text: "The row stretches it to the row's height (align-items: stretch). With align-self: flex-start it keeps its shape.", confirmed: true }
        : { text: "The box has a different shape from the image, and object-fit: fill bends the image to fit.", confirmed: false };
    case "stretched-shape":
      return { text: "The row stretches it to the row's height (align-items: stretch). With align-self: flex-start it keeps its shape.", confirmed: true };
    case "wider-than-box":
      return d.fits
        ? { text: "Nothing caps it at the width of its box. With max-width: 100% and height: auto it fits.", confirmed: true }
        : { text: "Nothing caps it at the width of its box.", confirmed: false };
    case "bg-tiles":
      return { text: "background-repeat is left at repeat, and the image doesn't cover the box.", confirmed: false };
    case "label-wrap":
      return { text: "Its width is held below its label. Sized to the label, it fits on one line.", confirmed: true };
    case "label-truncated":
      return d.reveals
        ? { text: "text-overflow: ellipsis cuts the label. Allowed to wrap, all of it shows.", confirmed: true }
        : { text: "text-overflow: ellipsis cuts the label.", confirmed: false };
    case "short-button":
      return { text: "The button has no min-width, so it is only as wide as its label and padding.", confirmed: false };
    case "fixed-offscreen":
      if (d.sticky) {
        return d.fits
          ? { text: "position: sticky with no max-height or scrolling. With a max-height of the screen minus its offset, it fits.", confirmed: true }
          : { text: "position: sticky with no max-height or scrolling.", confirmed: false };
      }
      return d.fits
        ? { text: "position: fixed with no max-height or scrolling. With max-height: 100dvh it fits.", confirmed: true }
        : { text: "position: fixed with no max-height or scrolling.", confirmed: false };
    case "pinned-cover":
      return { text: "Bars stay pinned whatever the screen's height. Nothing unpins them on short screens.", confirmed: false };
    case "covered-by-pinned":
      return { text: "The bar is taken out of the page's flow, and nothing makes room for it (a padding, a margin, or a variable that should set one).", confirmed: false };
    case "sticky-no-room":
      return d.freed
        ? { text: `The ${d.layout} stretches it to its parent's height (align-items: stretch). With align-self: flex-start it has room to stick.`, confirmed: true }
        : { text: "Its parent is exactly as tall as it is, so it has no room to move.", confirmed: false };
    case "empty-bar":
      return { text: "overflow: scroll draws a scrollbar whether there is anything to scroll or not.", confirmed: false };
    case "gutter-shift":
      return d.steady
        ? { text: "overflow: auto takes room for the scrollbar only once it appears. With scrollbar-gutter: stable nothing moves.", confirmed: true }
        : { text: "overflow: auto takes room for the scrollbar only once it appears.", confirmed: false };
    case "chains-to-page":
      return d.contained
        ? { text: "overscroll-behavior is left at auto, so scrolling past the end is passed on. With overscroll-behavior: contain the page stays still.", confirmed: true }
        : { text: "overscroll-behavior is left at auto, so scrolling past the end is passed on.", confirmed: false };
    case "control-past":
      return d.shrinks
        ? { text: "The items in its row won't shrink below their content (min-width: auto). With min-width: 0 it stays inside.", confirmed: true }
        : { text: "Its row is wider than its container. min-width: 0 alone didn't bring it back.", confirmed: false };
    case "text-touches-control":
      if (d.under) {
        return d.spaced
          ? { text: "The control is laid over the text, and the text keeps no room for it. With padding the width of the control, the text stays clear.", confirmed: true }
          : { text: "The control is laid over the text, and the text keeps no room for it.", confirmed: false };
      }
      return d.spaced
        ? { text: "The row sets no gap, so the text grows right up to its neighbour. With column-gap: 16px they stay apart.", confirmed: true }
        : { text: "The row sets no gap, so the text grows right up to its neighbour.", confirmed: false };
    case "uneven-row":
      return d.even
        ? { text: "justify-content spreads each line on its own, so a short line spreads wide. Packed to the start with a gap, every line matches.", confirmed: true }
        : { text: "justify-content spreads each line on its own, so a short line spreads wide.", confirmed: false };
    case "auto-fit-stretch":
      return d.fills
        ? { text: `${d.template} collapses the empty columns and gives their room to the items. With auto-fill they keep their width.`, confirmed: true }
        : { text: "repeat(auto-fit, …) collapses the empty columns and gives their room to the items.", confirmed: false };
    case "sticks-on-touch":
      return { text: "A :hover rule outside @media (hover: hover). Touch screens apply it on tap and keep it.", confirmed: true };
    case "focus-zoom":
      return { text: "The field's font-size is under 16 px.", confirmed: true };
    case "no-focus-ring":
      return d.reverts
        ? { text: "A style removes the outline and puts nothing in its place. With outline: revert the ring comes back.", confirmed: true }
        : { text: "No focus style is set on it.", confirmed: false };
    case "word-broken":
      return d.whole
        ? { text: "overflow-wrap or word-break lets the box shrink below the word. Set back to normal, the word stays whole.", confirmed: true }
        : { text: "overflow-wrap or word-break lets the word break, and the box has no room for it whole.", confirmed: false };
    case "page-overflow":
      if (d.right && d.fits) return { text: d.width ? `A set width of ${d.width}. With max-width: 100% the page fits.` : "Nothing caps this element at the screen's width. With max-width: 100% the page fits.", confirmed: true };
      return d.right
        ? { text: "This element reaches furthest past the edge.", confirmed: false }
        : { text: "Something with no element of its own runs past the edge, such as a ::before or ::after layer.", confirmed: false };
    case "var-unresolved":
      return { text: `var(${d.variable}) has no fallback, and nothing sets ${d.variable} on this element or above it.`, confirmed: true };
    case "dropped-rule":
      return { text: `A selector list is all or nothing: one part the browser can't read (${d.unsupported}) drops the rule for every part.`, confirmed: true };
    default:
      return undefined;
  }
}

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

async function openPage(browser: Browser, scenario: Scenario, url: string): Promise<{ context: BrowserContext; page: Page; finalUrl: string; fitted: boolean }> {
  const context = await browser.newContext({
    viewport: scenario.viewport,
    deviceScaleFactor: scenario.deviceScaleFactor,
    isMobile: scenario.mobile,
    hasTouch: scenario.mobile,
    reducedMotion: "reduce",
    colorScheme: scenario.colorScheme,
    ignoreHTTPSErrors: true, // local dev servers often use self-signed certificates
  });
  if (scenario.blockImages) {
    await context.route("**/*", (route) =>
      route.request().resourceType() === "image" ? route.abort() : route.continue(),
    );
  }
  // A click that opens a new tab has left the page being tested.
  context.on("page", (opened) => { if (context.pages().length > 1) opened.close().catch(() => {}); });
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

  const fitted = await settle(page, scenario, () => fail(`${url} has no page body to test. Give Caliper the address of an HTML page.`));
  return { context, page, finalUrl: page.url(), fitted };
}

// Wait for the page to finish: images and fonts, then the network, then
// the DOM. Apps that render after load (React, Vue) settle in the last step.
async function settle(page: Page, scenario: Scenario, noBody: () => Promise<never>): Promise<boolean> {
  await page.waitForLoadState("load", { timeout: 15_000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
  await inPage(page, `(${QUIET})()`);
  if (!(await inPage<boolean>(page, "Boolean(document.body)"))) await noBody();
  const fitted = scenario.mobile && (await inPage<boolean>(page, FIT));
  await inPage(page, `(${LAZY})()`);
  await inPage(page, `(${QUIET})()`);
  return fitted;
}

// With no viewport tag, a phone lays a page out 980 px wide and zooms out, so
// a 320 px scenario would quietly measure a desktop layout. Add the tag, so
// the scenario tests the width it names. Pages meant for desktop, such as an
// extension's side panel, often have none.
const FIT = `(() => {
  if (document.querySelector('meta[name="viewport" i]')) return false;
  const tag = document.createElement("meta");
  tag.name = "viewport";
  tag.content = "width=device-width, initial-scale=1";
  (document.head ?? document.documentElement).append(tag);
  return true;
})()`;

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
  const scenarios = [
    ...SCENARIOS.filter((s) => s.id === "baseline" || !options.scenarios || options.scenarios.includes(s.id)),
    ...(options.widths ?? []).map(widthScenario),
  ];
  const shotsDir = `${options.outDir}/shots`;

  const ignore = options.ignore ?? [];
  const explore = options.interact !== false;
  const detectSrc = await loadScript("detect.js");
  const stressSrc = await loadScript("stress.js");

  const browser = await launchBrowser(log);
  const byKey = new Map<string, Finding>();
  const incomplete: RunResult["incomplete"] = [];
  const capped: RunResult["capped"] = [];
  const states: RunResult["states"] = [];
  const notes: string[] = [];
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
    const scan = (scenario: Scenario, extra?: Record<string, unknown>) =>
      `(${detectSrc})(${JSON.stringify({ checkTapTargets: scenario.mobile, checkLabels: scenario.labels, checkFixed: scenario.checkFixed, checkBars: !scenario.mobile, checkWords: scenario.stress !== "long-word", ignore, ...extra })})`;
    const invalid = await inPage<string[]>(baseline.page, `${JSON.stringify(ignore)}.filter((s) => { try { document.querySelector(s); return false; } catch { return true; } })`);
    if (invalid.length) throw new Error(`--ignore "${invalid[0]}" isn't a valid CSS selector.`);
    const probeIn = <T>(page: Page, scenario: Scenario, request: Record<string, unknown>) => inPage<T>(page, scan(scenario, { probe: request }));
    const measure = async (page: Page, scenario: Scenario) => {
      const m = await inPage<Measurement>(page, scan(scenario));
      const more = async (op: string) => (await probeIn<Seen<RawFinding>>(page, scenario, { op })).findings;
      // Each check that hit its limit keeps its own cap: these come from separate passes.
      if (!scenario.blockImages) m.findings.push(...(await more("backgrounds")));
      m.findings.push(...(await more("sheets")));
      if (scenario.media) m.findings.push(...(await invisibleMedia(page, scenario)));
      if (scenario.blockImages) m.findings.push(...(await unreadableText(page, scenario)));
      if (!scenario.mobile && scenario.interact !== "none") m.findings.push(...(await chaining(page, scenario)));
      return m;
    };

    // Scrollers laid over the page: scroll each to its end with the real
    // wheel and see whether the page behind moves. Then try the fix.
    async function chaining(page: Page, scenario: Scenario): Promise<RawFinding[]> {
      const found: RawFinding[] = [];
      const targets = await probeIn<{ selector: string }[]>(page, scenario, { op: "chainers" });
      const turn = async (selector: string, contain: boolean) => {
        const at = await probeIn<{ x: number; y: number } | null>(page, scenario, { op: "chainStart", selector, contain });
        if (!at) return null;
        await page.mouse.move(at.x, at.y);
        await page.mouse.wheel(0, 600);
        await inPage(page, SETTLE);
        await page.waitForTimeout(250);
        return at;
      };
      for (const { selector } of targets) {
        if (!(await turn(selector, false))) continue;
        const first = await probeIn<{ moved: boolean }>(page, scenario, { op: "chainEnd", selector });
        if (!first.moved) continue;
        await turn(selector, true);
        const second = await probeIn<{ moved: boolean }>(page, scenario, { op: "chainEnd", selector });
        const seen = await probeIn<Seen<RawFinding>>(page, scenario, { op: "chainEnd", selector, report: true, contained: !second.moved });
        found.push(...seen.findings);
      }
      await page.mouse.move(0, 0);
      return found;
    }

    // Text laid over an image, once the image has failed: is it still
    // readable on what is left behind it? Two screenshots: as shown, and
    // with that text hidden, to read the colour behind it.
    async function unreadableText(page: Page, scenario: Scenario): Promise<RawFinding[]> {
      const list = await probeIn<(RawMedia & { color: string; large: boolean })[]>(page, scenario, { op: "overImage" });
      if (!list.length) return [];
      try {
        await probeIn(page, scenario, { op: "textStyle", hide: true });
        const behind = decodePng(await page.screenshot({ fullPage: true, scale: "css", animations: "disabled" }));
        const found: RawFinding[] = [];
        for (const item of list) {
          const back = commonColor(behind, item.box);
          const ink = item.color.match(/[\d.]+/g)?.map(Number);
          if (!back || !ink) continue;
          const alpha = ink[3] ?? 1;
          const text = [0, 1, 2].map((i) => Math.round(ink[i]! * alpha + back[i]! * (1 - alpha)));
          const ratio = contrast(text, back);
          const needed = item.large ? 3 : 4.5;
          if (ratio >= needed) continue;
          const hex = (c: number[]) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
          found.push({ ...item, kind: "unreadable-without-image", details: { color: hex(text), back: hex(back), contrast: ratio.toFixed(2), needed } });
        }
        return found.slice(0, 25);
      } catch {
        notes.push(`Caliper couldn't compare text colours ${scenario.phrase}, so text over images wasn't checked there.`);
        return [];
      } finally {
        await probeIn(page, scenario, { op: "textStyle" });
      }
    }

    // Touch screens: a tap applies :hover and leaves it on. Caliper forces
    // the hover state through the browser's developer tools rather than
    // tapping, because a tap would follow links. The same for focus, to read
    // a text field's size as it takes focus.
    async function touch(page: Page, scenario: Scenario): Promise<RawFinding[]> {
      const found: RawFinding[] = [];
      const cdp = await page.context().newCDPSession(page);
      try {
        await cdp.send("DOM.enable");
        await cdp.send("CSS.enable");
        const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
        const nodeOf = async (selector: string) => (await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector }).catch(() => ({ nodeId: 0 }))).nodeId;
        const force = (nodeId: number, forcedPseudoClasses: string[]) => cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses });
        const settle = () => inPage(page, `(async () => { await ${SETTLE}; await Promise.race([Promise.allSettled(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished)), new Promise((r) => setTimeout(r, 400))]); })()`);
        interface Look { lift: string[]; fill: boolean; shown: boolean[] }
        for (const { selector } of await probeIn<{ selector: string }[]>(page, scenario, { op: "hoverRules" })) {
          const nodeId = await nodeOf(selector);
          if (!nodeId) continue;
          const before = await probeIn<Look | null>(page, scenario, { op: "touchLook", selector });
          await force(nodeId, ["hover"]);
          await settle();
          const after = await probeIn<Look | null>(page, scenario, { op: "touchLook", selector });
          await force(nodeId, []);
          await settle();
          if (!before || !after) continue;
          const revealed = after.shown.some((on, i) => on && before.shown[i] === false);
          const lifted = after.lift.some((v, i) => v !== before.lift[i]);
          const filled = after.fill && !before.fill;
          if (!revealed && !lifted && !filled) continue;
          found.push(...(await probeIn<Seen<RawFinding>>(page, scenario, { op: "touchReport", selector, revealed, change: revealed ? "reveal" : lifted ? "lift" : "fill" })).findings);
        }
        for (const { selector } of await probeIn<{ selector: string }[]>(page, scenario, { op: "fields" })) {
          const nodeId = await nodeOf(selector);
          if (!nodeId) continue;
          await force(nodeId, ["focus", "focus-visible", "focus-within"]);
          const size = await probeIn<number | null>(page, scenario, { op: "fieldSize", selector });
          await force(nodeId, []);
          if (size !== null && size < 16) found.push(...(await probeIn<Seen<RawFinding>>(page, scenario, { op: "fieldReport", selector, size })).findings);
        }
      } catch {
        notes.push(`Caliper couldn't force hover and focus states ${scenario.phrase}, so touch hover and field zoom weren't checked there.`);
      } finally {
        await cdp.detach().catch(() => {});
      }
      return found;
    }

    // Images that vanish into their background. Three full-page screenshots,
    // whatever the number of images: as shown, images hidden, images inverted.
    async function invisibleMedia(page: Page, scenario: Scenario): Promise<RawFinding[]> {
      const media = (request: Record<string, unknown>) => inPage<RawMedia[]>(page, scan(scenario, { probe: request }));
      const list = await media({ op: "media" });
      if (!list.length) return [];
      const picture = async (look?: string) => {
        await media({ op: "mediaStyle", look });
        return decodePng(await page.screenshot({ fullPage: true, scale: "css", animations: "disabled" }));
      };
      try {
        const shown = await picture();
        const behind = await picture("hide");
        const inverted = await picture("invert");
        const found: RawFinding[] = [];
        for (const item of list) {
          const ink = inkIn(shown, behind, inverted, item.box);
          if (!ink) continue;
          const edge = edgeOf(shown, inverted, item.box);
          // A ring or outline drawn around it frames it, even when the image itself is pale.
          const framed = edge.edges >= 16 && edge.lost < edge.edges * 0.5;
          if (ink.vanishes && !framed) {
            found.push({ ...item, kind: "invisible-media", details: { ink: ink.ink, back: ink.back, contrast: ink.contrast.toFixed(2), visible: Math.round(ink.visible * 100) } });
          } else if (!ink.vanishes && item.label.startsWith("img") && item.box.width >= 24 && item.box.height >= 24 && edge.edges >= 16 && edge.lost > edge.edges * 0.8) {
            found.push({ ...item, kind: "edge-lost", details: { lost: Math.round((edge.lost / edge.edges) * 100) } });
          }
        }
        return found.slice(0, 50);
      } catch {
        notes.push(`Caliper couldn't compare image pixels ${scenario.phrase}, so images that vanish into their background weren't checked there.`);
        return [];
      } finally {
        await media({ op: "mediaStyle" });
      }
    }

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
        if (opened.fitted) notes.push("This page has no viewport tag, so a real phone would lay it out 980 px wide. The phone scenarios test it at their own width.");
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
        if (scenario.touch) m.findings.push(...(await touch(page, scenario)));
        await merge(scenario, page, m);
        // --no-interact stops what Caliper finds alone. Scripted states were
        // asked for by name, so they always run.
        if (scenario.interact !== "none" && (explore || options.steps?.length)) await handle(scenario, page);
      } finally {
        if (!isBaseline) {
          await context.close();
          release();
        }
      }
    }
    await baseline.context.close();

    // Measures what only shows after a click, a hover or a Tab. Screenshots
    // need the state on screen, so this runs here, one scenario at a time.
    async function handle(scenario: Scenario, page: Page) {
      try {
        const done = await exercise<RawFinding, Measurement>({
          page,
          url: page.url(),
          opens: explore,
          full: explore && scenario.interact === "full",
          scripted: options.steps ?? [],
          probe: <T>(request: Record<string, unknown>) => inPage<T>(page, scan(scenario, { probe: request })),
          measure: () => measure(page, scenario),
          record: (m, state) => merge(scenario, page, m, state),
          reload: async () => {
            await page.goto(testedUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
            await settle(page, scenario, async () => { throw new Error("the page lost its body after a reload."); });
          },
        }, (expression) => inPage(page, expression));
        for (const name of done.opened) states.push({ scenario: scenario.id, name });
        if (done.skipped) notes.push(`${done.skipped} more menus and sheets weren't opened ${scenario.phrase}: Caliper opens 12 per scenario. Reach the others with --steps.`);
        if (done.failed.length) incomplete.push({ scenario: scenario.id, reason: `scripted state ${done.failed.join("; ")}.` });
      } catch (error) {
        incomplete.push({ scenario: scenario.id, reason: scenarioError(error) });
      }
    }

    async function merge(scenario: Scenario, page: Page, m: Measurement | Seen<RawFinding>, state?: string) {
      const isBaseline = scenario.id === "baseline";
      // `group` decides which findings share a card. Flex items that break
      // the same row are one problem, so they group by their row.
      const raws: { rule: RuleId; selector: string; label: string; role: Role; text: string; cause?: { text: string; confirmed: boolean }; group: string; fixes?: Fixes }[] = m.findings.map((raw) => ({
        rule: toRule(raw, scenario),
        selector: raw.selector,
        label: raw.label,
        role: raw.kind === "label-wrap" || raw.kind === "label-truncated" ? "button" : raw.role,
        text: evidence(raw, scenario),
        cause: cause(raw),
        // The page scrolling sideways is one symptom per scenario, however
        // many elements cause it: one card, the culprits listed under it.
        group: raw.kind === "flex-shrink" || raw.kind === "flex-column" || raw.kind === "fixed-width" ? String(raw.details.container)
          : raw.kind === "page-overflow" ? `page@${scenario.id}`
          : raw.kind === "covered-by-pinned" ? String(raw.details.layerSelector)
          : raw.kind === "dropped-rule" ? String(raw.details.selector)
          : raw.kind === "var-unresolved" ? `${raw.details.variable}|${raw.details.property}`
          : raw.selector,
        fixes: fixesFor(raw),
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
          ...(state ? { state } : {}),
          shots: {},
          similar: [],
          ...(raw.fixes ? { fixes: raw.fixes } : {}),
        };
        byKey.set(key, finding);

        // High-severity findings always get screenshots (up to twice the budget).
        const high = RULES[raw.rule].severity === "high";
        if (shotCount < maxShots || (high && shotCount < maxShots * 2)) {
          shotCount++;
          const after = `shots/${finding.id}-after.png`;
          if (await shoot(page, raw.selector, `${options.outDir}/${after}`, m.pageWidth)) finding.shots.after = after;
          // A state can't be shown "before": it isn't on the baseline's screen.
          if (!isBaseline && !state) {
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

  return { url: options.url, testedUrl, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, scenarios, findings, incomplete, capped, unseen, states, notes: [...new Set(notes)] };
}
