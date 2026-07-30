import React from "react";

// Shown when a run is active but nothing is streaming yet, as a content-free
// "working" signal distinct from a thinking block. The motion lives in styles.css
// so reduced-motion can hold the dots static.
export function WorkingIndicator(): React.JSX.Element {
  return (
    <div
      className="nw-working animate-in fade-in duration-300 text-muted-foreground"
      role="status"
      aria-label="Working"
      data-testid="working-indicator"
    >
      <span className="nw-working-dot nw-working-dot-a" />
      <span className="nw-working-dot nw-working-dot-b" />
      <span className="nw-working-dot nw-working-dot-c" />
    </div>
  );
}
