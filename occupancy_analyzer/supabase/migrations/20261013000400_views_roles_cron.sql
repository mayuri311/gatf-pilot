-- occupancy_analyzer — chat views, read-only role, retention & cron (plan docs 04 §5.3, 08 §4)

-- ---------------------------------------------------------------------------
-- Views for "Ask the lot" (read-only role sees ONLY these). Local time columns
-- avoid the UTC-bucketing class of wrong answers (lesson kept from lot_views.sql).
-- ---------------------------------------------------------------------------
create or replace view public.lot_capacity as
  select lot_id, name, capacity, timezone from public.lots;

create or replace view public.lot_reads_local as
  select r.read_id, r.lot_id, r.camera_id, r.direction,
         r.event_at at time zone l.timezone as ts_local,
         (r.event_at at time zone l.timezone)::date as local_date,
         extract(hour from r.event_at at time zone l.timezone)::int as local_hour,
         r.plate_norm, r.plate_confidence, r.quality
    from public.plate_reads r join public.lots l using (lot_id);

create or replace view public.lot_sessions_local as
  select s.session_id, s.lot_id, s.plate_norm, s.status, s.match_method,
         s.entry_at at time zone l.timezone as entry_local,
         s.exit_at at time zone l.timezone as exit_local,
         (s.entry_at at time zone l.timezone)::date as entry_date,
         round(extract(epoch from (s.exit_at - s.entry_at)) / 60) as dwell_minutes,
         s.is_bounce,
         engine.is_overnight(s.entry_at, coalesce(s.exit_at, case when s.status = 'open' then now() end), l.timezone) as overnight
    from public.parking_sessions s join public.lots l using (lot_id);

create or replace view public.lot_occupancy_timeline as
  select t.lot_id, t.valid_from at time zone l.timezone as valid_from_local,
         lead(t.valid_from) over (partition by t.lot_id order by t.valid_from, t.seq) at time zone l.timezone as valid_to_local,
         t.occupancy, t.band_low, t.band_high, t.open_sessions, t.cause
    from public.occupancy_timeline t join public.lots l using (lot_id);

create or replace view public.lot_hourly as
  select lot_id, local_date, local_hour,
         count(*) filter (where direction = 'in') as entries,
         count(*) filter (where direction = 'out') as exits
    from (select p.lot_id, p.direction,
                 (p.event_at at time zone l.timezone)::date local_date,
                 extract(hour from p.event_at at time zone l.timezone)::int local_hour
            from public.passes p join public.lots l using (lot_id)) x
   group by 1, 2, 3;

create or replace view public.lot_daily as
  select lot_id, local_date,
         count(*) filter (where direction = 'in') as entries,
         count(*) filter (where direction = 'out') as exits,
         count(distinct plate_norm) filter (where direction = 'in') as unique_vehicles
    from (select p.lot_id, p.direction, p.plate_norm, (p.event_at at time zone l.timezone)::date local_date
            from public.passes p join public.lots l using (lot_id)) x
   group by 1, 2;

-- the anti-fabrication view: a date absent here has NO data (not zero cars)
create or replace view public.lot_data_coverage as
  select r.lot_id, (r.event_at at time zone l.timezone)::date as local_date, r.camera_id,
         count(*) as reads, min(r.event_at at time zone l.timezone) as first_read_local,
         max(r.event_at at time zone l.timezone) as last_read_local
    from public.plate_reads r join public.lots l using (lot_id)
   group by 1, 2, 3;

comment on view public.lot_data_coverage is
  'QUERY FIRST for any time-scoped question. A date/camera absent here means no data — say so, never report zero.';

-- ---------------------------------------------------------------------------
-- Read-only role for the chat. Password is set outside migrations
-- (seed.sql locally; ALTER ROLE by hand on the hosted project).
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'gatf_readonly') then
    create role gatf_readonly with login nosuperuser nocreatedb nocreaterole noinherit connection limit 5;
  end if;
end $$;
revoke all on schema public from gatf_readonly;
grant usage on schema public to gatf_readonly;
grant select on public.lot_capacity, public.lot_reads_local, public.lot_sessions_local, public.lot_occupancy_timeline,
                public.lot_hourly, public.lot_daily, public.lot_data_coverage to gatf_readonly;
grant usage on schema engine to gatf_readonly;
grant execute on function engine.is_overnight(timestamptz, timestamptz, text) to gatf_readonly;
alter role gatf_readonly set default_transaction_read_only = on;
alter role gatf_readonly set statement_timeout = '10s';
alter role gatf_readonly set idle_in_transaction_session_timeout = '30s';

-- views are reachable only by the chat role and the service role
revoke all on public.lot_capacity, public.lot_reads_local, public.lot_sessions_local, public.lot_occupancy_timeline,
              public.lot_hourly, public.lot_daily, public.lot_data_coverage from anon, authenticated;
grant select on public.lot_capacity, public.lot_reads_local, public.lot_sessions_local, public.lot_occupancy_timeline,
                public.lot_hourly, public.lot_daily, public.lot_data_coverage to service_role;

-- ---------------------------------------------------------------------------
-- Retention (D6): 7 d full reads[], 14 d crops, 30 d plaintext plates
-- ---------------------------------------------------------------------------
create or replace function engine.pseudonym(p text)
returns text language sql stable security definer set search_path = '' as $$
  select 'H:' || left(encode(extensions.hmac(p, (select value from private.app_secrets where name = 'plate_hmac_key'),
                                             'sha256'), 'hex'), 12)
$$;

create or replace function engine.run_retention()
returns jsonb language plpgsql security definer set search_path = public, engine, extensions as $$
declare n_compact int; n_pseudo int; full_days int := 7; plain_days int := 30;
begin
  -- 1. compact per-frame reads[] to the alternates already stored on plate_reads
  update public.events e set reads = null, reads_compacted_at = now()
   where e.reads is not null and e.captured_at_utc < now() - make_interval(days => full_days);
  get diagnostics n_compact = row_count;

  -- 2. plaintext plates -> keyed pseudonym (sessions, passes, reads, raw events)
  if exists (select 1 from private.app_secrets where name = 'plate_hmac_key') then
    update public.parking_sessions set plate_norm = engine.pseudonym(plate_norm)
     where plate_norm not like 'H:%' and coalesce(exit_at, entry_at) < now() - make_interval(days => plain_days)
       and status <> 'open';
    get diagnostics n_pseudo = row_count;
    update public.passes set plate_norm = engine.pseudonym(plate_norm), plate_alternates = '[]'
     where plate_norm not like 'H:%' and event_at < now() - make_interval(days => plain_days);
    update public.plate_reads set plate_norm = engine.pseudonym(plate_norm), plate_raw = engine.pseudonym(plate_raw),
                                  plate_alternates = '[]', corrected_plate = null
     where plate_norm not like 'H:%' and event_at < now() - make_interval(days => plain_days);
    update public.events set plate_text = engine.pseudonym(plate_text), reads = null
     where plate_text not like 'H:%' and captured_at_utc < now() - make_interval(days => plain_days);
  end if;
  return jsonb_build_object('compacted', n_compact, 'pseudonymized_sessions', coalesce(n_pseudo, 0));
end $$;

-- crops due for deletion (deleted via the Storage API by tools/crop_retention.py)
create or replace function public.crops_due_for_deletion(p_days int default 14, p_limit int default 1000)
returns table (read_id uuid, image_path text) language sql stable security definer set search_path = public as $$
  select read_id, image_path from public.plate_reads
   where image_path is not null and image_deleted_at is null and event_at < now() - make_interval(days => p_days)
   order by event_at limit p_limit
$$;
create or replace function public.mark_crops_deleted(p_ids uuid[])
returns int language sql security definer set search_path = public as $$
  with u as (update public.plate_reads set image_deleted_at = now() where read_id = any (p_ids) returning 1)
  select count(*)::int from u
$$;
revoke execute on function public.crops_due_for_deletion(int, int), public.mark_crops_deleted(uuid[]) from public, anon, authenticated;
grant execute on function public.crops_due_for_deletion(int, int), public.mark_crops_deleted(uuid[]) to service_role;

-- ---------------------------------------------------------------------------
-- Cron (pg_cron is optional: skipped silently where unavailable)
-- ---------------------------------------------------------------------------
do $$
begin
  create extension if not exists pg_cron;
  -- safety net for missed triggers / late data: replay the trailing 2 h every 5 min
  perform cron.schedule('oa_rebuild_trailing', '*/5 * * * *',
    $c$select engine.rebuild_lot(lot_id, now() - interval '2 hours') from public.lots$c$);
  perform cron.schedule('oa_retention', '30 7 * * *', $c$select engine.run_retention()$c$);   -- 03:30 ET (EDT)
  perform cron.schedule('oa_prune_cron_log', '0 8 * * *',
    $c$delete from cron.job_run_details where end_time < now() - interval '7 days'$c$);
exception when others then
  raise notice 'pg_cron not available: %', sqlerrm;
end $$;
