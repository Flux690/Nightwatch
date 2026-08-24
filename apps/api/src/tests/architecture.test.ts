import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep, dirname } from "node:path";
import { describe, it, expect } from "vitest";

// Injected by vitest.config.ts, which is the only place certain of this
// package's location however the suite was started.
const SRC = process.env["API_SRC"] ?? "";

function modules(
  dir: string,
  into: [string, string][] = [],
): [string, string][] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "tests") modules(path, into);
    } else if (entry.name.endsWith(".ts")) {
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
  [...text.matchAll(/from "(\.[^"]+)"/g)].map((m) => m[1] ?? "");

// The module a path belongs to, or null for the root files every module may use.
const moduleOf = (path: string): string | null =>
  path.includes("/") ? (path.split("/")[0] ?? null) : null;

function resolveImport(from: string, spec: string): string {
  const abs = resolve(dirname(join(SRC, from)), spec.replace(/\.js$/, ".ts"));
  return relative(SRC, abs).split(sep).join("/");
}

/* Two kinds of file sit at the root and only one may look down. Infrastructure
   is the process itself - the database handle, the logger, the key, the paths -
   and every module stands on it. The composition root wires those modules
   together, so of course it reaches them; that is the whole of its job. */
const INFRASTRUCTURE = [
  "db.ts",
  "logger.ts",
  "secrets.ts",
  "paths.ts",
  "public-url.ts",
  "console.ts",
];

describe("layering", () => {
  it("keeps infrastructure ignorant of the modules standing on it", () => {
    for (const [path, text] of MODULES) {
      if (!INFRASTRUCTURE.includes(path)) continue;
      for (const spec of imports(text)) {
        const target = resolveImport(path, spec);
        expect(
          moduleOf(target),
          `${path} imports ${spec}, so infrastructure depends on a module`,
        ).toBe(null);
      }
    }
  });

  it("leaves every root file accounted for as one kind or the other", () => {
    // A new root file is a decision, not a default: name it here or give it a
    // module, so the split above cannot quietly stop covering the root.
    const composition = ["index.ts", "dispatcher.ts", "run-pool.ts"];
    const roots = MODULES.map(([path]) => path).filter(
      (path) => moduleOf(path) === null,
    );
    expect(roots.sort()).toEqual([...INFRASTRUCTURE, ...composition].sort());
  });

  it("has no import cycles", () => {
    const graph = new Map<string, string[]>(
      MODULES.map(([path, text]) => [
        path,
        imports(text)
          .map((spec) => resolveImport(path, spec))
          .filter((target) => MODULES.some(([p]) => p === target)),
      ]),
    );

    const state = new Map<string, 1 | 2>();
    const found: string[] = [];

    const walk = (node: string, stack: string[]): void => {
      state.set(node, 1);
      stack.push(node);
      for (const next of graph.get(node) ?? []) {
        if (state.get(next) === 1) {
          found.push([...stack.slice(stack.indexOf(next)), next].join(" -> "));
        } else if (state.get(next) === undefined) {
          walk(next, stack);
        }
      }
      stack.pop();
      state.set(node, 2);
    };

    for (const [path] of MODULES) {
      if (state.get(path) === undefined) walk(path, []);
    }
    expect(found).toEqual([]);
  });
});

/* The sandbox is package-shaped so that extracting it stays a move rather than
   surgery: node builtins, external packages and its own files, nothing else. */
describe("the sandbox boundary", () => {
  it("lets the sandbox reach nothing above itself", () => {
    for (const [path, text] of MODULES) {
      if (!path.startsWith("sandbox/")) continue;
      for (const spec of imports(text)) {
        const target = resolveImport(path, spec);
        expect(
          target.startsWith("sandbox/"),
          `${path} imports ${spec}, which is outside sandbox/`,
        ).toBe(true);
      }
    }
  });
});
