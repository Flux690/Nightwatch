// One width per kind of control, so fields line up down a section and across
// sections. Prose is not in this list: the panel's own padding bounds it, and
// constraining it again wraps sentences at an arbitrary column.
export const FIELD_WIDTH = {
  // Endpoints, keys, model ids.
  text: "max-w-96",
  // Sized to the longest option any of these hold, "Allowlist (recommended)":
  // the popup inherits the trigger's width, so a narrow trigger truncates both.
  select: "max-w-56",
  // A few digits, sized to the digits rather than to the row.
  number: "w-20",
} as const;

// Scope headings inside a section, above the fields they govern.
export const GROUP_HEADING =
  "text-xs font-medium uppercase tracking-[0.06em] text-muted-foreground";

export const FIELD_HINT = "text-sm text-muted-foreground";

// These values are typed, not nudged one at a time.
export const NO_SPINNERS =
  "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none";
