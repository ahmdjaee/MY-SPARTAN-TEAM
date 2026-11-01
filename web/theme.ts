export type Theme = "light" | "dark" | "system";

const KEY = "ai-team-theme";
const ORDER: Theme[] = ["system", "light", "dark"];

export function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch {
    // localStorage bisa diblokir; abaikan
  }
  return "system";
}

/** `system` berarti ikut prefers-color-scheme (atribut dilepas). */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // tidak apa-apa kalau tidak bisa disimpan
  }
}

export function nextTheme(current: Theme): Theme {
  return ORDER[(ORDER.indexOf(current) + 1) % ORDER.length] ?? "system";
}

export const THEME_LABEL: Record<Theme, string> = {
  system: "Ikut sistem",
  light: "Terang",
  dark: "Gelap",
};
