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
  // A trial that shrinks the page can clamp the scroll position: the full
  // measurement puts it back where it found it.
  const startScroll = [window.scrollX, window.scrollY];
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

  // A slot whose overflow is one child running past it, with nothing
  // stacked (a name pushing out of a pill, a photo wider than its card), is
  // a box clipping its content, not a carousel.
  const isCarousel = (el) => {
    if (!isSlot(el)) return false;
    const box = el.getBoundingClientRect();
    const kids = [...el.children].filter((c) => css(c).display !== "none").map((c) => c.getBoundingClientRect());
    const past = kids.filter((k) => k.right > box.right + 2 || k.left < box.left - 2 || k.bottom > box.bottom + 2 || k.top < box.top - 2).length;
    if (past !== 1) return true;
    return kids.some((a, x) => kids.some((b, y) => y > x && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5 * Math.min(a.height, b.height) && Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 * Math.min(a.width, b.width)));
  };
  const inCarousel = (el) => {
    let n = el.parentElement;
    for (let i = 0; n && n !== document.body && i < 4; i++, n = n.parentElement) {
      const s = css(n);
      if ((hides(s.overflowY) || hides(s.overflowX)) && isCarousel(n)) return true;
    }
    return false;
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
  const listed = new Set(elements);
  const drawn = new Set(rendered.filter((el) => !ignored(el)));

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

  // The same past the left edge: a row packed to the end (justify-content:
  // flex-end, row-reverse, right to left) overflows there, where nobody can
  // scroll to it.
  const flowLeft = (el) => {
    const r = el.getBoundingClientRect();
    const s = css(el);
    const inner = r.left + parseFloat(s.borderLeftWidth) + parseFloat(s.paddingLeft);
    let left = Infinity;
    for (const c of el.children) {
      const cs = css(c);
      if (cs.position === "absolute" || cs.position === "fixed" || !isVisible(c)) continue;
      const k = c.getBoundingClientRect();
      if (k.width <= 2 || k.height <= 2) continue;
      left = Math.min(left, k.left - Math.min(0, parseFloat(cs.marginLeft) || 0));
    }
    return left === Infinity ? 0 : Math.round(inner - left);
  };
  const spillOf = (el) => Math.max(flowOverflow(el), flowLeft(el));

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
  // Put on temporary styles, and take them off exactly: the old values with
  // their priority, and no empty style attribute left behind.
  const wear = (el, styles) => {
    const saved = { bare: !el.hasAttribute("style"), list: Object.keys(styles).map((k) => [k, el.style.getPropertyValue(k), el.style.getPropertyPriority(k)]) };
    for (const [k, v] of Object.entries(styles)) el.style.setProperty(k, v, "important");
    return saved;
  };
  const unwear = (el, saved) => {
    for (const [k, v, prio] of saved.list) v ? el.style.setProperty(k, v, prio) : el.style.removeProperty(k);
    if (saved.bare && el.getAttribute("style") === "") el.removeAttribute("style");
  };
  const withStyles = (el, styles, measure) => {
    const saved = wear(el, styles);
    try {
      return measure();
    } finally {
      unwear(el, saved);
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

  // ---------- stylesheets ----------

  // The style rules of every stylesheet the page can read (same origin),
  // with those inside @media, @supports, @layer and nesting that apply now.
  let styleRules;
  const rulesOf = () => {
    if (styleRules) return styleRules;
    styleRules = [];
    const walk = (list) => {
      for (const rule of list) {
        if (rule.media && rule.cssRules && !matchMedia(rule.media.mediaText).matches) continue;
        // Whether a container query holds can't be read per element from
        // here, so its rules are left out rather than guessed.
        if (typeof CSSContainerRule !== "undefined" && rule instanceof CSSContainerRule) continue;
        if (typeof CSSSupportsRule !== "undefined" && rule instanceof CSSSupportsRule && !CSS.supports(rule.conditionText)) continue;
        if (typeof rule.selectorText === "string" && rule.style) styleRules.push(rule);
        if (rule.cssRules) walk(rule.cssRules);
      }
    };
    for (const sheet of document.styleSheets) {
      try { walk(sheet.cssRules); } catch { /* another origin's sheet can't be read */ }
    }
    return styleRules;
  };
  // The values a property is given for an element: inline first, then the
  // rules from last to first (source order, not specificity).
  const authored = (el, prop) => [el.style.getPropertyValue(prop), ...rulesOf().filter((r) => {
    try { return el.matches(r.selectorText); } catch { return false; }
  }).map((r) => r.style.getPropertyValue(prop)).reverse()].filter(Boolean);
  // Split a list at its top-level commas: "a, :is(b, c)" is two parts.
  const splitTop = (text) => {
    const parts = [];
    let depth = 0;
    let from = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === "(" || c === "[") depth++;
      else if (c === ")" || c === "]") depth--;
      else if (c === "," && depth === 0) {
        parts.push(text.slice(from, i).trim());
        from = i + 1;
      }
    }
    parts.push(text.slice(from).trim());
    return parts.filter(Boolean);
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
  const MODAL = "dialog, [role=dialog], [role=alertdialog], [aria-modal=true]";
  // A banner people can close (cookies, a promo) is in the way only until they do.
  const DISMISS = /^(accept|agree|allow|got it|ok(ay)?|dismiss|close|reject|decline|no,? thanks|×|✕|✖|x)(?!\p{L})/iu;
  const dismissible = (el) => [...el.querySelectorAll("button, [role=button], a")].some((b) => DISMISS.test((b.getAttribute("aria-label") || b.textContent || "").trim()));
  // Scroll the page without smooth scrolling, so a measurement sees the result at once.
  const jump = (y) => window.scrollTo({ left: window.scrollX, top: y, behavior: "instant" });
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
      return list.map((el) => {
        const control = el.tagName === "svg" && !el.querySelector("title") && el.closest("button, a[href], [role=button]");
        return { selector: selectorFor(el), label: control ? `${labelFor(el)} in ${labelFor(control)}` : labelFor(el), role: "box", box: box(el) };
      });
    },

    // Hide or invert every image for one screenshot, and put them back.
    mediaStyle: ({ look }) => {
      const worn = (globalThis.__caliperWorn ??= new Map());
      for (const [el, saved] of worn) unwear(el, saved);
      worn.clear();
      if (!look) return true;
      for (const el of globalThis.__caliperMedia ?? []) {
        const filter = css(el).filter;
        const styles = { transition: "none", animation: "none", ...(look === "hide" ? { visibility: "hidden" } : { filter: `${filter === "none" ? "" : `${filter} `}invert(1)` }) };
        worn.set(el, wear(el, styles));
      }
      return true;
    },

    // ---------- backgrounds: tiles that repeat by accident, and stretched ones ----------

    backgrounds: async () => {
      const sizes = new Map();
      const natural = (url) => {
        if (!sizes.has(url)) {
          sizes.set(url, new Promise((done) => {
            const img = new Image();
            const timer = setTimeout(() => done(null), 3000);
            img.onload = () => { clearTimeout(timer); done(img.naturalWidth && img.naturalHeight ? [img.naturalWidth, img.naturalHeight] : null); };
            img.onerror = () => { clearTimeout(timer); done(null); };
            img.src = url;
          }));
        }
        return sizes.get(url);
      };
      const resolve = (v, total) => (v === "auto" || v === undefined ? null : v.endsWith("%") ? (total * parseFloat(v)) / 100 : parseFloat(v));
      const tileOf = (size, [nw, nh], W, H) => {
        if (size === "cover" || size === "contain") {
          const k = (size === "cover" ? Math.max : Math.min)(W / nw, H / nh);
          return { w: nw * k, h: nh * k, both: false, relative: true };
        }
        const [a, b = "auto"] = size.split(/\s+/);
        let w = resolve(a, W);
        let h = resolve(b, H);
        const both = w !== null && h !== null;
        if (w === null && h === null) [w, h] = [nw, nh];
        else if (w === null) w = (h * nw) / nh;
        else if (h === null) h = (w * nh) / nw;
        return { w, h, both, relative: /%/.test(size) };
      };
      const axes = (repeat) => {
        const [a, b] = repeat.split(/\s+/);
        if (b) return [a, b];
        return a === "repeat-x" ? ["repeat", "no-repeat"] : a === "repeat-y" ? ["no-repeat", "repeat"] : [a, a];
      };
      for (const el of elements) {
        const s = css(el);
        // role=img on the element itself is how a background photo is
        // labelled, so it counts; inside a mock-up it doesn't.
        if (!s.backgroundImage.includes("url(") || el.matches("[role=presentation], [role=none]") || (el.parentElement && decorative(el.parentElement))) continue;
        const W = el.clientWidth;
        const H = el.clientHeight;
        if (W < 16 || H < 16) continue;
        const images = splitTop(s.backgroundImage);
        const bgSizes = splitTop(s.backgroundSize);
        const repeats = splitTop(s.backgroundRepeat);
        const places = splitTop(s.backgroundPosition);
        for (let i = 0; i < images.length; i++) {
          const url = images[i].match(/^url\(["']?(.*?)["']?\)$/)?.[1];
          if (!url) continue;
          const nat = await natural(new URL(url, document.baseURI).href);
          if (!nat) continue;
          const size = bgSizes[i % bgSizes.length];
          const tile = tileOf(size, nat, W, H);
          const svg = /^data:image\/svg|\.svg($|[?#])/i.test(url);
          const ratio = nat[0] / nat[1];
          if (tile.both && !svg && Math.abs(tile.w / tile.h - ratio) / ratio > 0.05) {
            push("img-distorted", el, { naturalWidth: nat[0], naturalHeight: nat[1], shownWidth: Math.round(tile.w), shownHeight: Math.round(tile.h), background: true });
          }
          const [rx, ry] = axes(repeats[i % repeats.length]);
          const place = places[i % places.length];
          // A small tile repeated from the corner is a pattern on purpose.
          // A tile that is big, sized to the box, or placed at an offset
          // (a corner mark) only repeats by accident.
          const placed = /right|bottom|[1-9]/.test(place.replace(/\b0(px|%)?/g, "")) && !/center|50%/.test(place);
          const accident = (t, total) => t < total - 1 && (t >= total * 0.5 || tile.relative || (placed && t >= 24));
          const x = rx === "repeat" && accident(tile.w, W);
          const y = ry === "repeat" && accident(tile.h, H);
          // A full-width band whose tile is fixed in size tiles on wider screens.
          const wideAt = !x && rx === "repeat" && !tile.relative && el.getBoundingClientRect().width >= vw - 1 && tile.w >= W - 1 && tile.w < 2560 ? Math.round(tile.w) : 0;
          if (x || y || wideAt) push("bg-tiles", el, { tileWidth: Math.round(tile.w), tileHeight: Math.round(tile.h), areaWidth: W, areaHeight: H, axis: x && y ? "both" : x ? "x" : y ? "y" : "x", wideAt });
        }
      }
      return answer();
    },

    // ---------- stylesheets: variables that resolve to nothing, rules the browser drops ----------

    sheets: async () => {
      // The var() references with no fallback: var(--a) counts, var(--a, 8px) doesn't.
      const bareVars = (value) => {
        const out = [];
        for (let i = value.indexOf("var("); i !== -1; i = value.indexOf("var(", i + 1)) {
          let depth = 0;
          let j = i + 3;
          for (; j < value.length; j++) {
            if (value[j] === "(") depth++;
            else if (value[j] === ")" && --depth === 0) break;
          }
          const inner = value.slice(i + 4, j);
          if (splitTop(inner).length === 1 && /^\s*--[\w-]+\s*$/.test(inner)) out.push(inner.trim());
          // A fallback's own references only matter when the variable is unset.
          if (splitTop(inner).length > 1) i = j;
        }
        return out;
      };
      const PSEUDO = /::?(before|after|placeholder|marker|selection|first-line|first-letter|backdrop|file-selector-button|-webkit-[\w-]+|-moz-[\w-]+)(\([^)]*\))?/g;
      const reported = new Set();
      for (const rule of rulesOf()) {
        for (const m of rule.style.cssText.matchAll(/(?:^|;)\s*([-\w]+)\s*:\s*([^;]+)/g)) {
          const [, prop, value] = m;
          if (prop.startsWith("--") || !value.includes("var(")) continue;
          for (const name of bareVars(value)) {
            const key = `${name}|${prop}`;
            if (reported.has(key)) continue;
            let els = [];
            try { els = [...document.querySelectorAll(rule.selectorText.replace(PSEUDO, "") || "*")].slice(0, 50); } catch { continue; }
            // Decorative icons count too: an unset fill hides them all the same.
            // And only where this declaration is the one in effect: setting the
            // variable must change the property, or a later rule overrides it.
            const pseudo = rule.selectorText.match(/::?(before|after|placeholder|marker)\b/)?.[0] ?? null;
            const read = (e) => getComputedStyle(e, pseudo).getPropertyValue(prop);
            const live = (e) => {
              const was = read(e);
              return ["1px", "red", "0", "2", "none", "auto", "10%", "block"].some((v) => withStyles(e, { [name]: v }, () => read(e) !== was));
            };
            const el = els.find((e) => drawn.has(e) && !css(e).getPropertyValue(name).trim() && live(e));
            if (!el) continue;
            reported.add(key);
            push("var-unresolved", el, { variable: name, property: prop, rule: rule.selectorText.slice(0, 120) });
          }
        }
      }

      // A selector list with one part this browser doesn't know drops the
      // whole rule: ::-webkit-input-placeholder, ::-moz-placeholder { … }.
      const texts = [];
      for (const sheet of document.styleSheets) {
        const node = sheet.ownerNode;
        try {
          if (node?.tagName === "STYLE") texts.push([node.textContent ?? "", "a <style> tag"]);
          else if (sheet.href && new URL(sheet.href).origin === location.origin) texts.push([await (await fetch(sheet.href, { cache: "force-cache" })).text(), sheet.href.split(/[?#]/)[0].split("/").pop()]);
        } catch { /* unreadable */ }
      }
      const VENDOR = /::?-(webkit|moz|ms|o)-/;
      const supported = (part) => {
        try { return CSS.supports(`selector(${part})`); } catch { return false; }
      };
      for (const [raw, sheet] of texts) {
        const text = raw.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
        for (const m of text.matchAll(/([^{};]+)\{/g)) {
          const prelude = m[1].trim();
          if (!prelude || prelude.startsWith("@") || !VENDOR.test(prelude)) continue;
          const parts = splitTop(prelude);
          if (parts.length < 2) continue;
          const bad = parts.filter((p) => !supported(p));
          const good = parts.filter((p) => supported(p));
          // Meant for this browser too (one part works here), and dropped.
          if (!bad.length || !good.length) continue;
          let el = document.body;
          for (const p of good) {
            try {
              const hit = [...document.querySelectorAll(p.replace(PSEUDO, "") || "*")].find((e) => listed.has(e));
              if (hit) { el = hit; break; }
            } catch { /* not a selector querySelector takes */ }
          }
          push("dropped-rule", el, { selector: prelude.replace(/\s+/g, " ").slice(0, 140), unsupported: bad.join(", ").slice(0, 80), sheet, line: text.slice(0, m.index + m[0].indexOf(m[1].trimStart())).split("\n").length });
        }
      }
      return answer();
    },

    // ---------- text laid over an image, for when the image fails ----------

    overImage: () => {
      // Any image the text sits on: a positioned photo under the text, or a
      // caption positioned over a photo in the flow.
      const layers = rendered.filter((el) => el.tagName === "IMG" || el.tagName === "VIDEO").map((el) => el.getBoundingClientRect());
      const list = [];
      for (const el of elements) {
        if (!hasOwnText(el) || decorative(el) || css(el).textShadow !== "none") continue;
        const t = textBox(el);
        if (t.right === -Infinity) continue;
        const area = (t.right - t.left) * (t.bottom - t.top);
        const covered = layers.some((r) => Math.max(0, Math.min(r.right, t.right) - Math.max(r.left, t.left)) * Math.max(0, Math.min(r.bottom, t.bottom) - Math.max(r.top, t.top)) >= area * 0.5);
        let painted = false;
        for (let n = el, i = 0; n && n !== document.body && i < 6 && !painted; n = n.parentElement, i++) painted = css(n).backgroundImage.includes("url(");
        if (!covered && !painted) continue;
        const s = css(el);
        list.push({ el, selector: selectorFor(el), label: labelFor(el), role: roleFor(el), box: { x: Math.round(t.left + window.scrollX), y: Math.round(t.top + window.scrollY), width: Math.round(t.right - t.left), height: Math.round(t.bottom - t.top) }, color: s.color, large: parseFloat(s.fontSize) >= 24 || (parseFloat(s.fontSize) >= 18.66 && Number(s.fontWeight) >= 700) });
        if (list.length >= 40) break;
      }
      globalThis.__caliperTexts = list.map((x) => x.el);
      return list.map(({ el, ...rest }) => rest);
    },

    // Hide the listed text for one screenshot, and put it back.
    textStyle: ({ hide }) => {
      const worn = (globalThis.__caliperTextWorn ??= new Map());
      for (const [el, saved] of worn) unwear(el, saved);
      worn.clear();
      if (!hide) return true;
      for (const el of globalThis.__caliperTexts ?? []) {
        worn.set(el, wear(el, { color: "transparent", "-webkit-text-fill-color": "transparent", "text-decoration-color": "transparent", transition: "none" }));
      }
      return true;
    },

    // ---------- scrolling an overlay past its end ----------

    // Scrollers laid over the page (a dialog, a drawer, a chat panel, an open
    // list) whose scrolling is passed on to the page at their end.
    chainers: () => {
      const page = root.scrollHeight > window.innerHeight + 2 && !hides(css(root).overflowY) && !hides(css(document.body).overflowY);
      if (!page) return [];
      return elements.filter((el) => {
        const s = css(el);
        if (!scrolls(s.overflowY) || el.scrollHeight <= el.clientHeight + 2 || el.clientHeight < 48 || s.overscrollBehaviorY !== "auto" || FORM.has(el.tagName) || decorative(el)) return false;
        return insideFixedOnly(el) || Boolean(el.closest(`${MODAL}, [role=listbox], [role=menu]`));
      }).slice(0, 6).map((el) => ({ selector: selectorFor(el), label: labelFor(el) }));
    },

    // Scroll the box to its end and the page to the top, and say where to
    // turn the wheel. With `contain`, try the fix as well.
    chainStart: ({ selector, contain }) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      globalThis.__caliperChain = { y: window.scrollY, top: el.scrollTop, worn: contain ? wear(el, { "overscroll-behavior-y": "contain" }) : null };
      jump(0);
      el.scrollTop = el.scrollHeight;
      const r = el.getBoundingClientRect();
      const [x, y] = [r.left + r.width / 2, r.top + r.height / 2];
      return x >= 0 && x < vw && y >= 0 && y < window.innerHeight ? { x, y } : null;
    },

    chainEnd: ({ selector, report, contained }) => {
      const el = document.querySelector(selector);
      const moved = window.scrollY > 0;
      const saved = globalThis.__caliperChain;
      if (el && saved) {
        if (saved.worn) unwear(el, saved.worn);
        globalThis.__caliperChain = null;
        el.scrollTop = saved.top;
        jump(saved.y);
      }
      if (report && el) push("chains-to-page", el, { contained });
      return { moved, ...answer() };
    },

    // ---------- touch screens: hover styles that stick, fields that zoom ----------

    // Elements with a :hover rule that applies on this screen (not inside
    // @media (hover: hover)) and changes more than colour.
    hoverRules: () => {
      const QUIET = /^(color|text-decoration|text-underline|cursor|transition|outline|caret|fill|stroke|-webkit-text-fill|text-emphasis|animation)/;
      const found = new Map();
      for (const rule of rulesOf()) {
        if (!rule.selectorText.includes(":hover") || ![...rule.style].some((p) => !QUIET.test(p) && !p.startsWith("--"))) continue;
        for (const part of splitTop(rule.selectorText)) {
          const host = part.split(":hover")[0].trim();
          if (!part.includes(":hover") || !host || /[>+~]$/.test(host) || found.has(host)) continue;
          let el;
          try { el = [...document.querySelectorAll(host)].find((e) => listed.has(e) && !decorative(e) && !e.closest(MODAL)); } catch { continue; }
          if (el) found.set(host, { selector: selectorFor(el), label: labelFor(el) });
        }
      }
      return [...found.values()].slice(0, 8);
    },

    // What a hover can change that matters on a touch screen: a lift or a
    // shadow, a fill where there was none, or parts that appear. A colour
    // shift on a link or a darker button doesn't count.
    touchLook: ({ selector }) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const parts = [el, ...[...el.querySelectorAll("*")].slice(0, 30)];
      return {
        lift: parts.map((p) => {
          const s = css(p);
          return [s.transform, s.translate, s.scale, s.boxShadow].join("|");
        }),
        fill: visibleFill(el),
        shown: parts.map((p) => {
          const s = css(p);
          return s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity) > 0.05;
        }),
      };
    },

    touchReport: ({ selector, revealed, change }) => {
      const el = document.querySelector(selector);
      if (el) push("sticks-on-touch", el, { revealed, change });
      return answer();
    },

    // Text fields under 16 px, which iOS zooms into when they take focus.
    // A viewport tag that blocks zooming stops that (and pinch zoom with it).
    fields: () => {
      const tag = document.querySelector("meta[name='viewport' i]")?.getAttribute("content") ?? "";
      if (/maximum-scale\s*=\s*1(\.0*)?(?![\d.])|user-scalable\s*=\s*(no|0)/i.test(tag)) return [];
      return elements.filter((el) => typesText(el) && !el.matches("[readonly], :disabled") && !decorative(el)).slice(0, 12).map((el) => ({ selector: selectorFor(el), label: labelFor(el) }));
    },

    fieldSize: ({ selector }) => {
      const el = document.querySelector(selector);
      return el ? parseFloat(css(el).fontSize) : null;
    },

    fieldReport: ({ selector, size }) => {
      const el = document.querySelector(selector);
      if (el) push("focus-zoom", el, { size: Math.round(size * 10) / 10 });
      return answer();
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
      // A set width is the usual cause: cap it at the screen and see.
      const width = authored(el, "width").find((v) => /^[\d.]+(px|rem|em)$/.test(v)) ?? "";
      const fits = withStyles(el, { "max-width": "100%", "min-width": "0" }, () => root.scrollWidth <= vw + 1);
      push("page-overflow", el, { pageWidth: root.scrollWidth, viewportWidth: vw, right: Math.round(far(el)), width, fits, media: el.matches("img, video, canvas, svg, iframe") });
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

  // Text cut by a box around it, not by its own: a name in a pill with a
  // fixed width and overflow: hidden. No ellipsis anywhere on the way.
  {
    const seen = new Set([...spill, ...clip]);
    const cutBy = [];
    for (const el of elements) {
      if (FORM.has(el.tagName) || !holdsText(el) || seen.has(el) || hides(css(el).overflowX) || inCarousel(el) || decorative(el)) continue;
      const r = el.getBoundingClientRect();
      for (let n = el.parentElement, i = 0; n && n !== document.body && i < 5; n = n.parentElement, i++) {
        const s = css(n);
        if (s.textOverflow === "ellipsis" || clamped(s) || scrolls(s.overflowX) || seen.has(n)) break;
        if (!hides(s.overflowX)) continue;
        const c = n.getBoundingClientRect();
        const inner = { left: c.left + parseFloat(s.borderLeftWidth), right: c.right - parseFloat(s.borderRightWidth) };
        if (Math.max(r.left + el.scrollWidth, r.right) <= inner.right + 2 && r.left >= inner.left - 2) break;
        const t = textBox(el);
        const past = Math.max(t.right - inner.right, inner.left - t.left);
        // Text pushed wholly out (a logo's hidden label) or a moving part is on purpose.
        if (past > 2 && past < t.right - t.left && !animating(n) && !isCarousel(n) && !inCarousel(n)) cutBy.push([el, n, past, t]);
        break;
      }
    }
    for (const [el, n, past, t] of cutBy.filter(([el]) => !cutBy.some(([other]) => other !== el && el.contains(other)))) {
      const reveals = withStyles(el, { ...BREAK, "max-width": "100%" }, () => {
        const k = textBox(el);
        const c = n.getBoundingClientRect();
        return k.right <= c.right + 2 && k.left >= c.left - 2;
      });
      push("clip-x", el, { contentWidth: Math.round(t.right - t.left), boxWidth: Math.round(t.right - t.left - past), gap: Math.round(past), longestWord: longestWord(el), reveals, by: labelFor(n) });
    }
  }

  // ---------- 3. flex and grid containers that overflow ----------

  // Grid tracks in px, from the computed value: "250px 1fr" computes to "250px 38px".
  const tracksOf = (el) => (css(el).gridTemplateColumns.match(/-?[\d.]+px/g) ?? []).map(parseFloat);
  const pageWide = () => root.scrollWidth > vw + 1;
  // Text an item shows past its own edges. Text cut by an ellipsis or a
  // clipping box doesn't count: nobody sees it.
  const clipBox = (el) => {
    const shown = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };
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
  const shownPast = (el) => {
    const r = el.getBoundingClientRect();
    const t = textBox(el, clipBox);
    return Math.max(t.right - r.right, r.left - t.left);
  };
  const textFits = (els) => els.every((c) => shownPast(c) <= 2);
  // Does anything inside this box push the page wider than the screen?
  const spillsPage = (el) => [el, ...el.querySelectorAll("*")].slice(0, 600).some((d) => d.getBoundingClientRect().right > vw + 1 && !containedX(d) && isVisible(d));

  const grids = [];
  for (const el of elements) {
    const s = css(el);
    const flex = s.display.includes("flex");
    if (!flex && !s.display.includes("grid")) continue;
    if (scrolls(s.overflowX) || hides(s.overflowX) || decorative(el)) continue;
    // Up to 3 px is rounding. Negative margins are left out of the measurement.
    const over = spillOf(el);
    if (over <= 3) continue;
    // A few pixels into its own padding (an icon a little wider than its
    // track) stays inside the box: nothing looks broken.
    if (over < 8 && over < Math.min(parseFloat(s.paddingLeft), parseFloat(s.paddingRight)) - 4) continue;
    if (!flex) {
      grids.push(el);
      continue;
    }
    if (s.flexDirection.startsWith("column") || s.flexWrap !== "nowrap") continue;
    const kids = [...el.children].filter((c) => isVisible(c) && !/absolute|fixed/.test(css(c).position));
    if (!kids.length) continue;
    const fits = () => spillOf(el) <= 2 && textFits(kids);
    const side = flowLeft(el) > flowOverflow(el) ? "left" : "right";
    const base = { container: selectorFor(el), containerWidth: el.clientWidth, contentWidth: el.clientWidth + over, side };
    const track = isTrack(el);

    // A set width that won't give way (a width plus flex: none) is the
    // cause, not the content. Release it and see.
    if (!track) {
      const rigid = kids.filter((c) => {
        const cs = css(c);
        if (parseFloat(cs.flexShrink) !== 0 || c.matches("img, svg, video, canvas, iframe, input, select, textarea")) return false;
        const w = c.getBoundingClientRect().width;
        return w > el.clientWidth / kids.length && withStyles(c, { width: "auto", "flex-basis": "auto" }, () => Math.abs(c.getBoundingClientRect().width - w) > 2);
      });
      if (rigid.length && trial(rigid, { "flex-shrink": "1", "min-width": "0" }, fits)) {
        for (const item of rigid.slice(0, 3)) push("fixed-width", item, { ...base, itemWidth: Math.round(item.getBoundingClientRect().width) });
        continue;
      }
    }

    // Scroll containers already shrink: their minimum is 0. overflow: clip
    // doesn't make one, and the browser gives images and form fields clip.
    const items = kids.filter((c) => {
      const cs = css(c);
      return cs.minWidth === "auto" && !scrolls(cs.overflowX) && cs.overflowX !== "hidden";
    });
    // Test the cause: let every item shrink, and check that the row fits
    // with each item's text still inside it. Failing that, let the row wrap.
    const confirmed = items.length > 0 && trial(items, { "min-width": "0" }, fits);
    if (!confirmed && track) continue;
    const wraps = !confirmed && withStyles(el, { "flex-wrap": "wrap" }, fits);
    // Items wider than an equal share of the row are the ones refusing to
    // shrink. The one furthest over its share leads.
    const share = el.clientWidth / kids.length;
    const lead = (items.length ? items : kids)
      .map((c) => [c, c.getBoundingClientRect().width - share])
      .filter(([, d]) => d > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
    for (const [item] of lead) {
      push("flex-shrink", item, { ...base, itemWidth: Math.round(item.getBoundingClientRect().width), longestWord: longestWord(item), confirmed, wraps, items: kids.length });
    }
  }
  // A grid inside a grid that blows out takes its parent with it: report
  // the innermost one, where the fix goes.
  for (const el of deepest(grids)) {
    const kids = [...el.children].filter(isVisible);
    const wasWide = pageWide();
    // Fitting means the grid fits and nothing in it still pushes the page wider.
    const fits = () => spillOf(el) <= 2 && !(wasWide && spillsPage(el));
    const confirmed = trial(kids, { "min-width": "0" }, fits);
    if (!confirmed && isTrack(el)) continue;
    // Columns that keep their size with no room at all are fixed: 250px,
    // repeat(3, 300px), minmax(240px, 1fr).
    const zero = withStyles(el, { width: "0px", "min-width": "0", "max-width": "0px" }, () => trial(kids, { "min-width": "0" }, () => tracksOf(el)));
    const fixedSum = Math.round(zero.filter((v) => v > 1).reduce((a, b) => a + b, 0));
    // Fixed columns are the cause when they take most of the room, or when
    // shrinking the content doesn't help.
    const fixedCause = fixedSum > 0 && (!confirmed || fixedSum > el.clientWidth * 0.6);
    const stacks = fixedCause && withStyles(el, { "grid-template-columns": "minmax(0, 1fr)" }, () => trial(kids, { "min-width": "0", "grid-column": "auto" }, fits));
    push("grid-blowout", el, {
      containerWidth: el.clientWidth,
      contentWidth: el.clientWidth + spillOf(el),
      columns: css(el).gridTemplateColumns,
      fixed: zero.map((v) => (v > 1 ? `${Math.round(v)}px` : "flex")).join(" "),
      fixedSum: fixedCause ? fixedSum : 0,
      confirmed: confirmed && !fixedCause,
      stacks,
    });
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
  // The items of the flex columns inside a box, a few levels down.
  const columnItems = (el, depth = 0) => {
    const s = css(el);
    if (depth > 3 || !s.display.includes("flex") || !s.flexDirection.startsWith("column")) return [];
    return [...el.children].filter(isVisible).flatMap((c) => [c, ...columnItems(c, depth + 1)]);
  };
  for (const el of deepest(tall)) {
    // In a flex column the set height may be right: an item that won't
    // shrink below its content (min-height: auto) stops the list inside
    // from scrolling. Test that before blaming the height.
    const items = columnItems(el).filter((c) => css(c).minHeight === "auto");
    if (items.length) {
      const before = new Map(items.map((c) => [c, c.getBoundingClientRect().height]));
      const shrunk = trial(items, { "min-height": "0" }, () => (el.scrollHeight <= el.clientHeight + 2 ? items.map((c) => [c, before.get(c) - c.getBoundingClientRect().height]) : null));
      if (shrunk) {
        const [item] = shrunk.sort((a, b) => b[1] - a[1])[0];
        push("flex-column", item, { container: selectorFor(el), containerHeight: el.clientHeight, contentHeight: el.scrollHeight, itemHeight: Math.round(before.get(item)) });
        continue;
      }
    }
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

  // How a flex or grid item lines up across the row: stretch fills the row's height.
  const alignOf = (el) => {
    const p = el.parentElement;
    if (!p) return "";
    const ps = css(p);
    if (!/flex|grid/.test(ps.display)) return "";
    const own = css(el).alignSelf;
    return own === "auto" ? ps.alignItems : own;
  };
  const stretches = (el) => /^(normal|stretch)$/.test(alignOf(el));

  for (const img of document.images) {
    if (!img.complete || img.naturalWidth === 0 || !isVisible(img) || ignored(img) || img.closest("[aria-hidden='true']")) continue;
    const s = css(img);
    const size = () => [img.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight), img.clientHeight - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom)];
    const [w, h] = size();
    if (w < 16 || h < 16) continue;
    const natural = img.naturalWidth / img.naturalHeight;
    const off = ([a, b]) => Math.abs(a / b - natural) / natural > 0.05;
    // An SVG keeps its shape in any box (preserveAspectRatio): it
    // letterboxes, it doesn't stretch. A round one still turns into an oval
    // when a row stretches its box.
    if (/^data:image\/svg|\.svg($|[?#])/i.test(img.currentSrc || img.src)) {
      if (!off([w, h]) || !stretches(img) || w > 96) continue;
      const own = withStyles(img, { "align-self": "flex-start" }, () => img.getBoundingClientRect());
      const radius = s.borderTopLeftRadius;
      const round = radius.endsWith("%") ? parseFloat(radius) >= 50 : parseFloat(radius) >= Math.min(own.width, own.height) / 2 - 1;
      if (round && own.height >= 8 && h >= own.height * 1.2) push("stretched-shape", img, { width: Math.round(img.clientWidth), height: Math.round(img.clientHeight), ownWidth: Math.round(own.width), ownHeight: Math.round(own.height), round });
      continue;
    }
    if (s.objectFit !== "fill") continue;
    if (off([w, h])) {
      // Test the usual cause in a row: the row stretches the image to its height.
      const stretched = stretches(img) && withStyles(img, { "align-self": "flex-start" }, () => !off(size()));
      push("img-distorted", img, { naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, shownWidth: Math.round(w), shownHeight: Math.round(h), stretched });
    }
  }

  // A square or round shape (an avatar, an icon tile, a step number) that
  // the row stretches to its own height, so a circle becomes a pill.
  // Initials avatars are often aria-hidden: their shape still shows.
  for (const el of rendered) {
    if (el.matches("img, svg, video, canvas, input, select, textarea, iframe") || ignored(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 96 || r.width < 8 || !stretches(el)) continue;
    const ps = css(el.parentElement);
    if (ps.display.includes("flex") && ps.flexDirection.startsWith("column")) continue;
    const s = css(el);
    if (/absolute|fixed/.test(s.position) || !isSurface(el) || decorative(el)) continue;
    const own = withStyles(el, { "align-self": "flex-start" }, () => el.getBoundingClientRect());
    if (own.height < 8 || r.height < own.height * 1.2) continue;
    const radius = s.borderTopLeftRadius;
    const round = radius.endsWith("%") ? parseFloat(radius) >= 50 : parseFloat(radius) >= Math.min(own.width, own.height) / 2 - 1;
    const square = Math.abs(own.width / own.height - 1) <= 0.12;
    if (!square && !round) continue;
    push("stretched-shape", el, { width: Math.round(r.width), height: Math.round(r.height), ownWidth: Math.round(own.width), ownHeight: Math.round(own.height), round });
  }

  // An image, video or canvas wider than the box it sits in, because
  // nothing caps it at the box (max-width: 100%).
  for (const el of elements) {
    if (!el.matches("img, video, canvas")) continue;
    const s = css(el);
    if (s.maxWidth !== "none" || /absolute|fixed/.test(s.position) || parseFloat(s.marginLeft) < 0 || parseFloat(s.marginRight) < 0 || decorative(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width >= vw - 1) continue; // full bleed on purpose
    // A carousel runs several slides past its edge, or stacks them. A card
    // that clips one wide image is the bug itself.
    if (inCarousel(el)) continue;
    let cb = el.parentElement;
    while (cb && cb !== document.body && /^(inline|contents)$/.test(css(cb).display)) cb = cb.parentElement;
    if (!cb) continue;
    const cs = css(cb);
    if (/flex|grid/.test(cs.display)) continue; // the row and grid checks cover these
    let scroller = false;
    for (let n = cb; n && n !== document.body; n = n.parentElement) if (scrolls(css(n).overflowX)) scroller = true;
    if (scroller) continue;
    const room = () => {
      const c = cb.getBoundingClientRect();
      const left = c.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
      const right = c.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight);
      const k = el.getBoundingClientRect();
      return { past: Math.max(k.right - right, left - k.left), width: right - left };
    };
    const { past, width } = room();
    if (past <= 1) continue;
    let clipped = false;
    for (let n = cb; n && n !== document.body; n = n.parentElement) if (hides(css(n).overflowX)) clipped = true;
    const fits = withStyles(el, { "max-width": "100%", height: "auto" }, () => room().past <= 1);
    push("wider-than-box", el, { width: Math.round(r.width), room: Math.round(width), past: Math.ceil(past), clipped, fits });
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

    // A button with a short label ("OK", "Go", a two-letter translation) and
    // no minimum width shrinks to a narrow chip that doesn't read as a button.
    for (const el of deepest(buttons)) {
      const text = (el.textContent || "").trim().replace(/\s+/g, " ");
      if (el.matches("[role=tab]") || cutBox(el) || !/\p{L}/u.test(text) || [...text].length > 24) continue;
      const r = el.getBoundingClientRect();
      if (r.width >= 44 && r.width >= r.height) continue;
      if (parseFloat(css(el).minWidth) > 0) continue;
      // Equal buttons side by side (a segmented control) are sized as a set.
      const set = [...(el.parentElement?.children ?? [])].filter((c) => c !== el && c.tagName === el.tagName && isVisible(c));
      if (set.length && set.every((c) => Math.abs(c.getBoundingClientRect().width - r.width) <= 1)) continue;
      push("short-button", el, { width: Math.round(r.width), height: Math.round(r.height), text: text.slice(0, 24) });
    }
  }

  // ---------- 8. fixed panels that run off a small screen ----------

  if (checkFixed) {
    const vh = window.innerHeight;
    const scrollsInside = (el) =>
      [el, ...el.querySelectorAll("*")].some((n) => scrolls(css(n).overflowY) && n.scrollHeight > n.clientHeight + 2);
    // A sticky panel taller than the screen: its end only comes into view
    // when its container runs out, often at the very end of the page.
    const tallSticky = (el) => {
      const s = css(el);
      if (s.top === "auto" || (el.parentElement && insideFixed(el.parentElement))) return;
      const top = parseFloat(s.top) || 0;
      const r = el.getBoundingClientRect();
      const room = vh - top;
      if (r.height <= room + 8 || !(el.textContent || "").trim() || scrollsInside(el)) return;
      // A parent no taller than the panel gives it no room to stick at all.
      if (!el.parentElement || el.parentElement.getBoundingClientRect().height < r.height + 48) return;
      const fits = withStyles(el, { "max-height": `calc(100dvh - ${top}px)`, "overflow-y": "auto" }, () => el.getBoundingClientRect().height <= room + 1);
      push("fixed-offscreen", el, { height: Math.round(r.height), viewportHeight: vh, hidden: Math.round(r.height - room), fits, sticky: true, top: Math.round(top) });
    };
    for (const el of elements) {
      if (css(el).position === "sticky") tallSticky(el);
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

    // Bars pinned to the top and bottom of a short screen leave little room
    // for the page itself (WCAG 1.4.10). Measured scrolled down, where sticky
    // bars have stuck.
    const y0 = window.scrollY;
    const most = root.scrollHeight - vh;
    if (most > 0) jump(Math.min(most, vh));
    const stuck = (el, s, r) => s.position === "fixed" || (s.top !== "auto" && Math.abs(r.top - parseFloat(s.top)) < 1.5) || (s.bottom !== "auto" && Math.abs(vh - r.bottom - parseFloat(s.bottom)) < 1.5);
    const bars = elements.filter((el) => {
      const s = css(el);
      if (!/fixed|sticky/.test(s.position) || (el.parentElement && insideFixed(el.parentElement)) || el.matches(MODAL) || dismissible(el)) return false;
      const r = el.getBoundingClientRect();
      if (r.width < vw * 0.5 || r.height < 8 || r.height >= vh * 0.9 || r.bottom <= 0 || r.top >= vh || scrollsInside(el)) return false;
      return stuck(el, s, r);
    });
    const spans = bars.map((el) => el.getBoundingClientRect()).map((r) => [Math.max(0, r.top), Math.min(vh, r.bottom)]).sort((a, b) => a[0] - b[0]);
    let covered = 0;
    let reach = 0;
    for (const [a, b] of spans) {
      covered += Math.max(0, b - Math.max(a, reach));
      reach = Math.max(reach, b);
    }
    if (covered > vh * 0.4) {
      const tallest = bars.reduce((x, y) => (y.getBoundingClientRect().height > x.getBoundingClientRect().height ? y : x));
      push("pinned-cover", tallest, { covered: Math.round(covered), viewportHeight: vh, share: Math.round((covered / vh) * 100), bars: bars.length });
    }
    jump(y0);
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

    // overflow: scroll draws its bar even with nothing to scroll.
    for (const el of elements) {
      const s = css(el);
      if (s.overflowY !== "scroll" && s.overflowX !== "scroll") continue;
      const ySide = el.offsetWidth - el.clientWidth - parseFloat(s.borderLeftWidth) - parseFloat(s.borderRightWidth);
      const xSide = el.offsetHeight - el.clientHeight - parseFloat(s.borderTopWidth) - parseFloat(s.borderBottomWidth);
      const y = s.overflowY === "scroll" && ySide > 0 && el.scrollHeight <= el.clientHeight + 1;
      const x = s.overflowX === "scroll" && xSide > 0 && el.scrollWidth <= el.clientWidth + 1;
      if ((!y && !x) || decorative(el) || FORM.has(el.tagName)) continue;
      push("empty-bar", el, { axis: y && x ? "both" : y ? "y" : "x", bar: Math.round(y ? ySide : xSide) });
    }

    // A box that scrolls only once its content is long enough jumps sideways
    // when its bar appears, unless the bar's room is reserved.
    for (const el of elements) {
      const s = css(el);
      if (s.overflowY !== "auto" || s.scrollbarGutter !== "auto" || el.clientHeight < 48 || el.scrollHeight > el.clientHeight + 1 || el.scrollHeight < el.clientHeight * 0.5) continue;
      if (FORM.has(el.tagName) || decorative(el) || el.offsetWidth - el.clientWidth - parseFloat(s.borderLeftWidth) - parseFloat(s.borderRightWidth) > 0) continue;
      // Only a box held to a height can run out of room.
      const height = el.getBoundingClientRect().height;
      const capped = s.maxHeight !== "none" || withStyles(el, { height: "auto", "max-height": "none", flex: "none" }, () => Math.abs(el.getBoundingClientRect().height - height) > 2);
      if (!capped) continue;
      const parts = [...el.querySelectorAll("*")].filter((c) => (hasOwnText(c) || c.matches(`svg, img, ${CONTROL}`)) && isVisible(c)).slice(0, 60);
      if (!parts.length) continue;
      const at = () => parts.map((c) => c.getBoundingClientRect().left);
      const before = at();
      const after = withStyles(el, { "overflow-y": "scroll" }, at);
      const shift = Math.max(...before.map((v, i) => Math.abs(after[i] - v)));
      if (shift < 1) continue;
      const steady = withStyles(el, { "scrollbar-gutter": "stable" }, () => {
        const still = at();
        return withStyles(el, { "overflow-y": "scroll" }, () => at().every((v, i) => Math.abs(v - still[i]) < 0.5));
      });
      push("gutter-shift", el, { shift: Math.round(shift * 10) / 10, fill: Math.round((el.scrollHeight / el.clientHeight) * 100), steady });
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

  // ---------- 13. content stuck under a pinned bar ----------

  // Content that moves with the page sits lowest at the top of the page, so
  // anything under a top bar there is never seen; the same for a bottom bar
  // at the end of the page. Content inside a pinned panel never moves at all.
  {
    const vh = window.innerHeight;
    const pinnedOf = (el) => {
      for (let n = el; n && n !== root; n = n.parentElement) if (/fixed|sticky/.test(css(n).position)) return n;
      return null;
    };
    const scrollsIn = (el) => {
      for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
        if (scrolls(css(n).overflowY) && n.scrollHeight > n.clientHeight + 2) return true;
      }
      return false;
    };
    const candidates = elements.filter((el) => (el.matches(CONTROL) || hasOwnText(el)) && !el.closest(MODAL) && !decorative(el)).slice(0, 1500);
    const under = new Map();
    const look = (end) => {
      for (const el of candidates) {
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        const [x, y] = [r.left + r.width / 2, r.top + r.height / 2];
        if (x < 0 || x >= vw || y < 0 || y >= vh) continue;
        const hit = document.elementFromPoint(x, y);
        if (!hit || el.contains(hit) || hit.contains(el)) continue;
        const layer = pinnedOf(hit);
        if (!layer || layer.contains(el) || layer.matches(MODAL) || ignored(layer) || dismissible(layer) || decorative(layer)) continue;
        const own = pinnedOf(el);
        const l = layer.getBoundingClientRect();
        const top = l.top + l.height / 2 < vh / 2;
        if (own ? end === "bottom" : (end === "top") !== top) continue;
        if (scrollsIn(el)) continue;
        const list = under.get(layer) ?? [];
        if (!list.some((other) => other.contains(el) || el.contains(other))) list.push(el);
        under.set(layer, list);
      }
    };
    const y0 = window.scrollY;
    jump(0);
    look("top");
    const most = root.scrollHeight - vh;
    if (most > 1) {
      jump(most);
      look("bottom");
    }
    jump(y0);
    for (const [layer, list] of under) {
      const l = layer.getBoundingClientRect();
      for (const el of list.slice(0, 3)) {
        push("covered-by-pinned", el, { layer: labelFor(layer), layerSelector: selectorFor(layer), position: css(layer).position, side: l.top + l.height / 2 < vh / 2 ? "top" : "bottom", height: Math.round(l.height), count: list.length });
      }
    }
  }

  // ---------- 14. sticky elements with no room to stick ----------

  // A grid or flex row stretches its items to the row's height, so a sticky
  // sidebar fills its parent and has nowhere to move: it scrolls away.
  for (const el of elements) {
    const s = css(el);
    if (s.position !== "sticky" || (s.top === "auto" && s.bottom === "auto")) continue;
    const p = el.parentElement;
    if (!p || p === document.body || el.getBoundingClientRect().height < 8 || decorative(el)) continue;
    const ps = css(p);
    const room = () => {
      const c = p.getBoundingClientRect();
      const k = el.getBoundingClientRect();
      const ks = css(el);
      const inner = c.height - parseFloat(ps.borderTopWidth) - parseFloat(ps.borderBottomWidth) - parseFloat(ps.paddingTop) - parseFloat(ps.paddingBottom);
      return inner - (k.height + parseFloat(ks.marginTop) + parseFloat(ks.marginBottom));
    };
    // Only a parent taller than the screen leaves something to scroll past.
    if (room() > 1 || p.getBoundingClientRect().height <= window.innerHeight + 48) continue;
    const freed = /flex|grid/.test(ps.display) && withStyles(el, { "align-self": "flex-start" }, () => room() > 48);
    push("sticky-no-room", el, { height: Math.round(el.getBoundingClientRect().height), parentHeight: Math.round(p.getBoundingClientRect().height), freed, layout: ps.display.includes("grid") ? "grid" : ps.display.includes("flex") ? "flex" : "block" });
  }

  // ---------- 15. text that runs into the control beside it ----------

  {
    // What text can collide with: a control, a number (a price, a count) or a badge.
    const PART = "a[href], button, input:not([type=hidden]), select, summary, [role=button], [role=switch], [role=checkbox], [role=tab]";
    const solid = (el) => el.matches(PART) || roleFor(el) === "number" || (isSurface(el) && (el.textContent || "").trim().length <= 12);
    const hasWords = (el) => !el.matches(PART) && Boolean((el.textContent || "").trim()) && textBox(el).right !== -Infinity;
    const pairs = [];
    for (const row of elements) {
      const s = css(row);
      if (!s.display.includes("flex") || s.flexDirection.startsWith("column") || row.closest("a[href], button, [role=button], summary") || decorative(row)) continue;
      const kids = [...row.children].filter((c) => isVisible(c) && !/absolute|fixed/.test(css(c).position)).slice(0, 30);
      for (let i = 1; i < kids.length; i++) {
        const [a, b] = [kids[i - 1], kids[i]];
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        if (ra.bottom <= rb.top || rb.bottom <= ra.top) continue; // different lines
        const [text, part] = solid(b) && hasWords(a) ? [a, b] : solid(a) && hasWords(b) ? [b, a] : [];
        if (!text) continue;
        const gapNow = () => {
          const t = textBox(text, shownBox);
          const p = part.getBoundingClientRect();
          const rt = text.getBoundingClientRect();
          // Only where the text and the part share a band of the row.
          if (t.bottom <= p.top || p.bottom <= t.top) return Infinity;
          // Wrapped text can reach its content edge on any line, whatever
          // this copy's line breaks happen to be.
          const ts = css(text);
          const lh = parseFloat(ts.lineHeight) || parseFloat(ts.fontSize) * 1.2;
          const edge = t.bottom - t.top > lh * 1.5
            ? { left: Math.min(t.left, rt.left + parseFloat(ts.borderLeftWidth) + parseFloat(ts.paddingLeft)), right: Math.max(t.right, rt.right - parseFloat(ts.borderRightWidth) - parseFloat(ts.paddingRight)) }
            : t;
          return rt.left < p.left ? p.left - edge.right : edge.left - p.right;
        };
        const boxGap = ra.left < rb.left ? rb.left - ra.right : ra.left - rb.right;
        const gap = gapNow();
        if (gap >= 4 || boxGap >= 1) continue;
        const spaced = withStyles(row, { "column-gap": "16px" }, () => gapNow() >= 8);
        pairs.push([text, part, gap, spaced, false]);
      }
    }
    // Text running under a control laid over it, like a card's menu button.
    // The layer can be the control itself or a cluster of them (a message's
    // Reply, Copy and Pin buttons in one positioned bar).
    for (const part of elements) {
      if (!/absolute|fixed/.test(css(part).position) || decorative(part)) continue;
      if (!part.matches(PART)) {
        const inside = part.querySelectorAll(PART);
        if (!inside.length || inside.length > 6 || hasOwnText(part)) continue;
      }
      const p = part.getBoundingClientRect();
      const area = surfaceOf(part) ?? part.offsetParent;
      if (!area || area === document.body || p.width < 8) continue;
      for (const text of [...area.querySelectorAll("*")].filter((c) => hasOwnText(c) && isVisible(c) && !c.contains(part) && !part.contains(c)).slice(0, 60)) {
        const overlap = () => {
          const t = textBox(text, shownBox);
          return Math.min(Math.min(t.right, p.right) - Math.max(t.left, p.left), Math.min(t.bottom, p.bottom) - Math.max(t.top, p.top));
        };
        if (overlap() <= 2) continue;
        // Text spilling out of its own box is the spill check's finding.
        if (text.scrollWidth > text.clientWidth + 1 && !hides(css(text).overflowX)) continue;
        const spaced = withStyles(text, { "padding-inline-end": `${Math.round(p.width + 8)}px` }, () => overlap() <= 0);
        pairs.push([text, part, -Math.round(overlap()), spaced, true]);
        break;
      }
    }
    for (const [text, part, gap, spaced, under] of pairs) {
      push("text-touches-control", text, { part: labelFor(part), gap: Math.round(gap), spaced, under });
    }
  }

  // ---------- 16. wrapped rows with uneven spacing ----------

  // justify-content: space-between spreads each line on its own, so a short
  // last line leaves its items pinned to the far edges.
  for (const el of elements) {
    const s = css(el);
    if (!s.display.includes("flex") || s.flexDirection.startsWith("column") || s.flexWrap === "nowrap" || !/space-(between|around|evenly)/.test(s.justifyContent)) continue;
    const kids = [...el.children].filter((c) => isVisible(c) && !/absolute|fixed/.test(css(c).position));
    if (kids.length < 3) continue;
    const gaps = () => {
      const lines = [];
      for (const k of kids.map((c) => c.getBoundingClientRect())) {
        const line = lines.find((l) => Math.abs(l[0].top - k.top) < 4);
        line ? line.push(k) : lines.push([k]);
      }
      return lines.filter((l) => l.length > 1).map((l) => {
        const xs = l.sort((a, b) => a.left - b.left);
        let sum = 0;
        for (let i = 1; i < xs.length; i++) sum += xs[i].left - xs[i - 1].right;
        return sum / (xs.length - 1);
      });
    };
    const g = gaps();
    if (g.length < 2) continue;
    const [least, most] = [Math.min(...g), Math.max(...g)];
    if (most <= Math.max(least * 1.5, least + 24)) continue;
    const even = withStyles(el, { "justify-content": "flex-start", "column-gap": `${Math.max(8, Math.round(least))}px` }, () => {
      const h = gaps();
      return h.length > 0 && Math.max(...h) - Math.min(...h) <= 2;
    });
    push("uneven-row", el, { lines: g.length, gap: Math.round(least), widest: Math.round(most), items: kids.length, even });
  }

  // ---------- 17. a lone item stretched across an auto-fit grid ----------

  // repeat(auto-fit, …) collapses the empty tracks (they compute to 0px) and
  // hands their room to the items, so one search result fills the row.
  for (const el of elements) {
    const s = css(el);
    if (!s.display.includes("grid") || decorative(el)) continue;
    const tracks = tracksOf(el);
    const empty = tracks.filter((t) => t === 0).length;
    if (tracks.length < 2 || !empty) continue;
    const kids = [...el.children].filter((c) => isVisible(c) && !/absolute|fixed/.test(css(c).position));
    if (!kids.length) continue;
    const content = el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
    const track = (content - (parseFloat(s.columnGap) || 0) * (tracks.length - 1)) / tracks.length;
    // Only an authored auto-fit collapses tracks for this reason: 0px tracks
    // from minmax(0, 1fr) gutters are a layout, not a stretch.
    const template = authored(el, "grid-template-columns").find((v) => /auto-fit/.test(v));
    if (!template) continue;
    const widest = () => Math.max(...kids.map((c) => c.getBoundingClientRect().width));
    const itemWidth = widest();
    if (itemWidth <= track * 1.8) continue;
    const fills = withStyles(el, { "grid-template-columns": template.replace(/auto-fit/g, "auto-fill") }, () => widest() <= track * 1.1);
    push("auto-fit-stretch", el, { items: kids.length, tracks: tracks.length, empty, itemWidth: Math.round(itemWidth), trackWidth: Math.round(track), fills, template });
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
  if (window.scrollX !== startScroll[0] || window.scrollY !== startScroll[1]) window.scrollTo({ left: startScroll[0], top: startScroll[1], behavior: "instant" });
  return { findings, images, capped, empty, unseen, pageWidth: root.scrollWidth, pageHeight: root.scrollHeight, viewportWidth: vw };
};
