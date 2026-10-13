"use client";

import { useEffect } from "react";

export const ACCENTS = [
  { id: "blue", label: "Blue", swatch: "#3b9cf6" },
  { id: "teal", label: "Teal", swatch: "#14a5ad" },
  { id: "violet", label: "Violet", swatch: "#9a74d6" },
  { id: "amber", label: "Amber", swatch: "#e0913d" },
] as const;
export type AccentId = (typeof ACCENTS)[number]["id"];

const KEY = "gatf-accent";

export function readAccent(): AccentId {
  try {
    const v = localStorage.getItem(KEY);
    if (ACCENTS.some((a) => a.id === v)) return v as AccentId;
  } catch {
    /* storage unavailable */
  }
  return "blue";
}

export function applyAccent(id: AccentId) {
  const el = document.documentElement;
  if (id === "blue") el.removeAttribute("data-accent");
  else el.setAttribute("data-accent", id);
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* ignore */
  }
}

/** Applies the per-viewer accent preference after hydration. */
export function AccentInit() {
  useEffect(() => {
    applyAccent(readAccent());
  }, []);
  return null;
}
