import type { Metadata } from "next";
import { getServerSupabase } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/auth";
import { rpc } from "@/lib/rpc";
import { PageHeader } from "@/components/common/page-header";
import { ErrorState } from "@/components/common/states";
import { ReviewQueue } from "@/components/review/review-queue";

export const metadata: Metadata = { title: "Review queue" };

export default async function ReviewPage() {
  const [supabase, user] = await Promise.all([getServerSupabase(), getSessionUser()]);
  const res = await rpc.reviewQueue(supabase);
  const isAdmin = user?.role === "admin";
  return (
    <>
      <PageHeader
        title="Review queue"
        subtitle={
          res.ok
            ? `${res.data.length} exit${res.data.length === 1 ? "" : "s"} waiting · exit crop vs top candidate entries, character differences highlighted`
            : "Fuzzy exit matches that need a human decision"
        }
      />
      {res.ok ? <ReviewQueue items={res.data} isAdmin={isAdmin} /> : <ErrorState error={res.error} />}
    </>
  );
}
