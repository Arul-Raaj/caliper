// A scenario is one way of stressing the page: a screen size plus,
// optionally, a change to the content. Each runs in a fresh browser tab.

export type StressMode = "none" | "long-text" | "long-word" | "text-spacing";

export interface Scenario {
  id: string;
  label: string; // shown in the report
  phrase: string; // finishes a sentence: "The page scrolls sideways on a 320 px phone"
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  mobile: boolean;
  stress: StressMode;
  blockImages: boolean;
  labels: boolean; // check for button labels that wrap (real content only)
  checkFixed: boolean; // check fixed panels that run off a small screen
  colorScheme: "light" | "dark";
  media: boolean; // compare pixels to find images that vanish into their background
  interact: "full" | "open" | "none"; // full hovers and tabs; open only opens menus and sheets
}

const DESKTOP = { width: 1280, height: 800 };

export const SCENARIOS: Scenario[] = [
  {
    id: "baseline",
    label: "As is, 1280 px",
    phrase: "as is",
    viewport: DESKTOP,
    deviceScaleFactor: 1,
    mobile: false,
    stress: "none",
    blockImages: false,
    labels: true,
    checkFixed: false,
    colorScheme: "light",
    media: true,
    interact: "full",
  },
  {
    id: "long-text",
    label: "Text 3x longer",
    phrase: "with text 3x longer",
    viewport: DESKTOP,
    deviceScaleFactor: 1,
    mobile: false,
    stress: "long-text",
    blockImages: false,
    labels: false,
    checkFixed: false,
    colorScheme: "light",
    media: false,
    interact: "none",
  },
  {
    id: "long-word",
    label: "63-letter word added",
    phrase: "with a 63-letter word",
    viewport: DESKTOP,
    deviceScaleFactor: 1,
    mobile: false,
    stress: "long-word",
    blockImages: false,
    labels: false,
    checkFixed: false,
    colorScheme: "light",
    media: false,
    interact: "none",
  },
  {
    id: "broken-images",
    label: "Images fail to load",
    phrase: "when images fail to load",
    viewport: DESKTOP,
    deviceScaleFactor: 1,
    mobile: false,
    stress: "none",
    blockImages: true,
    labels: false,
    checkFixed: false,
    colorScheme: "light",
    media: false,
    interact: "none",
  },
  {
    id: "narrow",
    label: "320 px phone",
    phrase: "on a 320 px phone",
    viewport: { width: 320, height: 640 },
    deviceScaleFactor: 2,
    mobile: true,
    stress: "none",
    blockImages: false,
    labels: true,
    checkFixed: true,
    colorScheme: "light",
    media: false,
    interact: "open",
  },
  {
    // A 1280 x 800 window at 200% browser zoom lays out exactly like a
    // 640 x 400 window at 2x pixel density.
    id: "zoom-200",
    label: "200% browser zoom",
    phrase: "at 200% browser zoom",
    viewport: { width: 640, height: 400 },
    deviceScaleFactor: 2,
    mobile: false,
    stress: "none",
    blockImages: false,
    labels: true,
    checkFixed: true,
    colorScheme: "light",
    media: false,
    interact: "none",
  },
  {
    // WCAG 2.2, 1.4.12: text must survive line height 1.5, paragraph
    // spacing 2x, letter spacing 0.12em and word spacing 0.16em.
    id: "text-spacing",
    label: "WCAG text spacing",
    phrase: "with WCAG text spacing",
    viewport: DESKTOP,
    deviceScaleFactor: 1,
    mobile: false,
    stress: "text-spacing",
    blockImages: false,
    labels: true,
    checkFixed: false,
    colorScheme: "light",
    media: false,
    interact: "none",
  },
  {
    // The width where navs and grids most often fall between breakpoints.
    id: "tablet",
    label: "768 px tablet",
    phrase: "on a 768 px tablet",
    viewport: { width: 768, height: 1024 },
    deviceScaleFactor: 2,
    mobile: true,
    stress: "none",
    blockImages: false,
    labels: true,
    checkFixed: false,
    colorScheme: "light",
    media: false,
    interact: "none",
  },
  {
    // Same layout, other palette: logos and icons drawn for one theme vanish in the other.
    id: "dark",
    label: "Dark mode",
    phrase: "in dark mode",
    viewport: DESKTOP,
    deviceScaleFactor: 1,
    mobile: false,
    stress: "none",
    blockImages: false,
    labels: false,
    checkFixed: false,
    colorScheme: "dark",
    media: true,
    interact: "open",
  },
];

// A desktop window at a width of your choice, for side panels and extensions.
export const widthScenario = (width: number): Scenario => ({
  id: `width-${width}`,
  label: `${width} px panel`,
  phrase: `in a ${width} px panel`,
  viewport: { width, height: 800 },
  deviceScaleFactor: 2,
  mobile: false,
  stress: "none",
  blockImages: false,
  labels: true,
  checkFixed: true,
  colorScheme: "light",
  media: true,
  interact: "full",
});

export const SCENARIO_IDS = SCENARIOS.map((s) => s.id);
