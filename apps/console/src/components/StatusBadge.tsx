// Color is passed in rather than computed here, so each domain's status-to-color
// mapping stays with its own data rather than growing a shared enum.
export function StatusBadge({
  label,
  color,
}: {
  label: string;
  color: string;
}): React.JSX.Element {
  return (
    <span
      style={{
        fontSize: 10,
        fontFamily: "var(--nw-mono)",
        color,
        textTransform: "uppercase",
        letterSpacing: "0.05em",
      }}
    >
      {label}
    </span>
  );
}
