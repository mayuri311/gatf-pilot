-- Migration: add the plate-tracking event shape to an existing `events` table.
-- Run once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
--
-- Why: the original schema modelled only the entry/exit occupancy events. The
-- plate pipeline emits event_type 'plate_track_finalized', which carries the
-- per-track frame span and the full list of per-frame OCR reads that the
-- consensus plate_text was derived from. Inserts of those events failed with
-- PGRST204 ("Could not find the 'frame_first' column") until this ran.

-- 1. The frame span / consensus counters for one tracked plate.
alter table events add column if not exists frame_first integer;
alter table events add column if not exists frame_last integer;
alter table events add column if not exists num_frames_tracked integer;
alter table events add column if not exists num_frames_with_text integer;
alter table events add column if not exists num_frames_used_for_consensus integer;
alter table events add column if not exists representative_frame_index integer;

-- 2. Every per-frame OCR attempt for the track: [{frame_index, text, confidence}, ...].
--    Kept as jsonb rather than a child table - it's read as a whole blob when
--    auditing why a plate_text came out the way it did, never queried per-read.
alter table events add column if not exists reads jsonb;

-- 3. Widen the event_type check to admit the new type. Postgres auto-named the
--    original inline constraint events_event_type_check.
alter table events drop constraint if exists events_event_type_check;
alter table events add constraint events_event_type_check
  check (event_type in ('entry', 'exit', 'plate_track_finalized'));
