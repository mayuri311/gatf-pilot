"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertAdmin } from "@/lib/auth";
import { getAdminSupabase } from "@/lib/supabase/admin";
import { getServerSupabase } from "@/lib/supabase/server";
import { rpc } from "@/lib/rpc";

export type UserActionResult = { ok: true; message?: string } | { ok: false; error: string };

const role = z.enum(["admin", "staff"]);
const password = z
  .string()
  .min(12, "Temporary password must be at least 12 characters")
  .regex(/[A-Za-z]/, "Use letters")
  .regex(/[0-9]/, "Use at least one number");

async function audit(action: string, target: string, detail: Record<string, unknown>) {
  try {
    await rpc.logAudit(await getServerSupabase(), action, target, detail);
  } catch {
    /* best effort */
  }
}

async function wrap(fn: () => Promise<UserActionResult>): Promise<UserActionResult> {
  try {
    await assertAdmin();
    const r = await fn();
    if (r.ok) revalidatePath("/admin/users");
    return r;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Create a user with a temporary password; no email is sent (D21/D28). */
export async function createUserAction(input: { email: string; password: string; role: string }) {
  return wrap(async () => {
    const parsed = z.object({ email: z.email("Enter a valid email"), password, role }).safeParse(input);
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
    const { email, role: r } = parsed.data;
    const { data, error } = await getAdminSupabase().auth.admin.createUser({
      email: email.toLowerCase(),
      password: parsed.data.password,
      email_confirm: true,
      app_metadata: { role: r, must_change_password: true },
    });
    if (error) return { ok: false, error: /already/i.test(error.message) ? "A user with this email already exists" : error.message };
    await audit("user_create", email, { role: r, user_id: data.user?.id });
    return { ok: true, message: `Created ${email} (${r}). Share the temporary password in person.` };
  });
}

async function mergeMeta(userId: string, patch: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const admin = getAdminSupabase();
  const { data, error } = await admin.auth.admin.getUserById(userId);
  if (error || !data.user) throw new Error(error?.message ?? "User not found");
  const { error: upErr } = await admin.auth.admin.updateUserById(userId, {
    ...extra,
    app_metadata: { ...(data.user.app_metadata ?? {}), ...patch },
  });
  if (upErr) throw new Error(upErr.message);
  return data.user.email ?? userId;
}

export async function resetPasswordAction(userId: string, newPassword: string) {
  return wrap(async () => {
    const p = password.safeParse(newPassword);
    if (!p.success) return { ok: false, error: p.error.issues[0]?.message ?? "Invalid password" };
    const email = await mergeMeta(userId, { must_change_password: true }, { password: p.data });
    await audit("user_reset_password", email, { user_id: userId });
    return { ok: true, message: `Password reset for ${email}; they must change it at next sign-in.` };
  });
}

export async function setRoleAction(userId: string, newRole: string) {
  return wrap(async () => {
    const me = await assertAdmin();
    const r = role.safeParse(newRole);
    if (!r.success) return { ok: false, error: "Invalid role" };
    if (userId === me.id && r.data !== "admin") return { ok: false, error: "You can't remove your own admin role" };
    const email = await mergeMeta(userId, { role: r.data });
    await audit("role_change", email, { user_id: userId, role: r.data });
    return { ok: true, message: `${email} is now ${r.data}. Takes effect at their next token refresh (≤ 1 h).` };
  });
}

export async function setActiveAction(userId: string, active: boolean) {
  return wrap(async () => {
    const me = await assertAdmin();
    if (userId === me.id) return { ok: false, error: "You can't deactivate yourself" };
    const admin = getAdminSupabase();
    const { data, error } = await admin.auth.admin.updateUserById(userId, { ban_duration: active ? "none" : "876000h" });
    if (error) return { ok: false, error: error.message };
    await audit(active ? "user_reactivate" : "user_deactivate", data.user?.email ?? userId, { user_id: userId });
    return { ok: true, message: `${data.user?.email} ${active ? "reactivated" : "deactivated"}.` };
  });
}
