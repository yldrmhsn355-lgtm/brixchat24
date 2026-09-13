"use client";

import { useCallback, useEffect, useState } from "react";

export const APP_THEME_STORAGE_KEY = "brixchat_app_theme";

export type AppTheme = "light" | "dark";

export function isAppTheme(value: string | null): value is AppTheme {
  return value === "light" || value === "dark";
}

export function resolveAppTheme(
  storedTheme: string | null,
  systemPrefersDark: boolean,
): AppTheme {
  if (isAppTheme(storedTheme)) return storedTheme;
  return systemPrefersDark ? "dark" : "light";
}

export function oppositeAppTheme(theme: AppTheme): AppTheme {
  return theme === "dark" ? "light" : "dark";
}

function applyAppTheme(theme: AppTheme) {
  document.documentElement.dataset.appTheme = theme;
  document.documentElement.style.colorScheme = theme;
}

export function useAppTheme() {
  const [theme, setTheme] = useState<AppTheme>("dark");

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");

    const syncTheme = (
      storedTheme = localStorage.getItem(APP_THEME_STORAGE_KEY),
    ) => {
      const nextTheme = resolveAppTheme(storedTheme, media.matches);
      applyAppTheme(nextTheme);
      setTheme(nextTheme);
    };

    syncTheme();

    const onStorage = (event: StorageEvent) => {
      if (event.key === APP_THEME_STORAGE_KEY) syncTheme(event.newValue);
    };
    const onSystemThemeChange = () => {
      if (!localStorage.getItem(APP_THEME_STORAGE_KEY)) syncTheme(null);
    };

    window.addEventListener("storage", onStorage);
    media.addEventListener("change", onSystemThemeChange);
    return () => {
      window.removeEventListener("storage", onStorage);
      media.removeEventListener("change", onSystemThemeChange);
    };
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const nextTheme = oppositeAppTheme(current);
      localStorage.setItem(APP_THEME_STORAGE_KEY, nextTheme);
      applyAppTheme(nextTheme);
      return nextTheme;
    });
  }, []);

  return { theme, toggleTheme };
}
