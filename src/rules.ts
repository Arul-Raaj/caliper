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

export type Fixes = readonly [Fix, Fix, Fix];

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

// Pick the fixes for one finding. Fixes built from the finding's own
// measurements come first; then text rules recommend by what the element
// is; the rest use the rule's own fixes.
export function recommend(rule: Rule, role: Role = "box", measured?: Fixes): Recommendation {
  if (measured) return { fixes: measured, confidence: "high", basis: "Picked from what Caliper measured and tested on this element." };
  let byRole = rule.roles ? BY_ROLE[role] : undefined;
  // A row that won't fit can always wrap: keep that option whatever the item is.
  if (byRole && rule.id === "layout/flex-min-size" && !byRole.some((f) => /flex-wrap: wrap/.test(f.css))) byRole = [byRole[0], byRole[1], rule.fixes[1]];
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
  "scroll/bar-over-content": {
    id: "scroll/bar-over-content",
    title: "The scrollbar lands on the content",
    severity: "medium",
    why: "The scroller's edge sits inside its panel, or its controls run right up to that edge, so when the scrollbar appears it covers them or floats in the middle of the surface. It stays hidden until the content is long enough to scroll.",
    fixes: [
      {
        title: "Move the padding inside the scroller",
        when: "Best for most cases: the bar sits at the panel's edge and the content keeps clear of it.",
        css: `.panel {
  padding-right: 0;
}
.scroller {
  padding-right: 16px;
}`,
      },
      {
        title: "Reserve the scrollbar's room",
        when: "When the layout must not shift as content grows long enough to scroll.",
        css: `.scroller {
  scrollbar-gutter: stable;
  padding-right: 4px;
}`,
      },
      {
        title: "Use a thin bar",
        when: "For tight side panels where a full-width bar takes too much room.",
        css: `.scroller {
  scrollbar-width: thin;
  padding-right: 12px;
}`,
      },
    ],
  },
  "layout/control-past-container": {
    id: "layout/control-past-container",
    title: "A control runs past the edge of its container",
    severity: "high",
    why: "The row holding the control is wider than the box drawn around it, so the button breaks out of the composer, card or toolbar it belongs to. Usually something beside it won't shrink.",
    fixes: [
      {
        title: "Let the row's other items shrink",
        when: "Best for most cases: the control stays in place and its neighbours give way.",
        css: `.row {
  display: flex;
  min-width: 0;
}
.row > .grow {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row > .control {
  flex: none;
}`,
      },
      {
        title: "Let the row wrap",
        when: "When every item must stay whole and the box can grow taller.",
        css: `.row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}`,
      },
      {
        title: "Give the control its own column",
        when: "For composers and toolbars with one fixed action.",
        css: `.row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
}`,
      },
    ],
  },
  "hover/fill-hugs-content": {
    id: "hover/fill-hugs-content",
    title: "A hover fill sits tight against its content",
    severity: "medium",
    why: "The row has no padding of its own, so its hover fill stops exactly at the text, or its square corners sit inside a rounded surface. At rest nothing shows it; on hover the row looks cut out.",
    fixes: [
      {
        title: "Pad the row",
        when: "Best for most cases: the fill gets room around the content.",
        css: `.row {
  padding: 8px 12px;
  border-radius: 8px;
}`,
      },
      {
        title: "Let the fill reach past the content",
        when: "When the text must stay aligned with the headings around it.",
        css: `.row {
  margin-inline: -12px;
  padding-inline: 12px;
  border-radius: 8px;
}`,
      },
      {
        title: "Run the fill edge to edge",
        when: "For lists in a rounded card: the card's corners clip the fill.",
        css: `.card {
  overflow: hidden;
}
.row {
  margin-inline: 0;
  border-radius: 0;
  padding: 8px 16px;
}`,
      },
    ],
  },
  "overlay/offscreen-x": {
    id: "overlay/offscreen-x",
    title: "A tooltip or popover runs off the side of the screen",
    severity: "high",
    why: "It is placed against its trigger with no check for the screen edge, so a trigger near the side pushes it out of view. Narrow side panels and phones make it common.",
    fixes: [
      {
        title: "Keep it inside the screen",
        when: "Best for most cases: it flips and shifts to stay in view.",
        css: `/* With Floating UI, also used by Radix */
computePosition(trigger, tooltip, {
  middleware: [flip(), shift({ padding: 8 })],
});`,
      },
      {
        title: "Anchor it to the nearer edge",
        when: "When a trigger always sits at the same side of the screen.",
        css: `.tooltip {
  left: auto;
  right: 0;
  transform: none;
}`,
      },
      {
        title: "Cap its width",
        when: "For long text in narrow panels. Use it with either fix above.",
        css: `.tooltip {
  max-width: calc(100vw - 16px);
  overflow-wrap: anywhere;
}`,
      },
    ],
  },
  "focus/no-visible-ring": {
    id: "focus/no-visible-ring",
    title: "Keyboard focus doesn't show",
    severity: "high",
    why: "Nothing changes when Tab reaches this control, so anyone using a keyboard can't tell where they are (WCAG 2.2, 2.4.7). A reset that sets outline: none is the usual cause.",
    fixes: [
      {
        title: "Add a focus ring",
        when: "Best for most cases: it shows for keyboard users, not on mouse clicks.",
        css: `.control:focus-visible {
  outline: 2px solid var(--focus, currentColor);
  outline-offset: 2px;
}`,
      },
      {
        title: "Ring it with a shadow",
        when: "When the ring must follow rounded corners on older browsers.",
        css: `.control:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--surface), 0 0 0 4px var(--focus);
}`,
      },
      {
        title: "Ring the wrapper",
        when: "For a control that sits inside a composer or field box.",
        css: `.field:has(:focus-visible) {
  border-color: var(--focus);
  box-shadow: 0 0 0 1px var(--focus);
}`,
      },
    ],
  },
  "text/word-broken": {
    id: "text/word-broken",
    title: "A word breaks across two lines",
    severity: "medium",
    why: "overflow-wrap: anywhere or word-break lets the box shrink below its longest word, so a short word splits in the middle, as in \"Requir / ed\". That rule is for long URLs and codes, not ordinary words.",
    fixes: [
      {
        title: "Break only what can't fit",
        when: "Best for most cases: long URLs still wrap, and the box won't shrink below an ordinary word.",
        css: `.element {
  word-break: normal;
  overflow-wrap: break-word;
}`,
      },
      {
        title: "Keep the column as wide as its label",
        when: "For table headers and short labels.",
        css: `th {
  white-space: nowrap;
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
    ],
  },
  "media/invisible-on-background": {
    id: "media/invisible-on-background",
    title: "An image or icon vanishes into its background",
    severity: "high",
    why: "It has almost no contrast with what is behind it, such as a white logo on white or a white icon on a pale fill. It was often drawn for the other theme, so it looks fine in one and disappears in the other.",
    fixes: [
      {
        title: "Use a version made for this background",
        when: "Best for logos: serve a light and a dark file.",
        css: `<picture>
  <source srcset="logo-light.svg" media="(prefers-color-scheme: dark)">
  <img src="logo-dark.svg" alt="Company name">
</picture>`,
      },
      {
        title: "Draw icons in currentColor",
        when: "Best for icons: they follow the text colour in every theme and state.",
        css: `.icon {
  color: var(--text);
  fill: currentColor;
}`,
      },
      {
        title: "Put it on a plate",
        when: "When the image can't change, such as a customer's logo.",
        css: `.logo {
  padding: 8px;
  background: var(--plate);
  border-radius: 8px;
}`,
      },
    ],
  },
  "layout/fixed-width": {
    id: "layout/fixed-width",
    title: "A fixed width won't fit a small screen",
    severity: "medium",
    why: "The element has a set width and won't shrink (flex: none or flex-shrink: 0), so on a narrow screen its row runs past the edge instead of giving way.",
    fixes: [
      {
        title: "Cap the width",
        when: "Best for most cases: it keeps its width where there is room and shrinks where there isn't.",
        css: `.element {
  flex: 0 1 280px; /* the old width, now allowed to shrink */
  min-width: 0;
}`,
      },
      {
        title: "Stack it on small screens",
        when: "For sidebars and filters beside a main column.",
        css: `@media (max-width: 640px) {
  .row {
    flex-direction: column;
  }
  .element {
    width: auto;
  }
}`,
      },
      {
        title: "Use a fluid width",
        when: "When it should follow the screen's width.",
        css: `.element {
  width: min(280px, 100%);
}`,
      },
    ],
  },
  "layout/stretched-shape": {
    id: "layout/stretched-shape",
    title: "A row stretches a shape out of its proportions",
    severity: "medium",
    why: "Flex and grid rows stretch their items to the row's height by default (align-items: stretch). A round avatar or a square icon tile with no set height grows with its neighbour, so the circle turns into a pill.",
    fixes: [
      {
        title: "Stop the row stretching it",
        when: "Best for most cases: it keeps its own size, top-aligned.",
        css: `.shape {
  align-self: flex-start;
}`,
      },
      {
        title: "Fix its shape",
        when: "When it must stay square whatever happens around it.",
        css: `.shape {
  aspect-ratio: 1;
  height: auto;
  align-self: flex-start;
}`,
      },
      {
        title: "Centre the row's items",
        when: "When everything in the row should line up on its middle.",
        css: `.row {
  align-items: center;
}`,
      },
    ],
  },
  "layout/sticky-no-room": {
    id: "layout/sticky-no-room",
    title: "A sticky element has no room to stick",
    severity: "medium",
    why: "A sticky element only moves inside its parent. A grid or flex row stretches it to the parent's full height, so there is nowhere to move: the table of contents or buy box just scrolls away.",
    fixes: [
      {
        title: "Align it to the start",
        when: "Best for most cases: it keeps its own height and sticks.",
        css: `.sticky {
  position: sticky;
  top: 16px;
  align-self: start;
}`,
      },
      {
        title: "Align the whole row to the start",
        when: "When no item in the row needs to stretch.",
        css: `.layout {
  align-items: start;
}`,
      },
      {
        title: "Wrap the content and stick the wrapper",
        when: "When the column itself must stretch, for a background or a border.",
        css: `.sidebar > .sticky-inner {
  position: sticky;
  top: 16px;
}`,
      },
    ],
  },
  "layout/pinned-cover": {
    id: "layout/pinned-cover",
    title: "Pinned bars cover most of a short screen",
    severity: "high",
    why: "Fixed and sticky bars keep their height whatever the screen's. On a phone held sideways or at 200% zoom they cover so much that the page shows through a narrow slot (WCAG 1.4.10).",
    fixes: [
      {
        title: "Pin bars only on tall screens",
        when: "Best for most cases: the bars scroll away with the page when height is short.",
        css: `.bar {
  position: static;
}
@media (min-height: 600px) {
  .bar {
    position: sticky;
    top: 0;
  }
}`,
      },
      {
        title: "Hide the bar while scrolling down",
        when: "For a header that must stay close: it slides away and comes back on scroll up.",
        css: `.bar {
  position: sticky;
  top: 0;
  transition: translate 250ms;
}
.bar[data-hidden] {
  translate: 0 -100%;
}`,
      },
      {
        title: "Make the bars shorter",
        when: "When the bars must stay pinned: trim padding and secondary rows on short screens.",
        css: `@media (max-height: 500px) {
  .bar {
    padding-block: 4px;
  }
  .bar .secondary {
    display: none;
  }
}`,
      },
    ],
  },
  "layout/covered-by-pinned": {
    id: "layout/covered-by-pinned",
    title: "A pinned bar covers content",
    severity: "high",
    why: "A fixed or sticky bar is laid over the page, and nothing makes room for it. The content under it sits at the top (or the end) of the page, so scrolling never brings it out: a heading, a link or the first line of text is simply never seen.",
    fixes: [
      {
        title: "Make room for the bar",
        when: "Best for most cases: the page starts below the bar.",
        css: `main {
  padding-top: 64px; /* the bar's height */
}`,
      },
      {
        title: "Give the variable a fallback",
        when: "When the room comes from a variable a script sets.",
        css: `main {
  padding-top: var(--header-height, 64px);
}`,
      },
      {
        title: "Use sticky, not fixed",
        when: "When the bar can take its own place in the page.",
        css: `.bar {
  position: sticky;
  top: 0;
}`,
      },
    ],
  },
  "layout/text-touches-control": {
    id: "layout/text-touches-control",
    title: "Text runs into the control beside it",
    severity: "medium",
    why: "The row sets no gap between a piece of text and the button, toggle or price next to it. Short text looks fine; a longer name or a narrower screen pushes the text right up against it, or under it.",
    fixes: [
      {
        title: "Set a gap on the row",
        when: "Best for most cases: the text wraps before it reaches its neighbour.",
        css: `.row {
  display: flex;
  column-gap: 16px;
}
.row > .text {
  min-width: 0;
}`,
      },
      {
        title: "Keep room for a control laid over it",
        when: "For a menu or close button placed in a card's corner.",
        css: `.card__title {
  padding-inline-end: 40px; /* the button's width plus 8 px */
}`,
      },
      {
        title: "Truncate the text",
        when: "For one-line rows like list items and settings.",
        css: `.row > .text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}`,
      },
    ],
  },
  "layout/uneven-row-spacing": {
    id: "layout/uneven-row-spacing",
    title: "A wrapped row spaces its lines unevenly",
    severity: "medium",
    why: "justify-content: space-between spreads each line on its own. A full line looks right, but a short last line pins its two items to the far edges, with a wide hole between them.",
    fixes: [
      {
        title: "Space with gap",
        when: "Best for most cases: every line uses the same spacing.",
        css: `.row {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-start;
  gap: 16px;
}`,
      },
      {
        title: "Use a grid",
        when: "For cards that should line up in columns.",
        css: `.row {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 200px), 1fr));
  gap: 16px;
}`,
      },
      {
        title: "Keep space-between for one line only",
        when: "For a header that spreads its two ends on wide screens.",
        css: `.row {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px 16px;
}`,
      },
    ],
  },
  "layout/auto-fit-stretch": {
    id: "layout/auto-fit-stretch",
    title: "A few items stretch across an auto-fit grid",
    severity: "medium",
    why: "repeat(auto-fit, …) collapses the columns it has no items for and hands their room to the items there are. With one search result or two team members, each card stretches across the row.",
    fixes: [
      {
        title: "Use auto-fill",
        when: "Best for most cases: empty columns keep their room and the cards keep their width.",
        css: `.grid {
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
}`,
      },
      {
        title: "Cap the item width",
        when: "When auto-fit should still centre a short row.",
        css: `.grid {
  grid-template-columns: repeat(auto-fit, minmax(240px, 320px));
  justify-content: center;
}`,
      },
      {
        title: "Use a flex row with a set width",
        when: "For a handful of cards that should keep one size.",
        css: `.grid {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
}
.grid > * {
  flex: 0 1 280px;
}`,
      },
    ],
  },
  "media/wider-than-box": {
    id: "media/wider-than-box",
    title: "An image is wider than its box",
    severity: "medium",
    why: "An image with no max-width is as wide as its file. In a narrower column it runs past the edge, or a card with overflow: hidden crops it.",
    fixes: [
      {
        title: "Cap images at their box",
        when: "Best for most cases: images scale down and keep their shape.",
        css: `img,
video {
  max-width: 100%;
  height: auto;
}`,
      },
      {
        title: "Fill the box and crop",
        when: "For thumbnails and covers with a set shape.",
        css: `img {
  width: 100%;
  aspect-ratio: 16 / 9;
  object-fit: cover;
}`,
      },
      {
        title: "Scroll inside a wrapper",
        when: "For diagrams and screenshots people need at full size.",
        css: `.figure {
  max-width: 100%;
  overflow-x: auto;
}`,
      },
    ],
  },
  "media/bg-tiles": {
    id: "media/bg-tiles",
    title: "A background image repeats by accident",
    severity: "medium",
    why: "background-repeat defaults to repeat. A photo or a corner mark that doesn't cover its box shows a second copy beside or below it, often only on wide or tall screens.",
    fixes: [
      {
        title: "Cover the box, once",
        when: "Best for photos: one copy that fills the box.",
        css: `.element {
  background-repeat: no-repeat;
  background-size: cover;
  background-position: center;
}`,
      },
      {
        title: "Turn off the repeat",
        when: "For a mark or an illustration placed in a corner.",
        css: `.element {
  background-repeat: no-repeat;
}`,
      },
      {
        title: "Fill with a colour behind it",
        when: "When the image keeps its size and the rest of the box shows a colour.",
        css: `.element {
  background: var(--surface) url("…") no-repeat center / contain;
}`,
      },
    ],
  },
  "media/edge-lost": {
    id: "media/edge-lost",
    title: "An image's edge disappears into the background",
    severity: "medium",
    why: "The image's outer pixels are the same colour as what is around it, such as an avatar on a white background on a white page. Its content shows, but its shape doesn't.",
    fixes: [
      {
        title: "Draw an inner ring",
        when: "Best for most cases: a faint ring that follows the corners in either theme.",
        css: `.avatar {
  outline: 1px solid rgb(0 0 0 / 0.1);
  outline-offset: -1px;
}`,
      },
      {
        title: "Ring it with a layer",
        when: "When the ring must sit over the image, like a wrapper with an inset shadow.",
        css: `.avatar-wrap {
  position: relative;
}
.avatar-wrap::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.1);
}`,
      },
      {
        title: "Put it on a plate",
        when: "For logos and app icons: a tinted tile behind them.",
        css: `.logo {
  padding: 8px;
  background: var(--plate);
  border-radius: 12px;
}`,
      },
    ],
  },
  "content/unreadable-without-image": {
    id: "content/unreadable-without-image",
    title: "Text over an image can't be read when the image fails",
    severity: "high",
    why: "Light text is placed on a photo and relies on it for contrast. When the image is slow, blocked or broken, the text sits on the plain background behind it, often white on white.",
    fixes: [
      {
        title: "Give the image a background colour",
        when: "Best for most cases: a dark colour shows until the image arrives, and if it never does.",
        css: `.hero img,
.hero {
  background-color: #1f2328; /* close to the image's own tone */
}`,
      },
      {
        title: "Lay a scrim under the text",
        when: "For captions on photos: readable on any image, and without one.",
        css: `.caption {
  background: linear-gradient(to top, rgb(0 0 0 / 0.7), transparent);
}`,
      },
      {
        title: "Shadow the text",
        when: "For short headings over busy photos.",
        css: `.overlay-text {
  text-shadow: 0 1px 3px rgb(0 0 0 / 0.6);
}`,
      },
    ],
  },
  "input/short-button": {
    id: "input/short-button",
    title: "A button with a short label is too narrow",
    severity: "medium",
    why: "The button is only as wide as its label. With \"OK\", \"Go\" or a short translation it shrinks to a small chip that is hard to hit and doesn't read as a button.",
    fixes: [
      {
        title: "Give buttons a minimum width",
        when: "Best for most cases: short labels keep a button's shape.",
        css: `.button {
  min-width: 80px;
  padding-inline: 16px;
}`,
      },
      {
        title: "Make the action buttons equal",
        when: "For a pair like Cancel and OK in a dialog.",
        css: `.actions {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  gap: 8px;
}`,
      },
      {
        title: "Use a fuller label",
        when: "When the label can say what happens, like \"Save changes\".",
        css: `<button class="button">Save changes</button>`,
      },
    ],
  },
  "input/focus-zoom": {
    id: "input/focus-zoom",
    title: "A text field zooms the page on iPhone",
    severity: "medium",
    why: "iOS Safari zooms into any text field whose font is under 16 px when it takes focus, and leaves the page zoomed in after. People have to pinch back out before they can carry on.",
    fixes: [
      {
        title: "Use 16 px or more in fields",
        when: "Best for most cases: no zoom, and easier to read.",
        css: `input,
select,
textarea {
  font-size: max(16px, 1rem);
}`,
      },
      {
        title: "Only on touch screens",
        when: "When the desktop design needs smaller fields.",
        css: `@media (pointer: coarse) {
  input,
  select,
  textarea {
    font-size: 16px;
  }
}`,
      },
      {
        title: "Scale the field, not the text",
        when: "When the field must look smaller: draw it at 16 px and scale it down.",
        css: `.compact-input {
  font-size: 16px;
  transform: scale(0.875);
  transform-origin: left center;
}`,
      },
    ],
  },
  "scroll/empty-bar": {
    id: "scroll/empty-bar",
    title: "A scrollbar shows with nothing to scroll",
    severity: "medium",
    why: "overflow: scroll draws a scrollbar whether the content needs one or not. On Windows, Linux and a Mac with a mouse it shows as an empty gutter.",
    fixes: [
      {
        title: "Scroll only when needed",
        when: "Best for most cases: the bar appears once the content is long enough.",
        css: `.element {
  overflow-y: auto;
}`,
      },
      {
        title: "Keep the room without the bar",
        when: "When the layout must not shift once the bar appears.",
        css: `.element {
  overflow-y: auto;
  scrollbar-gutter: stable;
}`,
      },
      {
        title: "Use a thin bar",
        when: "For tight panels that always scroll.",
        css: `.element {
  overflow-y: auto;
  scrollbar-width: thin;
}`,
      },
    ],
  },
  "scroll/gutter-shift": {
    id: "scroll/gutter-shift",
    title: "Content jumps sideways when a scrollbar appears",
    severity: "medium",
    why: "overflow: auto takes room for the scrollbar only once the content is long enough to scroll. On screens with classic scrollbars, everything inside then moves sideways by the bar's width.",
    fixes: [
      {
        title: "Reserve the scrollbar's room",
        when: "Best for most cases: the room is kept whether the bar shows or not.",
        css: `.scroller {
  overflow-y: auto;
  scrollbar-gutter: stable;
}`,
      },
      {
        title: "Use a thin bar",
        when: "When a full-width gutter is too much for a narrow panel.",
        css: `.scroller {
  overflow-y: auto;
  scrollbar-gutter: stable;
  scrollbar-width: thin;
}`,
      },
      {
        title: "Always scroll",
        when: "Only for panels that almost always overflow.",
        css: `.scroller {
  overflow-y: scroll;
}`,
      },
    ],
  },
  "scroll/chains-to-page": {
    id: "scroll/chains-to-page",
    title: "Scrolling past the end of a panel scrolls the page behind it",
    severity: "medium",
    why: "A dialog, drawer or chat panel that scrolls passes the scroll on to the page once it reaches its end. The page behind the overlay moves, and people lose their place.",
    fixes: [
      {
        title: "Contain the scroll",
        when: "Best for most cases: the panel keeps its scrolling to itself.",
        css: `.panel__body {
  overscroll-behavior: contain;
}`,
      },
      {
        title: "Lock the page while it is open",
        when: "For modal dialogs and full-height drawers.",
        css: `body:has(dialog[open]) {
  overflow: hidden;
}`,
      },
      {
        title: "Contain it on both axes",
        when: "For panels that scroll both ways, like a chat with wide code blocks.",
        css: `.panel__body {
  overscroll-behavior: contain;
  overflow: auto;
}`,
      },
    ],
  },
  "hover/sticks-on-touch": {
    id: "hover/sticks-on-touch",
    title: "A hover style sticks after a tap",
    severity: "medium",
    why: "Touch screens apply :hover on tap and keep it until something else is tapped. A card stays lifted, a row stays filled, or actions meant for hover appear by accident.",
    fixes: [
      {
        title: "Hover only where there is a mouse",
        when: "Best for most cases: touch screens never see the hover style.",
        css: `@media (hover: hover) {
  .card:hover {
    transform: translateY(-4px);
  }
}`,
      },
      {
        title: "Show hover-only actions on touch",
        when: "For actions that appear on hover: always show them when there is no hover.",
        css: `@media (hover: none) {
  .tile .actions {
    opacity: 1;
  }
}`,
      },
      {
        title: "Style the press instead",
        when: "For feedback on tap: it shows while the finger is down and goes away.",
        css: `.card:active {
  transform: scale(0.98);
}`,
      },
    ],
  },
  "css/var-unresolved": {
    id: "css/var-unresolved",
    title: "A CSS variable has no value and no fallback",
    severity: "high",
    why: "var(--name) with nothing set and no fallback makes the browser drop the whole declaration. A width, a padding or a colour silently falls back to its default, often only when a script that sets the variable fails.",
    fixes: [
      {
        title: "Add a fallback",
        when: "Best for most cases: the layout holds even when the variable is missing.",
        css: `.element {
  max-width: calc(100% - var(--actions-width, 120px));
}`,
      },
      {
        title: "Define it at the root",
        when: "When the variable is a design token every page needs.",
        css: `:root {
  --actions-width: 120px;
}`,
      },
      {
        title: "Register it with an initial value",
        when: "For variables a script updates: they always have a value.",
        css: `@property --actions-width {
  syntax: "<length>";
  inherits: true;
  initial-value: 120px;
}`,
      },
    ],
  },
  "css/dropped-rule": {
    id: "css/dropped-rule",
    title: "A CSS rule is dropped because of one vendor selector",
    severity: "medium",
    why: "A selector list is all or nothing. Grouping ::-webkit-input-placeholder with ::-moz-placeholder means every browser meets one selector it doesn't know, and drops the whole rule.",
    fixes: [
      {
        title: "Split the rule",
        when: "Best for most cases: each browser reads the rule meant for it.",
        css: `input::-webkit-input-placeholder {
  color: var(--muted);
}
input::-moz-placeholder {
  color: var(--muted);
}`,
      },
      {
        title: "Use the standard selector",
        when: "When every browser you support knows it.",
        css: `input::placeholder {
  color: var(--muted);
}`,
      },
      {
        title: "Wrap the list in :is()",
        when: "For pseudo-classes: :is() skips the parts a browser can't read. Pseudo-elements can't go inside it.",
        css: `:is(:-webkit-autofill, :autofill) {
  box-shadow: 0 0 0 40px var(--surface) inset;
}`,
      },
    ],
  },
} as const satisfies Record<string, Rule>;

export type RuleId = keyof typeof RULES;
