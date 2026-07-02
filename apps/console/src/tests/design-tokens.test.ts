import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { theme } from "../theme.js";

/* Pins the Navy/Cobalt accessibility contract (split AA bar): body ink stays
   near-black-free, muted text and interactive color at AA (>=4.5:1),
   non-text boundaries >=3:1, status colors deliberately kept at AAA (>=7:1),
   and the styles.css <-> theme.ts navy ramp staying identical. Retune tokens
   only with this test. */

function parseThemeColorTokens(css: string): Map<string, string> {
  const themeBlock = /@theme\s*\{([\s\S]*?)\n\}/.exec(css);
  if (!themeBlock)
    throw new Error(
      `no @theme block found in styles.css; got: ${css.slice(0, 120)}`,
    );
  const tokens = new Map<string, string>();
  for (const m of themeBlock[1].matchAll(
    /--color-([a-z-]+):\s*(#[0-9A-Fa-f]{6})\s*;/g,
  )) {
    tokens.set(m[1], m[2].toUpperCase());
  }
  return tokens;
}

function luminance(hex: string): number {
  const c = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(c.slice(i, i + 2), 16) / 255)
    .map((v) =>
      v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4),
    );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const tokens = parseThemeColorTokens(
  readFileSync(join(process.cwd(), "src/styles.css"), "utf8"),
);

function token(name: string): string {
  const value = tokens.get(name);
  if (!value) throw new Error(`token --color-${name} missing from @theme`);
  return value;
}

describe("design token contrast contract", () => {
  it("keeps ink readable at 12:1+ on primary surfaces", () => {
    for (const surface of ["card", "canvas", "surface"]) {
      expect(
        contrast(token("ink"), token(surface)),
        `ink on ${surface}`,
      ).toBeGreaterThanOrEqual(12);
    }
  });

  it("keeps muted ink at AA (4.5:1+) on every text-bearing surface", () => {
    for (const surface of ["card", "canvas", "surface", "surface-hover"]) {
      expect(
        contrast(token("ink-muted"), token(surface)),
        `ink-muted on ${surface}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps status colors at AAA on canvas and card", () => {
    for (const status of [
      "status-running",
      "status-awaiting",
      "status-failed",
    ]) {
      for (const surface of ["canvas", "card"]) {
        expect(
          contrast(token(status), token(surface)),
          `${status} on ${surface}`,
        ).toBeGreaterThanOrEqual(7);
      }
    }
  });

  it("keeps meaningful borders at 3:1+ non-text contrast (WCAG 1.4.11)", () => {
    expect(
      contrast(token("line-strong"), token("canvas")),
      "line-strong on canvas",
    ).toBeGreaterThanOrEqual(3);
    expect(
      contrast(token("line-strong"), token("card")),
      "line-strong on card",
    ).toBeGreaterThanOrEqual(3);
  });

  it("keeps the signal color at AA for links and 3:1+ as a focus border", () => {
    expect(
      contrast(token("signal"), token("card")),
      "signal on card",
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(token("signal"), token("canvas")),
      "signal on canvas",
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(token("signal"), token("selected-tint")),
      "signal on selected-tint",
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps white labels at AA on the primary fill trio", () => {
    for (const fill of ["primary-fill", "primary-hover", "primary-press"]) {
      expect(
        contrast(token("card"), token(fill)),
        `card text on ${fill}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps adjacent surface steps perceptibly separated", () => {
    const pairs: [string, string][] = [
      ["card", "canvas"],
      ["canvas", "surface"],
      ["surface", "surface-hover"],
      ["surface-hover", "surface-active"],
    ];
    for (const [a, b] of pairs) {
      expect(
        contrast(token(a), token(b)),
        `${a} vs ${b}`,
      ).toBeGreaterThanOrEqual(1.04);
    }
  });

  it("keeps the Mantine navy scale identical to the CSS ramp", () => {
    const ramp = [
      token("card"),
      token("canvas"),
      token("surface"),
      token("surface-hover"),
      token("surface-active"),
      token("line"),
      token("line-strong"),
      token("ink-faint"),
      token("ink-muted"),
      token("ink"),
    ];
    const navy = theme.colors?.navy;
    if (!navy) throw new Error("theme.colors.navy missing");
    expect([...navy].map((c) => c.toUpperCase())).toEqual(ramp);
  });

  it("anchors the Mantine cobalt scale on the signal tokens", () => {
    const cobalt = theme.colors?.cobalt;
    if (!cobalt) throw new Error("theme.colors.cobalt missing");
    expect(cobalt[6].toUpperCase()).toBe(token("signal"));
    expect(cobalt[7].toUpperCase()).toBe(token("signal-hover"));
  });
});
