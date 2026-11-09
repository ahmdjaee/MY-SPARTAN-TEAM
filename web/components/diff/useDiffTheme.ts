import { useEffect, useState } from "react";

function read(): "light" | "dark" {
  const attr = document.documentElement.dataset.theme;
  if (attr === "light" || attr === "dark") return attr;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Tema efektif aplikasi (light/dark); `system` diterjemahkan lewat prefers-color-scheme. */
export function useDiffTheme(): "light" | "dark" {
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    const update = () => setTheme(read());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    query.addEventListener("change", update);
    return () => {
      observer.disconnect();
      query.removeEventListener("change", update);
    };
  }, []);
  return theme;
}
