-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- Mirrors the event.json payload written by trigger_event() in yolo_plate_reader.py,
-- so upload_events.py can insert rows with almost no transformation.

create table events (
  event_id uuid primary key,
  event_type text not null check (event_type in ('entry', 'exit', 'plate_track_finalized')),
  timestamp_utc timestamptz not null,
  source text,
  track_id integer,
  occupancy_count integer,
  vehicle_class text,
  vehicle_class_id integer,
  detection_confidence real,
  bounding_box jsonb,
  plate_text text,
  plate_confidence real,
  plate_confidence_per_char jsonb,
  plate_detection_confidence real,
  plate_bounding_box jsonb,
  -- plate_track_finalized only: the frame span of one tracked plate, and how
  -- many of those frames actually produced text / fed the consensus vote.
  frame_first integer,
  frame_last integer,
  num_frames_tracked integer,
  num_frames_with_text integer,
  num_frames_used_for_consensus integer,
  representative_frame_index integer,
  -- every per-frame OCR attempt: [{frame_index, text, confidence}, ...]. Read as
  -- a whole blob when auditing a plate_text, never queried per-read.
  reads jsonb,
  -- storage object path within the private bucket, e.g. "<event_id>.jpg" -
  -- NOT a public URL. Generate a signed URL on demand when you need to view
  -- one: supabase.storage.from_(BUCKET).create_signed_url(image_path, 3600)
  image_path text,
  created_at timestamptz not null default now()
);

-- time-series analysis: filtering/bucketing by timestamp and by event_type
-- (e.g. entries per hour) are the two queries you'll run constantly
create index on events (timestamp_utc);
create index on events (event_type);
