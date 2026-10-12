-- Query layer for the natural-language chat endpoint (frontend/src/app/api/chat).
-- Run this in the Supabase dashboard (SQL Editor -> New query -> paste -> Run)
-- BEFORE readonly_role.sql, since that script grants SELECT on these views.
--
-- Why views instead of letting the model query `events` directly:
-- every one of these encodes a piece of logic the model would otherwise have
-- to invent on the fly, and get wrong in a way that looks plausible. The
-- timezone conversion is the clearest example - see lot_events_local below.
--
-- The chat role is granted SELECT on these views and NOT on `events`, so this
-- file also defines the entire surface the model can see.

-- Pittsburgh. Every view converts to this zone; change it in one place here
-- and re-run if the pilot ever moves.

-- ---------------------------------------------------------------------------
-- Capacity: the denominator for "how full is the lot"
-- ---------------------------------------------------------------------------
-- Not derivable from the events table - it lives in zones.json today, which
-- the database has no knowledge of. Without it, "how full" has no answer.

create table if not exists lot_capacity (
  id          boolean primary key default true constraint lot_capacity_single_row check (id),
  capacity    integer not null check (capacity > 0),
  updated_at  timestamptz not null default now()
);

insert into lot_capacity (id, capacity) values (true, 100)
  on conflict (id) do nothing;

comment on table lot_capacity is
  'Single-row table holding total parking capacity. Use as the denominator for '
  '"how full" / percentage-occupancy questions. Seeded to 100 from zones.json.';

-- ---------------------------------------------------------------------------
-- lot_events_local: every event, in LOCAL time
-- ---------------------------------------------------------------------------
-- This view exists to eliminate one specific class of confidently-wrong answer.
-- `timestamp_utc` is timestamptz stored in UTC. A model asked "how many cars
-- entered this morning" will reach for `WHERE timestamp_utc::date = CURRENT_DATE`,
-- which buckets by UTC days - shifting the window by 4-5 hours depending on DST.
-- It returns rows, it raises no error, and the number it produces is wrong.
-- Pre-computing local_date / local_hour removes the opportunity.

create or replace view lot_events_local as
select
  e.event_id,
  e.event_type,
  e.timestamp_utc,
  e.timestamp_utc at time zone 'America/New_York'            as ts_local,
  (e.timestamp_utc at time zone 'America/New_York')::date     as local_date,
  extract(hour from e.timestamp_utc at time zone 'America/New_York')::int as local_hour,
  e.track_id,
  e.occupancy_count,
  e.vehicle_class,
  e.detection_confidence,
  e.plate_text,
  e.plate_confidence,
  e.source
from events e;

comment on view lot_events_local is
  'All crossing events with UTC timestamps converted to America/New_York. '
  'ALWAYS filter on local_date / local_hour / ts_local for questions phrased in '
  'local time ("today", "this morning", "2pm") - never on timestamp_utc, which '
  'would silently shift the window by the UTC offset.';

-- ---------------------------------------------------------------------------
-- lot_occupancy_timeline: occupancy as an explicit step function
-- ---------------------------------------------------------------------------
-- Occupancy is only known at the instants a vehicle crossed the line; between
-- crossings it holds steady. Materializing [valid_from, valid_to) turns
-- "how full was the lot at 2pm yesterday" into an interval containment test
-- rather than a correlated subquery the model has to derive correctly.
--
-- CAVEAT (real, present-day): occupancy_count is written by yolo_plate_reader.py
-- from a counter that starts at 0 on every process start, so it is a per-RUN
-- count, not a durable lot occupancy. Until that pipeline is fixed, treat these
-- numbers as per-session and cross-check lot_data_coverage before reporting them.

create or replace view lot_occupancy_timeline as
select
  e.ts_local                                          as valid_from,
  lead(e.ts_local) over (order by e.ts_local)         as valid_to,
  e.occupancy_count,
  e.local_date,
  e.event_type,
  e.track_id
from lot_events_local e;

comment on view lot_occupancy_timeline is
  'Occupancy step function. Each row holds from valid_from until valid_to '
  '(NULL = still current). For occupancy at an instant T: '
  'WHERE valid_from <= T AND (valid_to IS NULL OR valid_to > T). '
  'WARNING: occupancy_count currently resets to 0 on each capture-script restart, '
  'so it is per-run, not a durable lot total. Check lot_data_coverage first.';

-- ---------------------------------------------------------------------------
-- lot_hourly: per-hour rollup for "peak hours" / "least occupied"
-- ---------------------------------------------------------------------------
-- Note: hours with no events produce no row (no zero-filling). An absent hour
-- means "no events recorded", which is NOT the same as "zero cars" - that
-- distinction is what lot_data_coverage is for.

create or replace view lot_hourly as
select
  e.local_date,
  e.local_hour,
  count(*) filter (where e.event_type = 'entry')  as entries,
  count(*) filter (where e.event_type = 'exit')   as exits,
  max(e.occupancy_count)                          as max_occupancy,
  min(e.occupancy_count)                          as min_occupancy,
  round(avg(e.occupancy_count), 2)                as avg_occupancy,
  min(e.ts_local)                                 as first_event_at,
  max(e.ts_local)                                 as last_event_at
from lot_events_local e
group by e.local_date, e.local_hour;

comment on view lot_hourly is
  'Per local-hour rollup: entry/exit counts and occupancy min/max/avg. '
  'Use for "peak hours" (order by entries or max_occupancy) and "least occupied" '
  '(order by min_occupancy). Hours with no recorded events are ABSENT, not zero - '
  'a missing hour means no data, so confirm against lot_data_coverage.';

-- ---------------------------------------------------------------------------
-- lot_data_coverage: what days actually have data
-- ---------------------------------------------------------------------------
-- The anti-fabrication mechanism. Without it, a question about a day the camera
-- was not running returns an empty result set that reads exactly like a genuine
-- zero, and the honest answer ("no data for that window") is indistinguishable
-- from the wrong one ("no cars entered"). The system prompt requires querying
-- this before answering any time-scoped question.

create or replace view lot_data_coverage as
select
  e.local_date,
  count(*)                                        as event_count,
  count(*) filter (where e.event_type = 'entry')  as entry_count,
  count(*) filter (where e.event_type = 'exit')   as exit_count,
  bool_or(e.event_type = 'exit')                  as has_exit_events,
  min(e.ts_local)                                 as first_event_at,
  max(e.ts_local)                                 as last_event_at,
  count(distinct e.source)                        as distinct_sources
from lot_events_local e
group by e.local_date;

comment on view lot_data_coverage is
  'Per-day data coverage. QUERY THIS FIRST for any question scoped to a date or '
  'time window. A date absent from this view means the camera logged nothing that '
  'day - report "no data for that window", never zero or an estimate. '
  'has_exit_events = false means occupancy figures for that day are unreliable, '
  'since occupancy can only decrease on exit crossings.';
