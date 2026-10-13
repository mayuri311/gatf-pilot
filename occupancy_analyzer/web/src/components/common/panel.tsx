import { cn } from "@/lib/utils";

/** Fortress-style card: 1px subtle border, ~10px radius, no heavy shadow in dark. */
export function Panel({ className, ...props }: React.ComponentProps<"section">) {
  return (
    <section
      className={cn(
        "relative rounded-[10px] border bg-card text-card-foreground shadow-[0_1px_2px_rgba(16,24,40,0.04)] dark:shadow-none",
        className,
      )}
      {...props}
    />
  );
}

export function PanelHeader({
  title,
  subtitle,
  actions,
  className,
  id,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-3 px-5 pt-5", className)}>
      <div className="min-w-0">
        <h2 id={id} className="text-[16px] leading-snug font-semibold tracking-[-0.005em]">
          {title}
        </h2>
        {subtitle && <p className="mt-1 text-[13px] text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function PanelBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("px-5 pt-4 pb-5", className)} {...props} />;
}
