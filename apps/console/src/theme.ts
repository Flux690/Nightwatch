import { createTheme, type CSSVariablesResolver } from "@mantine/core";

export const theme = createTheme({
  primaryColor: "cyan",
  fontFamily: "Inter, system-ui, -apple-system, sans-serif",
  fontFamilyMonospace: "JetBrains Mono, Menlo, Consolas, monospace",
  defaultRadius: "sm",
  other: {
    // Accent — cyan-green, verified AAA (7.59:1) on near-black
    accent: "#06b6d4",
    // Status badge colours, all verified AAA on near-black (#141414)
    statusStreaming: "#06b6d4", // 7.59:1
    statusAwaiting: "#f59e0b", // 8.58:1
    statusConcluded: "#9ca3af", // 7.26:1
    statusEscalated: "#fca5a5", // 9.71:1 (red-300, not red-400)
  },
});

export const cssVariablesResolver: CSSVariablesResolver = (t) => {
  const o = t.other as Record<string, string>;
  return {
    variables: {
      "--nw-accent": o.accent,
      "--nw-mono": t.fontFamilyMonospace ?? "monospace",
      "--nw-status-streaming": o.statusStreaming,
      "--nw-status-awaiting": o.statusAwaiting,
      "--nw-status-concluded": o.statusConcluded,
      "--nw-status-escalated": o.statusEscalated,
    },
    dark: {},
    light: {},
  };
};
