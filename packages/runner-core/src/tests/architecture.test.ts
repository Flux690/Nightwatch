import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// This package exists so two deployables can share code without reaching across.
// These hold the rule it was created for, which nothing else enforces.

const RUNNERS = fileURLToPath(
  new URL("../../../../apps/runners", import.meta.url),
);

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" || entry.name === "dist"
        ? []
        : tsFiles(path);
    }
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

function importsIn(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] ?? "");
}

describe("runner isolation", () => {
  const platforms = readdirSync(RUNNERS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  // A relative import out of one platform and into another is the thing this
  // package replaced. Only the package name may cross that line.
  it.each(platforms)("%s reaches no sibling platform", (platform) => {
    const others = platforms.filter((p) => p !== platform);
    for (const file of tsFiles(join(RUNNERS, platform))) {
      for (const spec of importsIn(file)) {
        if (!spec.startsWith(".")) continue;
        const resolved = join(file, "..", spec);
        for (const other of others) {
          expect(
            resolved.startsWith(join(RUNNERS, other)),
            `${file} imports ${spec}, which resolves into ${other}`,
          ).toBe(false);
        }
      }
    }
  });

  // A folder here that is not itself a runner is shared code by another name,
  // and shared code belongs in a package rather than beside its consumers.
  it("holds nothing but runners", () => {
    for (const platform of platforms) {
      const manifest = join(RUNNERS, platform, "package.json");
      expect(
        statSync(manifest, { throwIfNoEntry: false }) !== undefined,
        `apps/runners/${platform} has no package.json, so it is not a deployable`,
      ).toBe(true);
    }
  });
});
