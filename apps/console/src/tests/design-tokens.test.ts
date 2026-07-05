import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

/* Pins the Nightwatch accessibility contract. All hex values live in the
   @theme block of styles.css. The test reads them from there and verifies
   contrast ratios against WCAG 2.1 criteria:
   - Body ink at 12:1+ on primary surfaces (well above AAA)
   - Muted text at AA (4.5:1+) on every text-bearing surface
   - Status colors at AAA (7:1+) on card and canvas
   - Border-strong at 3:1+ non-text contrast (WCAG 1.4.11)
   - Accent (cobalt) at AA for links and focus rings
   - White labels at AA on accent fill states */

/** Parse hex tokens from the @theme block in styles.css.
 *  Matches patterns like `--color-background: #f6f9fc;` */
function parseThemeTokens(css: string): Map<string, string> {
  const themeBlock = /@theme\s*\{([\s\S]*?)\n\}/.exec(css);
  if (!themeBlock)
    throw new Error(
      `no @theme block found in styles.css; got: ${css.slice(0, 120)}`,
    );
  const tokens = new Map<string, string>();
  for (const m of themeBlock[1].matchAll(
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

const tokens = parseThemeTokens(
  readFileSync(join(process.cwd(), "src/styles.css"), "utf8"),
);

function token(name: string): string {
  const value = tokens.get(name);
  if (!value) throw new Error(`token --${name} missing from @theme`);
  return value;
}

describe("design token contrast contract", () => {
  it("keeps ink readable at 12:1+ on primary surfaces", () => {
    for (const surface of [
      "color-card",
      "color-background",
      "color-secondary",
    ]) {
      expect(
        contrast(token("color-foreground"), token(surface)),
        `foreground on ${surface}`,
      ).toBeGreaterThanOrEqual(12);
    }
  });

  it("keeps muted text at AA (4.5:1+) on every text-bearing surface", () => {
    for (const surface of [
      "color-card",
      "color-background",
      "color-secondary",
      "color-secondary-hover",
    ]) {
      expect(
        contrast(token("color-muted-foreground"), token(surface)),
        `muted-foreground on ${surface}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps status colors at AAA on canvas and card", () => {
    for (const status of [
      "color-success",
      "color-warning",
      "color-destructive",
    ]) {
      for (const surface of ["color-background", "color-card"]) {
        expect(
          contrast(token(status), token(surface)),
          `${status} on ${surface}`,
        ).toBeGreaterThanOrEqual(7);
      }
    }
  });

  it("keeps border-strong at 3:1+ non-text contrast (WCAG 1.4.11)", () => {
    expect(
      contrast(token("color-border-strong"), token("color-background")),
      "border-strong on background",
    ).toBeGreaterThanOrEqual(3);
    expect(
      contrast(token("color-border-strong"), token("color-card")),
      "border-strong on card",
    ).toBeGreaterThanOrEqual(3);
  });

  it("keeps input border between 1.5:1 and 3:1 on card (calm-border split)", () => {
    const ratio = contrast(token("color-input"), token("color-card"));
    expect(ratio, "input border on card lower bound").toBeGreaterThanOrEqual(
      1.5,
    );
    expect(ratio, "input border on card upper bound").toBeLessThanOrEqual(3);
  });

  it("keeps accent at AA for links and 3:1+ as a focus border", () => {
    expect(
      contrast(token("color-primary"), token("color-card")),
      "primary on card",
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(token("color-primary"), token("color-background")),
      "primary on background",
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps white labels at AA on accent fill states", () => {
    for (const fill of [
      "color-primary",
      "color-primary-hover",
      "color-primary-press",
    ]) {
      expect(
        contrast(token("color-primary-foreground"), token(fill)),
        `primary-foreground on ${fill}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps adjacent surface steps perceptibly separated", () => {
    const pairs: [string, string][] = [
      ["color-card", "color-background"],
      ["color-background", "color-secondary"],
      ["color-secondary", "color-secondary-hover"],
      ["color-secondary-hover", "color-surface-active"],
    ];
    for (const [a, b] of pairs) {
      expect(
        contrast(token(a), token(b)),
        `${a} vs ${b}`,
      ).toBeGreaterThanOrEqual(1.04);
    }
  });
});
