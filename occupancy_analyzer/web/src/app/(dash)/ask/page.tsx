import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/common/page-header";
import { AskChat } from "@/components/ask/ask-chat";
import { appConfig } from "@/lib/config";

export const metadata: Metadata = { title: "Ask the lot" };

export default function AskPage() {
  if (!appConfig.ai.enabled) notFound();

  return (
    <>
      <PageHeader
        title="Ask the lot"
        subtitle={
          <>
            Plain-English questions answered by <span className="num text-foreground">{appConfig.ai.model}</span>{" "}
            using read-only SQL over the lot views. Every answer shows the exact queries it ran.
          </>
        }
      />
      <AskChat model={appConfig.ai.model} />
    </>
  );
}
