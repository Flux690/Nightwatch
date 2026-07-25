import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";

// shared has no build of its own, so it must be inlined here. npm dependencies
// stay external: native modules cannot be bundled, and pino resolves its
// transports from node_modules at runtime.
const appDir = resolve(process.argv[2] ?? process.cwd());
const pkg = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8"));

await build({
  entryPoints: [join(appDir, "src/index.ts")],
  outfile: join(appDir, "dist/index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  external: Object.keys(pkg.dependencies ?? {}),
  logLevel: "info",
});
