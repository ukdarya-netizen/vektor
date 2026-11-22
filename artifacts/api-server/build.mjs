import path from "node:path";
import { fileURLToPath } from "node:url";
import { rm } from "node:fs/promises";
import { build } from "esbuild";

const dir = path.dirname(fileURLToPath(import.meta.url));
await rm(path.join(dir, "dist"), { recursive: true, force: true });
await build({
  entryPoints: [path.join(dir, "src/index.ts")],
  platform: "node",
  bundle: true,
  format: "esm",
  outdir: path.join(dir, "dist"),
  outExtension: { ".js": ".mjs" },
  sourcemap: "linked",
  logLevel: "info",
  // ccxt and pg stay in node_modules (large / optional native parts).
  external: ["ccxt", "pg", "pg-native", "web-push"],
  banner: {
    js: `import { createRequire as __cr } from 'node:module'; globalThis.require = __cr(import.meta.url);`,
  },
});
