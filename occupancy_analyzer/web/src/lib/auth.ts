import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { getServerSupabase } from "./supabase/server";

export type Role = "admin" | "staff";
export type SessionUser = {
  id: string;
  email: string;
  role: Role | null;
  mustChangePassword: boolean;
};

/** Verified identity from the JWT (getClaims verifies the signature). Cached per request. */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  try {
    const supabase = await getServerSupabase();
    const { data, error } = await supabase.auth.getClaims();
    if (error || !data?.claims) return null;
    const c = data.claims as Record<string, unknown> & { app_metadata?: Record<string, unknown> };
    const role = c.app_metadata?.role;
    return {
      id: String(c.sub ?? ""),
      email: String(c.email ?? ""),
      role: role === "admin" || role === "staff" ? role : null,
      mustChangePassword: c.app_metadata?.must_change_password === true,
    };
  } catch {
    return null;
  }
});

/** For pages: redirect to /login when signed out; to /account/password when a change is pending. */
export async function requireUser(opts: { allowPasswordChange?: boolean } = {}): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword && !opts.allowPasswordChange) redirect("/account/password");
  return user;
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== "admin") redirect("/?denied=admin");
  return user;
}

/** For server actions: throw instead of redirecting so the client can show the error. */
export async function assertAdmin(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new Error("Not signed in");
  if (user.role !== "admin") throw new Error("Admin role required");
  return user;
}

export { initials, displayName } from "./names";
