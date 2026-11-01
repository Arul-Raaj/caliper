// The rule catalogue. Each rule names one way a layout breaks, why it
// happens, and three ways to fix it, the recommended one first.

export type Severity = "high" | "medium";

// One way to fix an issue. The first fix of every rule is the one Caliper
// recommends; the other two suit different designs.
export interface Fix {
  title: string; // a few words, shown on the option
  when: string; // one line: when to pick it, or what it costs
  css: string;
}

type Fixes = readonly [Fix, Fix, Fix];

export interface Rule {
  id: string;
  title: string;
  severity: Severity;
  why: string;
  fixes: Fixes;
  roles?: boolean; // text rules: recommend by what the element is
}

// What the element is, measured in the page (browser/detect.js roleFor).
export type Role = "button" | "number" | "form" | "nav" | "heading" | "paragraph" | "title" | "box";

export const ROLE_NAMES: Record<Role, string> = {
  button: "button label",
  number: "price, date or code",
  form: "form label or message",
  nav: "navigation item",
  heading: "heading",
  paragraph: "paragraph",
  title: "short title or name",
  box: "box",
};

const clamp2 = `.element {
  min-width: 0;
  white-space: normal;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
}`;
const wrap = `.element {
  min-width: 0;
  white-space: normal;
  overflow-wrap: anywhere;
}`;
const oneLine = `.element {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}`;

// The UX rules: how each kind of text should behave when it runs out of room.
const BY_ROLE: Partial<Record<Role, Fixes>> = {
  // Titles and names: two lines, then an ellipsis.
  title: [
    { title: "Clamp to two lines", when: "Wraps once, then ends with an ellipsis. Put the full text in a title attribute or tooltip.", css: clamp2 },
    { title: "Wrap fully", when: "When every word matters and the row can grow taller.", css: wrap },
    { title: "One line with an ellipsis", when: "For dense tables and lists with a fixed row height.", css: oneLine },
  ],
  // Button labels: one line when it fits, two balanced lines when it doesn't, never cut.
  button: [
    {
      title: "Size to the label, wrap only if it must",
      when: "One line whenever it fits, two balanced lines when even the full row is too narrow. Never truncated.",
      css: `.actions {
  display: flex;
  flex-wrap: wrap;
}
.button {
  width: max-content;
  max-width: 100%;
  text-wrap: balance;
}`,
    },
    {
      title: "Full width on small screens",
      when: "For the main action on a phone, like Pay or Continue.",
      css: `@media (max-width: 480px) {
  .button {
    width: 100%;
    text-wrap: balance;
  }
}`,
    },
    {
      title: "Move details out of the label",
      when: "When the label carries details (a name, a total) that read better beside the button.",
      css: `<!-- The detail sits above, the action stays short -->
<p class="payee">To Sharma Electricals</p>
<button class="button">Pay ₹1,24,500</button>`,
    },
  ],
  // Amounts, dates and codes: never break, never truncate. The layout moves instead.
  number: [
    {
      title: "Keep it whole, let the row wrap",
      when: "The amount stays on one line and its label moves instead.",
      css: `.amount {
  flex: none;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.row {
  display: flex;
  flex-wrap: wrap;
  column-gap: 8px;
}`,
    },
    {
      title: "Stack under its label on small screens",
      when: "For summaries and receipts on phones.",
      css: `@media (max-width: 480px) {
  .row {
    flex-direction: column;
    align-items: flex-start;
  }
}`,
    },
    {
      title: "Scale the type down a step",
      when: "Last resort for a big display number. Never below 14 px.",
      css: `.amount {
  font-size: clamp(14px, 5vw, 32px);
  white-space: nowrap;
}`,
    },
  ],
  // Paragraphs: reading text is never truncated.
  paragraph: [
    { title: "Wrap and break long words", when: "Reading text is never truncated; only words that don't fit get broken.", css: wrap },
    {
      title: "Hyphenate",
      when: "For running text in a known language. Needs a lang attribute on the page.",
      css: `.element {
  hyphens: auto;
  overflow-wrap: break-word;
}`,
    },
    {
      title: "Let the container shrink",
      when: "When a flex or grid parent holds the text wider than the screen.",
      css: `.container {
  min-width: 0;
}`,
    },
  ],
  heading: [
    {
      title: "Wrap, balance and break long words",
      when: "Headings wrap into even lines and are never truncated.",
      css: `.heading {
  min-width: 0;
  white-space: normal;
  overflow-wrap: anywhere;
  text-wrap: balance;
}`,
    },
    {
      title: "Scale with the screen",
      when: "For big display headings that are too large on phones.",
      css: `.heading {
  font-size: clamp(28px, 6vw, 56px);
}`,
    },
    {
      title: "Hyphenate",
      when: "For long words in a known language. Needs a lang attribute on the page.",
      css: `.heading {
  hyphens: auto;
}`,
    },
  ],
  nav: [
    {
      title: "Scroll sideways",
      when: "Every item stays whole and readable. Fade the edge to hint there is more.",
      css: `.nav {
  display: flex;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
}
.nav > * {
  flex: none;
  white-space: nowrap;
}`,
    },
    {
      title: "Wrap onto two rows",
      when: "For short lists of tabs or chips where scrolling would hide items.",
      css: `.nav {
  display: flex;
  flex-wrap: wrap;
}`,
    },
    {
      title: "Truncate long items",
      when: "For long, user-made names like folders or channels. Show the full name on hover.",
      css: `.nav > * {
  max-width: 12em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}`,
    },
  ],
  form: [
    { title: "Wrap the text", when: "Labels and error messages are always read in full.", css: wrap },
    {
      title: "Stack the label above the field",
      when: "For side-by-side forms on narrow screens.",
      css: `.field {
  display: flex;
  flex-direction: column;
  align-items: stretch;
}`,
    },
    {
      title: "Let the label column size to its text",
      when: "For two-column forms with long labels.",
      css: `.form {
  grid-template-columns: minmax(0, max-content) minmax(0, 1fr);
}`,
    },
  ],
};

export interface Recommendation {
  fixes: Fixes;
  confidence: "high" | "medium";
  basis: string; // one line: why this fix is first
}

// Pick the fixes for one finding. Text rules recommend by what the element
// is; the rest use the rule's own fixes.
export function recommend(rule: Rule, role: Role = "box"): Recommendation {
  const byRole = rule.roles ? BY_ROLE[role] : undefined;
  if (byRole) {
    const sure = role !== "title";
    return {
      fixes: byRole,
      confidence: sure ? "high" : "medium",
      basis: sure
        ? `Picked for a ${ROLE_NAMES[role]}.`
        : `Picked for a ${ROLE_NAMES[role]}, judged from its short text. Check it is one.`,
    };
  }
  return { fixes: rule.fixes, confidence: "medium", basis: "The usual fix for this problem. Check it suits the design." };
}

export const RULES = {
  "layout/page-overflow": {
    id: "layout/page-overflow",
    title: "The page scrolls sideways",
    severity: "high",
    why: "One element is wider than the screen, so the whole page gains a horizontal scrollbar. On phones this feels broken: the page wobbles left and right as you scroll.",
    fixes: [
      {
        title: "Let the element shrink",
        when: "Best for most cases: the element fits any screen and nothing is hidden.",
        css: `.element {
  max-width: 100%;
  min-width: 0;
  white-space: normal;
  overflow-wrap: anywhere;
}`,
      },
      {
        title: "Scroll inside the element",
        when: "For wide content that can't shrink, like tables, code and charts.",
        css: `.element-wrapper {
  max-width: 100%;
  overflow-x: auto;
}`,
      },
      {
        title: "Clip at the page edge",
        when: "Only for decoration that may be cut, like a background shape. Never for content.",
        css: `body {
  overflow-x: clip;
}`,
      },
    ],
  },
  "content/spill": {
    id: "content/spill",
    title: "Text spills out of its box",
    severity: "medium",
    roles: true,
    why: "The box has a fixed or minimum width, so longer text runs past its edge and over whatever sits next to it.",
    fixes: [
      {
        title: "Wrap inside the box",
        when: "Best for most cases: every word stays readable and the box grows taller.",
        css: `.element {
  min-width: 0;
  white-space: normal;
  overflow-wrap: anywhere;
}`,
      },
      {
        title: "Truncate with an ellipsis",
        when: "For one-line slots like table cells and tabs. Show the full text on hover or focus.",
        css: `.element {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}`,
      },
      {
        title: "Clamp to a few lines",
        when: "For card titles and previews where a fixed height matters.",
        css: `.element {
  white-space: normal;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
}`,
      },
    ],
  },
  "content/clip": {
    id: "content/clip",
    title: "Text is cut off with no sign it was cut",
    severity: "high",
    roles: true,
    why: "The box hides overflow but shows no ellipsis, so readers lose words without knowing anything is missing.",
    fixes: [
      {
        title: "Let it wrap and grow",
        when: "Best for most cases: nothing is lost.",
        css: `.element {
  overflow: visible;
  white-space: normal;
  overflow-wrap: anywhere;
}`,
      },
      {
        title: "Add an ellipsis",
        when: "For one-line slots. Readers can see that text was cut.",
        css: `.element {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}`,
      },
      {
        title: "Clamp to a few lines",
        when: "For multi-line text in a fixed-height card.",
        css: `.element {
  white-space: normal;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
}`,
      },
    ],
  },
  "content/long-word": {
    id: "content/long-word",
    title: "A long word or URL pushes past its box",
    severity: "medium",
    roles: true,
    why: "Browsers only wrap at spaces by default. A URL, an email address or a long compound word has none, so it sticks out.",
    fixes: [
      {
        title: "Break long words anywhere",
        when: "Best for most cases: only words that don't fit get broken.",
        css: `.element {
  white-space: normal;
  overflow-wrap: anywhere;
}`,
      },
      {
        title: "Hyphenate",
        when: "For running text in a known language. Needs a lang attribute on the page.",
        css: `.element {
  hyphens: auto;
  overflow-wrap: break-word;
}`,
      },
      {
        title: "Truncate with an ellipsis",
        when: "For one-line slots like file names and links in a table.",
        css: `.element {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}`,
      },
    ],
  },
  "layout/flex-min-size": {
    id: "layout/flex-min-size",
    title: "A flex item won't shrink below its content",
    severity: "medium",
    roles: true,
    why: "Flex items default to min-width: auto, which means they refuse to get narrower than their longest word or widest child. The row overflows instead.",
    fixes: [
      {
        title: "Let the item shrink",
        when: "Best for most cases: the row keeps its shape and the text wraps.",
        css: `.flex-item {
  min-width: 0;
  white-space: normal;
  overflow-wrap: anywhere;
}`,
      },
      {
        title: "Let the row wrap",
        when: "For rows of chips, tags or buttons that can move onto a second line.",
        css: `.flex-row {
  flex-wrap: wrap;
}`,
      },
      {
        title: "Truncate the item",
        when: "For one-line rows like nav bars and list items with a fixed height.",
        css: `.flex-item {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}`,
      },
    ],
  },
  "layout/grid-min-size": {
    id: "layout/grid-min-size",
    title: "A grid column blows out with long content",
    severity: "medium",
    why: "A 1fr track has a hidden minimum of its content's width, so one long item stretches the column and the grid overflows.",
    fixes: [
      {
        title: "Give tracks a minimum of zero",
        when: "Best for most cases: columns stay equal and the content wraps.",
        css: `.grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
.grid > * {
  overflow-wrap: anywhere;
}`,
      },
      {
        title: "Let the items shrink",
        when: "When you can't change the grid itself, such as a shared layout.",
        css: `.grid > * {
  min-width: 0;
  overflow-wrap: anywhere;
}`,
      },
      {
        title: "Fit as many columns as fit",
        when: "For card grids: columns drop to fewer on narrow screens.",
        css: `.grid {
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 240px), 1fr));
}`,
      },
    ],
  },
  "layout/fixed-size": {
    id: "layout/fixed-size",
    title: "A fixed height can't fit its content",
    severity: "high",
    why: "The box has a set height. When content grows (longer text, bigger zoom), it spills below the box or gets clipped.",
    fixes: [
      {
        title: "Use a minimum height",
        when: "Best for most cases: the box keeps its size and grows when it must.",
        css: `.element {
  height: auto;
  min-height: 120px; /* the old fixed value */
}`,
      },
      {
        title: "Scroll inside the box",
        when: "For panels that must keep their height, like a sidebar or log.",
        css: `.element {
  overflow-y: auto;
}`,
      },
      {
        title: "Clamp the text",
        when: "For cards in a row that must line up. Show the full text elsewhere.",
        css: `.element p {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  overflow: hidden;
}`,
      },
    ],
  },
  "media/missing": {
    id: "media/missing",
    title: "The layout jumps when an image fails to load",
    severity: "medium",
    why: "The image has no reserved space, so when it fails (or loads late) its box collapses and the content around it moves.",
    fixes: [
      {
        title: "Set width and height in the HTML",
        when: "Best for most cases: the browser reserves the exact space before loading.",
        css: `/* <img src="..." width="800" height="600" alt="..."> */
img {
  max-width: 100%;
  height: auto;
}`,
      },
      {
        title: "Reserve an aspect ratio",
        when: "When images vary but should share one shape, like a card grid.",
        css: `img {
  width: 100%;
  height: auto;
  aspect-ratio: 4 / 3;
  object-fit: cover;
}`,
      },
      {
        title: "Give the frame a placeholder",
        when: "When a failed image should still look intentional, not blank.",
        css: `.image-frame {
  aspect-ratio: 4 / 3;
  background: var(--placeholder);
}
.image-frame img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}`,
      },
    ],
  },
  "media/distortion": {
    id: "media/distortion",
    title: "An image is stretched or squashed",
    severity: "medium",
    why: "The box has a different shape from the image, and the default object-fit: fill bends the image to fit it.",
    fixes: [
      {
        title: "Crop to fill",
        when: "Best for most cases: photos and covers keep their shape.",
        css: `img {
  object-fit: cover;
}`,
      },
      {
        title: "Fit inside the box",
        when: "For logos, diagrams and screenshots that must not be cropped.",
        css: `img {
  object-fit: contain;
}`,
      },
      {
        title: "Use the image's own shape",
        when: "When the box doesn't need a set height.",
        css: `img {
  height: auto;
}`,
      },
    ],
  },
  "content/label-wrap": {
    id: "content/label-wrap",
    title: "A button label wraps when it would fit on one line",
    severity: "high",
    why: "The button is held narrow (a fixed width, or a row that won't wrap), so a label like \"Pay ₹1,24,500 to Sharma Electricals\" breaks mid-phrase even though the row has room. The action reads as two fragments.",
    fixes: BY_ROLE.button!,
    roles: true,
  },
  "content/label-truncated": {
    id: "content/label-truncated",
    title: "A button label is cut off",
    severity: "high",
    why: "The label ends in an ellipsis, so people can't read the action they're about to take. A button label should wrap to a second line before it is ever truncated.",
    fixes: BY_ROLE.button!,
    roles: true,
  },
  "layout/fixed-offscreen": {
    id: "layout/fixed-offscreen",
    title: "A fixed panel runs off a small screen",
    severity: "high",
    why: "A fixed dialog, banner or menu is taller than the screen and doesn't scroll, so its bottom (often the button that closes it) can't be reached. Phones and 200% zoom make it common.",
    fixes: [
      {
        title: "Cap the height and scroll",
        when: "Best for most cases: the whole panel stays reachable.",
        css: `.panel {
  max-height: 100dvh;
  overflow-y: auto;
  overscroll-behavior: contain;
}`,
      },
      {
        title: "Pin the actions, scroll the body",
        when: "For dialogs and sheets whose buttons must always be visible.",
        css: `.panel {
  display: flex;
  flex-direction: column;
  max-height: 100dvh;
}
.panel__body {
  min-height: 0;
  overflow-y: auto;
}`,
      },
      {
        title: "Go full screen on small screens",
        when: "For chat widgets and long forms on phones.",
        css: `@media (max-width: 480px), (max-height: 480px) {
  .panel {
    inset: 0;
    width: auto;
    height: auto;
    max-height: none;
    overflow-y: auto;
  }
}`,
      },
    ],
  },
  "input/min-tap": {
    id: "input/min-tap",
    title: "A tap target is too small",
    severity: "medium",
    why: "On a touch screen, a target under 24 px with another target close by is easy to miss (WCAG 2.2, 2.5.8). Short labels and icon buttons are the usual cause.",
    fixes: [
      {
        title: "Give it a minimum size",
        when: "Best for most cases: 44 px matches Apple's guidance; 24 px is the WCAG minimum.",
        css: `.button {
  min-width: 44px;
  min-height: 44px;
}`,
      },
      {
        title: "Grow the hit area, not the look",
        when: "For icons that must stay small visually.",
        css: `.icon-button {
  position: relative;
}
.icon-button::after {
  content: "";
  position: absolute;
  inset: -10px;
}`,
      },
      {
        title: "Space the targets apart",
        when: "When the size can't change: no other target within 24 px.",
        css: `.toolbar {
  display: flex;
  gap: 24px;
}`,
      },
    ],
  },
} as const satisfies Record<string, Rule>;

export type RuleId = keyof typeof RULES;
