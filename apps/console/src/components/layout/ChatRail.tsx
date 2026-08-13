import { useRef, useState } from "react";

import { SessionView } from "@/pages/SessionView";
import { readStoredNumber, writeStoredNumber } from "@/lib/persisted";
import { cn } from "@/lib/utils";

/* The conversation beside the record. How wide it should be is a question about
   the user's screen and the shape of their work, not one this layout can
   answer, so they set it and it outlives the session: a width you have to set
   again every night is worse than one you cannot set at all. */

const WIDTH_KEY = "nightwarden.rail.width";
// The floor is what --container-rail rests at: narrower and the transcript wraps
// to shreds. The ceiling leaves the report its own measure to be read at.
const MIN_WIDTH = 420;
const MAX_WIDTH = 720;
const KEY_STEP = 20;

function clamp(width: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)));
}

export function ChatRail({
  sessionId,
  open,
  expanded,
}: {
  sessionId: string | null;
  open: boolean;
  // Covers the stage rather than widening past its ceiling. A distinct mode, so
  // leaving it restores the width the user chose instead of a drag's
  // leftover.
  expanded: boolean;
}): React.JSX.Element {
  const railRef = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(() =>
    clamp(readStoredNumber(WIDTH_KEY, MIN_WIDTH)),
  );
  const [dragging, setDragging] = useState(false);

  /* Listening on the window rather than capturing the pointer: a drag that
     leaves the handle, or the viewport, still has to end. */
  const beginDrag = (event: React.PointerEvent): void => {
    const rail = railRef.current;
    if (rail === null || event.button !== 0) return;
    event.preventDefault();
    const edge = rail.getBoundingClientRect().right;
    setDragging(true);

    let latest = width;
    const move = (moved: PointerEvent): void => {
      latest = clamp(edge - moved.clientX);
      setWidth(latest);
    };
    const stop = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      setDragging(false);
      // Once, at the end: a write per frame of a drag for a value only the last
      // one of which matters.
      writeStoredNumber(WIDTH_KEY, latest);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };

  const nudge = (by: number): void => {
    const next = clamp(width + by);
    setWidth(next);
    writeStoredNumber(WIDTH_KEY, next);
  };

  /* Width, not presence, so it closes like the sidebar. Closed it is zero-wide
     but still here, which is what takes it out of the accessibility tree and the
     tab order without taking the conversation down with it. */
  return (
    <aside
      ref={railRef}
      aria-label="Investigation chat"
      aria-hidden={!open}
      inert={!open}
      /* React types style as CSSProperties, which has no index signature for a
         custom property, and this one is read by two utilities below. */
      style={{ "--container-rail": `${width}px` } as React.CSSProperties}
      className={cn(
        "flex shrink-0 flex-col overflow-hidden border-l",
        // A drag is the pointer's own motion, so easing it lags the cursor. The
        // transition returns the moment the drag ends.
        dragging
          ? "transition-none"
          : "transition-[width,border-color] duration-(--duration-panel) ease-panel",
        // The edge says where the report stops. It fades out rather than
        // switching off, leaving no hairline.
        expanded
          ? "absolute inset-y-0 right-0 z-10 w-full border-transparent bg-background"
          : open
            ? "relative w-(--container-rail) border-border"
            : "relative w-0 border-transparent",
      )}
    >
      {/* Inside the rail's own edge, not straddling it: the panel clips its
          overflow, so half a handle hung outside would be half a handle. */}
      {open && !expanded && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the chat"
          aria-valuenow={width}
          aria-valuemin={MIN_WIDTH}
          aria-valuemax={MAX_WIDTH}
          tabIndex={0}
          onPointerDown={beginDrag}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            nudge(event.key === "ArrowLeft" ? KEY_STEP : -KEY_STEP);
          }}
          className="absolute inset-y-0 left-0 z-20 w-3 cursor-col-resize after:absolute after:inset-y-0 after:left-0 after:w-[2px] hover:after:bg-border-strong focus-visible:after:bg-border-strong"
        />
      )}
      {/* The chat holds its own width while the panel narrows past it, so
          nothing inside ever reflows on the way closed. */}
      <div
        className={cn(
          "flex min-h-0 flex-1 shrink-0 flex-col transition-opacity duration-(--duration-fast)",
          expanded ? "w-full" : "w-(--container-rail)",
          open ? "opacity-100 delay-(--duration-base)" : "opacity-0 delay-0",
        )}
      >
        <SessionView sessionId={sessionId} />
      </div>
    </aside>
  );
}
