import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

/* The palette's contract: every semantic token points at a step on the
   scale, each group of steps is evenly spaced, and every pair clears the WCAG floor its surface needs.
   Conversion happens here because a browser reports oklch() back verbatim, and
   a first prototype's rgb() regex read L, C and H as red, green and blue. */

type Step = { L: number; C: number; H: number };

const css = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
const root = css.matchAll(/:root\s*\{([\s\S]*?)\n\}/g);
const declarations = new Map<string, string>();
for (const block of root) {
  for (const m of block[1].matchAll(/--([a-z][-a-z0-9]*):\s*([^;]+);/g)) {
    declarations.set(m[1], m[2].trim().replace(/\s+/g, " "));
  }
}

/* A step is an opaque OKLCH triple. Scrim and shadow are black at alpha:
   depth rather than palette, so they are steps of nothing. */
const scale = new Map<string, Step>();
const aliases = new Map<string, string>();
for (const [name, value] of declarations) {
  const triple = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(value);
  if (triple) {
    scale.set(name, { L: +triple[1], C: +triple[2], H: +triple[3] });
    continue;
  }
  const alias = /^var\(--([a-z][-a-z0-9]*)\)$/.exec(value);
  if (alias) aliases.set(name, alias[1]);
}

function step(name: string): Step {
  const target = aliases.get(name) ?? name;
  const value = scale.get(target);
  if (!value)
    throw new Error(`--${name} does not resolve to a step on the scale`);
  return value;
}

/* OKLab to linear sRGB, then luminance. Clamped, because a browser clamps too:
   --status-fail is marginally outside the sRGB gamut and renders at its edge. */
function luminance({ L, C, H }: Step): number {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const [r, g, bl] = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((v) => Math.min(1, Math.max(0, v)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(step(a)), luminance(step(b))].sort(
    (x, y) => y - x,
  );
  return (hi + 0.05) / (lo + 0.05);
}

function expectEvenSteps(group: string[], spacing: number): void {
  for (let i = 1; i < group.length; i++) {
    const [below, above] = [step(group[i - 1] ?? ""), step(group[i] ?? "")];
    expect(above.L - below.L, `${group[i - 1]} to ${group[i]}`).toBeCloseTo(
      spacing,
      4,
    );
  }
}

const SURFACES = ["sidebar", "background", "card", "secondary", "muted-hover"];

describe("the scale", () => {
  it("spaces the neutral surfaces by 0.035", () => {
    expectEvenSteps(["n-1", "n-2", "n-3", "n-4", "n-5", "n-6"], 0.035);
  });

  it("spaces ink by 0.1225 and lines by 0.12", () => {
    expectEvenSteps(["ink-1", "ink-2", "ink-3"], 0.1225);
    expectEvenSteps(["line-1", "line-2"], 0.12);
  });

  it("spaces status tints by 0.09 and each fill pair by 0.04", () => {
    expectEvenSteps(["status-fail-tint", "status-fail-wash"], 0.09);
    expectEvenSteps(["cobalt-fill", "cobalt-fill-hover"], 0.04);
    expectEvenSteps(["red-fill", "red-fill-hover"], 0.04);
  });

  it("puts the sidebar below the stage, which sits below what is raised", () => {
    expect(step("sidebar").L).toBeLessThan(step("background").L);
    expect(step("background").L).toBeLessThan(step("card").L);
  });

  it("holds every semantic token to a step, and every step to a group", () => {
    for (const [name, value] of declarations) {
      if (scale.has(name) || aliases.has(name)) continue;
      expect(value, `--${name} is neither a step nor an alias`).toMatch(
        /oklch\(0 0 0 \/ /,
      );
    }
    for (const name of scale.keys()) {
      expect(name, `--${name} is a raw colour outside the scale`).toMatch(
        /^(n|line|ink|status|cobalt|red|white)(-|$)/,
      );
    }
    for (const [name, target] of aliases) {
      expect(scale.has(target), `--${name} points at --${target}`).toBe(true);
    }
  });
});

describe("the contrast matrix", () => {
  it("keeps full ink at 9:1+ on every surface", () => {
    for (const surface of SURFACES) {
      expect(
        contrast("foreground", surface),
        `foreground on ${surface}`,
      ).toBeGreaterThanOrEqual(9);
    }
  });

  it("keeps muted and subtle ink at AA on every surface", () => {
    for (const ink of ["muted-foreground", "ink-subtle"]) {
      for (const surface of SURFACES) {
        expect(
          contrast(ink, surface),
          `${ink} on ${surface}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps status hues at AAA on every surface that carries them", () => {
    for (const status of ["ok", "wait", "fail", "run"]) {
      for (const surface of ["sidebar", "background", "card"]) {
        expect(
          contrast(status, surface),
          `${status} on ${surface}`,
        ).toBeGreaterThanOrEqual(status === "run" ? 4.5 : 7);
      }
    }
  });

  it("keeps status text at AA on its own tint", () => {
    const pairs: [string, string][] = [
      ["success", "success-tint"],
      ["warning", "warning-tint"],
      ["destructive", "destructive-tint"],
      ["destructive", "destructive-wash"],
    ];
    for (const [text, tint] of pairs) {
      expect(contrast(text, tint), `${text} on ${tint}`).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

  it("keeps white labels at AA on every filled button", () => {
    for (const fill of [
      "primary",
      "primary-hover",
      "destructive-fill",
      "destructive-fill-hover",
    ]) {
      expect(
        contrast("primary-foreground", fill),
        `primary-foreground on ${fill}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps the focus ring at 3:1+ on canvas, on input and on raised (WCAG 1.4.11)", () => {
    for (const surface of ["background", "secondary", "card"]) {
      expect(
        contrast("ring", surface),
        `ring on ${surface}`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps border-strong at 3:1+ on canvas (WCAG 1.4.11)", () => {
    expect(
      contrast("border-strong", "background"),
      "border-strong on background",
    ).toBeGreaterThanOrEqual(3);
  });

  it("keeps the input border calm: between 1.5:1 and 3:1 on a card", () => {
    const ratio = contrast("input", "card");
    expect(ratio, "input on card lower bound").toBeGreaterThanOrEqual(1.5);
    expect(ratio, "input on card upper bound").toBeLessThanOrEqual(3);
  });
});
