// Builds the published package: one minified file, dist/caliper.js.
// The page scripts in browser/ are minified and inlined as strings, so
// nothing else ships. Playwright stays a normal dependency.

import { build, transform } from "esbuild";
import { readFile, rm } from "node:fs/promises";

const pkg = JSON.parse(await readFile("package.json", "utf8"));

const minifyScript = async (file) => {
  const source = (await readFile(`browser/${file}`, "utf8")).trim().replace(/;$/, "");
  // A bare function expression would be dropped as unused, so assign it,
  // minify, then take the assignment off again.
  const { code } = await transform(`var __page_script__=${source};`, { minify: true, target: "es2022" });
  const out = code.trim().replace(/^var __page_script__=/, "").replace(/;$/, "");
  if (out.length < 200) throw new Error(`Minifying browser/${file} produced almost nothing`);
  return out;
};

const inlineScripts = {
  name: "inline-page-scripts",
  setup(b) {
    b.onResolve({ filter: /\/scripts\.js$/ }, (args) => ({ path: args.path, namespace: "page-scripts" }));
    b.onLoad({ filter: /.*/, namespace: "page-scripts" }, async () => {
      const scripts = { "detect.js": await minifyScript("detect.js"), "stress.js": await minifyScript("stress.js") };
      return {
        contents: `const S = ${JSON.stringify(scripts)}; export async function loadScript(name) { return S[name]; }`,
        loader: "js",
      };
    });
  },
};

await rm("dist", { recursive: true, force: true });
await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/caliper.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: true,
  legalComments: "none",
  sourcemap: false,
  external: ["playwright"],
  plugins: [inlineScripts],
  banner: { js: `// ${pkg.name} ${pkg.version}. Copyright (c) 2026 Arul Raaj. Free to use, not to copy or modify. See LICENSE.` },
});
console.log("Built dist/caliper.js");
