import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

// Injected by vitest.config.ts, which runs in Node and is the only place certain
// of this package's location however the suite was started.
const SRC = process.env["CONSOLE_SRC"] ?? "";

const css = readFileSync(join(SRC, "styles.css"), "utf8");

/* Every declaration in styles.css, by the selector that carries it. A token is
   read in the context of a ground, because after re-anchoring the same name
   resolves to a different colour depending on which surface it lands on. */
const declarations = new Map<string, string>();
const groundOverrides = new Map<string, string>();

// Comments are stripped first, or a leading /* … */ is captured as part of the
// selector and the block it introduces is skipped.
const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");

for (const block of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const selector = ((block[1] ?? "").split(";").pop() ?? "").trim();
  const body = block[2] ?? "";
  if (!/^:root|\[data-ground/.test(selector)) continue;
  const scoped = /^\[data-ground="([a-z]+)"\]$/.exec(selector);
  for (const m of body.matchAll(/--([a-z][-a-z0-9]*):\s*([^;]+);/g)) {
    const name = m[1] ?? "";
    const value = (m[2] ?? "").trim().replace(/\s+/g, " ");
    if (scoped) {
      if (name === "ground-l" || name === "ground-c") {
        groundOverrides.set(`${scoped[1] ?? ""}:${name}`, value);
      }
      continue;
    }
    declarations.set(name, value);
  }
}

/* A calc() evaluator, because the ladder is arithmetic now: a role is its
   ground plus a departure times the contrast, and ink is a proportion of the
   distance to the pole. Anything the browser computes, this has to compute. */
function evaluate(expr: string, env: Map<string, string>): number {
  const src = expr.trim();
  let i = 0;
  const ws = () => {
    while (i < src.length && /\s/.test(src[i] ?? "")) i++;
  };
  function parseExpr(): number {
    let value = parseTerm();
    for (;;) {
      ws();
      const op = src[i];
      if (op !== "+" && op !== "-") return value;
      i++;
      const rhs = parseTerm();
      value = op === "+" ? value + rhs : value - rhs;
    }
  }
  function parseTerm(): number {
    let value = parseFactor();
    for (;;) {
      ws();
      const op = src[i];
      if (op !== "*" && op !== "/") return value;
      i++;
      const rhs = parseFactor();
      value = op === "*" ? value * rhs : value / rhs;
    }
  }
  function parseFactor(): number {
    ws();
    if (src.startsWith("calc(", i)) {
      i += 5;
      const v = parseExpr();
      ws();
      i++;
      return v;
    }
    if (src.startsWith("var(", i)) {
      const close = src.indexOf(")", i);
      const name = src
        .slice(i + 4, close)
        .trim()
        .replace(/^--/, "");
      i = close + 1;
      const ref = env.get(name);
      if (ref === undefined) throw new Error(`--${name} is not declared`);
      return evaluate(ref, env);
    }
    if (src[i] === "(") {
      i++;
      const v = parseExpr();
      ws();
      i++;
      return v;
    }
    if (src[i] === "-") {
      i++;
      return -parseFactor();
    }
    const m = /^-?[\d.]+/.exec(src.slice(i));
    if (!m) throw new Error(`cannot evaluate "${src}" at ${String(i)}`);
    i += m[0].length;
    return Number(m[0]);
  }
  return parseExpr();
}

interface Step {
  L: number;
  C: number;
  H: number;
}

/* The three slots of an lch(), split on the spaces between them: a slot may be
   a calc() carrying spaces and parens of its own. */
function slots(value: string): string[] | null {
  const body = /^lch\((.*)\)$/.exec(value.trim())?.[1];
  if (body === undefined) return null;
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
  return out.length >= 3 ? out.slice(0, 3) : null;
}

const GROUNDS = ["ground", "stage", "surface", "card", "popover"] as const;
type Ground = (typeof GROUNDS)[number];

/* Inputs swapped in for the duration of one block, so the same assertions can
   be run against a base and an accent this sheet has never been shown. */
let palette = new Map<string, string>();
function onPalette(inputs: Record<string, string>, run: () => void): void {
  palette = new Map(Object.entries(inputs));
  try {
    run();
  } finally {
    palette = new Map();
  }
}

function envFor(ground: Ground): Map<string, string> {
  const env = new Map(declarations);
  for (const name of ["ground-l", "ground-c"]) {
    const override = groundOverrides.get(`${ground}:${name}`);
    if (override !== undefined) env.set(name, override);
  }
  for (const [name, value] of palette) env.set(name, value);
  return env;
}

/* The three arguments of a color-mix(), split like slots() so a var() keeps
   its own parens: "in srgb-linear", "<colour> <pct>%", "<colour>". */
function mixParts(value: string): [string, number, string] | null {
  const body = /^color-mix\(\s*in srgb-linear\s*,(.*)\)$/.exec(
    value.trim(),
  )?.[1];
  if (body === undefined) return null;
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  if (out.length !== 2) return null;
  const weighted = /^(.*)\s+([\d.]+)%$/.exec((out[0] ?? "").trim());
  if (!weighted) return null;
  return [weighted[1] ?? "", Number(weighted[2]), (out[1] ?? "").trim()];
}

function stepOf(value: string, env: Map<string, string>): Step {
  const seen = new Set<string>();
  let current = value.trim();
  for (;;) {
    const alias = /^var\(--([a-z][-a-z0-9]*)\)$/.exec(current);
    if (!alias) break;
    const next = alias[1] ?? "";
    if (seen.has(next)) throw new Error(`--${next} loops through itself`);
    seen.add(next);
    const resolved = env.get(next);
    if (resolved === undefined) throw new Error(`--${next} is not declared`);
    current = resolved.trim();
  }
  const mix = mixParts(current);
  if (mix) {
    const [top, pct, bottom] = mix;
    const over = linear(stepOf(top, env));
    const under = linear(stepOf(bottom, env));
    const p = pct / 100;
    return lchOf(over.map((c, i) => p * c + (1 - p) * (under[i] ?? 0)));
  }
  const triple = slots(current);
  if (!triple) throw new Error(`not an lch() step: ${current}`);
  const [L, C, H] = triple.map((slot) => evaluate(slot, env));
  return { L: L ?? NaN, C: C ?? NaN, H: H ?? NaN };
}

function step(name: string, ground: Ground = "stage"): Step {
  const env = envFor(ground);
  if (!env.has(name)) throw new Error(`--${name} is not declared`);
  return stepOf(`var(--${name})`, env);
}

/* CSS Color 4 lch() is D50 Lab, so it is Bradford-adapted to D65 before the
   sRGB matrix. Getting this wrong reads every surface as black. */
const D50: [number, number, number] = [
  0.3457 / 0.3585,
  1,
  (1 - 0.3457 - 0.3585) / 0.3585,
];
const D50_TO_D65 = [
  [0.9554734527042182, -0.023098536874261423, 0.0632593086610217],
  [-0.028369706963208136, 1.0099954580058226, 0.021041398966943008],
  [0.012314001688319899, -0.020507696433477912, 1.3303659366080753],
];
const XYZ_TO_RGB = [
  [3.2409699419045226, -1.537383177570094, -0.4986107602930034],
  [-0.9692436362808796, 1.8759675015077202, 0.04155505740717559],
  [0.05563007969699366, -0.20397695888897652, 1.0569715142428786],
];
const apply = (m: number[][], v: number[]): number[] =>
  m.map(
    (r) =>
      (r[0] ?? 0) * (v[0] ?? 0) +
      (r[1] ?? 0) * (v[1] ?? 0) +
      (r[2] ?? 0) * (v[2] ?? 0),
  );

/* A wash composites in linear light, so a mix has to be taken before the
   transfer function and read back after it. */
const RGB_TO_XYZ = [
  [0.41239079926595934, 0.357584339383878, 0.18048078840183424],
  [0.21263900587151027, 0.7151686787677561, 0.07219231536073371],
  [0.01933081871559181, 0.11919477979462595, 0.9505321522496607],
];
const D65_TO_D50 = [
  [1.047929760567796, 0.022946950150051406, -0.050192316470654],
  [0.029627803023954218, 0.9904343701001199, -0.01707376778317304],
  [-0.009243028938201791, 0.015055225081508652, 0.7518742754143181],
];
const DELTA = 6 / 29;

function linear({ L, C, H }: Step): number[] {
  const h = (H * Math.PI) / 180;
  const fy = (L + 16) / 116;
  const fx = fy + (C * Math.cos(h)) / 500;
  const fz = fy - (C * Math.sin(h)) / 200;
  const inv = (t: number) =>
    t > DELTA ? t ** 3 : 3 * DELTA * DELTA * (t - 4 / 29);
  const xyz = [inv(fx) * D50[0], inv(fy) * D50[1], inv(fz) * D50[2]];
  return apply(XYZ_TO_RGB, apply(D50_TO_D65, xyz));
}

function lchOf(rgb: number[]): Step {
  const xyz = apply(D65_TO_D50, apply(RGB_TO_XYZ, rgb));
  const f = (t: number) =>
    t > DELTA ** 3 ? Math.cbrt(t) : t / (3 * DELTA * DELTA) + 4 / 29;
  const [fx, fy, fz] = [
    f((xyz[0] ?? 0) / D50[0]),
    f((xyz[1] ?? 0) / D50[1]),
    f((xyz[2] ?? 0) / D50[2]),
  ];
  const a = 500 * ((fx ?? 0) - (fy ?? 0));
  const b = 200 * ((fy ?? 0) - (fz ?? 0));
  return {
    L: 116 * (fy ?? 0) - 16,
    C: Math.hypot(a, b),
    H: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360,
  };
}

function channels(s: Step): [number, number, number] {
  const [r, g, b] = linear(s).map((c) => {
    const v =
      c <= 0.0031308 ? 12.92 * c : 1.055 * Math.abs(c) ** (1 / 2.4) - 0.055;
    return Math.min(1, Math.max(0, v));
  });
  return [r ?? 0, g ?? 0, b ?? 0];
}

function luminance(s: Step): number {
  const [r, g, b] = channels(s).map((c) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function ratio(a: Step, b: Step): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/* Rendered channel value, which is what the eye reads near black: contrast
   ratio and lightness both carry constants that flatten a doubling. */
const channel = (name: string, ground: Ground = "stage"): number =>
  Math.round((channels(step(name, ground))[1] ?? 0) * 255);

const GROUND_TOKEN: Record<Ground, string> = {
  ground: "n-1",
  stage: "n-2",
  surface: "n-3",
  card: "n-4",
  popover: "n-5",
};
const onOwnGround = (name: string, g: Ground): number =>
  ratio(step(name, g), step(GROUND_TOKEN[g], g));

/* Read from the sheet rather than restated here. A literal would assert the
   value the base happens to have today and permit the derivation to be lost. */
const scalar = (name: string, g: Ground = "stage"): number => {
  const env = envFor(g);
  return evaluate(env.get(name) ?? "", env);
};
const groundChroma = (g: Ground): number => scalar("ground-c", g);

describe("the ladder", () => {
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
    const env = envFor("stage");
    const anchor = evaluate(env.get("base-l") ?? "", env);
    const contrast = evaluate(env.get("contrast") ?? "", env);
    expect(step("n-2").L).toBeCloseTo(anchor, 10);
    for (const [rung, departure] of [
      ["n-1", "d-ground"],
      ["n-3", "d-surface"],
      ["n-4", "d-card"],
      ["n-5", "d-popover"],
    ] as const) {
      const d = evaluate(env.get(departure) ?? "", env);
      expect(step(rung).L, rung).toBeCloseTo(anchor + d * contrast, 8);
    }
  });

  /* The rule the whole system rests on: a control, an edge and ink are all
     departures from the ground they land on, not from the page. A token that
     resolves identically on every ground has stopped re-anchoring. */
  it("re-anchors every control, edge and ink per ground", () => {
    for (const name of [
      "control",
      "control-hover",
      "state-hover",
      "line-1",
      "line-2",
      "line-3",
      "line-2-hover",
      "ink-1",
      "ink-2",
      "ink-3",
      "ink-disabled",
      "control-disabled",
    ]) {
      const seen = GROUNDS.map((g) => step(name, g).L);
      expect(new Set(seen.map((l) => l.toFixed(4))).size, name).toBe(
        GROUNDS.length,
      );
    }
  });

  /* Chroma is a departure from the ground's own chroma, not a constant. Held
     flat, a control on a card came out duller than the same control on the
     stage, which is not what the system it reproduces does. */
  it("re-anchors chroma per ground, and mixes ink's at half rate", () => {
    for (const [role, departure] of [
      ["control", "dc-control"],
      ["control-hover", "dc-control-lit"],
      ["state-hover", "dc-state"],
      ["highlight", "dc-highlight"],
      ["line-1", "dc-line"],
      ["line-lit", "dc-line-lit"],
    ] as const) {
      const env = envFor("stage");
      const d = evaluate(env.get(departure) ?? "", env);
      for (const g of GROUNDS) {
        expect(step(role, g).C, `${role} on ${g}`).toBeCloseTo(
          groundChroma(g) + d,
          8,
        );
      }
    }
    const base = scalar("base-c");
    const inkBase = scalar("c-ink-base");
    const half = scalar("t-ink-c");
    for (const ink of ["ink-1", "ink-2", "ink-3"]) {
      for (const g of GROUNDS) {
        expect(step(ink, g).C, `${ink} on ${g}`).toBeCloseTo(
          inkBase + (groundChroma(g) - base) * half,
          8,
        );
      }
    }
  });

  /* A ground's chroma is a departure from the base's, like its lightness. As
     literals these were right at one base and silently wrong at every other. */
  it("states every ground's chroma as a departure from the base", () => {
    const base = scalar("base-c");
    for (const [g, departure] of [
      ["ground", "dc-ground"],
      ["surface", "dc-surface"],
      ["card", "dc-card"],
      ["popover", "dc-popover"],
    ] as const) {
      expect(groundChroma(g), g).toBeCloseTo(base + scalar(departure), 8);
      expect(step(GROUND_TOKEN[g], g).C, GROUND_TOKEN[g]).toBeCloseTo(
        groundChroma(g),
        8,
      );
    }
    expect(groundChroma("stage"), "stage").toBeCloseTo(base, 8);
  });

  /* The one family that must not re-anchor: a primary button is the same
     colour on the page, on a card and in a menu, which is what finds it. */
  it("holds the accent absolute, and on one hue", () => {
    for (const name of ["cobalt-fill", "cobalt-fill-hover", "cobalt-ink"]) {
      const seen = GROUNDS.map((g) => step(name, g));
      expect(new Set(seen.map((s) => s.L.toFixed(6))).size, name).toBe(1);
      for (const s of seen) {
        expect(s.H, `${name} hue`).toBeCloseTo(scalar("accent-h"), 8);
      }
    }
    expect(step("selection").H, "selection hue").toBeCloseTo(
      scalar("accent-h"),
      8,
    );
  });

  /* An edge answers the pointer the way a fill does. Without these a box drawn
     by its border alone was the one control that did not react at all. */
  it("moves every edge further from the ground under the pointer", () => {
    for (const g of GROUNDS) {
      expect(channel("line-2-hover", g), `edge hover on ${g}`).toBeGreaterThan(
        channel("line-2", g),
      );
    }
  });

  /* Inactive, not faded: a wash held a constant alpha and so a varying
     distance, which drifted as the ground it landed on got lighter. */
  it("keeps disabled a fixed distance from its own ground", () => {
    for (const g of GROUNDS) {
      expect(channel("ink-disabled", g), `ink on ${g}`).toBeLessThan(
        channel("ink-3", g),
      );
      expect(channel("ink-disabled", g), `ink on ${g}`).toBeGreaterThan(
        channel(GROUND_TOKEN[g], g),
      );
      expect(channel("control-disabled", g), `control on ${g}`).toBeLessThan(
        channel("control", g),
      );
    }
    const spread = GROUNDS.map(
      (g) => step("ink-disabled", g).L - step(GROUND_TOKEN[g], g).L,
    );
    for (const d of spread) expect(d).toBeGreaterThan(0);
  });

  it("keeps every line above the ground it is drawn on", () => {
    for (const line of ["line-1", "line-2", "line-3"]) {
      for (const g of GROUNDS) {
        expect(channel(line, g), `${line} on ${g}`).toBeGreaterThan(
          channel(GROUND_TOKEN[g], g),
        );
      }
    }
  });

  it("lifts a control off every ground it can stand on", () => {
    for (const g of GROUNDS) {
      expect(channel("control", g), `control on ${g}`).toBeGreaterThan(
        channel(GROUND_TOKEN[g], g),
      );
      expect(channel("control-hover", g), `hover on ${g}`).toBeGreaterThan(
        channel("control", g),
      );
    }
  });

  /* Ink is a proportion of the distance to the pole, never an offset. An
     additive ink ladder drifts the moment contrast or the base moves. */
  it("mixes ink toward the pole rather than offsetting it", () => {
    const env = envFor("stage");
    for (const [name, t] of [
      ["ink-1", "t-ink-1"],
      ["ink-2", "t-ink-2"],
      ["ink-3", "t-ink-3"],
    ] as const) {
      const share = evaluate(env.get(t) ?? "", env);
      for (const g of GROUNDS) {
        const groundL = step(GROUND_TOKEN[g], g).L;
        expect(step(name, g).L, `${name} on ${g}`).toBeCloseTo(
          groundL + share * (100 - groundL),
          8,
        );
      }
    }
  });

  /* Greys read as grey. Our first ladder carried four times this chroma and
     every dim label came out lavender. */
  it("keeps a ceiling on ink chroma", () => {
    for (const name of ["ink-1", "ink-2", "ink-3"]) {
      expect(step(name).C, name).toBeLessThanOrEqual(2);
      const [r, , b] = channels(step(name)).map((c) => Math.round(c * 255));
      expect(Math.abs((b ?? 0) - (r ?? 0)), `${name} tint`).toBeLessThanOrEqual(
        4,
      );
    }
  });

  it("holds every semantic token to a step or an alias", () => {
    for (const [name, value] of declarations) {
      if (/^(d|dc|c|t)-/.test(name) || /^(base|l|accent)-/.test(name)) continue;
      if (name === "contrast") continue;
      if (name === "ground-l" || name === "ground-c") continue;
      if (
        /^(hue|radius|text|container|ease|duration|font|spacing)/.test(name)
      ) {
        continue;
      }
      if (value.startsWith("linear-gradient(")) continue;
      if (/lch\(0 0 0 \/ /.test(value) || value.includes("px ")) continue;
      expect(
        () => step(name),
        `--${name} does not resolve to a step`,
      ).not.toThrow();
    }
  });

  /* A tint washes its own ground rather than naming a fixed rung, which is what
     lets it be a hover: held absolute it went darker than the menu it opened
     on, and no ground could outrun it without inverting. */
  it("washes every tint over the ground it is drawn on", () => {
    const tints = [...declarations.keys()].filter((n) =>
      /-tint(-hover)?$/.test(n),
    );
    expect(tints.length).toBeGreaterThan(0);
    for (const tint of tints) {
      const seen = GROUNDS.map((g) => step(tint, g).L);
      expect(new Set(seen.map((l) => l.toFixed(4))).size, tint).toBe(
        GROUNDS.length,
      );
      for (const g of GROUNDS) {
        expect(channel(tint, g), `${tint} on ${g}`).toBeGreaterThan(
          channel(GROUND_TOKEN[g], g),
        );
      }
    }
  });
});

describe("the contrast matrix", () => {
  /* Measured within a ground, never across two. After re-anchoring, ink inside
     a menu is the menu's ink; holding it against the page's background tests a
     pair that never appears on screen. */
  it("keeps full ink at 9:1+ on its own ground", () => {
    for (const g of GROUNDS) {
      expect(
        onOwnGround("foreground", g),
        `foreground on ${g}`,
      ).toBeGreaterThanOrEqual(9);
    }
  });

  it("keeps muted and subtle ink at AA on their own ground", () => {
    for (const ink of ["muted-foreground", "ink-subtle"]) {
      for (const g of GROUNDS) {
        expect(onOwnGround(ink, g), `${ink} on ${g}`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    }
  });

  it("keeps the focus ring at 3:1+ on every ground (WCAG 1.4.11)", () => {
    for (const g of GROUNDS) {
      expect(onOwnGround("ring", g), `ring on ${g}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps border-strong at 3:1+ on every ground (WCAG 1.4.11)", () => {
    for (const g of GROUNDS) {
      expect(onOwnGround("border-strong", g), `on ${g}`).toBeGreaterThanOrEqual(
        3,
      );
    }
  });

  it("keeps the input border calm on the ground it is drawn on", () => {
    for (const g of GROUNDS) {
      const r = onOwnGround("input", g);
      expect(r, `input on ${g} lower`).toBeGreaterThanOrEqual(1.1);
      expect(r, `input on ${g} upper`).toBeLessThanOrEqual(3);
    }
  });

  /* Status is absolute within a polarity, so it is held only on the grounds
     status actually appears on. Text and Base are two different jobs with two
     different floors: 7:1 for words, 3:1 for a dot. */
  const STATUS_GROUNDS: Ground[] = ["ground", "stage", "surface", "card"];

  it("keeps status text at AAA where status appears", () => {
    for (const tone of ["ok", "wait", "fail", "run"]) {
      for (const g of STATUS_GROUNDS) {
        expect(
          ratio(step(tone, g), step(GROUND_TOKEN[g], g)),
          `${tone} on ${g}`,
        ).toBeGreaterThanOrEqual(tone === "run" ? 4.5 : 7);
      }
    }
  });

  it("keeps status text at AA on its own tint", () => {
    for (const [text, tint] of [
      ["success", "success-tint"],
      ["warning", "warning-tint"],
      ["destructive", "destructive-tint"],
      ["destructive", "destructive-tint-hover"],
    ] as const) {
      expect(
        ratio(step(text), step(tint)),
        `${text} on ${tint}`,
      ).toBeGreaterThanOrEqual(4.5);
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
        ratio(step("primary-foreground"), step(fill)),
        `on ${fill}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("separates the sidebar's hover from its selected fill", () => {
    expect(channel("sidebar-active", "ground")).toBeGreaterThan(
      channel("sidebar-hover", "ground"),
    );
    expect(
      ratio(step("sidebar-foreground", "ground"), step("sidebar", "ground")),
    ).toBeGreaterThanOrEqual(4.5);
  });
});

/* A chart tells series apart by hue alone, so they have to be equal in every
   other way, and each has to clear the graphical-object floor on the stage. */
describe("chart series", () => {
  const series = [...declarations.keys()].filter((n) => /^series-\d$/.test(n));

  it("varies hue and nothing else", () => {
    expect(series.length).toBeGreaterThanOrEqual(4);
    const steps = series.map((n) => step(n));
    expect(new Set(steps.map((s) => s.L)).size).toBe(1);
    expect(new Set(steps.map((s) => s.C)).size).toBe(1);
    expect(new Set(steps.map((s) => s.H)).size).toBe(series.length);
  });

  /* Status means something. A line the same hue as ok, warn or fail reads as a
     healthy or a failing one when it is neither. */
  it("keeps clear of the hues that carry status", () => {
    const env = envFor("stage");
    const status = ["hue-green", "hue-yellow", "hue-red"].map((n) =>
      evaluate(env.get(n) ?? "", env),
    );
    for (const name of series) {
      for (const hue of status) {
        expect(
          Math.abs(step(name).H - hue),
          `--${name} sits on a status hue`,
        ).toBeGreaterThan(25);
      }
    }
  });

  it("clears 3:1 on the stage (WCAG 1.4.11)", () => {
    for (const name of series) {
      expect(ratio(step(name), step("n-2")), name).toBeGreaterThanOrEqual(3);
    }
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

const SOURCES = sources(SRC);

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
     column it had. shared/ui is exempt, carrying its own defaults. */
  it("names a container token rather than a raw width", () => {
    const declared = [...css.matchAll(/--container-([a-z-]+):/g)].map(
      (m) => m[1],
    );
    for (const [path, text] of SOURCES) {
      if (path.includes(join("shared", "ui"))) continue;
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

describe("colour", () => {
  /* Tailwind emits nothing at all for a class whose token is missing, so a
     colour that does not exist fails silently: the element simply inherits and
     nobody sees a build error. Every other namespace here is guarded; this is
     the one that renders the page. */
  it("paints only with colours the sheet declares", () => {
    const declared = new Set(
      [...css.matchAll(/--color-([a-z0-9-]+):/g)].map((m) => m[1] ?? ""),
    );
    // Tailwind's own keywords, and the words these prefixes carry that are not
    // colours at all: a border side, a ring width, a background clip.
    const keywords = new Set([
      "transparent",
      "current",
      "inherit",
      "white",
      "black",
      "none",
      "auto",
      "clip-padding",
      "clip-border",
      "clip-text",
    ]);
    const notAColour =
      /^(x|y|s|e|t|b|l|r|tl|tr|bl|br|se|ss|ee|es)(-\d+(\.\d+)?)?$/;
    const sizeOrStyle =
      /^(\d+(\.\d+)?|xs|sm|base|md|lg|xl|\dxl|left|right|center|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip|solid|dashed|dotted|double|hidden|inset|top|bottom|middle|super|sub)$/;

    for (const [path, text] of SOURCES) {
      for (const match of text.matchAll(
        /(?<![-\w])(bg|text|border|ring|fill|stroke|decoration|placeholder|caret|accent)-([a-z][a-z0-9-]*(?:\/\d+)?)(?![\w[\]-])/g,
      )) {
        const value = match[2] ?? "";
        if (keywords.has(value)) continue;
        if (notAColour.test(value)) continue;
        if (sizeOrStyle.test(value)) continue;
        // An opacity suffix names the same token: bg-input/30 is bg-input.
        const name = value.split("/")[0] ?? "";
        expect(
          declared.has(name),
          `\`${match[0]}\` in ${path} names no --color-${name}`,
        ).toBe(true);
      }
    }
  });
});

describe("radius", () => {
  it("declares one set, and no rung outside it", () => {
    const rungs = [...css.matchAll(/--radius(-[a-z0-9]*)?:/g)].map((m) => m[1]);
    expect(rungs.sort()).toEqual(["-2xl", "-lg", "-md", "-sm", "-xl"]);
  });

  /* Radius rises with depth, so it says what the shadow says a second time.
     Held at one value above the control rung, a panel and the menu over it
     were separated by fill alone. */
  it("rises from the control rung to the panel to what floats", () => {
    const rem = (name: string): number =>
      Number(new RegExp(`--${name}:\\s*([\\d.]+)rem`).exec(css)?.[1]);
    expect(rem("radius-sm")).toBe(rem("radius-md"));
    expect(rem("radius-lg")).toBeGreaterThan(rem("radius-md"));
    expect(rem("radius-xl")).toBeGreaterThan(rem("radius-lg"));
    expect(rem("radius-2xl")).toBe(rem("radius-xl"));
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

  it("spends only the project tokens", () => {
    const declared = [...declarations.keys()]
      .filter((name) => name.startsWith("shadow-"))
      .map((name) => name.slice("shadow-".length));
    expect(declared.length).toBeGreaterThan(0);
    expectUtilityValues(
      /(?<![-\w])shadow-([^\s"'`]+)/g,
      [...declared, "none"],
      "shadow",
    );
  });
});

/* One ordered ladder, or nothing orders: every overlay sat on the same rung
   and which one covered which was decided by document order. */
describe("layers", () => {
  it("names every layer, and pairs a backdrop with what it dims", () => {
    const layer = (name: string): number =>
      Number(new RegExp(`--z-${name}:\\s*(\\d+)`).exec(css)?.[1]);
    expect(layer("dialog-backdrop"), "dialog-backdrop").toBe(
      layer("dialog") - 1,
    );
    // A menu can be opened from inside a dialog; a dialog never from a menu.
    expect(layer("overlay")).toBeGreaterThan(layer("dialog"));
    expect(layer("tooltip")).toBeGreaterThan(layer("overlay"));
    expect(layer("skip-link")).toBeGreaterThan(layer("tooltip"));
    expect(layer("rail")).toBeLessThan(layer("dialog"));
  });

  it("spends only the named layers", () => {
    const declared = [...css.matchAll(/--z-([a-z-]+):/g)].map(
      (m) => m[1] ?? "",
    );
    expect(declared.length).toBeGreaterThan(0);
    for (const [path, text] of SOURCES) {
      for (const match of text.matchAll(/(?<![-\w])z-(?!index)([^\s"'`]+)/g)) {
        const value = match[1] ?? "";
        const named = /^\(--z-([a-z-]+)\)$/.exec(value)?.[1];
        expect(named, `raw z-index \`${match[0]}\` in ${path}`).toBeDefined();
        expect(declared, `\`${match[0]}\` in ${path}`).toContain(named);
      }
    }
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

/* The system is a set of departures or it is a set of colours that happen to
   look right. Everything above measures it at the base it ships with, which
   cannot tell the two apart: a literal is correct there by construction. So
   run the load-bearing relationships again on a base sharing no lightness, no
   chroma and no hue with ours, plus an unrelated accent. Every value that is
   really a departure survives; every value that is really a constant does not. */
describe("on a base it has never been shown", () => {
  const OTHER = {
    "base-l": "7",
    "base-c": "3",
    "base-h": "60",
    "accent-l": "52",
    "accent-c": "48",
    "accent-h": "262",
  };
  const run = (assertions: () => void) => () => {
    onPalette(OTHER, assertions);
  };

  it(
    "still departs from the base in chroma as well as lightness",
    run(() => {
      const base = scalar("base-c");
      expect(base).toBe(3);
      for (const [g, departure] of [
        ["ground", "dc-ground"],
        ["surface", "dc-surface"],
        ["card", "dc-card"],
        ["popover", "dc-popover"],
      ] as const) {
        expect(groundChroma(g), g).toBeCloseTo(base + scalar(departure), 8);
      }
      for (const g of GROUNDS) {
        expect(step(GROUND_TOKEN[g], g).H, `${g} hue`).toBe(60);
      }
    }),
  );

  it(
    "still mixes ink toward the pole and its chroma at half rate",
    run(() => {
      const base = scalar("base-c");
      const inkBase = scalar("c-ink-base");
      const half = scalar("t-ink-c");
      for (const ink of ["ink-1", "ink-2", "ink-3"]) {
        for (const g of GROUNDS) {
          const groundL = step(GROUND_TOKEN[g], g).L;
          const t = scalar(`t-${ink}`);
          expect(step(ink, g).L, `${ink} on ${g}`).toBeCloseTo(
            groundL + t * (100 - groundL),
            8,
          );
          expect(step(ink, g).C, `${ink} chroma on ${g}`).toBeCloseTo(
            inkBase + (groundChroma(g) - base) * half,
            8,
          );
        }
      }
    }),
  );

  it(
    "still lifts every control and edge off the ground it lands on",
    run(() => {
      for (const g of GROUNDS) {
        const ground = channel(GROUND_TOKEN[g], g);
        for (const line of ["line-1", "line-2", "line-3"]) {
          expect(channel(line, g), `${line} on ${g}`).toBeGreaterThan(ground);
        }
        expect(
          channel("line-2-hover", g),
          `edge hover on ${g}`,
        ).toBeGreaterThan(channel("line-2", g));
        expect(channel("control", g), `control on ${g}`).toBeGreaterThan(
          ground,
        );
        expect(channel("control-hover", g), `hover on ${g}`).toBeGreaterThan(
          channel("control", g),
        );
        expect(channel("control-disabled", g), `disabled on ${g}`).toBeLessThan(
          channel("control", g),
        );
      }
    }),
  );

  it(
    "still washes every tint over the ground it is drawn on",
    run(() => {
      const tints = [...declarations.keys()].filter((n) =>
        /-tint(-hover)?$/.test(n),
      );
      for (const tint of tints) {
        const seen = GROUNDS.map((g) => step(tint, g).L);
        expect(new Set(seen.map((l) => l.toFixed(4))).size, tint).toBe(
          GROUNDS.length,
        );
        for (const g of GROUNDS) {
          expect(channel(tint, g), `${tint} on ${g}`).toBeGreaterThan(
            channel(GROUND_TOKEN[g], g),
          );
        }
      }
    }),
  );

  it(
    "still holds the accent absolute, on the accent's own hue",
    run(() => {
      for (const name of ["cobalt-fill", "cobalt-fill-hover", "cobalt-ink"]) {
        const seen = GROUNDS.map((g) => step(name, g));
        expect(new Set(seen.map((s) => s.L.toFixed(6))).size, name).toBe(1);
        for (const s of seen) expect(s.H, `${name} hue`).toBeCloseTo(262, 8);
      }
      expect(step("cobalt-fill").L, "fill").toBeCloseTo(52, 8);
    }),
  );

  it(
    "still clears its contrast floors within each ground",
    run(() => {
      for (const g of GROUNDS) {
        expect(onOwnGround("ink-3", g), `full ink on ${g}`).toBeGreaterThan(9);
        expect(onOwnGround("ink-2", g), `muted ink on ${g}`).toBeGreaterThan(
          4.5,
        );
        expect(onOwnGround("ink-1", g), `subtle ink on ${g}`).toBeGreaterThan(
          4.5,
        );
        expect(onOwnGround("line-3", g), `strong edge on ${g}`).toBeGreaterThan(
          3,
        );
      }
    }),
  );
});
