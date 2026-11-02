// Starts Chromium. On the very first run the browser isn't downloaded yet,
// so we fetch it once (about 300 MB) and try again.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { chromium, type Browser } from "playwright";

// Playwright hides scrollbars by default. Caliper keeps them: they take up
// room, they land on content, and the report's screenshots should show them.
// macOS draws overlay bars that take no room and fade away, so ask for classic
// ones: the same layout on every machine, and the bar always in the picture.
const KEEP_SCROLLBARS = { ignoreDefaultArgs: ["--hide-scrollbars"], args: ["--disable-features=OverlayScrollbar"] };

const missingBrowser = (error: unknown) =>
  error instanceof Error && /Executable doesn't exist|playwright install/i.test(error.message);

export async function launchBrowser(log: (line: string) => void): Promise<Browser> {
  const executablePath = process.env.CALIPER_CHROMIUM;
  try {
    return await chromium.launch({ ...KEEP_SCROLLBARS, ...(executablePath ? { executablePath } : {}) });
  } catch (error) {
    if (executablePath || !missingBrowser(error)) throw error;
  }

  log("First run: downloading the browser Caliper drives (about 300 MB, once)…");
  const require = createRequire(import.meta.url);
  const cli = join(dirname(require.resolve("playwright/package.json")), "cli.js");
  const result = spawnSync(process.execPath, [cli, "install", "chromium"], { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error("Couldn't download the browser. Run `npx playwright install chromium` and try again.");
  }
  return chromium.launch(KEEP_SCROLLBARS);
}
