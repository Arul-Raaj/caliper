# Developing Caliper

Notes for working on Caliper itself. The public README (shipped to npm) is `README.md`.

## What it does

Each run loads the page in 9 scenarios, 3 at a time, plus one per `--width`:

| Scenario | What changes |
| --- | --- |
| As is, 1280 px | Nothing. Anything found here is already broken |
| Text 3x longer | Every short piece of text is tripled (names, titles, labels) |
| 63-letter word added | A long word with no spaces is added to short text, like a URL or a German noun |
| Images fail to load | Every image request is blocked |
| 320 px phone | A small phone screen with touch |
| 200% browser zoom | Exactly what a 1280 px window shows at 200% zoom |
| WCAG text spacing | Line height 1.5, paragraph spacing 2x, letter spacing 0.12em, word spacing 0.16em (WCAG 1.4.12) |
| 768 px tablet | The width where navs and grids fall between breakpoints |
| Dark mode | `prefers-color-scheme: dark`, for logos and icons drawn for one theme |
| `--width <px>` | A desktop window that wide with classic scrollbars, for side panels |

In each one it measures every element and checks 20 rules:

| Rule | What it catches |
| --- | --- |
| `layout/page-overflow` | The page scrolls sideways |
| `content/spill` | Text spills out of its box |
| `content/clip` | Text is cut off with no ellipsis |
| `content/long-word` | A long word or URL pushes past its box |
| `layout/flex-min-size` | A flex item won't shrink below its content |
| `layout/grid-min-size` | A grid column blows out with long content |
| `layout/fixed-size` | A fixed height can't fit its content |
| `media/missing` | The layout jumps when an image fails to load |
| `media/distortion` | An image is stretched or squashed |
| `input/min-tap` | A tap target under 24 px with another target too close (WCAG 2.5.8) |
| `content/label-wrap` | A button label wraps when one line would have fit in the row |
| `content/label-truncated` | A button label is cut off with an ellipsis |
| `layout/fixed-offscreen` | A fixed panel runs off a small screen and can't scroll |
| `scroll/bar-over-content` | A scroller is inset from its panel, or its controls end within 12 px of the bar |
| `layout/control-past-container` | A control passes the edge of its nearest bordered or filled ancestor |
| `hover/fill-hugs-content` | A hover fill has 0 px around its content, or square corners floating in a rounded surface |
| `overlay/offscreen-x` | An open tooltip or popover runs past the left or right of the screen |
| `focus/no-visible-ring` | Tab reaches a control and nothing about it changes (WCAG 2.4.7) |
| `text/word-broken` | An ordinary word splits across two lines, like "Requir / ed" |
| `media/invisible-on-background` | An image or icon has almost no contrast with what is behind it |

Copies of the same component (list items, cards) share one card in the report, with the other copies listed under it.

Each finding separates what was measured from why. A cause is marked tested only when Caliper changed the suspected property in the page and the problem went away: nowrap text is allowed to wrap, long words to break, clipped text to show, fixed panels get a max-height, buttons are sized to their label, flex and grid try `min-width: 0`, fixed heights are released. Measurements use the real text and in-flow children, never `scrollWidth` alone, which also counts invisible hit areas and positioned layers. The gap on a card is the text past the edge, so padding can't skew it. Mock-ups (`inert`, `pointer-events: none`, `role=img`) are skipped, and so is anything nobody can see: a hidden parent, a closed accordion or `details`, a tap target cropped out of its box. Every temporary style change is restored exactly, priority included.

A page that can scroll sideways always gets one card per scenario, even when the culprit has a finding of its own, and even when the culprit has no element (a pseudo-element). The element reaching furthest leads the card. `overflow-x: hidden` or `clip` on `html` or `body` stops the page scrolling, so nothing is reported.

A row of same-size items past a clipping parent is treated as a carousel, but only when `min-width: 0` can't fix it: a row that content pushes wider is a real break. Images are matched to the baseline by source, and "the layout jumps" is reported only when the box around the image, or what follows it, really moved.

Each finding also has a role (`button`, `number`, `form`, `nav`, `heading`, `paragraph`, `title`, `box`), judged from the original text before any stress. Text rules recommend by role: titles clamp at two lines, button labels never truncate, numbers never break, paragraphs and headings wrap. Confidence is high when the role is certain, and "check it fits" when it is a guess.

A scenario that fails is recorded in `incomplete` and the run carries on; checks that hit the 25-per-scenario limit are listed in `capped`; content inside iframes and shadow roots is counted in `unseen`. A page that draws nothing stops the run with an error, so it can't read as clean. A web font that never answers can't hold a run up for long, every call into the page has a 60 s limit, and a page that navigates mid-measurement is followed. Caliper's scripts run in an isolated world (`src/page.ts`), so a page that overrides built-ins can't break them. Decorative parts (`aria-hidden`), running animations, slot and carousel boxes, and form fields are left out of the text checks.

## The interaction pass

`src/interact.ts` runs after a scenario's first measurement, one scenario at a time, because screenshots need the state on screen. Which scenarios: as is and `--width` do everything; the phone and dark mode only open things; the rest do none of it. `--no-interact` turns it off.

- **Opening.** It clicks `[aria-haspopup]`, `[aria-expanded=false]` and closed `<details>` summaries, one per component and 12 per scenario (more is noted in the report). Each opened state is measured whole, then closed with Escape, a second click, or a reload. A finding that needed a state says which, in `state`. Inactive tabs aren't opened: use `--steps` for those.
- **Steps.** `--steps` runs the states in a JSON file (`src/steps.ts`), each from a fresh page. A step that fails marks the scenario partial.
- **Hover.** The real mouse visits up to 24 row-like controls and 8 labelled icon buttons, and compares each with how it looked at rest. A fill that appears on hover is measured against the text and icons you can see: a truncated label's hidden text doesn't count. Icon buttons wait 400 ms for a tooltip.
- **Tab.** Up to 40 Tab presses, stopping at a repeat. Each stop compares 18 style properties on the control, its `::before` and `::after`, three ancestors (`:focus-within`) and six children with their resting look. Text fields are left out, because their caret shows focus. Tab runs in the default state and in scripted states, not in menus Caliper opened.

Waits are bounded: 1 s after opening, 300 ms after a hover or Tab, so a page that never stops moving can't add minutes.

## How the new checks measure

`media/invisible-on-background` compares pixels, so it sees what reached the screen. It takes three full-page screenshots, however many images there are: as shown, images hidden, images inverted. A pixel that changes when inverted belongs to the image, so a transparent corner, an empty spacer or an image covered by something else never counts. It is a finding when almost nothing reaches 1.3:1 against what is behind it: under 12 pixels and under 1%. The count matters, because one thin line on a big white tile is under 1% and still plain to see. `src/pixels.ts` reads the PNGs with no dependencies. It covers `img` and `svg`, and skips one with its own CSS background or shadow, which sits on a plate; icon fonts and CSS background images aren't checked.

Caliper's browser draws classic 15 px scrollbars everywhere (`--disable-features=OverlayScrollbar`). Removing `--hide-scrollbars` isn't enough on a Mac, where overlay bars take no room and don't show in screenshots. So `scroll/bar-over-content` measures from where the bar starts: content flush against a classic bar is the content an overlay bar lands on. A bar that takes no room was hidden on purpose, so it is skipped. Phones are skipped too, because their bars fade. Controls inside a carousel keep their own overflow and don't count.

`text/word-broken` only reads text under `overflow-wrap: anywhere` or `break-word`, or `word-break`, since nothing else breaks a word. It skips text the stress test rewrote, the whole 63-letter scenario, `hyphens: auto`, URLs and codes, words over 30 letters and text clipped to nothing such as a skip link.

Mobile scenarios add a viewport tag to a page that has none. Without it Chromium lays the page out 980 px wide, so the "320 px phone" would quietly measure a desktop layout. Pages meant for desktop, such as an extension's side panel, usually have none. The report notes it, because a real phone would use 980 px.

## Use it from source

You need Node 24 (see `.nvmrc`).

```sh
npm install
npm run dev -- https://example.com
```

The report lands in `./caliper-report/`. Open `index.html` to see it. Each issue offers a recommended fix, two alternatives and "Write your own", and copies a prompt with the chosen one. `report.json` has the same findings, the role, the cause, all three fixes and the recommended prompt.

Useful options:

```sh
npm run dev -- http://localhost:3000/pricing --only narrow,long-text
npm run dev -- http://localhost:3000 --ignore ".marquee" --ignore "[data-chart]"
npm run dev -- http://localhost:5173/panel --width 400 --steps states.json
npm run dev -- --help
```

Add `data-caliper-ignore` to any element in your own markup to leave it out on purpose.

The command exits with 1 when it finds issues (so CI can fail on them), 2 on an error, and 0 when the page held up. `--no-fail` always exits with 0.

## Publishing

The public package is `caliper-check`: one minified file, `dist/caliper.js`, built by `scripts/bundle.mjs` (the page scripts in `browser/` are minified and inlined). Only `dist/caliper.js`, `LICENSE` and `README.md` ship; check with `npm pack --dry-run`. `prepack` runs the checks and the build, so `npm publish` can't ship a stale or failing build.

## How it works

```
src/cli.ts         reads the command line, prints the summary
src/run.ts         opens each scenario, stresses, measures, takes screenshots
src/page.ts        runs the browser scripts in an isolated world
src/interact.ts    opens menus and sheets, runs scripted states, hovers and tabs
src/steps.ts       reads and runs a --steps file
src/pixels.ts      reads screenshots and finds images that vanish
src/scenarios.ts   the 9 scenarios, and the --width one
src/rules.ts       the 20 rules, and the fixes by element role (recommended first)
src/prompt.ts      the prompt the report copies
src/report.ts      writes index.html and report.json
browser/stress.js  runs inside the page: lengthens text, applies text spacing
browser/detect.js  runs inside the page: measures every element, and answers the interaction pass
src/brand.ts       the product name, in one place
```

The two files in `browser/` are plain JavaScript on purpose: Playwright sends them to the browser as text, so they can't import anything.

## Develop

```sh
npm run check   # typecheck + tests
npm run dev -- http://localhost:3000   # run from source, no build
```

`test/fixture.test.ts` runs every scenario against `fixtures/fragile.html`. That page has one fragile copy of each component (which must be caught) and one robust copy (which must not be). Add both halves when you add a rule. `test/edge.test.ts` runs the tiny pages in `fixtures/edge/`, one per thing that went wrong on a real site or could: add one with each fix.

If Playwright can't find its browser, point it at one with `CALIPER_CHROMIUM=/path/to/chrome`.

## Renaming

The name lives in `src/brand.ts`, `package.json` (`name` and `bin`) and the bundle banner. Change those, the `data-caliper-ignore` attribute in `browser/detect.js`, and this README.
