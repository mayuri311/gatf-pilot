"use client";

import { useEffect } from "react";
import { RotateCcw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function DashError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div role="alert" className="mx-auto mt-16 max-w-md rounded-[10px] border bg-card p-6 text-center">
      <TriangleAlert className="mx-auto size-6 text-destructive" />
      <h1 className="mt-3 text-lg font-semibold">This page failed to load</h1>
      <p className="mt-1 text-[13px] text-muted-foreground">Something went wrong while rendering. The data itself is unaffected.</p>
      {error.digest && <p className="num mt-2 text-[11px] text-muted-foreground">ref {error.digest}</p>}
      <Button onClick={reset} className="mt-5 gap-1.5">
        <RotateCcw className="size-4" /> Try again
      </Button>
    </div>
  );
}
