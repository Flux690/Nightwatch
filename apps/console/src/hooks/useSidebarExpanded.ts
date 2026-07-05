import { useCallback, useState } from "react";

const SIDEBAR_KEY = "nw:sidebar-expanded";

// Sidebar expand/collapse state, persisted to localStorage so the choice
// survives reloads. Defaults to expanded when nothing is stored.
export function useSidebarExpanded(): [boolean, () => void] {
  const [expanded, setExpanded] = useState<boolean>(
    () => localStorage.getItem(SIDEBAR_KEY) !== "false",
  );

  const toggle = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      localStorage.setItem(SIDEBAR_KEY, String(next));
      return next;
    });
  }, []);

  return [expanded, toggle];
}
