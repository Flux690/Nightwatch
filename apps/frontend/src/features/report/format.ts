// One compact number format for every readout the report prints, so a figure in
// a chart and the same figure in a table can never round differently.
export const compact = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});
