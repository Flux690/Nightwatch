import { useEffect, useState } from "react";

// Trails a value that changes as fast as someone types, so whatever watches it
// reacts once they stop rather than on every keystroke.
export function useDebounced<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return settled;
}
