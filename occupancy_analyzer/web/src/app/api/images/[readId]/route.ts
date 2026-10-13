import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getAdminSupabase } from "@/lib/supabase/admin";
import { getServerSupabase } from "@/lib/supabase/server";
import { appConfig } from "@/lib/config";
import { rpc } from "@/lib/rpc";

export const dynamic = "force-dynamic";

/**
 * CONTRACT §5: auth check → log_audit('image_view') → 302 to a 300 s signed URL
 * for the read's image_path in the private `event-snapshots` bucket.
 */
export async function GET(_req: Request, ctx: RouteContext<"/api/images/[readId]">) {
  const user = await getSessionUser();
  if (!user || !user.role) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { readId } = await ctx.params;
  if (!z.guid().safeParse(readId).success) return NextResponse.json({ error: "Bad read id" }, { status: 400 });

  let admin;
  try {
    admin = getAdminSupabase();
  } catch {
    return NextResponse.json({ error: "Image service not configured" }, { status: 503 });
  }
  const { data, error } = await admin.from("plate_reads").select("image_path").eq("read_id", readId).maybeSingle();
  if (error) return NextResponse.json({ error: "Lookup failed" }, { status: 502 });
  const path = (data as { image_path: string | null } | null)?.image_path;
  if (!path) return NextResponse.json({ error: "No image for this read (expired after retention or never uploaded)" }, { status: 404 });

  // Audit with the user's own JWT so actor attribution is correct. Best-effort.
  await rpc.logAudit(await getServerSupabase(), "image_view", readId, { path });

  const { data: signed, error: signErr } = await admin.storage.from(appConfig.storage.bucket).createSignedUrl(path, 300);
  if (signErr || !signed?.signedUrl) return NextResponse.json({ error: "Image not found" }, { status: 404 });
  return NextResponse.redirect(signed.signedUrl, {
    status: 302,
    // Browser may reuse the redirect while the signed URL is still valid; never shared caches.
    headers: { "Cache-Control": "private, max-age=240" },
  });
}
