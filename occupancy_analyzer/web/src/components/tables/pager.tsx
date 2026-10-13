"use client";

import { useTransition } from "react";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { parseAsInteger, useQueryState } from "nuqs";
import { Button } from "@/components/ui/button";
import { fmtInt } from "@/lib/format";

export function Pager({ total, pageSize }: { total: number; pageSize: number }) {
  const [pending, startTransition] = useTransition();
  const [page, setPage] = useQueryState("page", parseAsInteger.withDefault(1).withOptions({ shallow: false, startTransition }));
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="flex items-center justify-between gap-3 border-t px-5 py-3 text-[12.5px] text-muted-foreground">
      <span className="num flex items-center gap-2">
        {pending && <Loader2 className="size-3.5 animate-spin" />}
        {fmtInt(from)}–{fmtInt(to)} of {fmtInt(total)}
      </span>
      <div className="flex items-center gap-1.5">
        <Button variant="outline" size="icon-sm" onClick={() => setPage(page - 1 <= 1 ? null : page - 1)} disabled={page <= 1} aria-label="Previous page">
          <ChevronLeft />
        </Button>
        <span className="num px-1">
          {page} / {pages}
        </span>
        <Button variant="outline" size="icon-sm" onClick={() => setPage(page + 1)} disabled={page >= pages} aria-label="Next page">
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}
