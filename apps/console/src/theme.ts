import { createTheme, type MantineColorsTuple } from "@mantine/core";

/* Mirrors the Navy ramp in styles.css @theme - Mantine needs literal color
   values for its variant math, so the hexes are duplicated here and kept in
   sync by design-tokens.test.ts. */
const navy: MantineColorsTuple = [
  "#FFFFFF",
  "#F6F9FC",
  "#EDF1F6",
  "#E3EAF1",
  "#D8E1EA",
  "#E3E8EE",
  "#6E859E",
  "#8A99AD",
  "#56677F",
  "#0D253D",
];

/* Cobalt is the interactive signal color; index 6 is the canonical
   --color-signal (#2563EB), index 7 its hover. */
const cobalt: MantineColorsTuple = [
  "#EFF6FF",
  "#DBEAFE",
  "#BFDBFE",
  "#93C5FD",
  "#60A5FA",
  "#3B82F6",
  "#2563EB",
  "#1D4ED8",
  "#1E40AF",
  "#1E3A8A",
];

export const theme = createTheme({
  fontFamily: "var(--font-sans)",
  fontFamilyMonospace: "var(--font-mono)",
  /* md is the body size; xs and sm are intentionally aliased - the design
     system has exactly one size below body. */
  fontSizes: {
    xs: "0.75rem",
    sm: "0.75rem",
    md: "0.875rem",
    lg: "1.125rem",
    xl: "1.25rem",
  },
  lineHeights: {
    xs: "1.3333",
    sm: "1.3333",
    md: "1.4286",
    lg: "1.4444",
    xl: "1.4",
  },
  headings: {
    fontWeight: "600",
    sizes: {
      h1: { fontSize: "1.5rem", lineHeight: "1.25" },
      h2: { fontSize: "1.25rem", lineHeight: "1.4" },
      h3: { fontSize: "1.125rem", lineHeight: "1.4444" },
    },
  },
  radius: {
    xs: "0.25rem",
    sm: "0.375rem",
    md: "0.5rem",
    lg: "0.75rem",
    xl: "1rem",
  },
  defaultRadius: "md",
  colors: { navy, cobalt },
  primaryColor: "cobalt",
  primaryShade: 6,
  cursorType: "pointer",
});
