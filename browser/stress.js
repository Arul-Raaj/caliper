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
