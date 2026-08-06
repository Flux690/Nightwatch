// One height for every control and one width per kind, applied to the control
// itself rather than a wrapper: a shared right edge is what makes a column of
// mixed controls read as ordered, so a pick-from control hugs its own option.
export const CONTROL = {
  // A pick-from control carries its raised fill from the Select itself; only
  // its size belongs to the settings row.
  select: "h-8 w-auto",
  // A hairline, not a box: at 1px the line outweighs what it bounds and the
  // field reads as sunken rather than as an edge.
  text: "h-8 w-72 border-[0.5px]",
  // Sized to the digits plus its unit, not to the row.
  number: "h-8 w-24",
} as const;

// These values are typed, not nudged one at a time.
export const NO_SPINNERS =
  "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none";
