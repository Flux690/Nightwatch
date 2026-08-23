// One width per kind of control, applied to the control itself rather than a
// wrapper: a shared right edge is what makes a column of mixed controls read as
// ordered. A pick-from control is absent because it hugs its own option.
//
// One `w-` class and no more: tailwind-merge cannot tell that `w-control` is a
// width, so a second one beside it survives and source order decides.
export const CONTROL = {
  // Beside a label rather than above it, so content cannot set the width.
  text: "w-control",
  // Sized to the digits plus its unit, not to the row.
  number: "w-24",
} as const;

// These values are typed, not nudged one at a time.
export const NO_SPINNERS =
  "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none";
