"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, Check, CheckCircle2, Loader2, Minus, Plus } from "lucide-react";
import { toast } from "sonner";
import type { ReconcilePreview, SessionRow } from "@/lib/rpc";
import { cn } from "@/lib/utils";
import { fmtDateTime, fmtDwell } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Panel } from "@/components/common/panel";
import { Plate, PlateThumb } from "@/components/common/plate";
import { FlagBadges } from "@/components/common/badges";
import { reconcileCommitAction, reconcilePreviewAction } from "@/app/actions/ops";

const STEPS = ["Count", "Compare", "Review residue", "Confirm"];

type Row = SessionRow & { reason: string | null };

function Stepper({ step }: { step: number }) {
  return (
    <ol className="mb-6 grid grid-cols-4 gap-2" aria-label="Progress">
      {STEPS.map((s, i) => (
        <li key={s} aria-current={i === step ? "step" : undefined} className="flex flex-col gap-1.5">
          <span className={cn("h-1 rounded-full", i <= step ? "bg-primary" : "bg-muted")} />
          <span className={cn("text-[11.5px] font-medium", i === step ? "text-foreground" : "text-muted-foreground")}>
            <span className="num mr-1">{i + 1}</span>
            <span className="hidden sm:inline">{s}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function Big({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: string }) {
  return (
    <div className="rounded-lg border bg-muted/15 p-4">
      <p className="text-[12px] text-muted-foreground">{label}</p>
      <p className="num mt-1 text-3xl font-semibold" style={tone ? { color: tone } : undefined}>
        {value}
      </p>
      {sub && <p className="num mt-0.5 text-[12px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

export function ReconcileFlow({ currentEstimate }: { currentEstimate: number | null }) {
  const [step, setStep] = useState(0);
  const [count, setCount] = useState<string>("");
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<ReconcilePreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [result, setResult] = useState<{ residual: number | null; closed: number | null } | null>(null);
  const [pending, start] = useTransition();
  const n = Number(count);
  const validN = count !== "" && Number.isInteger(n) && n >= 0;

  const proposedIds = useMemo(() => new Set((preview?.proposed ?? []).map((p) => p.session_id)), [preview]);
  const allRows: Row[] = useMemo(() => {
    if (!preview) return [];
    const extra = (preview.open ?? []).filter((o) => !proposedIds.has(o.session_id));
    return [...preview.proposed, ...extra] as Row[];
  }, [preview, proposedIds]);
  const rows = showAll ? allRows : allRows.filter((r) => proposedIds.has(r.session_id));
  const openNow = preview?.open_sessions ?? 0;
  const afterClose = openNow - selected.size;

  const loadPreview = () =>
    start(async () => {
      const r = await reconcilePreviewAction(n);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      if (!r.data) return;
      setPreview(r.data);
      setSelected(new Set(r.data.proposed.map((p) => p.session_id)));
      setStep(1);
    });

  const commit = () =>
    start(async () => {
      const r = await reconcileCommitAction(n, [...selected], note);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setResult(r.data ?? { residual: null, closed: null });
      toast.success("Occupancy reconciled");
    });

  if (result) {
    return (
      <Panel className="mx-auto max-w-xl p-6 text-center">
        <CheckCircle2 className="mx-auto size-10 text-success" />
        <h2 className="mt-3 text-xl font-bold">Reconciled to {n}</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Closed <span className="num font-semibold text-foreground">{result.closed ?? selected.size}</span> sessions as closed_admin. Residual (estimate − count):{" "}
          <span className="num font-semibold text-foreground">{result.residual == null ? "—" : result.residual > 0 ? `+${result.residual}` : result.residual}</span>. The band is now ±0.
        </p>
        <div className="mt-5 flex justify-center gap-2">
          <Button asChild>
            <Link href="/">Back to Live</Link>
          </Button>
          <Button variant="outline" onClick={() => { setResult(null); setStep(0); setCount(""); setNote(""); setPreview(null); }}>
            New count
          </Button>
        </div>
      </Panel>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <Stepper step={step} />
      {step === 0 && (
        <Panel className="p-5 sm:p-6">
          <h2 className="text-lg font-semibold">How many cars are in the lot right now?</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">Walk the lot and count every parked vehicle. The system currently estimates {currentEstimate ?? "—"}.</p>
          <form
            className="mt-5 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (validN) loadPreview();
            }}
          >
            <div className="flex items-center gap-3">
              <Button type="button" variant="outline" size="icon-lg" className="size-14" onClick={() => setCount(String(Math.max(0, (Number(count) || 0) - 1)))} aria-label="Minus one">
                <Minus className="size-5" />
              </Button>
              <Label htmlFor="visual-count" className="sr-only">Visual count</Label>
              <Input
                id="visual-count"
                inputMode="numeric"
                pattern="[0-9]*"
                autoFocus
                value={count}
                onChange={(e) => setCount(e.target.value.replace(/\D/g, "").slice(0, 4))}
                className="num h-14 flex-1 text-center text-3xl font-semibold md:text-3xl"
                placeholder="0"
              />
              <Button type="button" variant="outline" size="icon-lg" className="size-14" onClick={() => setCount(String((Number(count) || 0) + 1))} aria-label="Plus one">
                <Plus className="size-5" />
              </Button>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rec-note">Note (optional)</Label>
              <Textarea id="rec-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. 08:05 walk-through, row C blocked" rows={2} />
            </div>
            <Button type="submit" className="h-11 w-full gap-2" disabled={!validN || pending}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : <ArrowRight className="size-4" />} Compare with the estimate
            </Button>
          </form>
        </Panel>
      )}

      {step === 1 && preview && (
        <Panel className="p-5 sm:p-6">
          <h2 className="text-lg font-semibold">Compare</h2>
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Big label="Your count (N)" value={n} tone="var(--primary)" />
            <Big label="Estimate S1" value={preview.estimate ?? "—"} sub={preview.band_low != null ? `band ${preview.band_low}–${preview.band_high}` : undefined} />
            <Big label="Open sessions S2" value={preview.open_sessions ?? "—"} sub={`${(preview.open_sessions ?? 0) - n >= 0 ? "+" : ""}${(preview.open_sessions ?? 0) - n} vs N`} />
          </div>
          <p className="mt-4 rounded-md border bg-muted/20 px-3 py-2 text-[13px]">
            Residual if you confirm: <span className="num font-semibold">{preview.estimate != null ? (preview.estimate - n > 0 ? "+" : "") + (preview.estimate - n) : "—"}</span>.{" "}
            The system proposes closing <span className="num font-semibold">{preview.to_close_count ?? preview.proposed.length}</span> ghost sessions (suspect-stale / multi-day first, then oldest, then lowest confidence).
          </p>
          <div className="mt-5 flex justify-between gap-2">
            <Button variant="outline" onClick={() => setStep(0)} className="gap-1.5">
              <ArrowLeft className="size-4" /> Back
            </Button>
            <Button onClick={() => setStep(2)} className="gap-1.5">
              Review proposed residue <ArrowRight className="size-4" />
            </Button>
          </div>
        </Panel>
      )}

      {step === 2 && preview && (
        <Panel>
          <div className="sticky top-16 z-10 flex flex-wrap items-center justify-between gap-3 rounded-t-[10px] border-b bg-card/95 px-5 py-3 backdrop-blur">
            <p className="text-[14px]" aria-live="polite">
              Closing <span className="num font-semibold text-primary">{selected.size}</span> → open ={" "}
              <span className={cn("num font-semibold", afterClose === n ? "text-success" : "text-warning")}>{afterClose}</span>
              <span className="text-muted-foreground"> (target {n})</span>
            </p>
            <label className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
              <Checkbox checked={showAll} onCheckedChange={(v) => setShowAll(v === true)} /> Show all open sessions
            </label>
          </div>
          {rows.length === 0 ? (
            <p className="p-5 text-[13px] text-muted-foreground">Nothing to close — the open sessions already match your count.</p>
          ) : (
            <ul className="divide-y">
              {rows.map((r) => {
                const on = selected.has(r.session_id);
                return (
                  <li key={r.session_id}>
                    <label className={cn("flex cursor-pointer items-center gap-3 px-5 py-3 hover:bg-muted/30", !on && "opacity-75")}>
                      <Checkbox
                        checked={on}
                        onCheckedChange={(v) =>
                          setSelected((s) => {
                            const next = new Set(s);
                            if (v === true) next.add(r.session_id);
                            else next.delete(r.session_id);
                            return next;
                          })
                        }
                        aria-label={`${on ? "Close" : "Keep"} ${r.plate_norm ?? "session"}`}
                        className="size-5"
                      />
                      <PlateThumb readId={r.entry_read_id} alt={`Entry crop ${r.plate_norm ?? ""}`} className="h-9 w-24 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Plate value={r.plate_norm} link={false} />
                          <FlagBadges s={r} />
                        </div>
                        <p className="num mt-0.5 truncate text-[11.5px] text-muted-foreground">
                          in {fmtDateTime(r.entry_at)} · {fmtDwell(r.dwell_min)} · {r.reason ?? "open"}
                        </p>
                      </div>
                      <span className={cn("text-[12px] font-medium", on ? "text-destructive" : "text-success")}>{on ? "close" : "still here"}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="flex justify-between gap-2 border-t px-5 py-4">
            <Button variant="outline" onClick={() => setStep(1)} className="gap-1.5">
              <ArrowLeft className="size-4" /> Back
            </Button>
            <Button onClick={() => setStep(3)} className="gap-1.5">
              Continue <ArrowRight className="size-4" />
            </Button>
          </div>
        </Panel>
      )}

      {step === 3 && preview && (
        <Panel className="p-5 sm:p-6">
          <h2 className="text-lg font-semibold">Confirm reconciliation</h2>
          <ul className="mt-4 space-y-2 text-[14px]">
            <li>• Set occupancy to <span className="num font-semibold">{n}</span> (band collapses to ±0).</li>
            <li>• Close <span className="num font-semibold">{selected.size}</span> sessions as <span className="font-mono text-[12.5px]">closed_admin</span>; open sessions become <span className="num font-semibold">{afterClose}</span>.</li>
            <li>• Store residual <span className="num font-semibold">{preview.estimate != null ? (preview.estimate - n > 0 ? "+" : "") + (preview.estimate - n) : "—"}</span> in the calibration history. Audit-logged.</li>
            {note && <li>• Note: “{note}”</li>}
          </ul>
          <div className="mt-6 flex justify-between gap-2">
            <Button variant="outline" onClick={() => setStep(2)} className="gap-1.5">
              <ArrowLeft className="size-4" /> Back
            </Button>
            <Button onClick={commit} disabled={pending} className="h-10 gap-1.5">
              {pending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Confirm reconciliation
            </Button>
          </div>
        </Panel>
      )}
    </div>
  );
}
