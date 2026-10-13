"use client";

import Link from "next/link";
import { useTheme } from "next-themes";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Bell, Check, LogOut, Menu, Moon, Palette, Scale, Search, Sun, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { signOut } from "@/app/actions/auth";
import { cn } from "@/lib/utils";
import { fmtAge } from "@/lib/format";
import { ACCENTS, applyAccent, readAccent, type AccentId } from "./accent";
import type { ShellProps } from "./types";

const subscribeNoop = () => () => {};
function useMounted() {
  return useSyncExternalStore(subscribeNoop, () => true, () => false);
}

function IconButton({ label, children, ...props }: React.ComponentProps<typeof Button> & { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={label} className="size-9 text-muted-foreground hover:text-foreground" {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useMounted();
  const dark = !mounted || resolvedTheme !== "light";
  return (
    <IconButton label={dark ? "Switch to light theme" : "Switch to dark theme"} onClick={() => setTheme(dark ? "light" : "dark")}>
      {dark ? <Moon className="size-[18px]" /> : <Sun className="size-[18px]" />}
    </IconButton>
  );
}

function AccentMenu() {
  const [accent, setAccent] = useState<AccentId>("blue");
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync with localStorage after mount
    setAccent(readAccent());
  }, []);
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Accent colour" className="size-9 text-muted-foreground hover:text-foreground">
              <Palette className="size-[18px]" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Accent colour</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Accent</DropdownMenuLabel>
        {ACCENTS.map((a) => (
          <DropdownMenuItem
            key={a.id}
            onSelect={() => {
              applyAccent(a.id);
              setAccent(a.id);
            }}
          >
            <span className="size-3 rounded-full" style={{ background: a.swatch }} aria-hidden />
            {a.label}
            {accent === a.id && <Check className="ml-auto size-3.5" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const SEV_DOT: Record<string, string> = {
  critical: "bg-destructive",
  warning: "bg-warning",
  info: "bg-primary",
};

function AlertsBell({ alerts }: Pick<ShellProps, "alerts">) {
  const open = alerts.filter((a) => !a.acked);
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="relative size-9 text-muted-foreground hover:text-foreground"
              aria-label={open.length ? `Alerts: ${open.length} unacknowledged` : "Alerts: none"}
            >
              <Bell className="size-[18px]" />
              {open.length > 0 && (
                <span className="absolute top-[7px] right-[8px] size-2 rounded-full bg-destructive ring-2 ring-background" aria-hidden />
              )}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Alerts</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <span className="text-sm font-semibold">Alerts</span>
          <span className="num text-xs text-muted-foreground">{open.length} open</span>
        </div>
        <ul className="max-h-80 overflow-y-auto">
          {alerts.length === 0 && <li className="px-4 py-6 text-center text-sm text-muted-foreground">All clear. No active alerts.</li>}
          {alerts.slice(0, 8).map((a) => (
            <li key={a.key} className={cn("flex gap-3 border-b px-4 py-3 last:border-0", a.acked && "opacity-60")}>
              <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", SEV_DOT[a.severity])} aria-hidden />
              <div className="min-w-0">
                <p className="text-[13px] leading-snug font-medium">
                  <span className="sr-only">{a.severity}: </span>
                  {a.title}
                </p>
                {a.detail && <p className="truncate text-xs text-muted-foreground">{a.detail}</p>}
                <p className="num mt-0.5 text-[11px] text-muted-foreground">
                  {a.since ? `${fmtAge(a.since)} ago` : ""} {a.acked ? "· acknowledged" : ""}
                </p>
              </div>
            </li>
          ))}
        </ul>
        <div className="border-t p-2">
          <Button asChild variant="ghost" size="sm" className="w-full">
            <Link href="/alerts">Open alert inbox</Link>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function Header({
  user,
  alerts,
  onOpenSearch,
  onOpenMobileNav,
}: Pick<ShellProps, "user" | "alerts"> & { onOpenSearch: () => void; onOpenMobileNav: () => void }) {
  return (
    <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-3 border-b bg-background/85 px-4 backdrop-blur-md supports-[backdrop-filter]:bg-background/70 sm:px-6">
      <Button variant="ghost" size="icon" className="size-9 lg:hidden" onClick={onOpenMobileNav} aria-label="Open navigation">
        <Menu className="size-5" />
      </Button>
      <button
        type="button"
        onClick={onOpenSearch}
        className="flex h-9 w-full max-w-[288px] items-center gap-2.5 rounded-lg border bg-card px-3 text-left text-sm text-muted-foreground transition-colors hover:border-foreground/20 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none dark:bg-[#05080c]"
        aria-label="Search plates (Command K)"
      >
        <Search className="size-4 shrink-0" />
        <span className="flex-1 truncate">Search plates…</span>
        <kbd className="num hidden rounded border bg-muted px-1.5 py-px text-[10px] text-muted-foreground sm:inline">⌘K</kbd>
      </button>
      <div className="ml-auto flex items-center gap-1">
        {user.role === "admin" && (
          <Button asChild className="mr-2 hidden h-9 gap-2 px-3.5 sm:inline-flex">
            <Link href="/admin/reconcile">
              <Scale className="size-4" />
              Reconcile
            </Link>
          </Button>
        )}
        <div className="mr-1 hidden h-6 w-px bg-border sm:block" aria-hidden />
        <ThemeToggle />
        <AccentMenu />
        <AlertsBell alerts={alerts} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="ml-1 flex size-9 items-center justify-center rounded-full bg-primary/15 text-[12px] font-semibold text-primary ring-1 ring-primary/25 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              aria-label="Account menu"
            >
              {user.initials}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="font-normal">
              <span className="block text-sm font-medium">{user.name}</span>
              <span className="block truncate text-xs text-muted-foreground">{user.email}</span>
              <span className="mt-1 inline-block rounded bg-primary/10 px-1.5 py-px text-[10px] font-medium tracking-wide text-primary uppercase">
                {user.role ?? "no role"}
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/account/password">
                <UserRound /> Change password
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <form action={signOut} className="w-full">
                <button type="submit" className="flex w-full items-center gap-2">
                  <LogOut className="size-4" /> Sign out
                </button>
              </form>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
