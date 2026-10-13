"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertAdmin } from "@/lib/auth";
import { getServerSupabase } from "@/lib/supabase/server";
import { errorText, rpc } from "@/lib/rpc";

/** Admin-only mutations (D22). Role is checked here AND inside each SECURITY DEFINER RPC. */
export type ActionResult<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

const uuid = z.guid();
const plate = z
  .string()
  .transform((s) => s.toUpperCase().replace(/[^A-Z0-9]/g, ""))
  .pipe(z.string().min(2).max(10));

async function guard(): Promise<ActionResult | null> {
  try {
    await assertAdmin();
    return null;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Not allowed" };
  }
}

export async function resolveMatchAction(exitPass: string, entryPass: string | null, note?: string): Promise<ActionResult> {
  const denied = await guard();
  if (denied) return denied;
  if (!uuid.safeParse(exitPass).success || (entryPass !== null && !uuid.safeParse(entryPass).success)) {
    return { ok: false, error: "Invalid pass id" };
  }
  const res = await rpc.resolveMatch(await getServerSupabase(), exitPass, entryPass, note?.slice(0, 500) || null);
  if (!res.ok) return { ok: false, error: errorText(res.error) };
  revalidatePath("/review");
  return { ok: true };
}

export async function correctPlateAction(readId: string, newPlate: string, note?: string): Promise<ActionResult> {
  const denied = await guard();
  if (denied) return denied;
  const p = plate.safeParse(newPlate);
  if (!uuid.safeParse(readId).success || !p.success) return { ok: false, error: "Enter 2–10 letters/digits" };
  const res = await rpc.correctPlate(await getServerSupabase(), readId, p.data, note?.slice(0, 500) || null);
  if (!res.ok) return { ok: false, error: errorText(res.error) };
  revalidatePath("/reads");
  revalidatePath("/review");
  return { ok: true };
}

export async function ackAlertAction(key: string): Promise<ActionResult> {
  const denied = await guard();
  if (denied) return denied;
  const res = await rpc.ackAlert(await getServerSupabase(), key.slice(0, 200));
  if (!res.ok) return { ok: false, error: errorText(res.error) };
  revalidatePath("/alerts");
  return { ok: true };
}

export async function reconcilePreviewAction(visualCount: number) {
  const denied = await guard();
  if (denied) return denied;
  if (!Number.isInteger(visualCount) || visualCount < 0 || visualCount > 10000) return { ok: false as const, error: "Enter a whole number" };
  const res = await rpc.reconcilePreview(await getServerSupabase(), visualCount);
  if (!res.ok) return { ok: false as const, error: errorText(res.error) };
  return { ok: true as const, data: res.data };
}

export async function reconcileCommitAction(visualCount: number, close: string[], note?: string) {
  const denied = await guard();
  if (denied) return denied;
  if (!Number.isInteger(visualCount) || visualCount < 0) return { ok: false as const, error: "Invalid count" };
  if (!close.every((c) => uuid.safeParse(c).success)) return { ok: false as const, error: "Invalid session id" };
  const res = await rpc.reconcileCommit(await getServerSupabase(), visualCount, close, note?.slice(0, 500) || null);
  if (!res.ok) return { ok: false as const, error: errorText(res.error) };
  revalidatePath("/");
  revalidatePath("/admin/reconcile");
  return { ok: true as const, data: res.data };
}
