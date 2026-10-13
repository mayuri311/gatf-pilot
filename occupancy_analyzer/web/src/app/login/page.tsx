import type { Metadata } from "next";
import { SquareParking } from "lucide-react";
import { appConfig } from "@/lib/config";
import { supabaseConfigured } from "@/lib/supabase/env";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const sp = await searchParams;
  const next = typeof sp.next === "string" ? sp.next : undefined;
  const configError = sp.error === "config" || !supabaseConfigured;

  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-background px-4 py-12">
      {/* subtle grid backdrop */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.5] [mask-image:radial-gradient(ellipse_at_center,black_20%,transparent_70%)]"
        style={{
          backgroundImage:
            "linear-gradient(to right, var(--grid) 1px, transparent 1px), linear-gradient(to bottom, var(--grid) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
        }}
      />
      <div className="relative w-full max-w-[400px]">
        <div className="mb-8 flex items-center justify-center gap-3">
          <span className="flex size-11 items-center justify-center rounded-[11px] bg-primary text-white shadow-[0_8px_24px_-8px_var(--primary)]">
            <SquareParking className="size-6" />
          </span>
          <span className="leading-tight">
            <span className="block text-lg font-semibold">GATF Lot</span>
            <span className="eyebrow block text-muted-foreground">Occupancy Analyzer</span>
          </span>
        </div>
        <div className="rounded-xl border bg-card p-7 shadow-[0_20px_60px_-30px_rgba(0,0,0,0.5)]">
          <h1 className="text-xl font-bold">Sign in</h1>
          <p className="mt-1 mb-6 text-[13px] text-muted-foreground">
            {appConfig.lot.name} · staff &amp; admin access only. Accounts are created by an admin.
          </p>
          {configError ? (
            <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
              Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.
            </p>
          ) : (
            <LoginForm next={next} />
          )}
        </div>
        <p className="mt-6 text-center text-[12px] text-muted-foreground">
          Forgot your password? Ask an admin to reset it — no emails are sent.
        </p>
      </div>
    </div>
  );
}
