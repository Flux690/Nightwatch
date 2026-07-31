import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

/* Verifies each color pairing meets the WCAG 2.1 contrast level (AA or AAA)
   that surface actually needs. One palette, on :root. */

function parseBlockTokens(css: string, selector: string): Map<string, string> {
  const block = new RegExp(`${selector}\\s*\\{([\\s\\S]*?)\\n\\}`, "m").exec(
    css,
  );
  if (!block) throw new Error(`no ${selector} block found in styles.css`);
  const tokens = new Map<string, string>();
  for (const m of block[1].matchAll(
    /--([a-z][-a-z0-9]*):\s*(#[0-9A-Fa-f]{6})\s*;/g,
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

const css = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
const tokens = parseBlockTokens(css, ":root");

describe("design token contrast contract", () => {
  function token(name: string): string {
    const value = tokens.get(name);
    if (!value) throw new Error(`token --${name} missing from palette`);
    return value;
  }

  it("keeps ink readable at 12:1+ on primary surfaces", () => {
    for (const surface of ["card", "background", "secondary"]) {
      expect(
        contrast(token("foreground"), token(surface)),
        `foreground on ${surface}`,
      ).toBeGreaterThanOrEqual(12);
    }
  });

  it("keeps muted text at AA (4.5:1+) on every text-bearing surface", () => {
    for (const surface of [
      "card",
      "background",
      "secondary",
      "secondary-hover",
    ]) {
      expect(
        contrast(token("muted-foreground"), token(surface)),
        `muted-foreground on ${surface}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps status colors at AAA on canvas and card", () => {
    for (const status of ["success", "warning", "destructive"]) {
      for (const surface of ["background", "card"]) {
        expect(
          contrast(token(status), token(surface)),
          `${status} on ${surface}`,
        ).toBeGreaterThanOrEqual(7);
      }
    }
  });

  it("keeps run-state chips at AA on their tints and 3:1+ as indicators", () => {
    for (const state of ["run", "wait", "ok", "fail"]) {
      expect(
        contrast(token(state), token(`${state}-tint`)),
        `${state} on ${state}-tint`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(token(state), token("background")),
        `${state} on background`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps border-strong at 3:1+ non-text contrast (WCAG 1.4.11)", () => {
    expect(
      contrast(token("border-strong"), token("background")),
      "border-strong on background",
    ).toBeGreaterThanOrEqual(3);
    expect(
      contrast(token("border-strong"), token("card")),
      "border-strong on card",
    ).toBeGreaterThanOrEqual(3);
  });

  it("keeps input border between 1.5:1 and 3:1 on card (calm-border split)", () => {
    const ratio = contrast(token("input"), token("card"));
    expect(ratio, "input border on card lower bound").toBeGreaterThanOrEqual(
      1.5,
    );
    expect(ratio, "input border on card upper bound").toBeLessThanOrEqual(3);
  });

  it("keeps accent at AA for links and 3:1+ as a focus border", () => {
    expect(
      contrast(token("primary"), token("card")),
      "primary on card",
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(token("primary"), token("background")),
      "primary on background",
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps labels at AA on accent fill states", () => {
    for (const fill of ["primary", "primary-hover", "primary-press"]) {
      expect(
        contrast(token("primary-foreground"), token(fill)),
        `primary-foreground on ${fill}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps adjacent surface steps perceptibly separated", () => {
    const pairs: [string, string][] = [
      ["card", "background"],
      ["background", "secondary"],
      ["secondary", "secondary-hover"],
      ["secondary-hover", "surface-active"],
    ];
    for (const [a, b] of pairs) {
      expect(
        contrast(token(a), token(b)),
        `${a} vs ${b}`,
      ).toBeGreaterThanOrEqual(1.04);
    }
  });
});
