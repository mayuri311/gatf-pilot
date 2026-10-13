export function initials(email: string): string {
  const name = email.split("@")[0] ?? "";
  const parts = name.split(/[._-]+/).filter(Boolean);
  const s = (parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2)) || "?";
  return s.toUpperCase();
}

export function displayName(email: string): string {
  const name = email.split("@")[0] ?? email;
  return name
    .split(/[._-]+/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join(" ");
}
