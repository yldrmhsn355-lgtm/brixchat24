"use client";

import { Moon, Sun } from "lucide-react";
import { useAppTheme } from "../lib/app-theme";

export function ThemeToggle() {
  const { theme, toggleTheme } = useAppTheme();
  const isDark = theme === "dark";

  return (
    <button
      type="button"
      className="icon-button theme-toggle"
      aria-label={isDark ? "Gündüz temasına geç" : "Gece temasına geç"}
      aria-pressed={isDark}
      title={isDark ? "Gündüz teması" : "Gece teması"}
      onClick={toggleTheme}
    >
      {isDark ? (
        <Sun size={18} aria-hidden="true" />
      ) : (
        <Moon size={18} aria-hidden="true" />
      )}
    </button>
  );
}
