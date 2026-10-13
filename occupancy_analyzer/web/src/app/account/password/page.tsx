import type { Metadata } from "next";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { signOut } from "@/app/actions/auth";
import { PasswordForm } from "./form";

export const metadata: Metadata = { title: "Change password" };

export default async function PasswordPage() {
  const user = await requireUser({ allowPasswordChange: true });
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-[420px] rounded-xl border bg-card p-7">
        <span className="icon-tile mb-4" aria-hidden>
          <ShieldCheck className="size-5" />
        </span>
        <h1 className="text-xl font-bold">{user.mustChangePassword ? "Set a new password" : "Change password"}</h1>
        <p className="mt-1 mb-6 text-[13px] text-muted-foreground">
          {user.mustChangePassword
            ? "Your account uses a temporary password. Choose a new one to continue."
            : `Signed in as ${user.email}.`}
        </p>
        <PasswordForm />
        <div className="mt-5 flex items-center justify-between text-[12px] text-muted-foreground">
          <span className="truncate">{user.email}</span>
          {user.mustChangePassword ? (
            <form action={signOut}>
              <button className="underline-offset-2 hover:text-foreground hover:underline">Sign out</button>
            </form>
          ) : (
            <Link href="/" className="underline-offset-2 hover:text-foreground hover:underline">
              Back to dashboard
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
