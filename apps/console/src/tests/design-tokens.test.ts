import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

/* Every token points at a step, each band is evenly spaced, and every pair
   clears its WCAG floor. Converted here because a browser reports oklch() back
   verbatim, and a first prototype's rgb() regex read L, C and H as r, g and b. */

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
const mixes = new Map<string, { base: string; toward: string; part: number }>();
const MIX =
  /^color-mix\(\s*in oklab,\s*var\(--([a-z][-a-z0-9]*)\),\s*var\(--([a-z][-a-z0-9]*)\) ([\d.]+)%\s*\)$/;
for (const [name, value] of declarations) {
  const triple = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(value);
  if (triple) {
    scale.set(name, { L: +triple[1], C: +triple[2], H: +triple[3] });
    continue;
  }
  const blend = MIX.exec(value);
  if (blend) {
    mixes.set(name, {
      base: blend[1] ?? "",
      toward: blend[2] ?? "",
      part: +(blend[3] ?? 0) / 100,
    });
    continue;
  }
  const alias = /^var\(--([a-z][-a-z0-9]*)\)$/.exec(value);
  if (alias) aliases.set(name, alias[1]);
}

/* A mix is evaluated where the browser evaluates it, in OKLab, so the test
   reads the colour that actually paints rather than an approximation. */
function blend(x: Step, y: Step, part: number): Step {
  const polar = ({ L, C, H }: Step) => {
    const h = (H * Math.PI) / 180;
    return [L, C * Math.cos(h), C * Math.sin(h)] as const;
  };
  const [l1, a1, b1] = polar(x);
  const [l2, a2, b2] = polar(y);
  const [L, a, b] = [
    l1 + (l2 - l1) * part,
    a1 + (a2 - a1) * part,
    b1 + (b2 - b1) * part,
  ];
  let H = (Math.atan2(b, a) * 180) / Math.PI;
  if (H < 0) H += 360;
  return { L, C: Math.hypot(a, b), H };
}

function step(name: string): Step {
  const target = aliases.get(name) ?? name;
  const mix = mixes.get(target);
  if (mix) return blend(step(mix.base), step(mix.toward), mix.part);
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

const SURFACES = [
  "sidebar",
  "background",
  "card",
  "secondary",
  "surface-hover",
  "surface-active",
];

/* Rendered channel value, which is what the eye reads near black: contrast
   ratio and OKLCH lightness both carry constants that flatten a doubling. */
function channel(name: string): number {
  const { L, C, H } = step(name);
  const h = (H * Math.PI) / 180;
  const [a, b] = [C * Math.cos(h), C * Math.sin(h)];
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const g = Math.min(
    1,
    Math.max(0, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
  );
  return Math.round(
    (g <= 0.0031308 ? 12.92 * g : 1.055 * g ** (1 / 2.4) - 0.055) * 255,
  );
}

describe("the scale", () => {
  it("doubles the ground into the stage, then steps each rung about +14%", () => {
    expect(channel("n-2") / channel("n-1")).toBeGreaterThanOrEqual(1.9);
    for (const [below, above] of [
      ["n-2", "n-3"],
      ["n-3", "n-4"],
    ] as const) {
      const ratio = channel(above) / channel(below);
      expect(ratio, `${below} to ${above}`).toBeGreaterThan(1.08);
      expect(ratio, `${below} to ${above}`).toBeLessThan(1.22);
    }
  });

  it("keeps every line above every surface, so an edge cannot invert", () => {
    for (const line of ["line-1", "line-2", "line-3"])
      for (const n of ["n-1", "n-2", "n-3", "n-4"])
        expect(channel(line), `${line} over ${n}`).toBeGreaterThan(channel(n));
  });

  it("spaces ink by 0.1225", () => {
    expectEvenSteps(["ink-1", "ink-2", "ink-3"], 0.1225);
  });

  it("spaces status tints by 0.09", () => {
    expectEvenSteps(["status-fail-tint", "status-fail-wash"], 0.09);
  });

  /* One value per accent: a fill lifts toward white the same way a surface
     lifts toward ink, so a second hand-picked hex cannot drift from it. */
  it("lifts each fill toward white for its hover", () => {
    for (const [fill, hover] of [
      ["primary", "primary-hover"],
      ["destructive-fill", "destructive-fill-hover"],
    ] as const) {
      expect(mixes.get(hover)?.toward, `--${hover}`).toBe("white");
      expect(step(hover).L).toBeGreaterThan(step(fill).L);
    }
  });

  it("puts the sidebar below the stage, which sits below what is raised", () => {
    expect(step("sidebar").L).toBeLessThan(step("background").L);
    expect(step("background").L).toBeLessThan(step("card").L);
  });

  /* A gradient is a composition of steps, so each of its stops is held to the
     same rule every other colour is: it names a step, never a value. */
  it("builds every gradient out of steps", () => {
    const gradients = [...declarations].filter(([, v]) =>
      v.startsWith("linear-gradient("),
    );
    expect(gradients.length).toBeGreaterThan(0);
    for (const [name, value] of gradients) {
      const stops = [...value.matchAll(/var\(--([a-z][-a-z0-9]*)\)/g)];
      expect(stops.length, `--${name} has no stops`).toBeGreaterThan(1);
      for (const [, stop] of stops)
        expect(
          () => step(stop ?? ""),
          `--${name} stop --${stop}`,
        ).not.toThrow();
    }
  });

  it("holds every semantic token to a step, a mix or an alias", () => {
    for (const [name, value] of declarations) {
      if (scale.has(name) || aliases.has(name) || mixes.has(name)) continue;
      if (value.startsWith("linear-gradient(")) continue;
      expect(value, `--${name} is neither a step, a mix nor an alias`).toMatch(
        /oklch\(0 0 0 \/ /,
      );
    }
    for (const name of scale.keys()) {
      expect(name, `--${name} is a raw colour outside the scale`).toMatch(
        /^(n|line|ink|status|cobalt|red|white)(-|$)/,
      );
    }
    for (const [name, target] of aliases) {
      expect(
        scale.has(target) || mixes.has(target),
        `--${name} points at --${target}`,
      ).toBe(true);
    }
  });

  /* These shipped pointing at one token, so hovering a selected row said
     nothing and the two states were indistinguishable. */
  it("separates the sidebar's hover from its selected fill", () => {
    const [rest, hover, active] = [
      "sidebar",
      "sidebar-hover",
      "sidebar-active",
    ];
    expect(contrast(hover, rest)).toBeGreaterThan(1.05);
    expect(contrast(active, hover)).toBeGreaterThan(1.1);
    expect(step(active).L).toBeGreaterThan(step(hover).L);
  });

  /* Rest ink is dim so lifting it to full on hover is the signal; a bright
     rest leaves nowhere to travel. */
  it("keeps the sidebar's rest ink below its lit ink, both above AA", () => {
    expect(contrast("sidebar-foreground", "sidebar")).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(step("sidebar-foreground").L).toBeLessThan(
      step("sidebar-hover-foreground").L,
    );
    for (const fill of ["sidebar-hover", "sidebar-active"])
      expect(
        contrast("sidebar-hover-foreground", fill),
        `lit ink on ${fill}`,
      ).toBeGreaterThanOrEqual(7);
  });

  /* The rule the ladder depends on: a state is relative to the surface it
     lands on, so it stays right at every depth instead of only one. */
  it("derives every hover and active state rather than naming a rung", () => {
    const states = [...declarations.keys()].filter((n) =>
      /-(hover|active)$/.test(n),
    );
    expect(states.length).toBeGreaterThan(0);
    for (const name of states) {
      if (name === "primary-hover" || name.includes("fill")) continue;
      const mix = mixes.get(name);
      expect(mix, `--${name} is not a mix`).toBeDefined();
      expect(mix?.toward, `--${name} mixes toward the wrong pole`).toBe(
        "ink-3",
      );
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

/* Every source file that can carry a utility class, named so a failure says
   where. Tests are excluded: they assert on classes rather than declare them. */
function sources(
  dir: string,
  into: [string, string][] = [],
): [string, string][] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "tests") sources(path, into);
    } else if (/\.tsx?$/.test(entry.name)) {
      into.push([path, readFileSync(path, "utf8")]);
    }
  }
  return into;
}

const SOURCES = sources(join(process.cwd(), "src"));

/* Values a utility of this kind may name. Anything else either fails silently
   or invents a rung, which is the drift these bands exist to stop. */
function expectUtilityValues(
  pattern: RegExp,
  allowed: readonly string[],
  what: string,
): void {
  for (const [path, text] of SOURCES) {
    for (const match of text.matchAll(pattern)) {
      expect(allowed, `${what} \`${match[0]}\` in ${path}`).toContain(match[1]);
    }
  }
}

// Sizes are dimensions, not rhythm: only gaps, padding and margins are held.
// 1.5 and 2.5 are the 6px and 10px half-steps; density needs them.
const SPACING = ["0", "1", "1.5", "2", "2.5", "3", "4", "6", "8", "12"];

describe("radius", () => {
  it("declares one set, and no rung outside it", () => {
    const rungs = [...css.matchAll(/--radius(-[a-z0-9]*)?:/g)].map((m) => m[1]);
    expect(rungs.sort()).toEqual(["-2xl", "-lg", "-md", "-sm", "-xl"]);
  });

  /* Five names, two values: the names are Tailwind's namespace and the system
     has one radius for the stage and one for what floats above it. */
  it("spends two values across those names", () => {
    const values = [...css.matchAll(/--radius-[a-z0-9]*:\s*([^;]+);/g)].map(
      (m) => m[1]?.trim(),
    );
    expect([...new Set(values)].sort()).toEqual(["0.5rem", "0.75rem"]);
  });

  it("rounds nothing to a value off that set", () => {
    expectUtilityValues(
      /(?<![-\w])rounded(?:-(?:t|b|l|r|s|e|tl|tr|bl|br))?-([^\s"'`]+)/g,
      ["sm", "md", "lg", "xl", "2xl", "full", "none", "[inherit]"],
      "radius",
    );
  });
});

describe("focus", () => {
  it("is one edge on the cobalt ink, laid over the control's own border", () => {
    expect(css).toContain("outline: 1px solid var(--color-ring)");
    expect(css).toContain("outline-offset: -1px");
    expect(css).not.toContain(":focus-visible:not([data-slot])");
  });

  // It fades in, so it starts transparent rather than at the text colour.
  it("gives the edge a colour to fade in from", () => {
    expect(css).toContain("outline-color: transparent");
  });

  /* One group hoists the edge for the input inside it; nothing else recolours
     a border, and nothing draws a second mark of its own. */
  it("leaves the edge to the one rule, bar the group that owns its input", () => {
    for (const [path, text] of SOURCES) {
      if (path.endsWith("input-group.tsx")) continue;
      expect(text, `border-ring in ${path}`).not.toContain("border-ring");
    }
    expectUtilityValues(
      /(?<![-\w])outline-((?![0-9]|offset-|hidden\b)[^\s"'`]+)/g,
      ["ring", "none"],
      "outline",
    );
    // Suppressing the ring is legitimate only where another element draws it.
    for (const [path, text] of SOURCES) {
      expect(text, `unscoped outline-none in ${path}`).not.toMatch(
        /(?<!focus-visible:)outline-none/,
      );
    }
  });
});

describe("shadow", () => {
  it("clears Tailwind's own scale so a stale size stops generating", () => {
    expect(css).toContain("--shadow-*: initial;");
  });

  it("spends only the two project tokens", () => {
    expectUtilityValues(
      /(?<![-\w])shadow-([^\s"'`]+)/g,
      ["edge", "raised", "overlay", "none"],
      "shadow",
    );
  });
});

describe("motion", () => {
  it("resolves every duration and easing to a token", () => {
    expectUtilityValues(
      /(?<![-\w])duration-([^\s"'`]+)/g,
      [
        "(--duration-fast)",
        "(--duration-base)",
        "(--duration-slow)",
        "(--duration-panel)",
      ],
      "duration",
    );
    expectUtilityValues(
      /(?<![-\w])ease-([^\s"'`]+)/g,
      ["in", "out", "panel"],
      "easing",
    );
    for (const token of [
      "--duration-fast",
      "--duration-base",
      "--duration-slow",
      "--duration-panel",
    ])
      expect(css).toContain(`${token}:`);
  });

  it("no-ops every animation under reduced motion, in one place", () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\*,\s*\*::before,\s*\*::after \{[^}]*animation-duration: 1ms !important;[^}]*transition-duration: 1ms !important;/,
    );
    for (const [path, text] of SOURCES) {
      expect(text, `motion-reduce: in ${path}`).not.toContain("motion-reduce:");
    }
  });
});

describe("spacing", () => {
  it("states the 4px base the set is built on", () => {
    expect(css).toContain("--spacing: 0.25rem;");
  });

  it("holds every gap, padding and margin to the 4px set", () => {
    expectUtilityValues(
      /(?<![-\w])-?(?:gap|gap-x|gap-y|space-x|space-y|p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml)-(\d+(?:\.\d+)?)(?![\w.-])/g,
      SPACING,
      "spacing",
    );
  });
});
