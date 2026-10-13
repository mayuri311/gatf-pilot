"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";

export type LoginState = { error?: string; email?: string };

const schema = z.object({
  email: z.email("Enter a valid email address"),
  password: z.string().min(1, "Enter your password"),
  next: z.string().optional(),
});

export async function login(_prev: LoginState, form: FormData): Promise<LoginState> {
  const parsed = schema.safeParse({
    email: String(form.get("email") ?? "").trim(),
    password: String(form.get("password") ?? ""),
    next: String(form.get("next") ?? ""),
  });
  const email = String(form.get("email") ?? "");
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input", email };

  const supabase = await getServerSupabase();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });
  if (error || !data.user) {
    console.error("[login] sign-in failed:", error?.status, error?.code, error?.message);
    const banned = /banned/i.test(error?.message ?? "");
    return {
      error: banned ? "This account has been deactivated. Ask an admin." : "Email or password is incorrect.",
      email,
    };
  }
  const meta = (data.user.app_metadata ?? {}) as Record<string, unknown>;
  if (meta.must_change_password === true) redirect("/account/password");
  const next = parsed.data.next;
  redirect(next && next.startsWith("/") && !next.startsWith("//") ? next : "/");
}
