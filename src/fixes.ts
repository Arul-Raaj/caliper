// Fixes built from what was measured, for findings where the rule's usual
// fixes would be wrong: a row that needs to wrap, a grid with fixed columns,
// an image the row stretches, a bar of a known height.

import type { Fix, Fixes } from "./rules.js";
import type { RawFinding } from "./run.js";

const wrapRow: Fix = {
  title: "Let the row wrap",
  when: "Best here: the items keep their size and move onto a second line.",
  css: `.flex-row {
  flex-wrap: wrap;
  gap: 8px;
}`,
};

export function fixesFor(raw: RawFinding): Fixes | undefined {
  const d = raw.details;
  switch (raw.kind) {
    case "flex-shrink":
      if (!d.wraps) return undefined;
      return [
        wrapRow,
        {
          title: "Scroll the row sideways",
          when: "For tabs, chips and menus that must stay on one line.",
          css: `.flex-row {
  overflow-x: auto;
  overscroll-behavior-x: contain;
}
.flex-row > * {
  flex: none;
}`,
        },
        {
          title: "Let the items shrink",
          when: "When the labels can wrap inside their items.",
          css: `.flex-row > * {
  min-width: 0;
  white-space: normal;
  overflow-wrap: anywhere;
}`,
        },
      ];
    case "flex-column":
      return [
        {
          title: "Let the item shrink",
          when: "Best for most cases: the column keeps its height and the list inside scrolls.",
          css: `.column > .item {
  min-height: 0;
}`,
        },
        {
          title: "Scroll the item itself",
          when: "When the item is the part that should scroll.",
          css: `.column > .item {
  min-height: 0;
  overflow-y: auto;
}`,
        },
        {
          title: "Size it with a grid",
          when: "For panels with a header, a body and a footer.",
          css: `.column {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
}`,
        },
      ];
    case "grid-blowout": {
      const tracks = String(d.fixed).split(" ").filter(Boolean);
      if (Number(d.fixedSum)) {
        const room = Math.ceil((Number(d.fixedSum) + 240) / 10) * 10;
        return [
          {
            title: "Stack the columns on small screens",
            when: "Best for sidebars and multi-column layouts: one column below the width the fixed columns need.",
            css: `@media (max-width: ${room}px) {
  .grid {
    grid-template-columns: minmax(0, 1fr);
  }
}`,
          },
          {
            title: "Let the fixed columns shrink",
            when: "When the columns should stay side by side, only narrower.",
            css: `.grid {
  grid-template-columns: ${tracks.map((t) => (t === "flex" ? "minmax(0, 1fr)" : `minmax(0, ${t})`)).join(" ")};
}`,
          },
          {
            title: "Fit as many columns as fit",
            when: "For card grids: columns drop to fewer on narrow screens.",
            css: `.grid {
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 240px), 1fr));
}`,
          },
        ];
      }
      if (!tracks.length) return undefined;
      return [
        {
          title: "Give tracks a minimum of zero",
          when: "Best for most cases: the columns keep their share and the content wraps.",
          css: `.grid {
  grid-template-columns: ${tracks.length > 1 ? `repeat(${tracks.length}, minmax(0, 1fr))` : "minmax(0, 1fr)"};
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
      ];
    }
    case "img-distorted":
      if (d.background) {
        return [
          { title: "Cover the box", when: "Best for photos: the image fills the box and keeps its shape.", css: `.element {\n  background-size: cover;\n  background-position: center;\n}` },
          { title: "Fit inside the box", when: "For logos and illustrations that must not be cropped.", css: `.element {\n  background-size: contain;\n  background-repeat: no-repeat;\n  background-position: center;\n}` },
          { title: "Set one length only", when: "When the image should be a set width: the height follows its shape.", css: `.element {\n  background-size: 100% auto;\n}` },
        ];
      }
      if (!d.stretched) return undefined;
      return [
        { title: "Stop the row stretching it", when: "Best here: the image keeps its own height in the row.", css: `img {\n  align-self: flex-start;\n}` },
        { title: "Centre the row's items", when: "When everything in the row should line up on its middle.", css: `.row {\n  align-items: center;\n}` },
        { title: "Crop to fill", when: "When the image should match the row's height.", css: `img {\n  object-fit: cover;\n}` },
      ];
    case "page-overflow":
      if (d.media) {
        return [
          { title: "Cap it at its box", when: "Best for images and video: they scale down and keep their shape.", css: `img,\nvideo {\n  max-width: 100%;\n  height: auto;\n}` },
          { title: "Scroll inside a wrapper", when: "For wide diagrams and screenshots people need at full size.", css: `.figure {\n  max-width: 100%;\n  overflow-x: auto;\n}` },
          { title: "Clip at the page edge", when: "Only for decoration that may be cut. Never for content.", css: `body {\n  overflow-x: clip;\n}` },
        ];
      }
      if (!d.width || !d.fits) return undefined;
      return [
        { title: "Cap the width at the screen", when: "Best here: the element keeps its width where it fits and shrinks where it doesn't.", css: `.element {\n  width: ${d.width};\n  max-width: 100%;\n}` },
        { title: "Use a fluid width", when: "When the element should always follow the screen.", css: `.element {\n  width: min(${d.width}, 100%);\n}` },
        { title: "Scroll inside the element", when: "For wide content that can't shrink, like tables, code and charts.", css: `.element-wrapper {\n  max-width: 100%;\n  overflow-x: auto;\n}` },
      ];
    case "covered-by-pinned": {
      const h = Number(d.height);
      return d.side === "top"
        ? [
            { title: "Make room for the bar", when: "Best for most cases: the page starts below the bar.", css: `main {\n  padding-top: ${h}px; /* the bar's height */\n}\nhtml {\n  scroll-padding-top: ${h}px;\n}` },
            { title: "Give the variable a fallback", when: "When the room comes from a variable a script sets, such as the bar's height.", css: `main {\n  padding-top: var(--header-height, ${h}px);\n}` },
            { title: "Use sticky, not fixed", when: "When the bar can take its own place at the top of the page.", css: `.bar {\n  position: sticky;\n  top: 0;\n}` },
          ]
        : [
            { title: "Make room for the bar", when: "Best for most cases: the page ends above the bar.", css: `body {\n  padding-bottom: ${h}px; /* the bar's height */\n}` },
            { title: "Give the variable a fallback", when: "When the room comes from a variable a script sets, such as the bar's height.", css: `body {\n  padding-bottom: var(--bar-height, ${h}px);\n}` },
            { title: "Use sticky, not fixed", when: "When the bar can sit at the end of the page in its own place.", css: `.bar {\n  position: sticky;\n  bottom: 0;\n}` },
          ];
    }
    default:
      return undefined;
  }
}
