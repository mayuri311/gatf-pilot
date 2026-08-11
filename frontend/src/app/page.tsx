import { getSupabaseClient } from "@/lib/supabase-server";

// Occupancy + events are queried fresh on every request, not cached/prerendered -
// this is a live dashboard, not a static page.
export const dynamic = "force-dynamic";

type EventRow = {
  event_id: string;
  event_type: "entry" | "exit";
  timestamp_utc: string;
  track_id: number;
  occupancy_count: number;
  vehicle_class: string;
  detection_confidence: number;
  plate_text: string | null;
  plate_confidence: number | null;
};

async function getDashboardData() {
  const supabase = getSupabaseClient();

  const { data: latest, error: latestError } = await supabase
    .from("events")
    .select("occupancy_count")
    .order("timestamp_utc", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (latestError) throw latestError;

  const { data: events, error: eventsError } = await supabase
    .from("events")
    .select(
      "event_id, event_type, timestamp_utc, track_id, occupancy_count, vehicle_class, detection_confidence, plate_text, plate_confidence"
    )
    .order("timestamp_utc", { ascending: false })
    .limit(50);

  if (eventsError) throw eventsError;

  return {
    occupancy: latest?.occupancy_count as number | undefined,
    events: (events ?? []) as EventRow[],
  };
}

export default async function Home() {
  const { occupancy, events } = await getDashboardData();

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 p-8">
      <h1 className="text-2xl font-semibold mb-6">GATF Lot Dashboard</h1>

      <div className="mb-8 inline-block rounded-lg border border-neutral-800 bg-neutral-900 p-6">
        <div className="text-sm uppercase tracking-wide text-neutral-400">
          Current Occupancy
        </div>
        <div className="mt-2 text-5xl font-bold">{occupancy ?? "—"}</div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-neutral-800">
        <table className="w-full text-sm">
          <thead className="bg-neutral-900 text-neutral-400">
            <tr>
              <th className="px-4 py-3 text-left">Time (UTC)</th>
              <th className="px-4 py-3 text-left">Type</th>
              <th className="px-4 py-3 text-left">Vehicle</th>
              <th className="px-4 py-3 text-left">Confidence</th>
              <th className="px-4 py-3 text-left">Plate</th>
              <th className="px-4 py-3 text-left">Plate Conf.</th>
              <th className="px-4 py-3 text-left">Occupancy</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.event_id} className="border-t border-neutral-800">
                <td className="whitespace-nowrap px-4 py-3">
                  {new Date(e.timestamp_utc).toLocaleString()}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={
                      e.event_type === "entry"
                        ? "text-green-400"
                        : "text-red-400"
                    }
                  >
                    {e.event_type}
                  </span>
                </td>
                <td className="px-4 py-3">
                  {e.vehicle_class} <span className="text-neutral-500">#{e.track_id}</span>
                </td>
                <td className="px-4 py-3">{e.detection_confidence.toFixed(2)}</td>
                <td className="px-4 py-3">{e.plate_text ?? "—"}</td>
                <td className="px-4 py-3">
                  {e.plate_confidence != null ? e.plate_confidence.toFixed(2) : "—"}
                </td>
                <td className="px-4 py-3">{e.occupancy_count}</td>
              </tr>
            ))}
            {events.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-neutral-500">
                  No events yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
