# Developing Caliper

Notes for working on Caliper itself. The public README (shipped to npm) is `README.md`.

## What it does

Each run loads the page in 8 scenarios, 3 at a time:

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

In each one it measures every element and checks 13 rules:

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

Copies of the same component (list items, cards) share one card in the report, with the other copies listed under it.

Each finding separates what was measured from why. A cause is marked tested only when Caliper changed the suspected property in the page and the problem went away: nowrap text is allowed to wrap, long words to break, clipped text to show, fixed panels get a max-height, buttons are sized to their label, flex and grid try `min-width: 0`, fixed heights are released. Measurements use the real text and in-flow children, never `scrollWidth` alone, which also counts invisible hit areas and positioned layers. The gap on a card is the text past the edge, so padding can't skew it. Mock-ups (`inert`, `pointer-events: none`, `role=img`) are skipped, and so is anything nobody can see: a hidden parent, a closed accordion or `details`, a tap target cropped out of its box. Every temporary style change is restored exactly, priority included.

A page that can scroll sideways always gets one card per scenario, even when the culprit has a finding of its own, and even when the culprit has no element (a pseudo-element). The element reaching furthest leads the card. `overflow-x: hidden` or `clip` on `html` or `body` stops the page scrolling, so nothing is reported.

A row of same-size items past a clipping parent is treated as a carousel, but only when `min-width: 0` can't fix it: a row that content pushes wider is a real break. Images are matched to the baseline by source, and "the layout jumps" is reported only when the box around the image, or what follows it, really moved.

Each finding also has a role (`button`, `number`, `form`, `nav`, `heading`, `paragraph`, `title`, `box`), judged from the original text before any stress. Text rules recommend by role: titles clamp at two lines, button labels never truncate, numbers never break, paragraphs and headings wrap. Confidence is high when the role is certain, and "check it fits" when it is a guess.

A scenario that fails is recorded in `incomplete` and the run carries on; checks that hit the 25-per-scenario limit are listed in `capped`; content inside iframes and shadow roots is counted in `unseen`. A page that draws nothing stops the run with an error, so it can't read as clean. A web font that never answers can't hold a run up for long, every call into the page has a 60 s limit, and a page that navigates mid-measurement is followed. Caliper's scripts run in an isolated world (`src/page.ts`), so a page that overrides built-ins can't break them. Decorative parts (`aria-hidden`), running animations, slot and carousel boxes, and form fields are left out of the text checks.

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
npm run dev -- --help
```

Add `data-caliper-ignore` to any element in your own markup to leave it out on purpose.

The command exits with 1 when it finds issues (so CI can fail on them), 2 on an error, and 0 when the page held up. `--no-fail` always exits with 0.

## Publishing

The public package is `caliper-css`: one minified file, `dist/caliper.js`, built by `scripts/bundle.mjs` (the page scripts in `browser/` are minified and inlined). Only `dist/caliper.js`, `LICENSE` and `README.md` ship; check with `npm pack --dry-run`. The source repo stays private. `prepack` runs the checks and the build, so `npm publish` can't ship a stale or failing build.

## How it works

```
src/cli.ts         reads the command line, prints the summary
src/run.ts         opens each scenario, stresses, measures, takes screenshots
src/page.ts        runs the browser scripts in an isolated world
src/scenarios.ts   the 8 scenarios
src/rules.ts       the 13 rules, and the fixes by element role (recommended first)
src/prompt.ts      the prompt the report copies
src/report.ts      writes index.html and report.json
browser/stress.js  runs inside the page: lengthens text, applies text spacing
browser/detect.js  runs inside the page: measures every element
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
