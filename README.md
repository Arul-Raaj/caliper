# Caliper

Caliper opens your page in a real browser, feeds it the content real users bring, and shows you what breaks. Every issue comes with a screenshot, the measurement that proves it, and the CSS that fixes it.

```sh
npx caliper-check https://your-site.com
```

It works on anything with a URL: a live site, a preview deploy, or `http://localhost:3000`.

## What it tries

| Scenario | What changes |
| --- | --- |
| As is | Nothing. Anything found here is already broken |
| Longer text | Names, titles and labels get three times longer |
| A long word | A 63-letter word with no spaces, like a URL or a German noun |
| Broken images | Every image fails to load |
| Small phone | A 320 px touch screen |
| 200% zoom | What the page looks like at 200% browser zoom |
| Text spacing | The WCAG 2.2 text spacing test: more line, letter and word spacing |
| Tablet | A 768 px screen, where navs and grids often fall between breakpoints |

## What it catches

- The page scrolls sideways
- Text spills out of its box
- Text is cut off with no ellipsis
- A long word or URL pushes past its box
- A flex item won't shrink below its content
- A grid column blows out with long content
- A fixed height can't fit its content
- The layout jumps when an image fails to load
- An image is stretched or squashed
- A tap target is too small, with another one too close (WCAG 2.2)
- A button label wraps when one line would fit, or is cut off with an ellipsis
- A fixed panel, like a dialog or chat widget, runs off a small screen

Repeated components, like list items and cards, are grouped into one issue.

## The report

Caliper writes `caliper-report/index.html`. The worst issue comes first. Each one shows the screenshots, what was measured ("needs 312 px, has 224 px"), and the cause, marked as tested only when Caliper changed it in the page and the problem went away.

Every issue comes with a recommended fix, picked for what the element is:

- Titles and names wrap once, then end with an ellipsis on line two.
- Button labels stay on one line when they fit, and wrap to two balanced lines when they don't. They are never truncated.
- Prices, dates and codes never break; the layout around them moves instead.
- Paragraphs and headings wrap and are never truncated.

Two alternatives sit under "Other options", or write your own. Then copy a prompt for that issue, or one for all of them, and paste it into the AI assistant you use. Caliper itself uses no AI: the checks are measurements, and the same page gives the same report every time.

If a scenario doesn't finish, or a check hits its limit, the report and the output say so. A partial run never looks like a clean one, and exits with `2` when it found nothing. Caliper can't see inside iframes or web components yet: the report says so, and a page that sits mostly inside them counts as partial.

`caliper-report/report.json` has the same findings, fixes and prompts for scripts, CI and agents.

The first run downloads the browser Caliper drives (about 300 MB, once). After that, a page takes 10 to 40 seconds.

## Options

```sh
npx caliper-check <url> --only narrow,long-text   # run some scenarios
npx caliper-check <url> --ignore ".ticker"        # leave elements out
npx caliper-check <url> --out ./reports/home      # choose the folder
npx caliper-check <url> --no-fail                 # always exit 0
npx caliper-check --help
```

To leave an element out from your own markup, add `data-caliper-ignore` to it.

Caliper exits with `1` when it finds issues, so CI can fail on them, `0` when the page holds up, and `2` on an error or a partial run with no issues.

Requires Node 22.18 or newer.

## Licence

Free to use on any project, personal or commercial. Not open source: no copying, modifying or redistributing. See `LICENSE`.
