// A tiny static file server for the fixtures, so tests load pages over
// http:// (image blocking needs real network requests).
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../fixtures/", import.meta.url));
const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".css": "text/css" };

export function serve(): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    if (req.url === "/never") return; // a request that is never answered
    try {
      const path = join(root, decodeURIComponent((req.url ?? "/").split("?")[0]!));
      const body = await readFile(path);
      res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      done({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}
