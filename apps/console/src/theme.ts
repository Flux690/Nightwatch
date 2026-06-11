import { createTheme, type CSSVariablesResolver } from "@mantine/core";

export const theme = createTheme({
  // "red" is the closest built-in Mantine scale to Folio crimson (#8B1A1A).
  // Actual accent hex is in other.accentInteractive and --nw-accent.
  primaryColor: "red",
  primaryShade: { light: 9, dark: 9 },
  fontFamily: "IBM Plex Sans, system-ui, -apple-system, sans-serif",
  fontFamilyMonospace: "IBM Plex Mono, Menlo, Consolas, monospace",
  defaultRadius: "xs",
  radius: {
    xs: "1px",
    sm: "2px",
    md: "2px",
    lg: "4px",
    xl: "4px",
  },
  other: {
    bg: "#F2EFE9",
    surface: "#EAE6DE",
    // crimson #8B1A1A — 8.2:1 on bg (AAA)
    accentInteractive: "#8B1A1A",
    // prussian navy #1C3A5E — 9.7:1 on bg (AAA)
    accentLive: "#1C3A5E",
    textPrimary: "#1A1816",
    textMuted: "#5C5750",
    border: "#C8C3BA",
    // all status colours AAA on #F2EFE9
    statusStreaming: "#1C3A5E", // 9.7:1
    statusAwaiting: "#7A4A00", // 8.9:1
    statusEscalated: "#8B1A1A", // 8.2:1
  },
});

export const cssVariablesResolver: CSSVariablesResolver = (t) => {
  const o = t.other as Record<string, string>;
  return {
    variables: {
      "--nw-bg": o.bg,
      "--nw-surface": o.surface,
      "--nw-accent": o.accentInteractive,
      "--nw-accent-live": o.accentLive,
      "--nw-text": o.textPrimary,
      "--nw-text-muted": o.textMuted,
      "--nw-border": o.border,
      "--nw-mono": t.fontFamilyMonospace ?? "monospace",
      "--nw-status-streaming": o.statusStreaming,
      "--nw-status-awaiting": o.statusAwaiting,
      "--nw-status-escalated": o.statusEscalated,
    },
    dark: {},
    light: {},
  };
};
