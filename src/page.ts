// Runs Caliper's scripts inside the page, in an isolated world: the same
// DOM, but a clean set of JavaScript built-ins. A page that overrides
// Array.from, Set or JSON (old libraries do) can't break the measurements,
// and nothing Caliper defines leaks into the page.

import type { CDPSession, Page } from "playwright";

interface World { cdp: CDPSession; id?: number }
const worlds = new WeakMap<Page, World>();

const LIMIT_MS = 60_000; // a page stuck in a loop never answers
const NAVIGATED = /Cannot find context|context was destroyed|Execution context|navigated or closed|No frame for given id/i;

function limited<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("The page stopped responding, so Caliper couldn't finish measuring it.")), LIMIT_MS);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

async function createWorld(world: World): Promise<number> {
  const { frameTree } = await world.cdp.send("Page.getFrameTree");
  const { executionContextId } = await world.cdp.send("Page.createIsolatedWorld", {
    frameId: frameTree.frame.id,
    worldName: "caliper",
  });
  return executionContextId;
}

// `expression` is a complete JavaScript expression, such as
// "(source)(args)". Promises are awaited and the result is returned as JSON.
export async function inPage<T>(page: Page, expression: string): Promise<T> {
  let world = worlds.get(page);
  if (!world) {
    world = { cdp: await limited(page.context().newCDPSession(page)) };
    worlds.set(page, world);
  }
  for (let attempt = 0; ; attempt++) {
    try {
      world.id ??= await limited(createWorld(world));
      const res = await limited(
        world.cdp.send("Runtime.evaluate", {
          expression,
          contextId: world.id,
          returnByValue: true,
          awaitPromise: true,
        }),
      );
      if (res.exceptionDetails) {
        throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
      }
      return res.result.value as T;
    } catch (error) {
      // The page navigated (a late redirect, a reload) and took the world
      // with it. Wait for the new page and try again, a few times.
      const message = error instanceof Error ? error.message : String(error);
      if (!NAVIGATED.test(message)) throw error;
      if (attempt === 3) throw new Error("The page keeps reloading, so Caliper couldn't measure it.");
      world.id = undefined;
      await page.waitForLoadState("load", { timeout: 15_000 }).catch(() => {});
    }
  }
}
