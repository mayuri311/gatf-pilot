-- occupancy_analyzer — RPC API for the web (docs/CONTRACT.md §3)
-- Every public function is SECURITY DEFINER + role-checked; tables stay RLS-locked.

-- ---------------------------------------------------------------------------
-- Auth helpers
-- ---------------------------------------------------------------------------
create or replace function engine.current_role_name()
returns text language sql stable as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role',
                  case when auth.role() = 'service_role' or current_user in ('postgres', 'service_role')
                       then 'service' end)
$$;

create or replace function engine.require_role(p_min text)
returns void language plpgsql stable as $$
declare r text := engine.current_role_name();
begin
  if r = 'service' or r = 'admin' then return; end if;
  if p_min = 'staff' and r = 'staff' then return; end if;
  raise exception 'permission denied: requires % role', p_min using errcode = '42501';
end $$;

create or replace function engine.audit(p_action text, p_target text, p_detail jsonb default null)
returns void language sql as $$
  insert into public.audit_log (actor, actor_email, action, target, detail)
  values (auth.uid(), auth.jwt() ->> 'email', p_action, p_target, p_detail)
$$;

-- ---------------------------------------------------------------------------
-- Row builders (CONTRACT §3.2)
-- ---------------------------------------------------------------------------
create or replace function engine.lot_tz(p_lot text)
returns text language sql stable as $$
  select coalesce((select timezone from public.lots where lot_id = p_lot), 'America/New_York')
$$;

-- crosses a 03:00-local boundary => present overnight (D20)
create or replace function engine.is_overnight(p_from timestamptz, p_to timestamptz, p_tz text)
returns boolean language sql stable as $$
  select p_from is not null and
         date_trunc('day', (coalesce(p_to, now()) at time zone p_tz) - interval '3 hours')
       > date_trunc('day', (p_from at time zone p_tz) - interval '3 hours')
$$;

create or replace function engine.session_json(s public.parking_sessions)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'session_id', s.session_id, 'plate_norm', s.plate_norm,
    'entry_at', s.entry_at, 'exit_at', s.exit_at,
    'dwell_min', case when s.entry_at is null then null
                      else round(extract(epoch from (coalesce(s.exit_at, case when s.status = 'open' then now() end) - s.entry_at)) / 60)::int end,
    'status', s.status, 'match_method', s.match_method,
    'match_score', round(s.match_score::numeric, 3), 'closed_reason', s.closed_reason, 'is_bounce', s.is_bounce,
    'suspect_stale', s.status = 'open' and now() - s.entry_at > interval '24 hours',
    'multi_day', s.entry_at is not null and coalesce(s.exit_at, case when s.status = 'open' then now() end) - s.entry_at > interval '24 hours',
    'overnight', engine.is_overnight(s.entry_at, coalesce(s.exit_at, case when s.status = 'open' then now() end), engine.lot_tz(s.lot_id)),
    'entry_read_id', ep.primary_read_id, 'exit_read_id', xp.primary_read_id,
    'entry_image', er.image_path, 'exit_image', xr.image_path,
    'entry_confidence', ep.plate_confidence, 'exit_confidence', xp.plate_confidence,
    'exit_plate', xp.plate_norm)
  from (select 1) d
  left join public.passes ep on ep.pass_id = s.entry_pass_id
  left join public.passes xp on xp.pass_id = s.exit_pass_id
  left join public.plate_reads er on er.read_id = ep.primary_read_id
  left join public.plate_reads xr on xr.read_id = xp.primary_read_id
$$;

create or replace function engine.read_json(r public.plate_reads, p_with_reads boolean default false)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'read_id', r.read_id, 'camera_id', r.camera_id, 'direction', r.direction, 'event_at', r.event_at,
    'plate_norm', r.plate_norm, 'plate_raw', r.plate_raw, 'plate_confidence', r.plate_confidence,
    'plate_confidence_per_char', to_jsonb(r.char_conf), 'quality', r.quality,
    'alternates', r.plate_alternates, 'image_path', case when r.image_deleted_at is null then r.image_path end,
    'pass_id', r.pass_id, 'corrected', r.corrected_plate is not null,
    'num_frames_used', r.num_frames_used)
  || case when p_with_reads then jsonb_build_object(
       'reads', (select e.reads from public.events e where e.event_id = r.read_id),
       'track', (select jsonb_build_object('frame_first', e.frame_first, 'frame_last', e.frame_last,
                                           'num_frames_tracked', e.num_frames_tracked, 'device_id', e.device_id,
                                           'timestamp_utc', e.timestamp_utc, 'bbox', e.plate_bounding_box,
                                           'detection_confidence', e.plate_detection_confidence)
                   from public.events e where e.event_id = r.read_id))
     else '{}'::jsonb end
$$;

create or replace function engine.pass_json(p public.passes)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'pass_id', p.pass_id, 'direction', p.direction, 'event_at', p.event_at, 'plate_norm', p.plate_norm,
    'plate_confidence', p.plate_confidence, 'quality', p.quality, 'read_id', p.primary_read_id,
    'image_path', r.image_path, 'read_count', p.read_count,
    'session_id', s.session_id, 'match_method', s.match_method, 'status', s.status,
    'dwell_min', case when p.direction = 'out' and s.entry_at is not null
                      then round(extract(epoch from (p.event_at - s.entry_at)) / 60)::int end)
  from (select 1) d
  left join public.plate_reads r on r.read_id = p.primary_read_id
  left join lateral (select * from public.parking_sessions x
                      where (p.direction = 'in' and x.entry_pass_id = p.pass_id)
                         or (p.direction = 'out' and x.exit_pass_id = p.pass_id) limit 1) s on true
$$;

-- occupancy at an instant (last step at or before t)
create or replace function engine.timeline_at(p_lot text, p_at timestamptz)
returns public.occupancy_timeline language sql stable as $$
  select * from public.occupancy_timeline where lot_id = p_lot and valid_from <= p_at
   order by valid_from desc, seq desc limit 1
$$;

-- time-weighted stats of the occupancy step function over [a, b)
create or replace function engine.occ_window(p_lot text, p_a timestamptz, p_b timestamptz, p_threshold int default null)
returns table (occ_avg real, occ_max int, occ_min int, band_low int, band_high int, secs_above real, peak_at timestamptz)
language sql stable as $$
  with b as (select p_a a, least(p_b, now()) z),
  seg as (
    select s.valid_from, s.occupancy, s.band_low, s.band_high,
           greatest(s.valid_from, b.a) sf,
           least(coalesce(lead(s.valid_from) over (order by s.valid_from, s.seq), b.z), b.z) st
      from b cross join lateral (
        select * from (select * from public.occupancy_timeline t
                        where t.lot_id = p_lot and t.valid_from <= b.a order by t.valid_from desc, t.seq desc limit 1) i
        union all
        select * from public.occupancy_timeline t where t.lot_id = p_lot and t.valid_from > b.a and t.valid_from < b.z
      ) s
  ), w as (select *, greatest(extract(epoch from st - sf), 0) secs from seg where st > sf)
  select (sum(occupancy * secs) / nullif(sum(secs), 0))::real,
         max(occupancy), min(occupancy), min(band_low), max(band_high),
         coalesce(sum(secs) filter (where p_threshold is not null and occupancy >= p_threshold), 0)::real,
         (array_agg(sf order by occupancy desc, sf))[1]
    from w
$$;

-- ---------------------------------------------------------------------------
-- Devices & alerts (derived live — no cron needed)
-- ---------------------------------------------------------------------------
create or replace function engine.devices(p_lot text)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'device_id', c.device_id, 'camera_id', c.camera_id, 'direction', c.direction,
    'online', h.received_at is not null
              and now() - h.received_at < make_interval(secs => engine.setting(p_lot, 'heartbeat_offline_s', 180)),
    'status', h.status, 'camera_connected', h.camera_connected, 'fps', h.fps,
    'last_seen', h.received_at, 'last_event_at', h.last_event_at_utc, 'pending_uploads', h.pending_uploads,
    'clock_offset_ms', h.clock_offset_ms, 'uptime_s', h.uptime_s, 'app_version', h.app_version,
    'message', h.message,
    'last_read_at', (select max(event_at) from public.plate_reads r where r.camera_id = c.camera_id))
    order by c.direction), '[]')
  from public.cameras c left join public.device_heartbeats h on h.device_id = c.device_id
  where c.lot_id = p_lot and c.active
$$;

create or replace function engine.alerts(p_lot text)
returns jsonb language plpgsql stable as $$
declare
  out jsonb := '[]'; d jsonb; tl public.occupancy_timeline; cap int := engine.capacity_at(p_lot, now());
  eff real := engine.setting(p_lot, 'effective_pct', 0.85); n int; oldest timestamptz; sz bigint;
  rec record; since timestamptz; key text;
begin
  for d in select * from jsonb_array_elements(engine.devices(p_lot)) loop
    if not (d ->> 'online')::boolean then
      since := (d ->> 'last_seen')::timestamptz;
      out := out || jsonb_build_object('key', 'device_offline:' || (d ->> 'device_id') || ':' || coalesce(extract(epoch from since)::bigint::text, 'never'),
        'severity', 'critical', 'title', initcap(d ->> 'direction') || 'bound camera offline',
        'detail', coalesce('No heartbeat from ' || (d ->> 'device_id') || ' since ' || to_char(since at time zone engine.lot_tz(p_lot), 'Mon DD HH24:MI'),
                           'No heartbeat ever received from ' || (d ->> 'device_id')),
        'since', since);
    elsif coalesce(d ->> 'status', 'ok') <> 'ok' or not coalesce((d ->> 'camera_connected')::boolean, true) then
      since := (d ->> 'last_seen')::timestamptz;
      out := out || jsonb_build_object('key', 'device_degraded:' || (d ->> 'device_id') || ':' || to_char(since, 'YYYYMMDDHH24'),
        'severity', 'warning', 'title', initcap(d ->> 'direction') || 'bound camera ' || coalesce(d ->> 'status', 'degraded'),
        'detail', coalesce(d ->> 'message', 'camera_connected=' || coalesce(d ->> 'camera_connected', '?')), 'since', since);
    end if;
  end loop;

  tl := engine.timeline_at(p_lot, now());
  if tl.lot_id is not null then
    if tl.occupancy >= cap * 0.98 then
      out := out || jsonb_build_object('key', 'lot_full:' || to_char(tl.valid_from, 'YYYYMMDD'), 'severity', 'warning',
        'title', 'Lot full', 'detail', tl.occupancy || ' of ' || cap || ' spaces occupied', 'since', tl.valid_from);
    elsif tl.occupancy >= cap * eff then
      out := out || jsonb_build_object('key', 'lot_near_full:' || to_char(tl.valid_from, 'YYYYMMDD'), 'severity', 'info',
        'title', 'Lot effectively full', 'detail', round(100.0 * tl.occupancy / cap) || '% occupied', 'since', tl.valid_from);
    end if;
    if (tl.band_high - tl.band_low) / 2.0 > cap * 0.02 or abs(tl.open_sessions - tl.raw_occupancy) > 3
       or exists (select 1 from public.parking_sessions where lot_id = p_lot and status = 'open'
                     and entry_at < now() - interval '24 hours') then
      since := coalesce((select max(at) from public.occupancy_calibrations where lot_id = p_lot), tl.valid_from);
      out := out || jsonb_build_object('key', 'reconcile:' || extract(epoch from since)::bigint, 'severity', 'warning',
        'title', 'Reconcile recommended', 'detail', 'Count the cars and enter the number to clear drift', 'since', since);
    end if;
  end if;

  select count(*), min(exit_at) into n, oldest from public.parking_sessions
   where lot_id = p_lot and (status = 'pending_review' or (status = 'orphan_exit' and exit_at > now() - interval '7 days'));
  if n > 20 or oldest < now() - interval '24 hours' then
    out := out || jsonb_build_object('key', 'review_backlog:' || to_char(now(), 'YYYYMMDD'), 'severity', 'info',
      'title', 'Review queue needs attention', 'detail', n || ' item(s) waiting', 'since', oldest);
  end if;

  for rec in select kind, count(*) c, min(at) first_at from public.ingest_errors
              where at > now() - interval '24 hours' and kind <> 'clock_skew' group by kind loop
    out := out || jsonb_build_object('key', 'ingest:' || rec.kind || ':' || to_char(rec.first_at, 'YYYYMMDD'),
      'severity', case when rec.kind = 'engine_error' then 'warning' else 'critical' end,
      'title', case rec.kind when 'unknown_camera' then 'Events from an unknown camera'
                             when 'bad_schema_version' then 'Events with unsupported schema'
                             else 'Processing errors' end,
      'detail', rec.c || ' event(s) quarantined in the last 24 h', 'since', rec.first_at);
  end loop;

  sz := pg_database_size(current_database());
  if sz > 524288000 * 0.7 then
    out := out || jsonb_build_object('key', 'db_size:' || to_char(now(), 'YYYYMM'), 'severity', 'warning',
      'title', 'Database near Free-tier limit', 'detail', round(sz / 1048576.0) || ' MB of 500 MB', 'since', now());
  end if;

  return coalesce((select jsonb_agg(a || jsonb_build_object('acked', exists (
            select 1 from public.alert_acks k where k.alert_key = a ->> 'key')))
            from jsonb_array_elements(out) a), '[]');
end $$;

-- ---------------------------------------------------------------------------
-- Public RPCs
-- ---------------------------------------------------------------------------
create or replace function public.get_devices(p_lot text default 'gatf_main')
returns jsonb language plpgsql stable security definer set search_path = public, engine, extensions as $$
begin perform engine.require_role('staff'); return engine.devices(p_lot); end $$;

create or replace function public.get_alerts(p_lot text default 'gatf_main')
returns jsonb language plpgsql stable security definer set search_path = public, engine, extensions as $$
begin perform engine.require_role('staff'); return engine.alerts(p_lot); end $$;

create or replace function public.ack_alert(p_key text)
returns jsonb language plpgsql security definer set search_path = public, engine, extensions as $$
begin
  perform engine.require_role('admin');
  insert into public.alert_acks (alert_key, acked_by) values (p_key, auth.jwt() ->> 'email')
  on conflict (alert_key) do update set acked_by = excluded.acked_by, acked_at = now();
  perform engine.audit('ack_alert', p_key);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.get_live_snapshot(p_lot text default 'gatf_main')
returns jsonb language plpgsql stable security definer set search_path = public, engine, extensions as $$
declare
  l public.lots; tl public.occupancy_timeline; cap int; eff real; tz text; day0 timestamptz;
  reasons text[] := '{}'; n_stale int; res jsonb;
begin
  perform engine.require_role('staff');
  select * into l from public.lots where lot_id = p_lot;
  if not found then raise exception 'unknown lot %', p_lot; end if;
  cap := engine.capacity_at(p_lot, now()); eff := engine.setting(p_lot, 'effective_pct', 0.85); tz := l.timezone;
  day0 := date_trunc('day', now() at time zone tz) at time zone tz;
  tl := engine.timeline_at(p_lot, now());

  select count(*) into n_stale from public.parking_sessions
   where lot_id = p_lot and status = 'open' and entry_at < now() - interval '24 hours';
  if tl.lot_id is not null and (tl.band_high - tl.band_low) / 2.0 > cap * 0.02 then
    reasons := reasons || format('band ±%s > 2%% of capacity', ceil((tl.band_high - tl.band_low) / 2.0));
  end if;
  if tl.lot_id is not null and abs(tl.open_sessions - tl.raw_occupancy) > 3 then
    reasons := reasons || format('%s open sessions vs estimate %s', tl.open_sessions, tl.raw_occupancy);
  end if;
  if n_stale > 0 then reasons := reasons || format('%s vehicle(s) here > 24 h', n_stale); end if;

  res := jsonb_build_object(
    'lot', jsonb_build_object('lot_id', l.lot_id, 'name', l.name, 'capacity', cap, 'timezone', tz, 'effective_pct', eff),
    'occupancy', coalesce(tl.occupancy, 0), 'band_low', coalesce(tl.band_low, 0), 'band_high', coalesce(tl.band_high, 0),
    'open_sessions', coalesce(tl.open_sessions, 0),
    'pct', round(coalesce(tl.occupancy, 0)::numeric / cap, 4),
    'state', engine.occupancy_state(coalesce(tl.occupancy, 0), cap, eff),
    'updated_at', tl.valid_from,
    'last_in_at', (select max(event_at) from public.passes where lot_id = p_lot and direction = 'in'),
    'last_out_at', (select max(event_at) from public.passes where lot_id = p_lot and direction = 'out'),
    'last_reconciled_at', (select max(at) from public.occupancy_calibrations where lot_id = p_lot),
    'reconcile_recommended', cardinality(reasons) > 0, 'reconcile_reasons', to_jsonb(reasons),
    'today', jsonb_build_object(
      'entries', (select count(*) from public.passes where lot_id = p_lot and direction = 'in' and event_at >= day0),
      'exits', (select count(*) from public.passes where lot_id = p_lot and direction = 'out' and event_at >= day0),
      'bounces', (select count(*) from public.parking_sessions where lot_id = p_lot and is_bounce and exit_at >= day0),
      'avg_dwell_min', (select round(avg(extract(epoch from exit_at - entry_at)) / 60)::int from public.parking_sessions
                         where lot_id = p_lot and status = 'closed' and not is_bounce and exit_at >= day0),
      'overnight', (select count(*) from public.parking_sessions s where lot_id = p_lot and s.entry_at is not null
                      and s.entry_at < day0 + interval '3 hours'
                      and coalesce(s.exit_at, case when s.status = 'open' then now() end) > day0 + interval '3 hours'),
      'multi_day', n_stale,
      'unique_vehicles', (select count(distinct plate_norm) from public.passes
                           where lot_id = p_lot and direction = 'in' and event_at >= day0)),
    'devices', engine.devices(p_lot),
    'recent_passes', coalesce((select jsonb_agg(engine.pass_json(p) order by p.event_at desc)
                                 from (select * from public.passes where lot_id = p_lot
                                        order by event_at desc limit 25) p), '[]'),
    'in_lot', coalesce((select jsonb_agg(engine.session_json(s) order by s.entry_at)
                          from (select * from public.parking_sessions where lot_id = p_lot and status = 'open'
                                 order by entry_at limit 200) s), '[]'),
    'alerts', engine.alerts(p_lot));
  return res;
end $$;

create or replace function public.get_occupancy_series(
  p_lot text, p_from timestamptz, p_to timestamptz, p_bucket_minutes int default 15)
returns jsonb language plpgsql stable security definer set search_path = public, engine, extensions as $$
declare bucket interval := make_interval(mins => greatest(p_bucket_minutes, 1));
begin
  perform engine.require_role('staff');
  return coalesce((
    select jsonb_agg(jsonb_build_object('ts', g, 'occ_avg', round(w.occ_avg::numeric, 2), 'occ_max', w.occ_max,
                                        'occ_min', w.occ_min, 'band_low', w.band_low, 'band_high', w.band_high,
                                        'capacity', engine.capacity_at(p_lot, g)) order by g)
      from generate_series(date_bin(bucket, p_from, '2000-01-01'), least(p_to, now()), bucket) g
      cross join lateral engine.occ_window(p_lot, g, g + bucket) w), '[]');
end $$;

create or replace function public.get_typical_day(p_lot text, p_dow int, p_weeks int default 8)
returns jsonb language plpgsql stable security definer set search_path = public, engine, extensions as $$
declare tz text := engine.lot_tz(p_lot);
begin
  perform engine.require_role('staff');
  return coalesce((
    with days as (
      select d::date as day from generate_series((now() at time zone tz)::date - p_weeks * 7,
                                              (now() at time zone tz)::date - 1, interval '1 day') d
       where extract(dow from d) = p_dow
    ), samples as (
      select s.slot, (select occupancy from engine.timeline_at(p_lot, ((dd.day + s.slot * interval '15 minutes') at time zone tz))) v
        from days dd cross join generate_series(0, 95) s(slot)
       where exists (select 1 from public.occupancy_timeline t where t.lot_id = p_lot
                      and t.valid_from <= ((dd.day + s.slot * interval '15 minutes') at time zone tz))
    )
    , agg as (
      select slot, percentile_cont(0.1) within group (order by v) p10,
             percentile_cont(0.5) within group (order by v) p50,
             percentile_cont(0.9) within group (order by v) p90, count(*) n
        from samples where v is not null group by slot)
    select jsonb_agg(jsonb_build_object('slot', to_char(make_time(slot / 4, (slot % 4) * 15, 0), 'HH24:MI'),
                                        'p10', round(p10::numeric, 1), 'p50', round(p50::numeric, 1),
                                        'p90', round(p90::numeric, 1), 'days', n) order by slot)
      from agg), '[]');
end $$;

create or replace function public.get_flow_series(
  p_lot text, p_from timestamptz, p_to timestamptz, p_bucket_minutes int default 60)
returns jsonb language plpgsql stable security definer set search_path = public, engine, extensions as $$
declare bucket interval := make_interval(mins => greatest(p_bucket_minutes, 1));
begin
  perform engine.require_role('staff');
  return coalesce((
    select jsonb_agg(jsonb_build_object('ts', g,
             'arrivals', (select count(*) from public.passes where lot_id = p_lot and direction = 'in' and event_at >= g and event_at < g + bucket),
             'departures', (select count(*) from public.passes where lot_id = p_lot and direction = 'out' and event_at >= g and event_at < g + bucket),
             'bounces', (select count(*) from public.parking_sessions where lot_id = p_lot and is_bounce and exit_at >= g and exit_at < g + bucket))
             || jsonb_build_object('net',
                 (select count(*) filter (where direction = 'in') - count(*) filter (where direction = 'out')
                    from public.passes where lot_id = p_lot and event_at >= g and event_at < g + bucket))
           order by g)
      from generate_series(date_bin(bucket, p_from, '2000-01-01'), least(p_to, now()), bucket) g), '[]');
end $$;

create or replace function public.get_heatmap(p_lot text, p_from timestamptz, p_to timestamptz, p_metric text default 'occupancy')
returns jsonb language plpgsql stable security definer set search_path = public, engine, extensions as $$
declare tz text := engine.lot_tz(p_lot); cap int := engine.capacity_at(p_lot, now());
begin
  perform engine.require_role('staff');
  if p_metric = 'arrivals' then
    return coalesce((
      with c as (
        select extract(dow from event_at at time zone tz)::int dow, extract(hour from event_at at time zone tz)::int hr,
               (event_at at time zone tz)::date d, count(*) n
          from public.passes where lot_id = p_lot and direction = 'in' and event_at >= p_from and event_at < p_to
         group by 1, 2, 3)
      select jsonb_agg(jsonb_build_object('dow', dow, 'hour', hr, 'value', v))
        from (select dow, hr, round(avg(n), 2) v from c group by dow, hr) x), '[]');
  end if;
  return coalesce((
    with s as (
      select g, (select occupancy from engine.timeline_at(p_lot, g)) v
        from generate_series(date_trunc('hour', p_from) + interval '30 minutes', least(p_to, now()), interval '1 hour') g)
    select jsonb_agg(jsonb_build_object('dow', dow, 'hour', hr, 'value', v, 'pct', round(v / cap, 4)))
      from (select extract(dow from g at time zone tz)::int dow, extract(hour from g at time zone tz)::int hr,
                   round(avg(v), 2) v
              from s where v is not null group by 1, 2) x), '[]');
end $$;

create or replace function engine.kpis_raw(p_lot text, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable as $$
declare
  cap int := engine.capacity_at(p_lot, p_to); eff real := engine.setting(p_lot, 'effective_pct', 0.85);
  w record; days real := greatest(extract(epoch from least(p_to, now()) - p_from) / 86400.0, 1.0 / 24);
  ent int; ex int; bnc int; matched int;
begin
  select * into w from engine.occ_window(p_lot, p_from, p_to, ceil(cap * eff)::int);
  select count(*) filter (where direction = 'in'), count(*) filter (where direction = 'out') into ent, ex
    from public.passes where lot_id = p_lot and event_at >= p_from and event_at < p_to;
  select count(*) into bnc from public.parking_sessions where lot_id = p_lot and is_bounce and exit_at >= p_from and exit_at < p_to;
  select count(*) into matched from public.parking_sessions
   where lot_id = p_lot and exit_at >= p_from and exit_at < p_to and status in ('closed', 'pending_review');
  return jsonb_build_object(
    'entries', ent, 'exits', ex, 'bounces', bnc, 'bounce_rate', round(bnc::numeric / nullif(ent, 0), 4),
    'unique_vehicles', (select count(distinct plate_norm) from public.passes
                         where lot_id = p_lot and direction = 'in' and event_at >= p_from and event_at < p_to),
    'avg_dwell_min', (select round(avg(extract(epoch from exit_at - entry_at)) / 60)::int from public.parking_sessions
                       where lot_id = p_lot and status = 'closed' and not is_bounce and exit_at >= p_from and exit_at < p_to),
    'median_dwell_min', (select round(percentile_cont(0.5) within group (order by extract(epoch from exit_at - entry_at)) / 60)::int
                          from public.parking_sessions
                         where lot_id = p_lot and status = 'closed' and not is_bounce and exit_at >= p_from and exit_at < p_to),
    'turnover', round((ent::numeric / cap) / days::numeric, 2),
    'peak_occ', w.occ_max, 'peak_pct', round(w.occ_max::numeric / cap, 4), 'peak_at', w.peak_at,
    'utilization', round((w.occ_avg / cap)::numeric, 4),
    'hours_effectively_full', round((w.secs_above / 3600.0)::numeric, 2),
    'overnight', (select count(*) from public.parking_sessions s where lot_id = p_lot
                   and engine.is_overnight(s.entry_at, coalesce(s.exit_at, case when s.status = 'open' then now() end), engine.lot_tz(p_lot))
                   and s.entry_at < p_to and coalesce(s.exit_at, now()) >= p_from),
    'match_rate', round(matched::numeric / nullif(ex, 0), 4));
end $$;

create or replace function public.get_kpis(p_lot text, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = public, engine, extensions as $$
declare len interval := p_to - p_from;
begin
  perform engine.require_role('staff');
  return engine.kpis_raw(p_lot, p_from, p_to)
      || jsonb_build_object('prev', engine.kpis_raw(p_lot, p_from - len, p_from));
end $$;

create or replace function public.get_daily_stats(p_lot text, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = public, engine, extensions as $$
declare tz text := engine.lot_tz(p_lot); eff real := engine.setting(p_lot, 'effective_pct', 0.85);
begin
  perform engine.require_role('staff');
  return coalesce((
    with days as (
      select d::date as day, (d::date::timestamp at time zone tz) a, ((d::date + 1)::timestamp at time zone tz) z
        from generate_series((p_from at time zone tz)::date, (least(p_to, now()) at time zone tz)::date, interval '1 day') d)
    select jsonb_agg(jsonb_build_object(
      'day', to_char(days.day, 'YYYY-MM-DD'),
      'peak_occ', w.occ_max, 'peak_pct', round(w.occ_max::numeric / engine.capacity_at(p_lot, days.a), 4), 'peak_at', w.peak_at,
      'avg_occ', round(w.occ_avg::numeric, 1),
      'entries', (select count(*) from public.passes where lot_id = p_lot and direction = 'in' and event_at >= days.a and event_at < days.z),
      'exits', (select count(*) from public.passes where lot_id = p_lot and direction = 'out' and event_at >= days.a and event_at < days.z),
      'bounces', (select count(*) from public.parking_sessions where lot_id = p_lot and is_bounce and exit_at >= days.a and exit_at < days.z),
      'overnight', (select count(*) from public.parking_sessions s where lot_id = p_lot and s.entry_at < days.a + interval '3 hours'
                      and coalesce(s.exit_at, case when s.status = 'open' then now() end) > days.a + interval '3 hours'),
      'unique_vehicles', (select count(distinct plate_norm) from public.passes where lot_id = p_lot and direction = 'in'
                           and event_at >= days.a and event_at < days.z),
      'avg_dwell_min', d.avg_m, 'median_dwell_min', d.med_m, 'p90_dwell_min', d.p90_m,
      'hours_effectively_full', round((w.secs_above / 3600.0)::numeric, 2)) order by days.day)
    from days
    cross join lateral engine.occ_window(p_lot, days.a, days.z, ceil(engine.capacity_at(p_lot, days.a) * eff)::int) w
    cross join lateral (
      select round(avg(m))::int avg_m, round(percentile_cont(0.5) within group (order by m))::int med_m,
             round(percentile_cont(0.9) within group (order by m))::int p90_m
        from (select extract(epoch from exit_at - entry_at) / 60 m from public.parking_sessions
               where lot_id = p_lot and status = 'closed' and not is_bounce and exit_at >= days.a and exit_at < days.z) q) d
  ), '[]');
end $$;

create or replace function public.get_dwell_distribution(p_lot text, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = public, engine, extensions as $$
begin
  perform engine.require_role('staff');
  return (
    with m as (select extract(epoch from exit_at - entry_at) / 60 v from public.parking_sessions
                where lot_id = p_lot and status = 'closed' and exit_at >= p_from and exit_at < p_to),
    b as (select * from (values (1, '<15m', 0, 15), (2, '15–60m', 15, 60), (3, '1–2h', 60, 120), (4, '2–4h', 120, 240),
                                (5, '4–8h', 240, 480), (6, '8h+', 480, 1e9)) x(o, label, lo, hi))
    select jsonb_build_object(
      'buckets', (select jsonb_agg(jsonb_build_object('label', label, 'count',
                    (select count(*) from m where v >= lo and v < hi)) order by o) from b),
      'median_min', (select round(percentile_cont(0.5) within group (order by v)) from m),
      'p90_min', (select round(percentile_cont(0.9) within group (order by v)) from m),
      'avg_min', (select round(avg(v)) from m),
      'total', (select count(*) from m)));
end $$;

create or replace function public.list_sessions(
  p_lot text, p_from timestamptz, p_to timestamptz, p_status text[] default null, p_plate text default null,
  p_flags text[] default null, p_limit int default 50, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = public, engine, extensions as $$
declare q text := nullif(engine.plate_norm(p_plate), ''); tz text := engine.lot_tz(p_lot);
begin
  perform engine.require_role('staff');
  return (
    with f as (
      select s.* from public.parking_sessions s
       where s.lot_id = p_lot
         and coalesce(s.entry_at, s.exit_at) <= p_to
         and coalesce(s.exit_at, case when s.status = 'open' then now() end, s.entry_at) >= p_from
         and (p_status is null or s.status = any (p_status))
         and (q is null or s.plate_norm like '%' || q || '%')
         and (p_flags is null or (
               ('bounce' <> all (p_flags) or s.is_bounce)
           and ('review' <> all (p_flags) or s.status in ('pending_review', 'orphan_exit'))
           and ('suspect_stale' <> all (p_flags) or (s.status = 'open' and s.entry_at < now() - interval '24 hours'))
           and ('multi_day' <> all (p_flags) or coalesce(s.exit_at, now()) - s.entry_at > interval '24 hours')
           and ('overnight' <> all (p_flags) or engine.is_overnight(s.entry_at, coalesce(s.exit_at, case when s.status = 'open' then now() end), tz))))
    )
    select jsonb_build_object('total', (select count(*) from f),
      'rows', coalesce((select jsonb_agg(engine.session_json(x) order by coalesce(x.entry_at, x.exit_at) desc)
                          from (select * from f order by coalesce(entry_at, exit_at) desc limit p_limit offset p_offset) x), '[]')));
end $$;

create or replace function public.list_reads(
  p_lot text, p_from timestamptz, p_to timestamptz, p_camera text default null, p_plate text default null,
  p_quality text default null, p_limit int default 50, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = public, engine, extensions as $$
declare q text := nullif(engine.plate_norm(p_plate), '');
begin
  perform engine.require_role('staff');
  return (
    with f as (select * from public.plate_reads r
                where r.lot_id = p_lot and r.event_at >= p_from and r.event_at <= p_to
                  and (p_camera is null or r.camera_id = p_camera)
                  and (p_quality is null or r.quality = p_quality)
                  and (q is null or r.plate_norm like '%' || q || '%'))
    select jsonb_build_object('total', (select count(*) from f),
      'rows', coalesce((select jsonb_agg(engine.read_json(x) order by x.event_at desc)
                          from (select * from f order by event_at desc limit p_limit offset p_offset) x), '[]')));
end $$;

create or replace function public.search_plates(p_q text)
returns jsonb language plpgsql security definer set search_path = public, engine, extensions as $$
declare q text := engine.plate_norm(p_q); res jsonb;
begin
  perform engine.require_role('staff');
  if length(q) < 2 then return jsonb_build_object('exact', '[]'::jsonb, 'similar', '[]'::jsonb); end if;
  with agg as (
    select plate_norm, max(coalesce(exit_at, entry_at)) last_seen, count(*) filter (where entry_at is not null) visits
      from public.parking_sessions group by plate_norm)
  select jsonb_build_object(
    'exact', coalesce((select jsonb_agg(jsonb_build_object('plate_norm', plate_norm, 'last_seen', last_seen, 'visits', visits))
                         from agg where plate_norm = q), '[]'),
    'similar', coalesce((select jsonb_agg(x order by (x ->> 'similarity')::real desc) from (
        select jsonb_build_object('plate_norm', plate_norm, 'last_seen', last_seen, 'visits', visits,
                                  'similarity', round(engine.plate_similarity(q, plate_norm)::numeric, 3)) x
          from agg
         where plate_norm <> q and (plate_norm like '%' || q || '%' or extensions.similarity(plate_norm, q) > 0.2
                                    or engine.plate_key(plate_norm) = engine.plate_key(q))
         order by engine.plate_similarity(q, plate_norm) desc limit 20) s), '[]'))
    into res;
  perform engine.audit('plate_search', q);
  return res;
end $$;

create or replace function public.get_vehicle_profile(p_plate text)
returns jsonb language plpgsql security definer set search_path = public, engine, extensions as $$
declare q text := engine.plate_norm(p_plate); res jsonb; tz text := 'America/New_York';
begin
  perform engine.require_role('staff');
  select jsonb_build_object(
    'plate_norm', q,
    'first_seen', min(coalesce(entry_at, exit_at)), 'last_seen', max(coalesce(exit_at, entry_at)),
    'visits', count(*) filter (where entry_at is not null),
    'avg_dwell_min', round(avg(extract(epoch from exit_at - entry_at) / 60) filter (where status = 'closed'))::int,
    'usual_arrival_hour', mode() within group (order by extract(hour from entry_at at time zone tz)),
    'overnight_count', count(*) filter (where engine.is_overnight(entry_at, coalesce(exit_at, case when status = 'open' then now() end), tz)),
    'aliases', coalesce((select jsonb_agg(distinct a ->> 'text')
                           from public.parking_sessions s2 join public.passes p on p.pass_id in (s2.entry_pass_id, s2.exit_pass_id)
                           cross join jsonb_array_elements(p.plate_alternates) a
                          where s2.plate_norm = q and a ->> 'text' <> q), '[]'),
    'sessions', coalesce((select jsonb_agg(engine.session_json(s3) order by coalesce(s3.entry_at, s3.exit_at) desc)
                            from public.parking_sessions s3 where s3.plate_norm = q), '[]'))
    into res
    from public.parking_sessions where plate_norm = q;
  perform engine.audit('vehicle_profile', q);
  return res;
end $$;

-- candidates an exit could belong to (sessions open at that moment), best first.
-- Cheap C-level prefilter on the confusion-collapsed key first (same as the engine), then the
-- plpgsql matcher once per survivor — the unfiltered version took ~0.5 s per exit on 2 weeks of data.
create or replace function engine.exit_candidates(p_exit public.passes, p_limit int default 3)
returns jsonb language sql stable as $$
  with pool as (
    select s.session_id, s.entry_pass_id, s.plate_norm, s.entry_at, s.status, ep.plate_norm ep_plate,
           ep.char_conf, ep.plate_alternates, ep.primary_read_id
      from public.parking_sessions s
      join public.passes ep on ep.pass_id = s.entry_pass_id
     where s.lot_id = p_exit.lot_id and s.entry_at < p_exit.event_at
       and (s.status = 'open' or s.closed_at >= p_exit.event_at)
       and extensions.levenshtein(left(engine.plate_key(s.plate_norm), 255),
                                  left(engine.plate_key(p_exit.plate_norm), 255)) <= 3
  ), scored as (
    select pool.*, engine.match_score(ep_plate, char_conf, plate_alternates,
                                      p_exit.plate_norm, p_exit.char_conf, p_exit.plate_alternates) score
      from pool
  )
  select coalesce(jsonb_agg(jsonb_build_object('session_id', x.session_id, 'entry_pass_id', x.entry_pass_id,
                     'plate_norm', x.plate_norm, 'entry_at', x.entry_at, 'status', x.status,
                     'score', round(x.score::numeric, 3), 'read', engine.read_json(r)) order by x.score desc), '[]')
    from (select * from scored order by score desc limit p_limit) x
    join public.plate_reads r on r.read_id = x.primary_read_id
$$;

-- badge count for the app shell (cheap: no candidate scoring)
create or replace function public.get_review_count(p_lot text default 'gatf_main')
returns int language plpgsql stable security definer set search_path = public, engine, extensions as $$
begin
  perform engine.require_role('staff');
  return (select count(*)::int from public.parking_sessions
           where lot_id = p_lot
             and (status = 'pending_review' or (status = 'orphan_exit' and exit_at > now() - interval '14 days')));
end $$;

create or replace function public.get_session(p_session uuid)
returns jsonb language plpgsql stable security definer set search_path = public, engine, extensions as $$
declare s public.parking_sessions; ep public.passes; xp public.passes; res jsonb;
begin
  perform engine.require_role('staff');
  select * into s from public.parking_sessions where session_id = p_session;
  if not found then return null; end if;
  select * into ep from public.passes where pass_id = s.entry_pass_id;
  select * into xp from public.passes where pass_id = s.exit_pass_id;
  res := engine.session_json(s)
    || jsonb_build_object(
         'entry_read', (select engine.read_json(r, true) from public.plate_reads r where r.read_id = ep.primary_read_id),
         'exit_read', (select engine.read_json(r, true) from public.plate_reads r where r.read_id = xp.primary_read_id));
  if s.status in ('pending_review', 'orphan_exit') and xp.pass_id is not null then
    res := res || jsonb_build_object('candidates', engine.exit_candidates(xp, 3));
  end if;
  return res;
end $$;

-- single read with its per-frame reads[] timeline (reads drawer outside a session)
create or replace function public.get_read(p_read uuid)
returns jsonb language plpgsql stable security definer set search_path = public, engine, extensions as $$
begin
  perform engine.require_role('staff');
  return (select engine.read_json(r, true) from public.plate_reads r where r.read_id = p_read);
end $$;

create or replace function public.get_review_queue(p_lot text default 'gatf_main')
returns jsonb language plpgsql stable security definer set search_path = public, engine, extensions as $$
begin
  perform engine.require_role('staff');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'session_id', s.session_id, 'exit_pass_id', xp.pass_id, 'status', s.status,
             'match_score', round(s.match_score::numeric, 3), 'current_plate', s.plate_norm,
             'exit_read', engine.read_json(xr), 'candidates', engine.exit_candidates(xp, 3))
           order by s.exit_at desc)
      from public.parking_sessions s
      join public.passes xp on xp.pass_id = s.exit_pass_id
      join public.plate_reads xr on xr.read_id = xp.primary_read_id
     where s.lot_id = p_lot
       and (s.status = 'pending_review' or (s.status = 'orphan_exit' and s.exit_at > now() - interval '14 days'))), '[]');
end $$;

create or replace function public.resolve_match(p_exit_pass uuid, p_entry_pass uuid default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public, engine, extensions as $$
declare xp public.passes; ep public.passes; es public.parking_sessions; t timestamptz;
begin
  perform engine.require_role('admin');
  select * into xp from public.passes where pass_id = p_exit_pass;
  if not found then raise exception 'unknown exit pass'; end if;
  if p_entry_pass is not null then
    select * into ep from public.passes where pass_id = p_entry_pass;
    select * into es from public.parking_sessions where entry_pass_id = p_entry_pass;
  end if;
  insert into public.match_overrides (exit_read_id, entry_read_id, actor, actor_email, note)
  values (xp.primary_read_id, ep.primary_read_id, auth.uid(), auth.jwt() ->> 'email', p_note)
  on conflict (exit_read_id) do update
    set entry_read_id = excluded.entry_read_id, actor = excluded.actor, actor_email = excluded.actor_email,
        note = excluded.note, created_at = now();
  -- if the chosen entry was consumed by an earlier exit, replay from there so it is free again
  t := least(xp.event_at, coalesce(es.closed_at, xp.event_at));
  perform engine.rebuild_lot(xp.lot_id, t);
  perform engine.audit('resolve_match', p_exit_pass::text,
                       jsonb_build_object('entry_pass', p_entry_pass, 'note', p_note));
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.correct_plate(p_read uuid, p_plate text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public, engine, extensions as $$
declare r public.plate_reads; q text := engine.plate_norm(p_plate);
begin
  perform engine.require_role('admin');
  if length(q) < 2 then raise exception 'invalid plate'; end if;
  select * into r from public.plate_reads where read_id = p_read;
  if not found then raise exception 'unknown read'; end if;
  update public.plate_reads
     set corrected_plate = q, plate_norm = q, char_conf = null, corrected_by = auth.jwt() ->> 'email',
         plate_alternates = jsonb_build_array(jsonb_build_object('text', q, 'weight', 1))
   where read_id = p_read;
  perform engine.rebuild_lot(r.lot_id, r.event_at);
  perform engine.audit('correct_plate', p_read::text, jsonb_build_object('from', r.plate_norm, 'to', q, 'note', p_note));
  return jsonb_build_object('ok', true);
end $$;

create or replace function engine.reconcile_candidates(p_lot text)
returns setof jsonb language sql stable as $$
  select engine.session_json(s) || jsonb_build_object('reason',
           case when now() - s.entry_at > interval '24 hours' then 'here > 24 h (probable missed exit)'
                when engine.is_overnight(s.entry_at, now(), engine.lot_tz(p_lot)) then 'present overnight'
                when p.quality = 'low' then 'low-confidence entry read'
                else 'oldest open session' end)
    from public.parking_sessions s left join public.passes p on p.pass_id = s.entry_pass_id
   where s.lot_id = p_lot and s.status = 'open'
   order by (now() - s.entry_at > interval '24 hours') desc,
            engine.is_overnight(s.entry_at, now(), engine.lot_tz(p_lot)) desc,
            s.entry_at asc, coalesce(p.plate_confidence, 0) asc
$$;

create or replace function public.reconcile_preview(p_lot text, p_visual_count int)
returns jsonb language plpgsql stable security definer set search_path = public, engine, extensions as $$
declare tl public.occupancy_timeline; k int; all_open jsonb;
begin
  perform engine.require_role('admin');
  tl := engine.timeline_at(p_lot, now());
  select coalesce(jsonb_agg(c), '[]') into all_open from engine.reconcile_candidates(p_lot) c;
  k := greatest(jsonb_array_length(all_open) - p_visual_count, 0);
  return jsonb_build_object(
    'estimate', coalesce(tl.occupancy, 0), 'band_low', coalesce(tl.band_low, 0), 'band_high', coalesce(tl.band_high, 0),
    'open_sessions', jsonb_array_length(all_open), 'visual_count', p_visual_count, 'to_close_count', k,
    'proposed', coalesce((select jsonb_agg(e) from (select e from jsonb_array_elements(all_open) e limit k) x), '[]'),
    'open', all_open);
end $$;

create or replace function public.reconcile_commit(p_lot text, p_visual_count int, p_close uuid[], p_note text default null)
returns jsonb language plpgsql security definer set search_path = public, engine, extensions as $$
declare tl public.occupancy_timeline; resid int; n_open int;
begin
  perform engine.require_role('admin');
  if p_visual_count < 0 then raise exception 'visual count must be >= 0'; end if;
  tl := engine.timeline_at(p_lot, now());
  select count(*) into n_open from public.parking_sessions where lot_id = p_lot and status = 'open';
  resid := coalesce(tl.occupancy, 0) - p_visual_count;
  insert into public.occupancy_calibrations (lot_id, at, visual_count, estimate_before, open_sessions_before,
                                             residual, closed_session_ids, actor, actor_email, note)
  values (p_lot, now(), p_visual_count, coalesce(tl.occupancy, 0), n_open, resid, coalesce(p_close, '{}'),
          auth.uid(), auth.jwt() ->> 'email', p_note);
  perform engine.rebuild_lot(p_lot, now());
  perform engine.audit('reconcile', p_lot, jsonb_build_object('visual_count', p_visual_count, 'residual', resid,
                                                                'closed', cardinality(coalesce(p_close, '{}'))));
  return jsonb_build_object('residual', resid, 'closed', cardinality(coalesce(p_close, '{}')));
end $$;

create or replace function public.get_calibration_history(p_lot text default 'gatf_main')
returns jsonb language plpgsql stable security definer set search_path = public, engine, extensions as $$
begin
  perform engine.require_role('staff');
  return coalesce((select jsonb_agg(jsonb_build_object('at', at, 'visual_count', visual_count,
            'estimate_before', estimate_before, 'residual', residual, 'closed_count', cardinality(closed_session_ids),
            'actor_email', actor_email, 'note', note) order by at desc)
           from public.occupancy_calibrations where lot_id = p_lot), '[]');
end $$;

create or replace function public.get_data_quality(p_lot text, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = public, engine, extensions as $$
declare tz text := engine.lot_tz(p_lot); tl public.occupancy_timeline := engine.timeline_at(p_lot, now());
  n_exit int; n_matched int; n_exact int;
begin
  perform engine.require_role('staff');
  select count(*) into n_exit from public.passes where lot_id = p_lot and direction = 'out' and event_at >= p_from and event_at < p_to;
  select count(*) filter (where status in ('closed', 'pending_review')), count(*) filter (where match_method = 'exact')
    into n_matched, n_exact
    from public.parking_sessions where lot_id = p_lot and exit_at >= p_from and exit_at < p_to;
  return jsonb_build_object(
    'reads', (select count(*) from public.plate_reads where lot_id = p_lot and event_at >= p_from and event_at < p_to),
    'passes', (select count(*) from public.passes where lot_id = p_lot and event_at >= p_from and event_at < p_to),
    'read_rate_high', (select round(avg((quality in ('high', 'medium'))::int)::numeric, 4) from public.passes
                        where lot_id = p_lot and event_at >= p_from and event_at < p_to),
    'exit_match_rate', round(n_matched::numeric / nullif(n_exit, 0), 4),
    'exact_share', round(n_exact::numeric / nullif(n_matched, 0), 4),
    'orphan_exits', (select count(*) from public.parking_sessions where lot_id = p_lot and status = 'orphan_exit'
                      and exit_at >= p_from and exit_at < p_to),
    'fuzzy_pending', (select count(*) from public.parking_sessions where lot_id = p_lot and status = 'pending_review'),
    'suspect_stale', (select count(*) from public.parking_sessions where lot_id = p_lot and status = 'open'
                       and entry_at < now() - interval '24 hours'),
    'fragments', (select count(*) from public.passes where lot_id = p_lot and read_count > 1
                   and event_at >= p_from and event_at < p_to),
    'drift', coalesce(tl.open_sessions - tl.raw_occupancy, 0),
    'per_camera', coalesce((select jsonb_agg(jsonb_build_object('camera_id', camera_id, 'reads', n,
                     'avg_conf', round(ac::numeric, 4), 'low_quality', lq) order by camera_id)
                     from (select camera_id, count(*) n, avg(plate_confidence) ac, count(*) filter (where quality = 'low') lq
                             from public.plate_reads where lot_id = p_lot and event_at >= p_from and event_at < p_to
                            group by camera_id) x), '[]'),
    'conf_by_hour', coalesce((select jsonb_agg(jsonb_build_object('hour', h, 'avg_conf', round(ac::numeric, 4), 'reads', n) order by h)
                     from (select extract(hour from event_at at time zone tz)::int h, avg(plate_confidence) ac, count(*) n
                             from public.plate_reads where lot_id = p_lot and event_at >= p_from and event_at < p_to
                            group by 1) x), '[]'));
end $$;

create or replace function public.get_system_status()
returns jsonb language plpgsql stable security definer set search_path = public, engine, extensions as $$
begin
  perform engine.require_role('admin');
  return jsonb_build_object(
    'db_size_bytes', pg_database_size(current_database()), 'db_limit_bytes', 524288000,
    'events', (select count(*) from public.events), 'reads', (select count(*) from public.plate_reads),
    'sessions', (select count(*) from public.parking_sessions),
    'oldest_event', (select min(captured_at_utc) from public.events),
    'last_config_sync', (select max(config_synced_at) from public.lots),
    'capacity', (select capacity from public.lots order by lot_id limit 1),
    'ingest_errors_24h', (select count(*) from public.ingest_errors where at > now() - interval '24 hours'));
end $$;

create or replace function public.get_audit_log(p_limit int default 200)
returns jsonb language plpgsql stable security definer set search_path = public, engine, extensions as $$
begin
  perform engine.require_role('admin');
  return coalesce((select jsonb_agg(jsonb_build_object('at', at, 'actor_email', actor_email, 'action', action,
                     'target', target, 'detail', detail) order by at desc)
                     from (select * from public.audit_log order by at desc limit p_limit) a), '[]');
end $$;

create or replace function public.log_audit(p_action text, p_target text default null, p_detail jsonb default null)
returns jsonb language plpgsql security definer set search_path = public, engine, extensions as $$
begin
  perform engine.require_role('staff');
  perform engine.audit(p_action, p_target, p_detail);
  return jsonb_build_object('ok', true);
end $$;

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
                                        camera_connected, fps, last_event_at_utc, pending_uploads, uptime_s, app_version, message)
  values (hb ->> 'device_id', coalesce(hb ->> 'camera_id', cam.camera_id), cam.lot_id, sent, now(),
          (extract(epoch from now() - sent) * 1000)::int, hb ->> 'status', (hb ->> 'camera_connected')::boolean,
          (hb ->> 'fps')::real, (hb ->> 'last_event_at_utc')::timestamptz, (hb ->> 'pending_uploads')::int,
          (hb ->> 'uptime_s')::bigint, hb ->> 'app_version', hb ->> 'message')
  on conflict (device_id) do update set
    camera_id = excluded.camera_id, lot_id = excluded.lot_id, sent_at_utc = excluded.sent_at_utc,
    received_at = excluded.received_at, clock_offset_ms = excluded.clock_offset_ms, status = excluded.status,
    camera_connected = excluded.camera_connected, fps = excluded.fps, last_event_at_utc = excluded.last_event_at_utc,
    pending_uploads = excluded.pending_uploads, uptime_s = excluded.uptime_s, app_version = excluded.app_version,
    message = excluded.message;
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

-- ---------------------------------------------------------------------------
-- Grants: RPCs only. PUBLIC/anon get nothing.
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon;
revoke execute on all functions in schema engine from public, anon, authenticated;
grant usage on schema engine to authenticated;   -- needed to resolve composite types in definer functions
do $$
declare f text;
begin
  foreach f in array array[
    'get_devices(text)', 'get_alerts(text)', 'ack_alert(text)', 'get_live_snapshot(text)',
    'get_occupancy_series(text,timestamptz,timestamptz,integer)', 'get_typical_day(text,integer,integer)',
    'get_flow_series(text,timestamptz,timestamptz,integer)', 'get_heatmap(text,timestamptz,timestamptz,text)',
    'get_kpis(text,timestamptz,timestamptz)', 'get_daily_stats(text,timestamptz,timestamptz)',
    'get_dwell_distribution(text,timestamptz,timestamptz)',
    'list_sessions(text,timestamptz,timestamptz,text[],text,text[],integer,integer)',
    'list_reads(text,timestamptz,timestamptz,text,text,text,integer,integer)',
    'search_plates(text)', 'get_vehicle_profile(text)', 'get_session(uuid)', 'get_read(uuid)', 'get_review_queue(text)', 'get_review_count(text)',
    'resolve_match(uuid,uuid,text)', 'correct_plate(uuid,text,text)', 'reconcile_preview(text,integer)',
    'reconcile_commit(text,integer,uuid[],text)', 'get_calibration_history(text)',
    'get_data_quality(text,timestamptz,timestamptz)', 'get_system_status()', 'get_audit_log(integer)',
    'log_audit(text,text,jsonb)', 'report_heartbeat(jsonb)'] loop
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;
grant execute on all functions in schema engine to service_role;

-- Realtime: private lot channels readable by admin/staff only (CONTRACT §4)
create policy "lot channel members can receive" on realtime.messages
  for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'staff')
         and realtime.topic() like 'lot:%');
