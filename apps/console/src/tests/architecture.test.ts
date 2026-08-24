import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, it, expect } from "vitest";

// Injected by vitest.config.ts, which runs in Node and is the only place
// certain of this package's location however the suite was started.
const SRC = process.env["CONSOLE_SRC"] ?? "";

function modules(
  dir: string,
  into: [string, string][] = [],
): [string, string][] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "tests") modules(path, into);
    } else if (/\.tsx?$/.test(entry.name)) {
      into.push([
        relative(SRC, path).split(sep).join("/"),
        readFileSync(path, "utf8"),
      ]);
    }
  }
  return into;
}

const MODULES = modules(SRC);

const imports = (text: string): string[] =>
  [...text.matchAll(/from "(@\/[^"]+)"/g)].map((m) => m[1] ?? "");

/* Grouped by the feature a file serves, which holds only while the arrows point
   one way: app composes features, features stand on shared, shared knows
   neither. Every misplacement this replaced began as one import going back. */
describe("layering", () => {
  it("keeps shared ignorant of the features standing on it", () => {
    for (const [path, text] of MODULES) {
      if (!path.startsWith("shared/")) continue;
      for (const spec of imports(text)) {
        expect(
          spec.startsWith("@/features/") || spec.startsWith("@/app/"),
          `${path} imports ${spec}`,
        ).toBe(false);
      }
    }
  });

  it("keeps the router and shell out of what they mount", () => {
    for (const [path, text] of MODULES) {
      if (!path.startsWith("features/")) continue;
      for (const spec of imports(text)) {
        expect(spec.startsWith("@/app/"), `${path} imports ${spec}`).toBe(
          false,
        );
      }
    }
  });

  /* A primitive that reads application state cannot be rendered at a size or in
     a mode the caller chooses; it decides for itself. Props are the seam. */
  it("leaves the primitives taking props rather than reading state", () => {
    for (const [path, text] of MODULES) {
      if (!path.startsWith("shared/ui/")) continue;
      for (const spec of imports(text)) {
        expect(
          spec.startsWith("@/shared/hooks/") ||
            spec.startsWith("@/shared/events/"),
          `${path} imports ${spec}`,
        ).toBe(false);
      }
    }
  });

  it("leaves nothing behind the folders the features replaced", () => {
    for (const [path, text] of MODULES) {
      for (const spec of imports(text)) {
        expect(
          /^@\/(pages|components|hooks|lib|api|auth)\//.test(spec),
          `${path} imports ${spec}, a folder that no longer exists`,
        ).toBe(false);
      }
    }
  });
});
