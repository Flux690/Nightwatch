import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";

// shared has no build of its own, so it must be inlined here. npm dependencies
// stay external: native modules cannot be bundled, and pino resolves its
// transports from node_modules at runtime. Listing them from `dependencies`
// rather than esbuild's `packages: "external"` is deliberate - shared is a
// devDependency, and blanket externalising would leave it unresolved at runtime.
const appDir = resolve(process.argv[2] ?? process.cwd());
const pkg = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8"));

// The target follows the one declared Node floor, so the syntax esbuild emits
// and the version the image runs cannot drift apart.
const root = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const major = /(\d+)/.exec(root.engines?.node ?? "")?.[1];
if (major === undefined) {
  throw new Error(
    "root package.json needs engines.node to name a major version",
  );
}

await build({
  entryPoints: [join(appDir, "src/index.ts")],
  outfile: join(appDir, "dist/index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: `node${major}`,
  sourcemap: true,
  external: Object.keys(pkg.dependencies ?? {}),
  logLevel: "info",
});
