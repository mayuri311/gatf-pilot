"use server";

import { redirect } from "next/navigation";
import { getServerSupabase } from "@/lib/supabase/server";
import { getAdminSupabase } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/auth";
import { rpc } from "@/lib/rpc";

export type PwState = { error?: string };

export async function changePassword(_prev: PwState, form: FormData): Promise<PwState> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const pw = String(form.get("password") ?? "");
  const confirm = String(form.get("confirm") ?? "");
  if (pw.length < 12) return { error: "Use at least 12 characters." };
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return { error: "Use letters and at least one number." };
  if (pw !== confirm) return { error: "The two passwords don't match." };

  const supabase = await getServerSupabase();
  const { error } = await supabase.auth.updateUser({ password: pw });
  if (error) {
    return { error: /different|same/i.test(error.message) ? "Choose a password different from the current one." : error.message };
  }

  // Clear the forced-change flag (app_metadata is only writable with the service role).
  try {
    const admin = getAdminSupabase();
    const { data } = await admin.auth.admin.getUserById(user.id);
    const meta = { ...(data.user?.app_metadata ?? {}), must_change_password: false };
    await admin.auth.admin.updateUserById(user.id, { app_metadata: meta });
  } catch (e) {
    return { error: `Password changed, but the account flag could not be cleared: ${e instanceof Error ? e.message : e}` };
  }
  // New JWT so the cleared flag is visible to proxy.ts immediately.
  await supabase.auth.refreshSession();
  await rpc.logAudit(supabase, "password_change", user.email, {});
  redirect("/");
}
