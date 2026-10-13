"use client";

import { useEffect, useState } from "react";

import { ChevronLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Brand, SidebarNav, UserFooter } from "./sidebar";
import { Header } from "./header";
import { CommandPalette } from "./command-palette";
import type { ShellProps } from "./types";

const COOKIE = "gatf_sidebar_collapsed";

export function AppShell({ children, ...props }: ShellProps & { children: React.ReactNode }) {
  const { user, counts, alerts, aiEnabled, kiosk, initialCollapsed } = props;
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    document.cookie = `${COOKIE}=${next ? 1 : 0}; path=/; max-age=31536000; samesite=lax`;
  };

  if (kiosk) {
    return <main className="min-h-dvh bg-background p-4 sm:p-6 lg:p-8">{children}</main>;
  }

  return (
    <div className="flex min-h-dvh">
      <a
        href="#main"
        className="sr-only z-50 rounded bg-primary px-3 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      {/* Desktop sidebar — always dark, both themes */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 hidden flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 lg:flex",
          collapsed ? "w-[72px]" : "w-[260px]",
        )}
        aria-label="Sidebar"
      >
        <Brand collapsed={collapsed} />
        <SidebarNav collapsed={collapsed} user={user} counts={counts} aiEnabled={aiEnabled} />
        <UserFooter user={user} collapsed={collapsed} />
        <button
          type="button"
          onClick={toggle}
          className="absolute top-[80px] -right-3 z-50 flex size-6 items-center justify-center rounded-full border border-sidebar-border bg-sidebar text-sidebar-foreground/80 shadow-sm hover:text-white focus-visible:outline-2 focus-visible:outline-sidebar-ring"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
        >
          <ChevronLeft className={cn("size-3.5 transition-transform", collapsed && "rotate-180")} />
        </button>
      </aside>

      {/* Mobile: sidebar becomes a sheet */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent
          side="left"
          className="flex w-[280px] flex-col gap-0 border-sidebar-border bg-sidebar p-0 text-sidebar-foreground sm:max-w-[280px] [&>button]:text-sidebar-foreground"
        >
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SheetDescription className="sr-only">Main navigation</SheetDescription>
          <Brand />
          <SidebarNav user={user} counts={counts} aiEnabled={aiEnabled} onNavigate={() => setMobileOpen(false)} />
          <UserFooter user={user} />
        </SheetContent>
      </Sheet>

      <div className={cn("flex min-w-0 flex-1 flex-col transition-[padding] duration-200", collapsed ? "lg:pl-[72px]" : "lg:pl-[260px]")}>
        <Header user={user} alerts={alerts} onOpenSearch={() => setSearchOpen(true)} onOpenMobileNav={() => setMobileOpen(true)} />
        <main id="main" className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-7">
          {children}
        </main>
      </div>
      <CommandPalette open={searchOpen} onOpenChange={setSearchOpen} user={user} aiEnabled={aiEnabled} />
    </div>
  );
}
