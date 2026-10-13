-- occupancy_analyzer — schema (plan docs 04 §3, 13; contract docs/CONTRACT.md §1–2)
--
-- Raw input is `events` (contract v2, written by the edge devices). Everything in
-- the "derived" section is rebuilt from events + match_overrides +
-- occupancy_calibrations by engine.rebuild_lot(), so those tables never need a
-- migration-time backfill.

create extension if not exists pg_trgm with schema extensions;
create extension if not exists fuzzystrmatch with schema extensions;
create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- D16 fresh start: an existing pre-v2 `events` table (hosted project) is kept
-- untouched as events_v0 and ignored by everything below.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'events')
     and not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'events'
                       and column_name = 'schema_version') then
    alter table public.events rename to events_v0;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Configuration (synced from config/config.yaml by web/scripts/sync-config.ts)
-- ---------------------------------------------------------------------------
create table public.lots (
  lot_id            text primary key,
  name              text not null,
  capacity          int  not null check (capacity > 0),
  timezone          text not null default 'America/New_York',
  settings          jsonb not null default '{}',
  config_synced_at  timestamptz
);

create table public.lot_capacity_history (
  lot_id      text not null references public.lots on delete cascade,
  capacity    int  not null check (capacity > 0),
  valid_from  timestamptz not null,
  primary key (lot_id, valid_from)
);

create table public.cameras (
  camera_id  text primary key,
  lot_id     text not null references public.lots on delete cascade,
  direction  text not null check (direction in ('in', 'out')),
  device_id  text not null,
  active     boolean not null default true
);

-- ---------------------------------------------------------------------------
-- Raw ingest: event contract v2
-- ---------------------------------------------------------------------------
create table public.events (
  event_id                       uuid primary key,
  schema_version                 int  not null,
  event_type                     text not null,
  camera_id                      text not null,
  device_id                      text not null,
  captured_at_utc                timestamptz not null,
  timestamp_utc                  timestamptz not null,
  source                         text,
  track_id                       int,
  frame_first                    int,
  frame_last                     int,
  representative_frame_index     int,
  num_frames_tracked             int,
  num_frames_with_text           int,
  num_frames_used_for_consensus  int,
  plate_text                     text not null,
  plate_confidence               real,
  plate_confidence_per_char      jsonb,
  plate_detection_confidence     real,
  plate_bounding_box             jsonb,
  reads                          jsonb,
  reads_compacted_at             timestamptz,
  image_path                     text,
  received_at                    timestamptz not null default now()
);
create index events_camera_captured_idx on public.events (camera_id, captured_at_utc);
create index events_captured_brin on public.events using brin (captured_at_utc);

-- ---------------------------------------------------------------------------
-- Derived (rebuildable)
-- ---------------------------------------------------------------------------
create table public.plate_reads (
  read_id                 uuid primary key references public.events (event_id) on delete cascade,
  lot_id                  text not null references public.lots,
  camera_id               text not null,
  direction               text not null check (direction in ('in', 'out')),
  event_at                timestamptz not null,
  plate_raw               text not null,
  plate_norm              text not null,
  plate_alternates        jsonb not null default '[]',   -- [{text, weight}] weight relative to best = 1
  plate_confidence        real,
  char_conf               real[],
  num_frames_used         int,
  quality                 text not null check (quality in ('high', 'medium', 'low')),
  image_path              text,
  image_deleted_at        timestamptz,
  corrected_plate         text,                          -- admin correction (survives rebuilds)
  corrected_by            text,
  pass_id                 uuid
);
create index plate_reads_lot_time_idx on public.plate_reads (lot_id, event_at);
create index plate_reads_pass_idx on public.plate_reads (pass_id);
create index plate_reads_plate_trgm on public.plate_reads using gin (plate_norm extensions.gin_trgm_ops);

create table public.passes (
  pass_id            uuid primary key,                   -- = earliest read in the pass (stable)
  lot_id             text not null references public.lots,
  camera_id          text not null,
  direction          text not null check (direction in ('in', 'out')),
  event_at           timestamptz not null,
  plate_norm         text not null,
  plate_alternates   jsonb not null default '[]',
  char_conf          real[],
  plate_confidence   real,
  quality            text not null,
  read_count         int not null default 1,
  primary_read_id    uuid not null,
  possible_fragment  boolean not null default false
);
create index passes_lot_time_idx on public.passes (lot_id, event_at);

create table public.parking_sessions (
  session_id      uuid primary key,                      -- entry pass id, or exit pass id for orphan exits
  lot_id          text not null references public.lots,
  plate_norm      text not null,
  entry_pass_id   uuid,
  exit_pass_id    uuid,
  entry_at        timestamptz,
  exit_at         timestamptz,
  closed_at       timestamptz,                           -- when the closing input happened (exit, re-entry, reconcile, expiry)
  status          text not null check (status in
                   ('open', 'pending_review', 'closed', 'closed_inferred', 'closed_admin', 'expired', 'orphan_exit')),
  match_method    text check (match_method in ('exact', 'fuzzy', 'fuzzy_pending', 'manual')),
  match_score     real,
  closed_reason   text,
  is_bounce       boolean not null default false
);
create index parking_sessions_open_idx on public.parking_sessions (lot_id, plate_norm) where status = 'open';
create index parking_sessions_entry_idx on public.parking_sessions (lot_id, entry_at);
create index parking_sessions_exit_idx on public.parking_sessions (lot_id, exit_at);
create index parking_sessions_plate_trgm on public.parking_sessions using gin (plate_norm extensions.gin_trgm_ops);

create table public.occupancy_timeline (
  lot_id          text not null references public.lots,
  seq             bigserial,
  valid_from      timestamptz not null,
  occupancy       int not null,       -- headline: clamp(S2 open sessions + unseen, 0, capacity)
  raw_occupancy   int not null,       -- S1 flow count (entries - exits - re-entry corrections), drift cross-check
  unseen          real not null default 0,  -- cars confirmed by a visual count but never read on entry
  band_low        int not null,
  band_high       int not null,
  open_sessions   int not null,       -- S2
  n_in            int not null,       -- entries since anchor (for the band)
  n_out           int not null,
  anchor_at       timestamptz,
  cause           text not null,      -- in | out | reentry | calibration | rebuild
  cause_pass_id   uuid,
  primary key (lot_id, seq)
);
create index occupancy_timeline_time_idx on public.occupancy_timeline (lot_id, valid_from);

-- ---------------------------------------------------------------------------
-- Human decisions (inputs to the rebuild; never derived)
-- ---------------------------------------------------------------------------
create table public.match_overrides (
  exit_read_id    uuid primary key,              -- read ids, not pass ids: stable across rebuilds
  entry_read_id   uuid,                          -- null = "no match" (keep as orphan)
  actor           uuid,
  actor_email     text,
  note            text,
  created_at      timestamptz not null default now()
);

create table public.occupancy_calibrations (
  calibration_id         bigserial primary key,
  lot_id                 text not null references public.lots,
  at                     timestamptz not null default now(),
  visual_count           int not null check (visual_count >= 0),
  estimate_before        int,
  open_sessions_before   int,
  residual               int,
  closed_session_ids     uuid[] not null default '{}',
  actor                  uuid,
  actor_email            text,
  note                   text
);
create index occupancy_calibrations_lot_at_idx on public.occupancy_calibrations (lot_id, at);

-- ---------------------------------------------------------------------------
-- Operations
-- ---------------------------------------------------------------------------
create table public.device_heartbeats (
  device_id          text primary key,
  camera_id          text,
  lot_id             text,
  sent_at_utc        timestamptz,
  received_at        timestamptz not null default now(),
  clock_offset_ms    int,
  status             text,
  camera_connected   boolean,
  fps                real,
  last_event_at_utc  timestamptz,
  pending_uploads    int,
  uptime_s           bigint,
  app_version        text,
  message            text
);

create table public.ingest_errors (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  event_id    uuid,
  kind        text not null,        -- unknown_camera | bad_schema_version | clock_skew | engine_error
  detail      text
);

create table public.alert_acks (
  alert_key   text primary key,
  acked_by    text,
  acked_at    timestamptz not null default now()
);

create table public.audit_log (
  id           bigserial primary key,
  at           timestamptz not null default now(),
  actor        uuid,
  actor_email  text,
  action       text not null,
  target       text,
  detail       jsonb
);
create index audit_log_at_idx on public.audit_log (at desc);

create table private.app_secrets (
  name   text primary key,
  value  text not null
);

-- ---------------------------------------------------------------------------
-- Security: every table is RLS-locked with no policies. The web reaches data
-- only through role-checked security-definer RPCs; devices use the service
-- role. Explicit grants (Supabase Data API change, 2026-10-30).
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['lots','lot_capacity_history','cameras','events','plate_reads','passes',
                           'parking_sessions','occupancy_timeline','match_overrides',
                           'occupancy_calibrations','device_heartbeats','ingest_errors',
                           'alert_acks','audit_log'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;
grant usage, select on all sequences in schema public to service_role;

-- Private crop bucket (contract §1.1)
insert into storage.buckets (id, name, public)
values ('event-snapshots', 'event-snapshots', false)
on conflict (id) do nothing;
