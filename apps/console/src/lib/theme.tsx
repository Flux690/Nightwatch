import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

// Client-side preference, per device: applies instantly and never round-trips
// the API. Two states only - dark (the default look) and light.
export type ThemePreference = "light" | "dark";

export const THEME_STORAGE_KEY = "nw-theme";

function storedPreference(): ThemePreference {
  // Dark is the default; light is opt-in per device.
  return localStorage.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark";
}

function applyTheme(preference: ThemePreference): void {
  document.documentElement.classList.toggle("dark", preference === "dark");
}

interface ThemeContextValue {
  preference: ThemePreference;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const [preference, setPreference] =
    useState<ThemePreference>(storedPreference);

  useEffect(() => {
    applyTheme(preference);
  }, [preference]);

  const toggle = useCallback((): void => {
    setPreference((prev) => {
      const next = prev === "dark" ? "light" : "dark";
      localStorage.setItem(THEME_STORAGE_KEY, next);
      return next;
    });
  }, []);

  return (
    <ThemeContext.Provider value={{ preference, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme requires ThemeProvider");
  return ctx;
}
