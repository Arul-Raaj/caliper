// Loads the two scripts that run inside the page (browser/*.js) as text.
// The published bundle replaces this file with the scripts inlined and
// minified (see scripts/bundle.mjs), so the package ships one file.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const browserDir = fileURLToPath(new URL("../browser/", import.meta.url));

export async function loadScript(name: "detect.js" | "stress.js"): Promise<string> {
  return (await readFile(browserDir + name, "utf8")).trim().replace(/;$/, "");
}
