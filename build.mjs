// Build script: paths are relative to this file; no absolute paths.
import { build } from "esbuild";
import { readFileSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const out = join(root, "dist", "map-overlay-card.js");
await build({
  entryPoints: [join(root, "src", "map-overlay-card.js")],
  bundle: true, minify: true, format: "esm", target: "es2020",
  outfile: out, loader: { ".css": "text" },
  define: { __VERSION__: JSON.stringify(pkg.version) },
  legalComments: "inline",
});
const vdir = join(root, "versions", pkg.version);
mkdirSync(vdir, { recursive: true });
copyFileSync(out, join(vdir, "map-overlay-card.js"));
console.log("built", pkg.version);
