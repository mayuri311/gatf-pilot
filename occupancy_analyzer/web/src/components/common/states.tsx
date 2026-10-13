import { CircleSlash, DatabaseZap, Lock, PlugZap, TriangleAlert, WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { errorText, type RpcError } from "@/lib/rpc";

export function EmptyState({
  title = "No data",
  children,
  icon: Icon = CircleSlash,
  className,
  compact,
}: {
  title?: string;
  children?: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-lg border border-dashed text-center",
        compact ? "gap-1.5 px-4 py-6" : "gap-2 px-6 py-12",
        className,
      )}
    >
      <Icon className="size-5 text-muted-foreground" aria-hidden />
      <p className="text-sm font-medium">{title}</p>
      {children && <div className="max-w-sm text-[13px] text-muted-foreground">{children}</div>}
    </div>
  );
}

const ERROR_ICON = {
  missing: DatabaseZap,
  forbidden: Lock,
  auth: Lock,
  network: WifiOff,
  timeout: WifiOff,
  invalid: PlugZap,
  error: TriangleAlert,
} as const;

export function ErrorState({ error, className, compact }: { error: RpcError; className?: string; compact?: boolean }) {
  const Icon = ERROR_ICON[error.kind];
  const title =
    error.kind === "missing"
      ? "Not available yet"
      : error.kind === "forbidden"
        ? "Admins only"
        : error.kind === "network"
          ? "Offline"
          : error.kind === "timeout"
            ? "Taking too long"
          : "Couldn't load this";
  return (
    <div
      role="status"
      className={cn(
        "flex flex-col items-center justify-center rounded-lg border border-dashed text-center",
        compact ? "gap-1.5 px-4 py-6" : "gap-2 px-6 py-12",
        className,
      )}
    >
      <Icon className={cn("size-5", error.kind === "error" ? "text-destructive" : "text-muted-foreground")} aria-hidden />
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-md text-[13px] text-muted-foreground">{errorText(error)}</p>
      {error.kind !== "missing" && error.code && (
        <p className="num text-[11px] text-muted-foreground/70">
          {error.fn} · {error.code}
        </p>
      )}
    </div>
  );
}
