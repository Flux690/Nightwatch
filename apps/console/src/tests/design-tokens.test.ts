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

/* An overlay names no base, because a control that can sit on four depths has
   no one surface to be mixed against. It composites over whatever is beneath. */
const overlays = new Map<string, { ink: string; alpha: number }>();
const OVERLAY =
  /^color-mix\(\s*in srgb,\s*var\(--([a-z][-a-z0-9]*)\) ([\d.]+)%,\s*transparent\s*\)$/;
/* A scalar declaration: a theme's four inputs and the departures they drive.
   Resolved here so the test does the arithmetic the browser does. */
const scalars = new Map<string, number>();
for (const [name, value] of declarations) {
  if (/^-?[\d.]+$/.test(value)) scalars.set(name, +value);
}

// var() and calc() over those scalars, with the two operators the ladder uses.
function scalar(expr: string): number {
  const resolved = expr
    .replace(/var\(--([a-z0-9-]+)\)/g, (_, ref: string) =>
      String(scalars.get(ref) ?? NaN),
    )
    .replace(/^calc\((.*)\)$/, "$1")
    .trim();
  const sum = resolved.split(/\s+\+\s+/).map((term) =>
    term
      .split(/\s*\*\s*/)
      .map(Number)
      .reduce((a, b) => a * b, 1),
  );
  return sum.reduce((a, b) => a + b, 0);
}

// The three slots of an oklch(), split on the spaces between them: a slot may
// be a calc() carrying spaces and parens of its own.
function slots(value: string): string[] | null {
  const body = /^oklch\((.*)\)$/.exec(value.replace(/\s+/g, " ").trim())?.[1];
  if (body === undefined || body.includes("/")) return null;
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === " " && depth === 0) {
      if (current) out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) out.push(current);
  return out.length === 3 ? out : null;
}

for (const [name, value] of declarations) {
  const triple = slots(value);
  if (triple) {
    const [L, C, H] = triple.map(scalar);
    if ([L, C, H].every(Number.isFinite)) {
      scale.set(name, { L: L!, C: C!, H: H! });
      continue;
    }
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
  const wash = OVERLAY.exec(value);
  if (wash) {
    overlays.set(name, { ink: wash[1] ?? "", alpha: +(wash[2] ?? 0) / 100 });
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

// Every gap in a band equals the first one. The value is the theme's; only the
// evenness is the system's, so a band of two is trivially even and says nothing.
function expectEvenSteps(group: string[]): void {
  const gaps = group
    .slice(1)
    .map((name, i) => step(name).L - step(group[i] ?? "").L);
  for (const [i, gap] of gaps.entries()) {
    expect(gap, `${group[i]} to ${group[i + 1]}`).toBeCloseTo(gaps[0]!, 4);
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
  /* The ladder rises away from the anchor and never doubles back. The size of a
     step is a theme's business; the order is the system's, so only order is
     asserted here and the contrast floors below carry the rest. */
  it("rises monotonically away from the anchor", () => {
    for (const [below, above] of [
      ["n-1", "n-2"],
      ["n-2", "n-3"],
      ["n-3", "n-4"],
      ["n-4", "n-5"],
    ] as const) {
      expect(channel(above), `${below} to ${above}`).toBeGreaterThan(
        channel(below),
      );
    }
  });

  /* Every surface is the anchor plus its own departure, so a theme moves the
     whole ladder by moving one value. A rung that stops deriving is a rung that
     will be wrong in the next theme. */
  it("derives every surface from the one anchor", () => {
    const anchor = scalars.get("base-l");
    expect(anchor, "--base-l").toBeTypeOf("number");
    expect(step("n-2").L).toBeCloseTo(anchor!, 10);
    for (const rung of ["n-1", "n-3", "n-4", "n-5"]) {
      const departure = scalars.get(`d-${rung}`);
      expect(departure, `--d-${rung}`).toBeTypeOf("number");
      expect(step(rung).L, rung).toBeCloseTo(
        anchor! + departure! * scalars.get("contrast")!,
        10,
      );
    }
  });

  it("keeps every line above every surface, so an edge cannot invert", () => {
    for (const line of ["line-1", "line-2", "line-3"])
      for (const n of ["n-1", "n-2", "n-3", "n-4", "n-5"])
        expect(channel(line), `${line} over ${n}`).toBeGreaterThan(channel(n));
  });

  /* Evenly spaced, without saying by how much: the gap is a theme's to choose
     and a band with one uneven rung is the defect. */
  it("spaces ink evenly, whatever the spacing is", () => {
    expectEvenSteps(["ink-1", "ink-2", "ink-3"]);
  });

  it("spaces status tints evenly, whatever the spacing is", () => {
    expectEvenSteps(["status-fail-tint", "status-fail-wash"]);
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
      if (overlays.has(name)) continue;
      if (value.startsWith("linear-gradient(")) continue;
      // A theme's inputs and the departures they drive are numbers, not colours.
      if (scalars.has(name)) continue;
      expect(value, `--${name} is neither a step, a mix nor an alias`).toMatch(
        /oklch\(0 0 0 \/ /,
      );
    }
    for (const name of scale.keys()) {
      expect(name, `--${name} is a raw colour outside the scale`).toMatch(
        /^(n|line|ink|status|series|cobalt|red|white)(-|$)/,
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
     lands on, so it stays right at every depth instead of only one. A state
     bound to a surface it does not sit on is what makes a hover sink. */
  it("derives every hover and active state rather than naming a rung", () => {
    const states = [...declarations.keys()].filter((n) =>
      /-(hover|active)$/.test(n),
    );
    expect(states.length).toBeGreaterThan(0);
    for (const name of states) {
      if (name === "primary-hover" || name.includes("fill")) continue;
      const overlay = overlays.get(name);
      if (overlay) {
        expect(overlay.ink, `--${name} washes with the wrong pole`).toBe(
          "ink-3",
        );
        continue;
      }
      const mix = mixes.get(name);
      expect(mix, `--${name} is neither a mix nor a wash`).toBeDefined();
      expect(mix?.toward, `--${name} mixes toward the wrong pole`).toBe(
        "ink-3",
      );
    }
  });

  /* A wash's ink sits above the whole surface ramp, so compositing it can only
     lighten. A rung used this way lifts at one depth and sinks at the next,
     which put a menu row darker than the menu it opened on. */
  it("keeps a depth-independent state above every surface it can land on", () => {
    expect(overlays.size).toBeGreaterThan(0);
    for (const [name, { ink, alpha }] of overlays) {
      expect(alpha, `--${name} washes with no ink`).toBeGreaterThan(0);
      for (const surface of [...SURFACES, "popover", "control", "input"]) {
        expect(
          step(ink).L,
          `--${name} would sink on --${surface}`,
        ).toBeGreaterThan(step(surface).L);
      }
    }
  });
});

/* A chart tells series apart by hue alone, so they have to be equal in every
   other way, and each has to clear the graphical-object floor on the stage. */
describe("chart series", () => {
  const series = [...scale.entries()].filter(([name]) =>
    name.startsWith("series-"),
  );

  it("varies hue and nothing else", () => {
    expect(series.length).toBeGreaterThanOrEqual(4);
    expect(new Set(series.map(([, step]) => step.L)).size).toBe(1);
    expect(new Set(series.map(([, step]) => step.C)).size).toBe(1);
    expect(new Set(series.map(([, step]) => step.H)).size).toBe(series.length);
  });

  /* Status means something. A line the same hue as ok, warn or fail reads as a
     healthy or a failing one when it is neither. */
  it("keeps clear of the hues that carry status", () => {
    const status = ["status-ok", "status-warn", "status-fail"].map(
      (name) => scale.get(name)!.H,
    );
    for (const [name, step] of series) {
      for (const hue of status) {
        expect(
          Math.abs(step.H - hue),
          `--${name} sits on a status hue`,
        ).toBeGreaterThan(25);
      }
    }
  });

  it("clears 3:1 on the stage (WCAG 1.4.11)", () => {
    for (const [name] of series) {
      expect(contrast(name, "background"), name).toBeGreaterThanOrEqual(3);
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

describe("widths", () => {
  /* styles.css states the rule: every width resolves to a container token. A
     raw `max-w-120` on a Field is how help text ended up clamped to half the
     column it had. components/ui is exempt, carrying its own defaults. */
  it("names a container token rather than a raw width", () => {
    const declared = [...css.matchAll(/--container-([a-z-]+):/g)].map(
      (m) => m[1],
    );
    for (const [path, text] of SOURCES) {
      if (path.includes(join("components", "ui"))) continue;
      for (const match of text.matchAll(/\bmax-w-([a-z0-9-]+)/g)) {
        const value = match[1] ?? "";
        // Tailwind's own keywords stay: they are relationships, not measures.
        if (["full", "none", "fit", "min", "max", "screen"].includes(value)) {
          continue;
        }
        expect(declared, `\`${match[0]}\` in ${path}`).toContain(value);
      }
    }
  });
});

describe("radius", () => {
  it("declares one set, and no rung outside it", () => {
    const rungs = [...css.matchAll(/--radius(-[a-z0-9]*)?:/g)].map((m) => m[1]);
    expect(rungs.sort()).toEqual(["-2xl", "-lg", "-md", "-sm", "-xl"]);
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
  it("holds every gap, padding and margin to the 4px set", () => {
    expectUtilityValues(
      /(?<![-\w])-?(?:gap|gap-x|gap-y|space-x|space-y|p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml)-(\d+(?:\.\d+)?)(?![\w.-])/g,
      SPACING,
      "spacing",
    );
  });
});
