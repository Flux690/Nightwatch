import React from "react";

// Shown when a run is active but nothing is streaming into the transcript yet -
// right after send, and in the gaps between turns. Three dots morph on a seamless
// loop (equilateral triangle pulse -> rotation -> ellipsis wave -> back) as a
// content-free "assistant is working" affordance, distinct from a thinking block.
// The motion lives in styles.css; reduced-motion falls back to an opacity pulse.
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
