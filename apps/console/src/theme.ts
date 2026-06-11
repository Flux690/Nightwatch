import {
  colorsTuple,
  createTheme,
  type CSSVariablesResolver,
} from "@mantine/core";

export const theme = createTheme({
  colors: {
    ink: colorsTuple([
      "#F5F2EE",
      "#E9E5E0",
      "#D9D3CD",
      "#BEB6AF",
      "#918983",
      "#6F6862",
      "#504A45",
      "#3C3834",
      "#24211F",
      "#0D0C0B",
    ]),
    streaming: colorsTuple("#00552A"),
    awaiting: colorsTuple("#684000"),
    escalated: colorsTuple("#7A0E0E"),
  },
  primaryColor: "ink",
  primaryShade: { light: 9, dark: 9 },
  black: "#0D0C0B",
  white: "#FDFCFB",
  fontFamily:
    '"IBM Plex Sans", Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  fontFamilyMonospace:
    '"IBM Plex Mono", "JetBrains Mono", "SFMono-Regular", Menlo, Consolas, monospace',
  defaultRadius: "xs",
  radius: {
    xs: "1px",
    sm: "1px",
    md: "2px",
    lg: "2px",
    xl: "2px",
  },
  other: {
    bg: "#F5F2EE",
    surface: "#EFECE8",
    surfaceRaised: "#E6E1DB",
    accent: "#0D0C0B",
    accentHover: "#24211F",
    textPrimary: "#0D0C0B",
    textMuted: "#504A45",
    border: "#C9C1BA",
    borderStrong: "#918983",
    statusStreaming: "#00552A", // 8.07:1 on bg
    statusAwaiting: "#684000", // 8.10:1 on bg
    statusConcluded: "#504A45", // 7.82:1 on bg
    statusEscalated: "#7A0E0E", // 9.92:1 on bg
  },
});

export const cssVariablesResolver: CSSVariablesResolver = (t) => {
  const o = t.other as Record<string, string>;
  return {
    variables: {
      "--nw-bg": o.bg,
      "--nw-surface": o.surface,
      "--nw-surface-raised": o.surfaceRaised,
      "--nw-accent": o.accent,
      "--nw-accent-hover": o.accentHover,
      "--nw-text": o.textPrimary,
      "--nw-text-muted": o.textMuted,
      "--nw-border": o.border,
      "--nw-border-strong": o.borderStrong,
      "--nw-mono": t.fontFamilyMonospace ?? "monospace",
      "--nw-status-streaming": o.statusStreaming,
      "--nw-status-awaiting": o.statusAwaiting,
      "--nw-status-concluded": o.statusConcluded,
      "--nw-status-escalated": o.statusEscalated,
    },
    dark: {},
    light: {
      "--mantine-color-body": o.bg,
      "--mantine-color-text": o.textPrimary,
      "--mantine-color-dimmed": o.textMuted,
      "--mantine-color-default": o.surface,
      "--mantine-color-default-hover": o.surfaceRaised,
      "--mantine-color-default-color": o.textPrimary,
      "--mantine-color-default-border": o.border,
      "--mantine-color-placeholder": o.textMuted,
    },
  };
};
