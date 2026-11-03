// Runs inside the page and measures it. Returns raw findings: which
// element broke, how, and the numbers that prove it. Node turns these into
// rules and the report.
//
// Plain JavaScript on purpose: Playwright sends this source to the browser
// as-is, so it must not depend on anything outside itself.
//
// With `probe` set it answers one question about the page as it is right now,
// for the interaction pass (src/interact.ts), instead of measuring everything.
({ checkTapTargets, checkLabels, checkFixed, checkBars, checkWords, ignore, probe }) => {
  if (!document.body) return { findings: [], images: [], pageWidth: 0, pageHeight: 0, viewportWidth: 0 };
  const MAX_PER_KIND = 25;
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "BR", "OPTION"]);
  const root = document.documentElement;
  const vw = root.clientWidth;
  const findings = [];

  // ---------- helpers ----------

  const css = (el) => getComputedStyle(el);

  // A closed accordion keeps its contents laid out, inside a box with no height.
  const collapsed = new Map();
  const inCollapsed = (n) => {
    if (!n || n === document.body) return false;
    if (collapsed.has(n)) return collapsed.get(n);
    const s = css(n);
    const closed = (hides(s.overflowY) && n.clientHeight <= 1) || (hides(s.overflowX) && n.clientWidth <= 1) || inCollapsed(n.parentElement);
    collapsed.set(n, closed);
    return closed;
  };

  const isVisible = (el) => {
    const s = css(el);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    // A hidden parent hides its children too, even though they keep their
    // layout: a closed menu (opacity: 0), a closed <details>, an accordion.
    if (el.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) === false || inCollapsed(el.parentElement)) return false;
    // Screen-reader-only text is clipped to nothing on purpose: not a visual
    // bug. It comes as rect(0, 0, 0, 0), rect(1px, 1px, 1px, 1px) and the like.
    if (s.clipPath === "inset(50%)") return false;
    if (s.clip !== "auto") {
      const [top, right, bottom, left] = s.clip.match(/-?[\d.]+(?=px)/g)?.map(Number) ?? [];
      if (right <= left || bottom <= top) return false;
    }
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false;
    // Parked off canvas (a closed drawer): nobody can see it, so skip it.
    return r.right > 0 && r.bottom + window.scrollY > 0;
  };

  const hasOwnText = (el) =>
    [...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim().length > 0);

  // A box whose text sits in inline children holds that text itself: in
  // <div><span>Text</span></div> the span has no width of its own to measure.
  const holdsText = (el) => {
    if (hasOwnText(el)) return true;
    if (el.closest("pre, code")) return false; // lines of code run long by nature
    const inner = el.querySelectorAll("*");
    return inner.length > 0 && inner.length <= 12 && Boolean((el.textContent || "").trim()) && [...inner].every((c) => css(c).display.startsWith("inline"));
  };

  // The box that the element's visible text actually occupies, from the
  // text itself. Icons, hidden labels and screen-reader text don't count.
  // Text inside an absolutely positioned layer is placed on purpose, so it
  // doesn't count as the element's own overflow.
  const positionedWithin = (node, el) => {
    for (let n = node; n && n !== el; n = n.parentElement) {
      const p = css(n).position;
      if (p === "absolute" || p === "fixed") return true;
    }
    return false;
  };
  const textBox = (el, shownOf = null) => {
    const box = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity, lines: [] };
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.nodeValue.trim()) continue;
      const parent = node.parentElement;
      if (!parent || parent.closest("svg, [aria-hidden='true']") || !isVisible(parent) || positionedWithin(parent, el)) continue;
      range.selectNodeContents(node);
      const shown = shownOf?.(parent);
      for (const rect of range.getClientRects()) {
        // Text past an ellipsis still has a box, but nobody can see it.
        const r = shown ? { left: Math.max(rect.left, shown.left), top: Math.max(rect.top, shown.top), right: Math.min(rect.right, shown.right), bottom: Math.min(rect.bottom, shown.bottom), height: rect.height } : rect;
        if (r.right - r.left < 1 || r.bottom - r.top < 1) continue;
        box.left = Math.min(box.left, r.left);
        box.top = Math.min(box.top, r.top);
        box.right = Math.max(box.right, r.right);
        box.bottom = Math.max(box.bottom, r.bottom);
        if (!box.lines.some((t) => Math.abs(t - r.top) < r.height * 0.5)) box.lines.push(r.top);
      }
    }
    return box;
  };

  // Moving parts (tickers, rotating words, carousels) overflow on purpose.
  const animating = (el) => {
    try {
      return el.getAnimations({ subtree: true }).some((a) => a.playState === "running");
    } catch { return false; }
  };

  // A box that clips a stack of same-size slides, or a track of slides
  // running past its edge, is a slot or carousel. A plain box whose
  // children simply fit is not: its overflow is a real bug.
  const isSlot = (el) => {
    const kids = [...el.children].filter((c) => css(c).display !== "none");
    if (kids.length < 2) return false;
    const r = el.getBoundingClientRect();
    const rects = kids.map((c) => c.getBoundingClientRect());
    if (!rects.every((k) => k.height <= el.clientHeight + 2)) return false;
    const overlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    const stacked = rects.some((a, i) => rects.some((b, j) => j > i && overlap(a, b) > 0.5 * Math.min(a.width * a.height, b.width * b.height)));
    const track = rects.some((k) => k.right > r.right + 2 || k.left < r.left - 2 || k.bottom > r.bottom + 2 || k.top < r.top - 2);
    return stacked || track;
  };

  // Inside such a slot, each slide's overflow is hidden by design.
  const inSlot = (el) => {
    let n = el.parentElement;
    for (let i = 0; n && n !== document.body && i < 4; i++, n = n.parentElement) {
      const s = css(n);
      if ((hides(s.overflowY) || hides(s.overflowX)) && isSlot(n)) return true;
    }
    return false;
  };

  const FORM = new Set(["INPUT", "TEXTAREA", "SELECT"]);

  const scrolls = (value) => value === "auto" || value === "scroll";
  const hides = (value) => value === "hidden" || value === "clip";

  // A short, unique CSS path such as "main > section:nth-of-type(2) > h2".
  const selectorFor = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== root) {
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id) && document.querySelectorAll(`#${node.id}`).length === 1) {
        parts.unshift(`#${node.id}`);
        break;
      }
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  };

  // A human label such as 'h2.card__title "Pricing that…"', from the text the
  // page really has, so a coding agent can search for it. Images have no text,
  // so they go by their alt text or file name.
  const labelFor = (el) => {
    const classes = el.getAttribute("class")?.trim(); // an SVG's className isn't a string
    const cls = classes ? "." + classes.split(/\s+/)[0] : "";
    const file = () => (el.currentSrc || el.src).split(/[?#]/)[0].split("/").filter((part) => /\.\w{2,5}$/.test(part)).pop();
    const name = el.tagName === "IMG" ? el.alt || file() : originalText(el);
    const text = (name || "").trim().replace(/\s+/g, " ");
    const snippet = text ? ` "${text.slice(0, 40)}${text.length > 40 ? "…" : ""}"` : "";
    return `${el.tagName.toLowerCase()}${cls}${snippet}`;
  };

  const box = (el) => {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.left + window.scrollX),
      y: Math.round(r.top + window.scrollY),
      width: Math.round(r.width),
      height: Math.round(r.height),
    };
  };

  // Does the box look like a button: a fill, a border or a background image?
  const filled = (s) => {
    const bg = s.backgroundColor;
    const hasBg = bg && bg !== "transparent" && !/rgba\(.*,\s*0\)$/.test(bg);
    const hasBorder = parseFloat(s.borderTopWidth) > 0 && s.borderTopStyle !== "none";
    return hasBg || hasBorder || s.backgroundImage !== "none";
  };

  const isButton = (el) => {
    if (el.matches("input")) return false;
    if (el.matches("button, [role=button], summary")) return true;
    if (!el.matches("a[href]")) return false;
    const s = css(el);
    // A link only counts as a button when it is styled like one.
    return s.display !== "inline" && filled(s) && parseFloat(s.paddingLeft) >= 6;
  };

  // What the element is, so the report can recommend the right fix: a
  // title clamps at two lines, a button label never truncates, a price
  // never breaks.
  const NUMBER = /^[^\p{L}\d]{0,3}\s?[\d][\d.,:\/\s%-]*\s?[\p{L}%]{0,4}$/u;
  // The element's text before any stress was applied (see stress.js).
  const originalText = (el) => {
    const original = globalThis.__caliperOriginal;
    let text = "";
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(node.parentElement?.tagName ?? "")) text += original?.get(node) ?? node.nodeValue;
    }
    return text;
  };
  // Class names like card, tile or menu-item mark a card. Utility classes
  // like items-center and self-start don't.
  const cardClass = (c) => /card|tile|item/i.test(c) && !/^(justify-|place-)?(items|self)-/.test(c);
  const inCard = (el) => {
    if (el.closest("li, article, td, th")) return true;
    for (let n = el, i = 0; n && n !== document.body && i < 6; n = n.parentElement, i++) {
      if (typeof n.className === "string" && n.className.split(/\s+/).some(cardClass)) return true;
    }
    return false;
  };
  const MENU = "nav, [role=tablist], [role=menubar], [role=navigation]";
  const roleFor = (el) => {
    const text = originalText(el).trim().replace(/\s+/g, " ");
    const button = el.closest("button, [role=button], summary, a[href]");
    if (button && (button === el || el.textContent === button.textContent) && isButton(button)) return "button";
    if (text && text.length <= 24 && NUMBER.test(text)) return "number";
    if (el.closest("label, legend, [role=alert]") || el.matches(".error, [aria-live]")) return "form";
    // A heading inside a card or list item is that card's title: it clamps.
    if (el.matches("h1, h2, h3, h4, h5, h6, [role=heading]")) return inCard(el) && !el.matches("h1") ? "title" : "heading";
    // A menu and its items. A plain wrapper inside a menu is a layout box.
    if (el.closest(MENU) && (el.matches(MENU) || el.closest("a, button, li, [role=tab], [role=menuitem]"))) return "nav";
    if (el.matches("p, blockquote, dd")) return "paragraph";
    // A row of several parts (name and description) is a layout box, not one piece of text.
    if (!hasOwnText(el) && [...el.children].filter((c) => (c.textContent || "").trim()).length > 1) return "box";
    if (text.length > 120) return "paragraph";
    if (text) return "title";
    return "box";
  };

  const push = (kind, el, details) => {
    if (findings.filter((f) => f.kind === kind).length >= MAX_PER_KIND) return;
    findings.push({ kind, selector: selectorFor(el), label: labelFor(el), role: roleFor(el), box: box(el), details });
  };

  // Keep only the deepest elements: if a child is already flagged, its
  // parents are flagged only because of that child.
  const deepest = (els) => els.filter((el) => !els.some((other) => other !== el && el.contains(other)));

  const insideFixed = (el) => {
    for (let n = el; n && n !== root; n = n.parentElement) {
      const p = css(n).position;
      if (p === "fixed" || p === "sticky") return true;
    }
    return false;
  };

  // A fixed element stays out of the page's width. A sticky one doesn't.
  const insideFixedOnly = (el) => {
    for (let n = el; n && n !== root; n = n.parentElement) if (css(n).position === "fixed") return true;
    return false;
  };

  // True when an ancestor clips or scrolls horizontally, so the element's
  // overflow never reaches the page. An absolute element answers only to its
  // positioned ancestor: an overflow box between the two doesn't hold it in.
  const containedX = (el) => {
    let position = css(el).position;
    for (let n = el.parentElement; n && n !== document.body && n !== root; n = n.parentElement) {
      const s = css(n);
      const moved = s.transform !== "none";
      if (position === "fixed" ? !moved : position === "absolute" && s.position === "static" && !moved) continue;
      if (hides(s.overflowX) || scrolls(s.overflowX)) return true;
      position = s.position;
    }
    return false;
  };

  // Scrolled or cropped out of a box, so nobody can see or tap it right now.
  const cutOff = (el) => {
    const r = el.getBoundingClientRect();
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const s = css(n);
      const c = n.getBoundingClientRect();
      if (s.overflowX !== "visible" && (r.right <= c.left || r.left >= c.right)) return true;
      if (s.overflowY !== "visible" && (r.bottom <= c.top || r.top >= c.bottom)) return true;
    }
    return false;
  };

  // Word by word, per text node: textContent glues neighbouring elements
  // ("Shop" + "Help") into one long false word.
  const longestWord = (el) => {
    let max = 0;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) for (const w of walker.currentNode.nodeValue.split(/\s+/)) max = Math.max(max, w.length);
    return max;
  };

  // Elements can opt out with data-caliper-ignore, or via --ignore selectors.
  const ignoreSelector = ["[data-caliper-ignore]", ...ignore].join(", ");
  const ignored = (el) => {
    try { return Boolean(el.closest(ignoreSelector)); } catch { return false; }
  };

  // Decorative parts (aria-hidden) are graphics, not content, though they can
  // still make the page scroll sideways.
  const rendered = [...document.body.querySelectorAll("*")].filter((el) => !SKIP.has(el.tagName) && !(el instanceof SVGElement && el.tagName !== "svg") && isVisible(el));
  const elements = rendered.filter((el) => !ignored(el) && !el.closest("[aria-hidden='true']"));

  // Mock-ups and illustrations (a product screenshot built in HTML) can't be
  // used, so their cropping is design, not a bug.
  const decorative = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      if (n.inert || n.matches("[role=img], [role=presentation], [role=none]") || css(n).pointerEvents === "none") return true;
    }
    return false;
  };

  // How far a container's in-flow children reach past its right edge.
  // Ignores positioned layers, pseudo-element hit areas and hairline rules.
  const flowOverflow = (el) => {
    const r = el.getBoundingClientRect();
    const s = css(el);
    const inner = r.right - parseFloat(s.borderRightWidth) - parseFloat(s.paddingRight);
    let right = -Infinity;
    for (const c of el.children) {
      const cs = css(c);
      if (cs.position === "absolute" || cs.position === "fixed" || !isVisible(c)) continue;
      const k = c.getBoundingClientRect();
      if (k.width <= 2 || k.height <= 2) continue;
      // A negative margin pulls a child past the edge on purpose.
      right = Math.max(right, k.right + Math.min(0, parseFloat(cs.marginRight) || 0));
    }
    return right === -Infinity ? 0 : Math.round(right - inner);
  };

  // A row of same-size items running past a clipping parent is a carousel or
  // a logo strip: it slides, or it's cropped, on purpose. Only for rows that
  // min-width: 0 can't fix: a row content pushes wider is a real break.
  const isTrack = (el) => {
    const kids = [...el.children].filter(isVisible).map((c) => c.getBoundingClientRect());
    if (kids.length < 3 || !kids.every((k) => Math.abs(k.width - kids[0].width) <= kids[0].width * 0.1)) return false;
    for (let n = el.parentElement, i = 0; n && n !== document.body && i < 6; n = n.parentElement, i++) {
      const o = css(n).overflowX;
      if (hides(o) || scrolls(o)) return true;
    }
    return false;
  };

  // Change some inline styles, measure, and put them back exactly as they
  // were, priority included, so one check can't affect the next.
  const withStyles = (el, styles, measure) => {
    const saved = Object.keys(styles).map((k) => [k, el.style.getPropertyValue(k), el.style.getPropertyPriority(k)]);
    for (const [k, v] of Object.entries(styles)) el.style.setProperty(k, v, "important");
    try {
      return measure();
    } finally {
      for (const [k, v, prio] of saved) v ? el.style.setProperty(k, v, prio) : el.style.removeProperty(k);
    }
  };

  // The same, across several elements at once.
  const trial = (els, styles, measure) =>
    els.reduceRight((inner, el) => () => withStyles(el, styles, inner), measure)();

  // How far the element's text runs past its edges, in px.
  const textPast = (el) => {
    const r = el.getBoundingClientRect();
    const s = css(el);
    const t = textBox(el);
    return Math.max(t.right - (r.right - parseFloat(s.borderRightWidth)), r.left + parseFloat(s.borderLeftWidth) - t.left);
  };

  // Test a cause: change it and see whether the text fits.
  const WRAP = { "white-space": "normal" };
  const BREAK = { "white-space": "normal", "overflow-wrap": "anywhere", "min-width": "0" };
  const REVEAL = { ...BREAK, overflow: "visible", "text-overflow": "clip", height: "auto", "max-height": "none" };
  const fitsWith = (el, styles) => withStyles(el, styles, () => textPast(el) <= 2);

  // A line clamp needs text that wraps. On nowrap text it shows one cut line
  // with no ellipsis.
  const clamped = (s) => Boolean(s.webkitLineClamp) && s.webkitLineClamp !== "none" && !/nowrap|^pre$/.test(s.whiteSpace);

  // Does the element have a set height (or max-height)? Release it and see
  // whether it grows. Overflow from a box with an automatic height comes
  // from somewhere else (negative margins, positioned children).
  const hasFixedHeight = (el) => {
    const before = el.getBoundingClientRect().height;
    const after = withStyles(el, { height: "auto", "max-height": "none" }, () => el.getBoundingClientRect().height);
    return after > before + 2;
  };

  // ---------- colours and surfaces ----------

  // Computed colours can be oklch() or color(): a canvas turns any of them into sRGB.
  const paint = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d", { willReadFrequently: true });
  const colors = new Map();
  const rgba = (color) => {
    if (!colors.has(color)) {
      paint.clearRect(0, 0, 1, 1);
      paint.fillStyle = color;
      paint.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = paint.getImageData(0, 0, 1, 1).data;
      colors.set(color, { r, g, b, a: a / 255 });
    }
    return colors.get(color);
  };
  const over = (top, back) => ({ r: top.r * top.a + back.r * (1 - top.a), g: top.g * top.a + back.g * (1 - top.a), b: top.b * top.a + back.b * (1 - top.a), a: 1 });
  const sameColor = (a, b) => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) <= 6;
  const hexOf = ({ r, g, b }) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

  // The solid colour showing behind an element.
  const backdropOf = (el) => {
    const layers = [];
    for (let n = el.parentElement; n; n = n.parentElement) {
      const c = rgba(css(n).backgroundColor);
      if (c.a === 0) continue;
      layers.push(c);
      if (c.a === 1) break;
    }
    return layers.reduceRight((back, c) => over(c, back), { r: 255, g: 255, b: 255, a: 1 });
  };
  const visibleFill = (el) => {
    const c = rgba(css(el).backgroundColor);
    if (c.a === 0) return false;
    const back = backdropOf(el);
    return !sameColor(over(c, back), back);
  };

  // A box you can see the edges of: filled, or outlined on at least three sides.
  const isSurface = (el) => {
    const s = css(el);
    const sides = ["Top", "Right", "Bottom", "Left"].filter((side) => parseFloat(s[`border${side}Width`]) > 0 && s[`border${side}Style`] !== "none" && rgba(s[`border${side}Color`]).a > 0);
    return sides.length >= 3 || s.backgroundImage !== "none" || visibleFill(el);
  };
  const surfaceOf = (el) => {
    for (let n = el.parentElement; n && n !== document.body && n !== root; n = n.parentElement) if (isSurface(n)) return n;
    return null;
  };

  const CONTROL = "a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=switch], [role=checkbox], [role=radio], [role=tab], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=option], [role=row], [role=treeitem], [tabindex]:not([tabindex='-1'])";
  const inactive = (el) => el.matches(":disabled, [aria-disabled='true']");
  const typesText = (el) => el.isContentEditable || el.matches("textarea, select, input:not([type=button], [type=submit], [type=reset], [type=checkbox], [type=radio], [type=range], [type=color], [type=file])");

  // The box around what a control shows: its text, its icons, its images.
  const inkBox = (el, shownOf = shownBox) => {
    const { left, top, right, bottom } = textBox(el, shownOf);
    const ink = { left, top, right, bottom };
    for (const part of el.querySelectorAll("svg, img")) {
      if (!isVisible(part)) continue;
      const r = shownOf(part);
      ink.left = Math.min(ink.left, r.left);
      ink.top = Math.min(ink.top, r.top);
      ink.right = Math.max(ink.right, r.right);
      ink.bottom = Math.max(ink.bottom, r.bottom);
    }
    return ink.right === -Infinity ? null : ink;
  };

  // The part of a box that it and its ancestors don't clip away.
  const shownBox = (el) => {
    const r = el.getBoundingClientRect();
    const shown = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const s = css(n);
      if (s.overflowX === "visible" && s.overflowY === "visible") continue;
      const c = n.getBoundingClientRect();
      shown.left = Math.max(shown.left, c.left);
      shown.top = Math.max(shown.top, c.top);
      shown.right = Math.min(shown.right, c.right);
      shown.bottom = Math.min(shown.bottom, c.bottom);
    }
    return shown;
  };

  // The same, sideways only: a row scrolled below the fold still has a right edge.
  const shownAcross = (el) => {
    const { top, bottom } = el.getBoundingClientRect();
    return { ...shownBox(el), top, bottom };
  };

  // ---------- 9. tooltips and popovers past the sides of the screen ----------

  const OVERLAY = "[role=tooltip], [role=menu], [role=listbox], [role=dialog], [role=alertdialog], dialog[open], [popover], [data-side], [data-popper-placement], [data-radix-popper-content-wrapper]";
  const NAMED_OVERLAY = "[class*=tooltip i], [class*=popover i], [class*=dropdown i]";
  const checkOverlays = () => {
    const open = elements.filter((el) => el.matches(OVERLAY) || (el.matches(NAMED_OVERLAY) && /absolute|fixed/.test(css(el).position)));
    for (const el of open) {
      if (open.some((other) => other !== el && other.contains(el)) || !(el.textContent || "").trim()) continue;
      const r = el.getBoundingClientRect();
      // Wholly past the edge is parked, not open: a closed sheet waits there.
      if (r.left >= vw || r.right <= 0) continue;
      const [left, right] = [-r.left, r.right - vw];
      if (Math.max(left, right) > 1) push("overlay-offscreen-x", el, { side: right >= left ? "right" : "left", past: Math.ceil(Math.max(left, right)), width: Math.round(r.width), viewportWidth: vw });
    }
  };

  // ---------- questions for the interaction pass ----------

  const LOOK = ["outlineStyle", "outlineWidth", "outlineColor", "outlineOffset", "boxShadow", "borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor", "borderTopWidth", "backgroundColor", "backgroundImage", "color", "textDecorationLine", "textDecorationColor", "opacity", "transform", "filter"];
  const lookOf = (el, pseudo) => {
    const s = getComputedStyle(el, pseudo);
    return LOOK.map((k) => s[k]).join("|");
  };
  // Focus can show on the control, its ::before or ::after, a wrapper
  // (:focus-within) or a part inside it.
  const looks = (el) => {
    const parts = [lookOf(el), lookOf(el, "::before"), lookOf(el, "::after")];
    for (let n = el.parentElement, i = 0; n && n !== root && i < 3; n = n.parentElement, i++) parts.push(lookOf(n));
    for (const c of [...el.children].slice(0, 6)) parts.push(lookOf(c));
    return parts;
  };
  const sameLook = (a, b) => a.length === b.length && a.every((part, i) => part === b[i]);

  const answer = () => ({ findings, images: [], pageWidth: root.scrollWidth });
  const rowLike = (el, r) => css(el).display !== "inline" && !el.matches("input, textarea, select") && r.width >= 80 && r.height >= 16 && r.height <= 120 && r.width >= r.height * 2.5;
  const hasText = (el) => textBox(el).right !== -Infinity;
  const named = (el, r) => r.width <= 64 && r.height <= 64 && el.matches("[aria-label], [aria-describedby], [title], [data-tooltip], [data-tip]") && !hasText(el);
  const usable = (el) => !inactive(el) && !decorative(el) && !cutOff(el);

  const probes = {
    count: () => rendered.length,

    triggers: () => elements
      .filter((el) => el.matches("[aria-haspopup]:not([aria-haspopup=false]), [aria-expanded=false], details:not([open]) > summary") && usable(el))
      .map((el) => ({ selector: selectorFor(el), label: labelFor(el) })),

    // How everything looks untouched, for hover and focus to compare with.
    rest: () => {
      document.activeElement?.blur?.();
      const rest = (globalThis.__caliperRest = new WeakMap());
      for (const el of elements) if (el.matches(CONTROL)) rest.set(el, { looks: looks(el), background: css(el).backgroundColor, fill: visibleFill(el) });
      return true;
    },

    hoverTargets: () => elements.filter((el) => el.matches(CONTROL) && usable(el)).flatMap((el) => {
      const r = el.getBoundingClientRect();
      const kind = rowLike(el, r) && hasText(el) ? "row" : named(el, r) ? "icon" : null;
      return kind ? [{ selector: selectorFor(el), label: labelFor(el), kind }] : [];
    }),

    hover: ({ selector }) => {
      const el = document.querySelector(selector);
      const before = el && globalThis.__caliperRest?.get(el);
      if (before && el.matches(":hover") && !before.fill && css(el).backgroundColor !== before.background && visibleFill(el)) {
        const ink = inkBox(el);
        const shown = shownBox(el);
        const gaps = ink ? { left: ink.left - shown.left, right: shown.right - ink.right, top: ink.top - shown.top, bottom: shown.bottom - ink.bottom } : {};
        const [side, gap] = Object.entries(gaps).sort((a, b) => a[1] - b[1])[0] ?? [];
        const fill = hexOf(over(rgba(css(el).backgroundColor), backdropOf(el)));
        const surface = surfaceOf(el);
        const s = css(el);
        const square = ["TopLeft", "TopRight", "BottomLeft", "BottomRight"].every((c) => parseFloat(s[`border${c}Radius`]) === 0);
        const round = surface ? parseFloat(css(surface).borderTopLeftRadius) : 0;
        const c = surface?.getBoundingClientRect();
        // A row running edge to edge is clipped by the surface: only a fill
        // floating inside it shows its own corners.
        const inset = c ? Math.max(shown.left - c.left, c.right - shown.right) : 0;
        if (ink && gap < 1) push("hover-hug", el, { gap: Math.max(0, Math.round(gap)), side, fill });
        else if (square && round >= 4 && inset >= 2) push("hover-hug", el, { corners: true, radius: Math.round(round), inset: Math.round(inset), fill });
      }
      checkOverlays();
      return answer();
    },

    // One Tab stop: did anything change on the control now holding focus?
    focus: () => {
      const el = document.activeElement;
      if (!el || el === document.body || el === root || el.tagName === "IFRAME") return { done: true, ...answer() };
      const before = globalThis.__caliperRest?.get(el);
      if (before && isVisible(el) && !ignored(el) && !decorative(el) && !typesText(el) && sameLook(looks(el), before.looks)) {
        const s = css(el);
        push("no-focus-ring", el, {
          outline: `${s.outlineStyle === "none" ? "0px" : s.outlineWidth} ${s.outlineStyle}`,
          shadow: s.boxShadow,
          compared: LOOK.length,
          reverts: withStyles(el, { outline: "revert" }, () => !sameLook(looks(el), before.looks)),
        });
      }
      checkOverlays();
      return { done: false, selector: selectorFor(el), ...answer() };
    },

    media: () => {
      const list = rendered.filter((el) => {
        if (!el.matches("img, svg") || ignored(el) || el.closest("[inert]") || el.parentElement.closest("svg")) return false;
        // On its own background or shadow it sits on a plate, so it can't
        // vanish into what is behind it.
        const s = css(el);
        if (rgba(s.backgroundColor).a > 0 || s.boxShadow !== "none") return false;
        const r = el.getBoundingClientRect();
        return r.width >= 8 && r.height >= 8 && (el.tagName !== "IMG" || (el.complete && el.naturalWidth > 0));
      });
      globalThis.__caliperMedia = list;
      // The nearest of three ancestors that draws a clearly round shape (a
      // circle, a pill, a squircle) around the image without the image filling
      // it, so the image's own corners land inside the curve. An image that
      // fills its round box is cut by the curve and can't show corners.
      const roundAround = (el) => {
        const r = el.getBoundingClientRect();
        for (let up = el.parentElement, i = 0; up && i < 3; up = up.parentElement, i++) {
          const u = up.getBoundingClientRect();
          const s = css(up);
          const radius = Math.min(parseFloat(s.borderTopLeftRadius) || 0, u.width / 2, u.height / 2);
          if (radius < Math.min(u.width, u.height) * 0.25) continue;
          const drawn = s.overflow !== "visible" || rgba(s.backgroundColor).a > 0 || s.boxShadow !== "none" || parseFloat(s.borderTopWidth) > 0;
          if (!drawn) continue;
          const inside = r.left >= u.left - 0.5 && r.top >= u.top - 0.5 && r.right <= u.right + 0.5 && r.bottom <= u.bottom + 0.5;
          const fills = r.width >= u.width - 1 && r.height >= u.height - 1;
          return inside && !fills ? { box: box(up), radius: Math.round(radius) } : null;
        }
        return null;
      };
      return list.map((el) => {
        const control = el.tagName === "svg" && !el.querySelector("title") && el.closest("button, a[href], [role=button]");
        const round = roundAround(el);
        return { selector: selectorFor(el), label: control ? `${labelFor(el)} in ${labelFor(control)}` : labelFor(el), role: "box", box: box(el), ...(round ? { round } : {}) };
      });
    },

    // Hide or invert every image for one screenshot, and put them back.
    mediaStyle: ({ look }) => {
      const worn = (globalThis.__caliperWorn ??= new Map());
      for (const [el, saved] of worn) for (const [k, v, prio] of saved) v ? el.style.setProperty(k, v, prio) : el.style.removeProperty(k);
      worn.clear();
      if (!look) return true;
      for (const el of globalThis.__caliperMedia ?? []) {
        const filter = css(el).filter;
        const styles = { transition: "none", animation: "none", ...(look === "hide" ? { visibility: "hidden" } : { filter: `${filter === "none" ? "" : `${filter} `}invert(1)` }) };
        worn.set(el, Object.keys(styles).map((k) => [k, el.style.getPropertyValue(k), el.style.getPropertyPriority(k)]));
        for (const [k, v] of Object.entries(styles)) el.style.setProperty(k, v, "important");
      }
      return true;
    },
  };
  if (probe) return probes[probe.op](probe);

  // ---------- 1. the page scrolls sideways ----------

  // Overflow set on html, or on body when html leaves it visible, applies to
  // the whole page: with hidden or clip there, nobody can scroll sideways.
  const pageX = css(root).overflowX === "visible" ? css(document.body).overflowX : css(root).overflowX;
  if (root.scrollWidth > vw + 1 && !hides(pageX)) {
    const rtl = css(root).direction === "rtl";
    const reach = (el) => {
      const r = el.getBoundingClientRect();
      return rtl ? vw - r.left : r.right;
    };
    const reachOf = new Map();
    const far = (el) => reachOf.get(el) ?? reach(el);
    const free = (el) => !insideFixedOnly(el) && !containedX(el);
    const wide = rendered.filter((el) => reach(el) > vw + 1 && free(el));
    // The outermost wide element is the culprit; its children are just along
    // for the ride. The one reaching furthest comes first.
    const inWide = new Set(wide);
    const outer = wide.filter((el) => !inWide.has(el.parentElement));
    // Text can run further still, out of a box that stays on screen.
    const textReach = (el) => el.getBoundingClientRect().left + el.scrollWidth;
    const spilled = deepest(rendered.filter((el) => !rtl && el !== document.body && !inWide.has(el) && textReach(el) > vw + 1 && !hides(css(el).overflowX) && free(el)));
    for (const el of spilled) reachOf.set(el, textReach(el));
    const culprits = [...outer, ...spilled].filter((el) => !ignored(el)).sort((a, b) => far(b) - far(a));
    for (const el of culprits) {
      push("page-overflow", el, { pageWidth: root.scrollWidth, viewportWidth: vw, right: Math.round(far(el)) });
    }
    // The page still scrolls when the culprit has no element to measure,
    // such as a ::before or ::after layer.
    if (!outer.length && !spilled.length) push("page-overflow", document.body, { pageWidth: root.scrollWidth, viewportWidth: vw, right: 0 });
  }

  // ---------- 2. text spills or is cut off sideways ----------

  const spill = [];
  const clip = [];
  const textWidth = new Map();
  const textGap = new Map();
  for (const el of elements) {
    if (el.clientWidth === 0 || FORM.has(el.tagName) || el.scrollWidth <= el.clientWidth + 2 || !holdsText(el) || inSlot(el)) continue;
    const s = css(el);
    if (scrolls(s.overflowX)) continue;
    if (decorative(el)) continue;
    // Only text that really runs past the edge counts. scrollWidth alone
    // also counts invisible hit areas (::before, ::after) and positioned layers.
    const t = textBox(el);
    const past = textPast(el);
    if (past <= 2) continue;
    textWidth.set(el, Math.round(t.right - t.left));
    textGap.set(el, Math.round(past));
    if (hides(s.overflowX)) {
      if (s.textOverflow === "ellipsis" || clamped(s)) continue;
      // Text pushed wholly out of its box (text-indent on a logo) is hidden on purpose.
      if (past >= t.right - t.left) continue;
      if (animating(el) || isSlot(el)) continue;
      clip.push(el);
    } else {
      spill.push(el);
    }
  }
  // Spill only matters when it lands on something: a neighbour, or past
  // the edge of its container. Running into an empty gap is harmless.
  const spillHurts = (el) => {
    const r = el.getBoundingClientRect();
    const rtl = css(el).direction === "rtl";
    const from = rtl ? r.right - el.scrollWidth : r.right;
    const to = rtl ? r.left : r.left + el.scrollWidth;
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    const parent = el.parentElement;
    if (!parent) return true;
    const p = parent.getBoundingClientRect();
    const ps = css(parent);
    const inner = { left: p.left + parseFloat(ps.borderLeftWidth), right: p.right - parseFloat(ps.borderRightWidth) };
    if (lo < inner.left - 1 || hi > inner.right + 1) return true;
    for (const sib of parent.children) {
      if (sib === el || !isVisible(sib)) continue;
      const o = sib.getBoundingClientRect();
      const sameRow = o.top < r.bottom - 1 && o.bottom > r.top + 1;
      if (sameRow && o.left < hi - 1 && o.right > lo + 1) return true;
    }
    return false;
  };
  // The gap is the text past the edge, so padding can't skew it.
  const widths = (el) => ({ contentWidth: textWidth.get(el), boxWidth: textWidth.get(el) - textGap.get(el), gap: textGap.get(el) });
  for (const el of deepest(spill).filter(spillHurts)) {
    push("spill-x", el, { ...widths(el), longestWord: longestWord(el), whiteSpace: css(el).whiteSpace, wraps: fitsWith(el, WRAP), breaks: fitsWith(el, BREAK) });
  }
  for (const el of deepest(clip)) {
    push("clip-x", el, { ...widths(el), longestWord: longestWord(el), reveals: fitsWith(el, REVEAL) });
  }

  // ---------- 3. flex and grid containers that overflow ----------

  const grids = [];
  for (const el of elements) {
    const s = css(el);
    // Under 8 px is usually a deliberate negative margin (a bigger hit area), not a break.
    if (el.scrollWidth <= el.clientWidth + 8 || scrolls(s.overflowX) || hides(s.overflowX)) continue;
    if (decorative(el) || flowOverflow(el) <= 8) continue;

    if (s.display.includes("flex") && !s.flexDirection.startsWith("column") && s.flexWrap === "nowrap") {
      const items = [...el.children].filter((c) => isVisible(c) && css(c).minWidth === "auto" && !scrolls(css(c).overflowX) && !hides(css(c).overflowX));
      if (!items.length) continue;
      // Items wider than an equal share of the row are the ones refusing to shrink.
      const share = el.clientWidth / items.length;
      const over = flowOverflow(el);
      // Test the cause: let every item shrink and see whether the row fits.
      const confirmed = trial(items, { "min-width": "0" }, () => flowOverflow(el) <= 2);
      if (!confirmed && isTrack(el)) continue;
      for (const item of items.filter((c) => c.getBoundingClientRect().width > share).slice(0, 3)) {
        push("flex-shrink", item, { container: selectorFor(el), containerWidth: el.clientWidth, contentWidth: el.clientWidth + over, itemWidth: Math.round(item.getBoundingClientRect().width), longestWord: longestWord(item), confirmed });
      }
    }

    if (s.display.includes("grid")) grids.push(el);
  }
  // A grid inside a grid that blows out takes its parent with it: report
  // the innermost one, where the fix goes.
  for (const el of deepest(grids)) {
    // Test the cause: give every item a minimum of zero and see whether the grid fits.
    const kids = [...el.children].filter(isVisible);
    const confirmed = trial(kids, { "min-width": "0" }, () => flowOverflow(el) <= 2);
    if (!confirmed && isTrack(el)) continue;
    push("grid-blowout", el, { containerWidth: el.clientWidth, contentWidth: el.clientWidth + flowOverflow(el), columns: css(el).gridTemplateColumns, confirmed });
  }

  // ---------- 4. fixed heights that can't fit their content ----------

  const tall = [];
  for (const el of elements) {
    if (el === document.body || el.clientHeight === 0) continue;
    if (el.scrollHeight <= el.clientHeight + 2) continue;
    const s = css(el);
    if (scrolls(s.overflowY)) continue;
    if (s.webkitLineClamp && s.webkitLineClamp !== "none") continue;
    // Icon glyphs (one or two characters) sit in fixed boxes on purpose.
    if ((el.textContent || "").trim().length <= 2) continue;
    if (FORM.has(el.tagName) || animating(el) || (hides(s.overflowY) && isSlot(el)) || inSlot(el) || decorative(el)) continue;
    // Only visible text that runs past the bottom edge counts, by more
    // than 4 px: a logo's hidden label or a descender doesn't.
    const t = textBox(el);
    if (!(t.bottom > el.getBoundingClientRect().bottom - parseFloat(s.borderBottomWidth) + 4)) continue;
    if (!hasFixedHeight(el)) continue;
    tall.push(el);
  }
  for (const el of deepest(tall)) {
    push("fixed-height", el, { contentHeight: el.scrollHeight, boxHeight: el.clientHeight, clipped: hides(css(el).overflowY) });
  }

  // ---------- 5. images ----------

  // The box around an image and where the next thing sits in it: if these
  // change when the image fails, the layout around it really moved.
  const surroundings = (img) => {
    const first = img.closest("picture") ?? img;
    const p = first.parentElement.getBoundingClientRect();
    const next = first.nextElementSibling;
    return { width: Math.round(p.width), height: Math.round(p.height), next: next ? Math.round(next.getBoundingClientRect().top - p.top) : 0 };
  };
  const images = [...document.images].map((img) => {
    const r = img.getBoundingClientRect();
    return { src: img.currentSrc || img.src, selector: selectorFor(img), label: labelFor(img), width: Math.round(r.width), height: Math.round(r.height), box: box(img), visible: isVisible(img) && !ignored(img), around: surroundings(img) };
  });

  for (const img of document.images) {
    if (!img.complete || img.naturalWidth === 0 || !isVisible(img) || ignored(img) || img.closest("[aria-hidden='true']")) continue;
    const s = css(img);
    if (s.objectFit !== "fill") continue;
    const w = img.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
    const h = img.clientHeight - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom);
    if (w < 16 || h < 16) continue;
    const natural = img.naturalWidth / img.naturalHeight;
    const shown = w / h;
    if (Math.abs(shown - natural) / natural > 0.05) {
      push("img-distorted", img, { naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, shownWidth: Math.round(w), shownHeight: Math.round(h) });
    }
  }

  // ---------- 6. tap targets (touch screens only) ----------

  if (checkTapTargets) {
    const controls = elements.filter((el) => el.matches("a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button]") && !decorative(el) && !cutOff(el));
    const rects = controls.map((el) => el.getBoundingClientRect());
    // A fixed panel floats over whatever scrolls under it: only compare
    // targets that move together.
    const layer = controls.map((el) => insideFixed(el));
    // WCAG 2.5.8: a target under 24 x 24 px still passes when a 24 px circle
    // centred on it touches no other target and no other small target's circle.
    const small = (r) => r.width < 24 || r.height < 24;
    const circleHits = (cx, cy, r) => {
      const nx = Math.max(r.left, Math.min(cx, r.right));
      const ny = Math.max(r.top, Math.min(cy, r.bottom));
      return Math.hypot(cx - nx, cy - ny) < 12;
    };
    controls.forEach((el, i) => {
      const r = rects[i];
      if (!small(r)) return;
      // Links inside a sentence are exempt in WCAG 2.5.8.
      if (el.tagName === "A" && css(el).display === "inline" && el.parentElement && (el.parentElement.textContent || "").trim().length > (el.textContent || "").trim().length + 10) return;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const crowded = controls.some((other, j) => {
        if (j === i || other.contains(el) || el.contains(other) || layer[j] !== layer[i]) return false;
        const o = rects[j];
        if (circleHits(cx, cy, o)) return true;
        return small(o) && Math.hypot(cx - (o.left + o.width / 2), cy - (o.top + o.height / 2)) < 24;
      });
      if (crowded) push("tap-small", el, { width: Math.round(r.width), height: Math.round(r.height) });
    });
  }

  // ---------- 7. button labels that wrap onto a second line ----------

  if (checkLabels) {
    // Lines of visible text only: an icon or chevron beside the label isn't a line.
    const lines = (el) => textBox(el).lines.length;
    const buttons = elements.filter((el) => {
      if (!isButton(el)) return false;
      const text = (el.textContent || "").trim().replace(/\s+/g, " ");
      if (!text || text.length > 80) return false;
      // Cards and big links that happen to be clickable are not buttons.
      if (el.querySelector("h1, h2, h3, h4, h5, h6, p, img, video, ul, ol, table")) return false;
      if (el.getBoundingClientRect().height > 120) return false;
      return true;
    });
    // A title stacked over a description is two lines on purpose.
    const stacked = (el) => [...el.querySelectorAll("*")].some((c) => /^(block|flex|grid|list-item|table)$/.test(css(c).display) && (c.textContent || "").trim());
    // The ellipsis may sit on the button, or on a span inside it.
    const cutBox = (el) =>
      [el, ...el.querySelectorAll("*")].find((n) => {
        const s = css(n);
        return (s.textOverflow === "ellipsis" || (s.webkitLineClamp && s.webkitLineClamp !== "none")) && hides(s.overflowX) && n.scrollWidth > n.clientWidth + 1;
      });

    // The room a button could have: the content width of the nearest
    // block-level ancestor. If the row wrapped, the button could use all of it.
    const room = (el) => {
      for (let n = el.parentElement; n && n !== root; n = n.parentElement) {
        const s = css(n);
        if (/inline|contents/.test(s.display)) continue;
        return n.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
      }
      return vw;
    };
    // How wide the button would be with its label on one line.
    const oneLineWidth = (el) =>
      withStyles(el, { "white-space": "nowrap", width: "max-content", "max-width": "none", "min-width": "0", flex: "none" }, () => el.getBoundingClientRect().width);

    for (const el of deepest(buttons)) {
      // A cut-off label is worse than a wrapped one: the action is unreadable.
      const cut = cutBox(el);
      if (cut) {
        push("label-truncated", el, { contentWidth: cut.scrollWidth, boxWidth: cut.clientWidth, reveals: withStyles(cut, REVEAL, () => cut.scrollWidth <= cut.clientWidth + 1) });
        continue;
      }
      if (stacked(el)) continue;
      const n = lines(el);
      if (n < 2) continue;
      // Wrapping is fine when the label can't fit one line even with the
      // whole row to itself. It's a bug when one line would have fit.
      const needed = oneLineWidth(el);
      const available = room(el);
      if (needed <= available + 1) push("label-wrap", el, { lines: n, width: Math.round(el.getBoundingClientRect().width), needed: Math.ceil(needed), available: Math.round(available) });
    }
  }

  // ---------- 8. fixed panels that run off a small screen ----------

  if (checkFixed) {
    const vh = window.innerHeight;
    const scrollsInside = (el) =>
      [el, ...el.querySelectorAll("*")].some((n) => scrolls(css(n).overflowY) && n.scrollHeight > n.clientHeight + 2);
    for (const el of elements) {
      if (css(el).position !== "fixed") continue;
      if (el.parentElement && el.parentElement !== document.body && insideFixed(el.parentElement)) continue;
      const r = el.getBoundingClientRect();
      // Panels parked off screen (closed drawers, hidden sheets) aren't open.
      if (r.top >= vh - 1 || r.bottom <= 1 || r.right <= 1 || r.left >= vw - 1) continue;
      // Only panels with something to reach: they hold text or controls.
      if (!(el.textContent || "").trim()) continue;
      const below = r.bottom - vh;
      const above = -r.top;
      // A sideways page scrollbar takes its height from the screen, not from
      // 100dvh. That is the page's overflow, which has its own card.
      if (Math.max(below, above) <= 8 + vh - root.clientHeight || scrollsInside(el)) continue;
      // Test the cause: cap the height and see whether the panel fits.
      const fits = withStyles(el, { "max-height": "100dvh", "overflow-y": "auto" }, () => {
        const capped = el.getBoundingClientRect();
        return capped.bottom <= vh + 1 && capped.top >= -1;
      });
      push("fixed-offscreen", el, { height: Math.round(r.height), viewportHeight: vh, hidden: Math.round(Math.max(below, 0) + Math.max(above, 0)), fits });
    }
  }

  checkOverlays();

  // ---------- 10. scrollbars that land on content ----------

  if (checkBars) {
    // What a bar can land on: a control's own box when you can see it, or
    // else what it shows. A full-width row with padding keeps its text clear.
    const reach = (el) => (isSurface(el) ? el.getBoundingClientRect().right : (inkBox(el, shownAcross)?.right ?? el.getBoundingClientRect().right));
    // A carousel inside the scroller keeps its own overflow: what runs past
    // its edge isn't under the bar.
    const heldBelow = (c, el) => {
      for (let n = c.parentElement; n && n !== el; n = n.parentElement) if (css(n).overflowX !== "visible") return true;
      return false;
    };
    const besideIt = (el, r) => [...(el.parentElement?.children ?? [])].some((sib) => {
      if (sib === el || !isVisible(sib)) return false;
      const o = sib.getBoundingClientRect();
      return o.left >= r.right - 1 && o.top < r.bottom - 1 && o.bottom > r.top + 1;
    });
    for (const el of elements) {
      const s = css(el);
      if (!scrolls(s.overflowY) || el.scrollHeight <= el.clientHeight + 2 || el.clientHeight < 48 || FORM.has(el.tagName) || decorative(el)) continue;
      // Caliper's browser draws classic bars, so a bar that takes no room was
      // hidden on purpose (scrollbar-width: none, ::-webkit-scrollbar).
      const r = el.getBoundingClientRect();
      const borders = parseFloat(s.borderLeftWidth) + parseFloat(s.borderRightWidth);
      if (el.offsetWidth - el.clientWidth - borders <= 0) continue;
      const inside = [...el.querySelectorAll(CONTROL)].filter((c) => isVisible(c) && !inactive(c) && !heldBelow(c, el));
      const contentRight = inside.length ? Math.max(...inside.map(reach)) : -Infinity;
      // From where the bar starts, not the outer edge: content beside a
      // classic bar is the same content an overlay bar would land on.
      const edge = r.left + el.clientLeft + el.clientWidth;
      const gap = edge - contentRight;
      // A scroller with no edge of its own can't show where its bar belongs.
      // Far from the panel's edge it is a column, not a misplaced gutter.
      const panel = surfaceOf(el);
      const panelRight = panel ? panel.getBoundingClientRect().right - parseFloat(css(panel).borderRightWidth) : vw;
      const inset = Math.round(panelRight - r.right);
      const floats = !isSurface(el) && inset >= 4 && inset <= 48 && !besideIt(el, r);
      // Under 4 px it touches the bar. The fixes leave at least that much.
      const near = contentRight !== -Infinity && gap < 4;
      if (floats || near) push("bar-over-content", el, { right: Math.round(r.right), panelRight: Math.round(panelRight), inset: floats ? inset : 0, edge: Math.round(edge), contentRight: near ? Math.round(contentRight) : 0, gap: near ? Math.max(0, Math.round(gap)) : -1 });
    }
  }

  // ---------- 11. controls past the edge of their container ----------

  {
    const isControl = (el) => (el.matches("a[href]") ? isButton(el) : el.matches("button, [role=button], input:not([type=hidden]), select, textarea, [role=switch], [role=tab]"));
    const pastEdges = (el, c) => {
      const r = el.getBoundingClientRect();
      const s = css(el);
      // A negative margin pulls a control past the edge on purpose.
      const pulled = (side) => Math.min(0, parseFloat(s[`margin${side}`]) || 0);
      return {
        right: r.right + pulled("Right") - c.right,
        left: c.left - r.left + pulled("Left"),
        bottom: r.bottom + pulled("Bottom") - c.bottom,
        top: c.top - r.top + pulled("Top"),
      };
    };
    for (const el of elements) {
      if (!isControl(el)) continue;
      const surface = surfaceOf(el);
      if (!surface || positionedWithin(el, surface) || decorative(el) || cutOff(el) || inSlot(el)) continue;
      const c = surface.getBoundingClientRect();
      const edges = pastEdges(el, c);
      // Inside a scroller, passing the edge in the scroll direction is normal.
      const rows = [];
      for (let n = el.parentElement; n; n = n.parentElement) {
        const s = css(n);
        if (scrolls(s.overflowX)) edges.left = edges.right = 0;
        if (scrolls(s.overflowY)) edges.top = edges.bottom = 0;
        if (s.display.includes("flex") && !s.flexDirection.startsWith("column")) rows.push(n);
        if (n === surface) break;
      }
      const [side, past] = Object.entries(edges).sort((a, b) => b[1] - a[1])[0];
      if (past <= 2) continue;
      // Test the cause: let every item in the rows shrink and see whether it comes back.
      const items = rows.flatMap((row) => [...row.children].filter(isVisible));
      const shrinks = items.length > 0 && trial(items, { "min-width": "0" }, () => pastEdges(el, c)[side] <= 2);
      push("control-past", el, { side, past: Math.ceil(past), container: labelFor(surface), clipped: hides(css(surface).overflowX), shrinks });
    }
  }

  // ---------- 12. words split across two lines ----------

  if (checkWords) {
    // Only an ordinary word counts: URLs and codes have to break, and
    // anything longer than 30 letters belongs to content/long-word.
    const WORD = /^[^\p{L}\d]*((?:\p{Script=Latin}|\p{Script=Cyrillic}|\p{Script=Greek}|\p{M}){3,30})[^\p{L}\d]*$/u;
    const breakable = (s) => /anywhere|break-word/.test(s.overflowWrap) || /break-all|break-word/.test(s.wordBreak) || s.lineBreak === "anywhere";
    const blockOf = (el) => {
      let n = el;
      while (n.parentElement && css(n).display.startsWith("inline")) n = n.parentElement;
      return n;
    };
    const range = document.createRange();
    const linesOf = (rects) => rects.some((r) => Math.abs(r.top - rects[0].top) >= rects[0].height * 0.5);
    const rectsOf = (node, from, to) => {
      range.setStart(node, from);
      range.setEnd(node, to);
      return [...range.getClientRects()].filter((r) => r.width >= 1);
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const done = new Set();
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const el = node.parentElement;
      // Text the stress test rewrote isn't the page's own, so it proves nothing.
      if (!el || done.has(el) || SKIP.has(el.tagName) || !node.nodeValue.trim() || globalThis.__caliperOriginal?.has(node)) continue;
      const s = css(el);
      if (!breakable(s) || s.hyphens === "auto" || el.closest("pre, code, kbd, samp, textarea, svg, [aria-hidden='true']") || ignored(el) || !isVisible(el) || decorative(el)) continue;
      // A skip link clipped to nothing has no words to read until it is focused.
      const shown = shownBox(el);
      if (shown.right - shown.left <= 1 || shown.bottom - shown.top <= 1) continue;
      for (const m of node.nodeValue.matchAll(/\S+/g)) {
        const word = m[0].match(WORD)?.[1];
        if (!word) continue;
        const from = m.index + m[0].indexOf(word);
        const to = from + word.length;
        const rects = rectsOf(node, from, to);
        if (rects.length < 2 || !linesOf(rects)) continue;
        let split = 1;
        while (split < word.length - 1 && !linesOf([rects[0], ...rectsOf(node, from + split, from + split + 1)])) split++;
        const block = blockOf(el);
        const b = css(block);
        const whole = withStyles(el, { "overflow-wrap": "normal", "word-break": "normal", "line-break": "auto" }, () => !linesOf(rectsOf(node, from, to)) && textPast(block) <= 2);
        push("word-broken", el, { word, head: word.slice(0, split), tail: word.slice(split), wordWidth: Math.ceil(rects.reduce((sum, r) => sum + r.width, 0)), room: Math.round(block.clientWidth - parseFloat(b.paddingLeft) - parseFloat(b.paddingRight)), whole });
        done.add(el);
        break;
      }
    }
  }

  // What Caliper can't measure: a page that drew nothing, and content sealed
  // inside iframes and shadow roots.
  const sealed = elements.filter((el) => el.tagName === "IFRAME" || el.shadowRoot);
  const empty = !sealed.length && !(document.body.innerText || "").trim() && !document.querySelector("img, svg, video, canvas, iframe, object, embed");
  const frames = sealed.filter((el) => el.tagName === "IFRAME");
  const shadow = sealed.filter((el) => el.shadowRoot);
  // How much of the page is out of reach: frames by the area they cover,
  // shadow roots by the elements inside them.
  const frameArea = frames.reduce((sum, el) => sum + el.getBoundingClientRect().width * el.getBoundingClientRect().height, 0);
  const shadowed = shadow.reduce((sum, el) => sum + el.shadowRoot.querySelectorAll("*").length, 0);
  const pageArea = Math.max(1, vw * document.body.getBoundingClientRect().height);
  const unseen = { frames: frames.length, shadow: shadow.length, share: Math.min(1, Math.max(frameArea / pageArea, shadowed / (shadowed + elements.length))) };

  // Kinds that hit the per-kind limit: the report says more may exist.
  // Page overflow is one card per scenario anyway, so its cap hides nothing.
  const capped = [...new Set(findings.map((f) => f.kind))].filter((k) => k !== "page-overflow" && findings.filter((f) => f.kind === k).length >= MAX_PER_KIND);
  return { findings, images, capped, empty, unseen, pageWidth: root.scrollWidth, pageHeight: root.scrollHeight, viewportWidth: vw };
};
