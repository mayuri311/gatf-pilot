-- Edge-system metrics on heartbeats (one Jetson running both cameras).
--
-- scripts/sysmetrics.py samples CPU/GPU/RAM/temperature/power, per-camera stream
-- bitrate, uplink throughput, SSD space and the upload/clip backlogs; each plate
-- reader's heartbeat v1 carries the latest snapshot as an optional `metrics`
-- object (additive - schema_version stays 1, and older edge builds simply send
-- no metrics). Latest value per device only: the full history stays on the
-- Jetson's SSD (gatf/metrics/*.jsonl), which keeps the Free-tier DB small.
--
-- Only change vs 20261013000300_rpc.sql: the new column, report_heartbeat storing
-- hb->'metrics' (ignored unless it's a JSON object), and engine.devices returning
-- it. Function bodies are otherwise identical; CREATE OR REPLACE keeps grants.

alter table public.device_heartbeats add column if not exists metrics jsonb;

create or replace function engine.devices(p_lot text)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'device_id', c.device_id, 'camera_id', c.camera_id, 'direction', c.direction,
    'online', h.received_at is not null
              and now() - h.received_at < make_interval(secs => engine.setting(p_lot, 'heartbeat_offline_s', 180)),
    'status', h.status, 'camera_connected', h.camera_connected, 'fps', h.fps,
    'last_seen', h.received_at, 'last_event_at', h.last_event_at_utc, 'pending_uploads', h.pending_uploads,
    'clock_offset_ms', h.clock_offset_ms, 'uptime_s', h.uptime_s, 'app_version', h.app_version,
    'message', h.message, 'metrics', h.metrics,
    'last_read_at', (select max(event_at) from public.plate_reads r where r.camera_id = c.camera_id))
    order by c.direction), '[]')
  from public.cameras c left join public.device_heartbeats h on h.device_id = c.device_id
  where c.lot_id = p_lot and c.active
$$;

-- heartbeat v1 from the edge (doc 13 §2)
create or replace function public.report_heartbeat(hb jsonb)
returns jsonb language plpgsql security definer set search_path = public, engine, extensions as $$
declare cam public.cameras; prev public.device_heartbeats; sent timestamptz;
begin
  perform engine.require_role('admin');   -- devices use the service role
  if coalesce((hb ->> 'schema_version')::int, 0) <> 1 then raise exception 'unsupported heartbeat schema_version'; end if;
  select * into cam from public.cameras where device_id = hb ->> 'device_id'
     or camera_id = hb ->> 'camera_id' order by (device_id = hb ->> 'device_id') desc limit 1;
  select * into prev from public.device_heartbeats where device_id = hb ->> 'device_id';
  sent := (hb ->> 'sent_at_utc')::timestamptz;
  insert into public.device_heartbeats (device_id, camera_id, lot_id, sent_at_utc, received_at, clock_offset_ms, status,
                                        camera_connected, fps, last_event_at_utc, pending_uploads, uptime_s, app_version, message,
                                        metrics)
  values (hb ->> 'device_id', coalesce(hb ->> 'camera_id', cam.camera_id), cam.lot_id, sent, now(),
          (extract(epoch from now() - sent) * 1000)::int, hb ->> 'status', (hb ->> 'camera_connected')::boolean,
          (hb ->> 'fps')::real, (hb ->> 'last_event_at_utc')::timestamptz, (hb ->> 'pending_uploads')::int,
          (hb ->> 'uptime_s')::bigint, hb ->> 'app_version', hb ->> 'message',
          case when jsonb_typeof(hb -> 'metrics') = 'object' then hb -> 'metrics' end)
  on conflict (device_id) do update set
    camera_id = excluded.camera_id, lot_id = excluded.lot_id, sent_at_utc = excluded.sent_at_utc,
    received_at = excluded.received_at, clock_offset_ms = excluded.clock_offset_ms, status = excluded.status,
    camera_connected = excluded.camera_connected, fps = excluded.fps, last_event_at_utc = excluded.last_event_at_utc,
    pending_uploads = excluded.pending_uploads, uptime_s = excluded.uptime_s, app_version = excluded.app_version,
    message = excluded.message, metrics = excluded.metrics;
  -- broadcast only on change (Free-tier message budget)
  if prev.device_id is null or prev.status is distinct from hb ->> 'status'
     or prev.camera_connected is distinct from (hb ->> 'camera_connected')::boolean
     or now() - prev.received_at > make_interval(secs => engine.setting(coalesce(cam.lot_id, 'gatf_main'), 'heartbeat_offline_s', 180)) then
    perform engine.safe_broadcast('lot:' || coalesce(cam.lot_id, 'gatf_main'), 'device',
      jsonb_build_object('device_id', hb ->> 'device_id', 'status', hb ->> 'status',
                         'camera_connected', (hb ->> 'camera_connected')::boolean, 'online', true));
  end if;
  return jsonb_build_object('ok', true);
end $$;

