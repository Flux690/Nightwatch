import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

/* Pins the Nightwatch accessibility contract. All hex values live in the
   :root block of styles.css. The test reads them from there and verifies
   contrast ratios against WCAG 2.1 criteria:
   - Body ink at 12:1+ on primary surfaces (well above AAA)
   - Muted text at AA (4.5:1+) on every text-bearing surface
   - Status colors at AAA (7:1+) on card and canvas
   - Border-strong at 3:1+ non-text contrast (WCAG 1.4.11)
   - Accent (cobalt) at AA for links and focus rings
   - White labels at AA on accent fill states */

/** Parse hex tokens from the :root block in styles.css.
 *  Matches patterns like `--canvas: #f6f9fc;` and `--accent-color: #2563eb;` */
function parseRootTokens(css: string): Map<string, string> {
  const rootBlock = /:root\s*\{([\s\S]*?)\n\}/.exec(css);
  if (!rootBlock)
    throw new Error(
      `no :root block found in styles.css; got: ${css.slice(0, 120)}`,
    );
  const tokens = new Map<string, string>();
  for (const m of rootBlock[1].matchAll(
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

const tokens = parseRootTokens(
  readFileSync(join(process.cwd(), "src/styles.css"), "utf8"),
);

function token(name: string): string {
  const value = tokens.get(name);
  if (!value) throw new Error(`token --${name} missing from :root`);
  return value;
}

describe("design token contrast contract", () => {
  it("keeps ink readable at 12:1+ on primary surfaces", () => {
    for (const surface of ["card", "canvas", "surface-1"]) {
      expect(
        contrast(token("ink"), token(surface)),
        `ink on ${surface}`,
      ).toBeGreaterThanOrEqual(12);
    }
  });

  it("keeps ink-muted at AA (4.5:1+) on every text-bearing surface", () => {
    for (const surface of ["card", "canvas", "surface-1", "surface-2"]) {
      expect(
        contrast(token("ink-muted"), token(surface)),
        `ink-muted on ${surface}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps status colors at AAA on canvas and card", () => {
    for (const status of ["success", "warning", "destructive"]) {
      for (const surface of ["canvas", "card"]) {
        expect(
          contrast(token(status), token(surface)),
          `${status} on ${surface}`,
        ).toBeGreaterThanOrEqual(7);
      }
    }
  });

  it("keeps hairline-strong at 3:1+ non-text contrast (WCAG 1.4.11)", () => {
    expect(
      contrast(token("hairline-strong"), token("canvas")),
      "hairline-strong on canvas",
    ).toBeGreaterThanOrEqual(3);
    expect(
      contrast(token("hairline-strong"), token("card")),
      "hairline-strong on card",
    ).toBeGreaterThanOrEqual(3);
  });

  it("keeps hairline-input between 1.5:1 and 3:1 on card (calm-border split)", () => {
    const ratio = contrast(token("hairline-input"), token("card"));
    expect(ratio, "hairline-input on card lower bound").toBeGreaterThanOrEqual(
      1.5,
    );
    expect(ratio, "hairline-input on card upper bound").toBeLessThanOrEqual(3);
  });

  it("keeps accent at AA for links and 3:1+ as a focus border", () => {
    expect(
      contrast(token("accent-color"), token("card")),
      "accent on card",
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(token("accent-color"), token("canvas")),
      "accent on canvas",
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps white labels at AA on accent fill states", () => {
    for (const fill of ["accent-color", "accent-hover", "accent-press"]) {
      expect(
        contrast(token("on-accent"), token(fill)),
        `on-accent text on ${fill}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps adjacent surface steps perceptibly separated", () => {
    const pairs: [string, string][] = [
      ["card", "canvas"],
      ["canvas", "surface-1"],
      ["surface-1", "surface-2"],
      ["surface-2", "surface-3"],
    ];
    for (const [a, b] of pairs) {
      expect(
        contrast(token(a), token(b)),
        `${a} vs ${b}`,
      ).toBeGreaterThanOrEqual(1.04);
    }
  });
});
