// Runs inside the page. Rewrites short pieces of text to simulate the
// content real users bring: longer names, titles and labels, or one long
// word with no spaces (a URL, an email, a German compound noun). Or
// applies the WCAG text spacing overrides.
//
// Plain JavaScript on purpose: Playwright sends this source to the browser
// as-is, so it must not depend on anything outside itself.
(mode) => {
  if (!document.body) return 0;
  if (mode === "text-spacing") {
    const style = document.createElement("style");
    style.textContent = "*:not(svg *) { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-block-end: 2em !important; }";
    document.head.append(style);
    return 1;
  }
  // A short translation: every button label becomes "OK".
  if (mode === "short-labels") {
    const original = (globalThis.__caliperOriginal ??= new WeakMap());
    let changed = 0;
    for (const el of document.querySelectorAll("button, [role=button], a[href]")) {
      const text = (el.textContent || "").trim();
      if (text.length < 3 || text.length > 20 || el.querySelector("img, svg, h1, h2, h3, h4, h5, h6, p") || el.closest("nav, [aria-hidden='true']")) continue;
      // Links count only when they look like buttons: a fill or a border, and padding.
      if (el.matches("a")) {
        const s = getComputedStyle(el);
        const filled = s.backgroundColor !== "rgba(0, 0, 0, 0)" || parseFloat(s.borderTopWidth) > 0;
        if (s.display === "inline" || !filled || parseFloat(s.paddingLeft) < 6) continue;
      }
      const nodes = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) if (walker.currentNode.nodeValue.trim()) nodes.push(walker.currentNode);
      nodes.forEach((node, i) => {
        if (!original.has(node)) original.set(node, node.nodeValue);
        node.nodeValue = i === 0 ? "OK" : "";
      });
      changed++;
    }
    return changed;
  }
  const LONG_WORD = "Rindfleischetikettierungsüberwachungsaufgabenübertragungsgesetz";
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "CODE", "PRE", "TEXTAREA", "SVG", "TEMPLATE", "OPTION"]);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);

  // Remember each original text, so the measuring script can judge what an
  // element is (a title, a paragraph) from its real content, not the stretched one.
  const original = (globalThis.__caliperOriginal ??= new WeakMap());
  let changed = 0;
  for (const node of nodes) {
    const text = node.nodeValue.trim();
    // Skip icons and glyphs (1 or 2 characters), numbers, prices and dates:
    // their length is fixed by format, so stretching them proves nothing.
    if (text.length <= 2) continue;
    if (/^[\d\s.,:/\-–+%$€£₹()#]+$/.test(text)) continue;
    if (/^([A-Z][a-z]{2,8}\.? \d{1,2},? \d{4}|\d{1,2} [A-Z][a-z]{2,8}\.? \d{4})$/.test(text)) continue;
    const parent = node.parentElement;
    if (!parent || parent.closest("[aria-hidden='true']")) continue;
    if ([...SKIP].some((tag) => parent.closest(tag.toLowerCase()))) continue;

    if ((mode === "long-text" && text.length <= 120) || (mode === "long-word" && text.length <= 60)) {
      if (!original.has(node)) original.set(node, node.nodeValue);
    }
    if (mode === "long-text" && text.length <= 120) {
      node.nodeValue = `${text} ${text} ${text}`.slice(0, 300);
      changed++;
    }
    if (mode === "long-word" && text.length <= 60) {
      node.nodeValue = `${text} ${LONG_WORD}`;
      changed++;
    }
  }
  return changed;
};
