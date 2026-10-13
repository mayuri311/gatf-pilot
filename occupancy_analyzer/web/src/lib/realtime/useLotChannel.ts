"use client";

import { useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { getBrowserSupabase } from "../supabase/browser";
import type { PassRow } from "../rpc";

export type ConnState = "connecting" | "live" | "reconnecting" | "offline";

export type LotUpdate = {
  occupancy?: number;
  band_low?: number;
  band_high?: number;
  open_sessions?: number;
  capacity?: number;
  state?: string;
  ts?: string;
  pass?: PassRow;
};
export type DeviceUpdate = { device_id: string; status?: string; camera_connected?: boolean };

type Handlers = {
  onUpdate?: (u: LotUpdate) => void;
  onDevice?: (d: DeviceUpdate) => void;
  /** Called on every SUBSCRIBED (initial and after reconnects) and on each poll tick. */
  onResync?: () => void;
};

const POLL_MS = 30_000;

/**
 * CONTRACT §4: private broadcast channel `lot:<lotId>`. setAuth() before
 * subscribing; refetch the snapshot on every SUBSCRIBED; poll every 30 s
 * regardless (device ages + derived alerts change without messages).
 */
export function useLotChannel(lotId: string, handlers: Handlers, enabled = true): ConnState {
  const [state, setState] = useState<ConnState>("connecting");
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });

  useEffect(() => {
    if (!enabled) return;
    const supabase = getBrowserSupabase();
    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    (async () => {
      try {
        await supabase.realtime.setAuth();
      } catch {
        /* falls back to anon; the private channel will then error → polling */
      }
      if (cancelled) return;
      channel = supabase
        .channel(`lot:${lotId}`, { config: { private: true } })
        .on("broadcast", { event: "update" }, (msg) => ref.current.onUpdate?.(msg.payload as LotUpdate))
        .on("broadcast", { event: "device" }, (msg) => ref.current.onDevice?.(msg.payload as DeviceUpdate))
        .subscribe((status) => {
          if (cancelled) return;
          if (status === "SUBSCRIBED") {
            setState("live");
            ref.current.onResync?.();
          } else if (status === "TIMED_OUT" || status === "CLOSED") {
            setState("reconnecting");
          } else if (status === "CHANNEL_ERROR") {
            setState("offline");
          }
        });
    })();

    // Keep the realtime token fresh when the session refreshes.
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      if (session?.access_token) supabase.realtime.setAuth(session.access_token).catch(() => {});
    });

    const poll = window.setInterval(() => {
      if (document.visibilityState === "visible") ref.current.onResync?.();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") ref.current.onResync?.();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      window.clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
      sub.subscription.unsubscribe();
      if (channel) supabase.removeChannel(channel);
    };
  }, [lotId, enabled]);

  return state;
}
