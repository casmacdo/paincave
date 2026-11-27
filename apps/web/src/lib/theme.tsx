import { createContext, useContext, useEffect, type ReactNode } from "react";

export type ThemeMode = "light";

const THEME_STORAGE_KEY = "paincave_theme";

interface ThemeContextValue {
  theme: ThemeMode;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "light",
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.classList.remove("dark");
    }
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
    }
  }, []);

  return (
    <ThemeContext.Provider value={{ theme: "light" }}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
