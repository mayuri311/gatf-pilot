"use client";

import { useState, useTransition } from "react";
import { PencilLine } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { correctPlateAction } from "@/app/actions/ops";

/** Admin-only (D22): correct a misread plate. Audited by the RPC. */
export function CorrectPlate({ readId, current, onDone }: { readId: string; current: string | null; onDone?: () => void }) {
  const [open, setOpen] = useState(false);
  const [plate, setPlate] = useState(current ?? "");
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <PencilLine className="size-3.5" /> Correct plate
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              const r = await correctPlateAction(readId, plate, note);
              if (r.ok) {
                toast.success(`Plate corrected to ${plate.toUpperCase()}`);
                setOpen(false);
                onDone?.();
              } else toast.error(r.error);
            });
          }}
        >
          <div className="space-y-1">
            <Label htmlFor={`cp-${readId}`} className="text-xs">Correct plate</Label>
            <Input id={`cp-${readId}`} value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} className="plate h-9" maxLength={10} autoFocus />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`cpn-${readId}`} className="text-xs">Note (optional)</Label>
            <Input id={`cpn-${readId}`} value={note} onChange={(e) => setNote(e.target.value)} className="h-8 text-xs" />
          </div>
          <Button type="submit" size="sm" className="w-full" disabled={pending || plate.length < 2}>
            Save correction
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
