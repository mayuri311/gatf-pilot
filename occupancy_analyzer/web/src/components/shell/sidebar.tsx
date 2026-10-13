"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { ChevronDown, LogOut, SquareParking } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { signOut } from "@/app/actions/auth";
import { NAV, isActive } from "./nav";
import type { ShellProps } from "./types";

export function Brand({ collapsed }: { collapsed?: boolean }) {
  return (
    <Link
      href="/"
      className="flex h-16 shrink-0 items-center gap-3 border-b border-sidebar-border px-4 outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
      aria-label="GATF Lot — Live overview"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-[9px] bg-sidebar-primary text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]">
        <SquareParking className="size-[19px]" strokeWidth={2} />
      </span>
      {!collapsed && (
        <span className="min-w-0 leading-tight">
          <span className="block truncate text-[15px] font-semibold text-white">GATF Lot</span>
          <span className="eyebrow block truncate text-[9.5px] text-sidebar-muted">Occupancy Analyzer</span>
        </span>
      )}
    </Link>
  );
}

export function SidebarNav({
  collapsed,
  user,
  counts,
  aiEnabled,
  onNavigate,
}: Pick<ShellProps, "user" | "counts" | "aiEnabled"> & { collapsed?: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  const [closed, setClosed] = useState<Record<string, boolean>>({});

  return (
    <nav aria-label="Main" className="sidebar-scroll flex-1 overflow-y-auto overflow-x-hidden px-3 py-4">
      {NAV.filter((g) => !g.adminOnly || user.role === "admin").map((group) => {
        const items = group.items.filter((i) => !i.requiresAi || aiEnabled);
        const isClosed = closed[group.id] && !collapsed;
        return (
          <div key={group.id} className="mb-5 last:mb-0">
            {collapsed ? (
              <div className="mx-auto mb-2 h-px w-6 bg-sidebar-border" aria-hidden />
            ) : (
              <button
                type="button"
                onClick={() => setClosed((c) => ({ ...c, [group.id]: !c[group.id] }))}
                className="eyebrow mb-1.5 flex w-full items-center justify-between rounded px-3 py-1 text-sidebar-muted hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-sidebar-ring"
                aria-expanded={!isClosed}
              >
                {group.label}
                <ChevronDown className={cn("size-3.5 transition-transform", isClosed && "-rotate-90")} />
              </button>
            )}
            {!isClosed && (
              <ul className="space-y-0.5">
                {items.map((item) => {
                  const active = isActive(pathname, item.href);
                  const count = item.badge ? counts[item.badge] : 0;
                  const link = (
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "group relative flex h-[38px] items-center gap-3 rounded-lg px-3 text-[14px] font-medium outline-none transition-colors",
                        "focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                        active
                          ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)]"
                          : "text-sidebar-foreground/85 hover:bg-white/[0.03] hover:text-white",
                        collapsed && "justify-center px-0",
                      )}
                    >
                      <item.icon
                        className={cn("size-[18px] shrink-0", active ? "text-sidebar-primary" : "text-sidebar-foreground/70")}
                        strokeWidth={1.75}
                      />
                      {!collapsed && <span className="truncate">{item.label}</span>}
                      {count > 0 &&
                        (collapsed ? (
                          <span className="absolute top-1.5 right-2 size-2 rounded-full bg-sidebar-primary" aria-label={`${count} pending`} />
                        ) : (
                          <span className="num ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-sidebar-primary/15 px-1.5 text-[10.5px] font-semibold text-sidebar-primary">
                            {count > 99 ? "99+" : count}
                          </span>
                        ))}
                    </Link>
                  );
                  return (
                    <li key={item.href}>
                      {collapsed ? (
                        <Tooltip>
                          <TooltipTrigger asChild>{link}</TooltipTrigger>
                          <TooltipContent side="right">{item.label}</TooltipContent>
                        </Tooltip>
                      ) : (
                        link
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </nav>
  );
}

export function UserFooter({ user, collapsed }: Pick<ShellProps, "user"> & { collapsed?: boolean }) {
  return (
    <div className={cn("flex h-[76px] shrink-0 items-center gap-3 border-t border-sidebar-border px-4", collapsed && "justify-center px-0")}>
      <span
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-sidebar-primary text-[12px] font-semibold text-white"
        aria-hidden
      >
        {user.initials}
      </span>
      {!collapsed && (
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-[14px] font-medium text-white" title={user.email}>
            {user.name}
          </span>
          <span className="block truncate text-[11.5px] text-sidebar-muted capitalize">{user.role ?? "no role"}</span>
        </span>
      )}
      {!collapsed && (
        <form action={signOut}>
          <button
            type="submit"
            className="flex size-8 items-center justify-center rounded-md text-sidebar-muted hover:bg-white/5 hover:text-white focus-visible:outline-2 focus-visible:outline-sidebar-ring"
            aria-label="Sign out"
            title="Sign out"
          >
            <LogOut className="size-[17px]" />
          </button>
        </form>
      )}
    </div>
  );
}
