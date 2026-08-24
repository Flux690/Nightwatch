import { useEffect, useState } from "react";

// The one place the two boundaries are written down. Width, not orientation:
// a phone in landscape is 844x390 and still cannot serve the layout.
const TABLET_MIN = 768;
const DESKTOP_MIN = 1024;

type ViewportTier = "phone" | "tablet" | "desktop";

function tierFor(width: number): ViewportTier {
  if (width < TABLET_MIN) return "phone";
  return width < DESKTOP_MIN ? "tablet" : "desktop";
}

export function useViewportTier(): ViewportTier {
  const [tier, setTier] = useState<ViewportTier>(() =>
    tierFor(window.innerWidth),
  );

  useEffect(() => {
    function onResize(): void {
      setTier(tierFor(window.innerWidth));
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return tier;
}
