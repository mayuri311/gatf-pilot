"use client";

import { useState, useTransition } from "react";
import { KeyRound, Loader2, MoreHorizontal, ShieldCheck, UserMinus, UserPlus, UserRoundCheck, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { fmtDateTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { createUserAction, resetPasswordAction, setActiveAction, setRoleAction, type UserActionResult } from "@/app/actions/users";

export type AdminUser = {
  id: string;
  email: string;
  role: string | null;
  mustChange: boolean;
  banned: boolean;
  createdAt: string | null;
  lastSignIn: string | null;
};

function genPassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const a = new Uint32Array(16);
  crypto.getRandomValues(a);
  const s = Array.from(a, (n) => chars[n % chars.length]).join("");
  return s.slice(0, 6) + "-" + s.slice(6, 12) + String(a[0] % 10);
}

function report(r: UserActionResult) {
  if (r.ok) toast.success(r.message ?? "Done");
  else toast.error(r.error);
  return r.ok;
}

export function CreateUserDialog() {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [role, setRole] = useState("staff");
  const [pending, start] = useTransition();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="h-9 gap-1.5">
          <UserPlus className="size-4" /> Create user
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create user</DialogTitle>
          <DialogDescription>No email is sent. Share the temporary password in person; they must change it at first sign-in.</DialogDescription>
        </DialogHeader>
        <form
          id="create-user"
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              if (report(await createUserAction({ email, password: pw, role }))) {
                setOpen(false);
                setEmail("");
                setPw("");
              }
            });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="nu-email">Email</Label>
            <Input id="nu-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nu-pw">Temporary password</Label>
            <div className="flex gap-2">
              <Input id="nu-pw" required minLength={12} value={pw} onChange={(e) => setPw(e.target.value)} className="font-mono" autoComplete="off" />
              <Button type="button" variant="outline" onClick={() => setPw(genPassword())} className="gap-1.5">
                <Wand2 className="size-3.5" /> Generate
              </Button>
            </div>
          </div>
          <fieldset className="space-y-1.5">
            <legend className="mb-1.5 text-sm font-medium">Role</legend>
            <div className="grid grid-cols-2 gap-2">
              {[
                ["staff", "Staff", "View, search, export, chat"],
                ["admin", "Admin", "Also reconcile, resolve, users"],
              ].map(([v, l, d]) => (
                <label key={v} className={cn("cursor-pointer rounded-lg border p-3 text-[13px]", role === v && "border-primary bg-primary/5")}>
                  <input type="radio" name="role" value={v} checked={role === v} onChange={() => setRole(v)} className="sr-only" />
                  <span className="block font-medium">{l}</span>
                  <span className="block text-[11.5px] text-muted-foreground">{d}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </form>
        <DialogFooter>
          <Button type="submit" form="create-user" disabled={pending} className="gap-1.5">
            {pending && <Loader2 className="size-4 animate-spin" />} Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResetDialog({ user, open, onOpenChange }: { user: AdminUser; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [pw, setPw] = useState("");
  const [pending, start] = useTransition();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset password</DialogTitle>
          <DialogDescription>{user.email} will have to choose a new password at next sign-in.</DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <Label htmlFor="rp-pw" className="sr-only">Temporary password</Label>
          <Input id="rp-pw" value={pw} onChange={(e) => setPw(e.target.value)} className="font-mono" placeholder="Temporary password" autoComplete="off" />
          <Button type="button" variant="outline" onClick={() => setPw(genPassword())} className="gap-1.5">
            <Wand2 className="size-3.5" /> Generate
          </Button>
        </div>
        <DialogFooter>
          <Button
            disabled={pending || pw.length < 12}
            onClick={() =>
              start(async () => {
                if (report(await resetPasswordAction(user.id, pw))) onOpenChange(false);
              })
            }
          >
            Reset password
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RowActions({ user, isSelf }: { user: AdminUser; isSelf: boolean }) {
  const [resetOpen, setResetOpen] = useState(false);
  const [pending, start] = useTransition();
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${user.email}`} disabled={pending}>
            {pending ? <Loader2 className="animate-spin" /> : <MoreHorizontal />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onSelect={() => setResetOpen(true)}>
            <KeyRound /> Reset password
          </DropdownMenuItem>
          <DropdownMenuItem disabled={isSelf} onSelect={() => start(async () => void report(await setRoleAction(user.id, user.role === "admin" ? "staff" : "admin")))}>
            <ShieldCheck /> Make {user.role === "admin" ? "staff" : "admin"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {user.banned ? (
            <DropdownMenuItem onSelect={() => start(async () => void report(await setActiveAction(user.id, true)))}>
              <UserRoundCheck /> Reactivate
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem variant="destructive" disabled={isSelf} onSelect={() => start(async () => void report(await setActiveAction(user.id, false)))}>
              <UserMinus /> Deactivate
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <ResetDialog user={user} open={resetOpen} onOpenChange={setResetOpen} />
    </>
  );
}

export function UsersTable({ users, selfId }: { users: AdminUser[]; selfId: string }) {
  return (
    <div className="scrollbar-thin overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b text-left text-[11.5px] text-muted-foreground uppercase">
            {["User", "Role", "Status", "Created", "Last sign-in", ""].map((h, i) => (
              <th key={i} scope="col" className="px-3 py-2.5 font-medium first:pl-5 last:pr-5">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className={cn("border-b border-border/60 last:border-0", u.banned && "opacity-60")}>
              <td className="px-3 py-3 pl-5">
                <span className="font-medium">{u.email}</span>
                {u.id === selfId && <span className="ml-2 text-[11px] text-muted-foreground">(you)</span>}
              </td>
              <td className="px-3">
                <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-semibold tracking-wide uppercase", u.role === "admin" ? "bg-primary/12 text-primary" : "bg-muted text-muted-foreground")}>
                  {u.role ?? "none"}
                </span>
              </td>
              <td className="px-3 text-[12.5px]">
                {u.banned ? (
                  <span className="text-destructive">■ Deactivated</span>
                ) : u.mustChange ? (
                  <span className="text-warning">▲ Must change password</span>
                ) : (
                  <span className="text-success">● Active</span>
                )}
              </td>
              <td className="num px-3 text-muted-foreground">{fmtDateTime(u.createdAt)}</td>
              <td className="num px-3 text-muted-foreground">{u.lastSignIn ? fmtDateTime(u.lastSignIn) : "never"}</td>
              <td className="px-3 pr-5 text-right">
                <RowActions user={u} isSelf={u.id === selfId} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
