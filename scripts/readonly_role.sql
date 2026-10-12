-- Read-only Postgres role for the natural-language chat endpoint.
-- Run ONCE in the Supabase dashboard (SQL Editor), AFTER lot_views.sql.
--
-- This is the layer that holds even if the model, the system prompt, and
-- postgres-mcp's restricted mode all fail at the same time. DELETE / DROP /
-- UPDATE / INSERT / TRUNCATE are not "blocked" here - the privilege simply
-- does not exist for this role, so there is no text a model can emit that
-- grants itself one. Everything else in the design is defense in depth on top.
--
-- Before running: replace CHANGE_ME_STRONG_PASSWORD below. Generate one with
--   python3 -c "import secrets; print(secrets.token_urlsafe(32))"

-- ---------------------------------------------------------------------------
-- 1. The role
-- ---------------------------------------------------------------------------
-- NOINHERIT so it never picks up privileges from any role it might later be
-- added to. CONNECTION LIMIT caps the blast radius of a connection leak.

create role gatf_readonly with login password 'CHANGE_ME_STRONG_PASSWORD'
  nosuperuser
  nocreatedb
  nocreaterole
  noinherit
  connection limit 5;

-- ---------------------------------------------------------------------------
-- 2. Schema access: USAGE only, explicitly no CREATE
-- ---------------------------------------------------------------------------

revoke all on schema public from gatf_readonly;
grant usage on schema public to gatf_readonly;

-- ---------------------------------------------------------------------------
-- 3. SELECT on the views only - never on the `events` base table
-- ---------------------------------------------------------------------------
-- This works because Postgres views run with the VIEW OWNER's privileges when
-- reading underlying tables (security_invoker defaults to false). So this role
-- reads `events` *through* the views without holding any privilege on `events`
-- itself. Do NOT set security_invoker = true on these views - that would flip
-- the check to the calling role and break the whole arrangement.

grant select on
  lot_events_local,
  lot_occupancy_timeline,
  lot_hourly,
  lot_data_coverage,
  lot_capacity
to gatf_readonly;

-- ---------------------------------------------------------------------------
-- 4. Safety nets
-- ---------------------------------------------------------------------------
-- NOTE: default_transaction_read_only is a safety net, NOT the security
-- boundary. Any session can issue `SET default_transaction_read_only = off` to
-- undo it. It catches accidents and buggy code; the GRANT restrictions above
-- are what catch adversarial input. Do not rely on this line.
--
-- statement_timeout is the real protection against a runaway query pinning the
-- database, and complements the app-side loop bounds in the route handler.

alter role gatf_readonly set default_transaction_read_only = on;
alter role gatf_readonly set statement_timeout = '10s';
alter role gatf_readonly set idle_in_transaction_session_timeout = '30s';

-- ---------------------------------------------------------------------------
-- 5. Verification - run these AS gatf_readonly, not as postgres
-- ---------------------------------------------------------------------------
-- Connect with the gatf_readonly connection string, then run each. The first
-- five MUST fail with "permission denied"; the last four must succeed.
--
--   drop table events;                          -- expect: permission denied
--   delete from events;                         -- expect: permission denied
--   update events set plate_text = 'x';         -- expect: permission denied
--   insert into events (event_id) values (gen_random_uuid());  -- permission denied
--   select * from events;                       -- expect: permission denied
--   update lot_capacity set capacity = 1;       -- expect: permission denied
--
--   select * from lot_data_coverage;            -- expect: rows (or empty set)
--   select * from lot_capacity;                 -- expect: capacity = 100
--   select count(*) from lot_events_local;      -- expect: a number
--   select * from lot_hourly limit 5;           -- expect: rows (or empty set)
--
-- A "permission denied for table events" on the SELECT is the signal that the
-- view-only grant is doing its job: the model can read aggregates but cannot
-- reach the raw table.

-- ---------------------------------------------------------------------------
-- Teardown, if you need to start over
-- ---------------------------------------------------------------------------
--   revoke all on lot_events_local, lot_occupancy_timeline, lot_hourly,
--                 lot_data_coverage, lot_capacity from gatf_readonly;
--   revoke all on schema public from gatf_readonly;
--   drop role gatf_readonly;
