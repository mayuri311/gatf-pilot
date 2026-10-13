import {
  BellRing,
  CarFront,
  ChartSpline,
  FileChartColumn,
  GitCompareArrows,
  HeartPulse,
  LayoutDashboard,
  Scale,
  ScanLine,
  ScrollText,
  Settings2,
  Sparkles,
  UsersRound,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  badge?: "review" | "alerts";
  adminOnly?: boolean;
  requiresAi?: boolean;
};
export type NavGroup = { id: string; label: string; items: NavItem[]; adminOnly?: boolean };

export const NAV: NavGroup[] = [
  {
    id: "overview",
    label: "Overview",
    items: [
      { href: "/", label: "Live", icon: LayoutDashboard },
      { href: "/analytics", label: "Analytics", icon: ChartSpline },
      { href: "/reports", label: "Reports", icon: FileChartColumn },
    ],
  },
  {
    id: "investigate",
    label: "Investigate",
    items: [
      { href: "/sessions", label: "Sessions", icon: CarFront },
      { href: "/reads", label: "Plate reads", icon: ScanLine },
      { href: "/ask", label: "Ask the lot", icon: Sparkles, requiresAi: true },
    ],
  },
  {
    id: "operations",
    label: "Operations",
    items: [
      { href: "/review", label: "Review queue", icon: GitCompareArrows, badge: "review" },
      { href: "/alerts", label: "Alerts", icon: BellRing, badge: "alerts" },
      { href: "/health", label: "System health", icon: HeartPulse },
    ],
  },
  {
    id: "admin",
    label: "Admin",
    adminOnly: true,
    items: [
      { href: "/admin/reconcile", label: "Reconcile", icon: Scale },
      { href: "/admin/users", label: "Users", icon: UsersRound },
      { href: "/admin/config", label: "Config", icon: Settings2 },
      { href: "/admin/audit", label: "Audit log", icon: ScrollText },
    ],
  },
];

export function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}
