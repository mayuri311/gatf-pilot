"use client";

import { useState } from "react";
import Link from "next/link";
import { ImageOff } from "lucide-react";
import { cn } from "@/lib/utils";

export function Plate({
  value,
  link = true,
  className,
  hidden,
}: {
  value: string | null | undefined;
  link?: boolean;
  className?: string;
  hidden?: boolean;
}) {
  if (hidden) return <span className={cn("plate text-muted-foreground", className)}>•••••</span>;
  if (!value) return <span className={cn("plate text-muted-foreground", className)}>—</span>;
  const inner = (
    <span
      className={cn(
        "plate inline-flex items-center rounded-[5px] border border-foreground/15 bg-foreground/[0.04] px-1.5 py-px text-[12.5px] text-foreground",
        className,
      )}
    >
      {value}
    </span>
  );
  if (!link) return inner;
  return (
    <Link
      href={`/vehicles/${encodeURIComponent(value)}`}
      className="rounded-[5px] outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring"
      onClick={(e) => e.stopPropagation()}
    >
      {inner}
    </Link>
  );
}

/** Plate crop via /api/images/[readId] (auth + audit + 300 s signed URL). */
export function PlateThumb({
  readId,
  alt,
  className,
  hidden,
}: {
  readId: string | null | undefined;
  alt: string;
  className?: string;
  hidden?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const box = cn(
    "flex shrink-0 items-center justify-center overflow-hidden rounded-[5px] border bg-muted/60",
    className ?? "h-7 w-[72px]",
  );
  if (hidden) return <span className={box} aria-hidden />;
  if (!readId || failed) {
    return (
      <span className={box} title="No crop available">
        <ImageOff className="size-3.5 text-muted-foreground/60" aria-hidden />
        <span className="sr-only">No crop available</span>
      </span>
    );
  }
  return (
    <span className={box}>
      <img
        src={`/api/images/${encodeURIComponent(readId)}`}
        alt={alt}
        loading="lazy"
        decoding="async"
        className="h-full w-full object-cover"
        onError={() => setFailed(true)}
      />
    </span>
  );
}
