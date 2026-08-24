// One `w-` class per control, on the control rather than a wrapper: a shared
// right edge is what orders a column, and tailwind-merge cannot dedupe two
// because it does not know `w-control` is a width.
export const CONTROL = {
  // Beside a label rather than above it, so content cannot set the width.
  text: "w-control",
  // Sized to the digits plus its unit, not to the row.
  number: "w-24",
} as const;

// These values are typed, not nudged one at a time.
export const NO_SPINNERS =
  "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none";
