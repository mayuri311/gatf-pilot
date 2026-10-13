import type { AlertRow } from "@/lib/rpc";

export type ShellUser = {
  email: string;
  name: string;
  initials: string;
  role: "admin" | "staff" | null;
};

export type ShellProps = {
  user: ShellUser;
  counts: { review: number; alerts: number };
  alerts: AlertRow[];
  aiEnabled: boolean;
  kiosk: boolean;
  initialCollapsed: boolean;
};
