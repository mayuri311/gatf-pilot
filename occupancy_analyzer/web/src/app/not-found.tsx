import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background px-4 text-center">
      <p className="num text-5xl font-semibold text-muted-foreground">404</p>
      <h1 className="text-lg font-semibold">Page not found</h1>
      <p className="text-[13px] text-muted-foreground">The page doesn&apos;t exist, or this feature is turned off.</p>
      <Button asChild className="mt-2">
        <Link href="/">Back to Live</Link>
      </Button>
    </div>
  );
}
