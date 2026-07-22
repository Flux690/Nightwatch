import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

// Client-side preference, deliberately not part of AgentConfig: the theme
// belongs to the device, applies instantly, and never round-trips the API.
export type ThemePreference = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "nw-theme";

function storedPreference(): ThemePreference {
  const raw = localStorage.getItem(THEME_STORAGE_KEY);
  // Dark is the default look; light and system are opt-in per device.
  return raw === "light" || raw === "dark" || raw === "system" ? raw : "dark";
}

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyTheme(preference: ThemePreference): void {
  const dark =
    preference === "dark" || (preference === "system" && systemPrefersDark());
  document.documentElement.classList.toggle("dark", dark);
}

interface ThemeContextValue {
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const [preference, setPreferenceState] =
    useState<ThemePreference>(storedPreference);

  useEffect(() => {
    applyTheme(preference);
    if (preference !== "system") return;
    // Follow live OS theme changes only while the preference is "system".
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (): void => applyTheme("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [preference]);

  const setPreference = useCallback((next: ThemePreference): void => {
    localStorage.setItem(THEME_STORAGE_KEY, next);
    setPreferenceState(next);
  }, []);

  return (
    <ThemeContext.Provider value={{ preference, setPreference }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme requires ThemeProvider");
  return ctx;
}
