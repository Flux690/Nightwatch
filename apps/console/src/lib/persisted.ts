/* Preferences the operator sets by hand and expects to find again. Neither read
   nor write may throw: localStorage is absent in a private window and its
   contents are user-editable, so a missing store and a garbage value are both
   ordinary inputs. A lost preference is a small cost; a blank console is not. */

export function readStoredNumber(key: string, fallback: number): number {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

export function writeStoredNumber(key: string, value: number): void {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // A blocked or full store costs this preference and nothing else.
  }
}
