-- occupancy_analyzer — matching & session engine (plan doc 03)
--
-- Design: derived state is a deterministic replay of ordered inputs
--   (passes built from plate_reads, admin calibrations, match overrides).
-- engine.rebuild_lot(lot, from) rewinds everything at/after `from` and replays
-- forward. A normal (in-order) insert therefore replays exactly one pass; a late
-- upload replays the window since its capture time; human decisions are inputs,
-- so a replay can never undo them.

create schema if not exists engine;
revoke all on schema engine from public, anon, authenticated;
grant usage on schema engine to service_role;

-- ---------------------------------------------------------------------------
-- Settings (defaults from plan doc 03 §8; per-lot overrides in lots.settings)
-- ---------------------------------------------------------------------------
create or replace function engine.setting(p_lot text, p_key text, p_default numeric)
returns numeric language sql stable as $$
  select coalesce((select (settings ->> p_key)::numeric from public.lots where lot_id = p_lot), p_default)
$$;

create or replace function engine.capacity_at(p_lot text, p_at timestamptz)
returns int language sql stable as $$
  select coalesce(
    (select capacity from public.lot_capacity_history
      where lot_id = p_lot and valid_from <= p_at order by valid_from desc limit 1),
    (select capacity from public.lots where lot_id = p_lot))
$$;

-- ---------------------------------------------------------------------------
-- Plate normalization & similarity (doc 03 §2, §4.1)
-- ---------------------------------------------------------------------------
create or replace function engine.plate_norm(p text)
returns text language sql immutable as $$
  select regexp_replace(upper(replace(coalesce(p, ''), 'Ø', '0')), '[^A-Z0-9]', '', 'g')
$$;

-- confusion-collapsed key: visually ambiguous glyphs map to one representative
create or replace function engine.plate_key(p text)
returns text language sql immutable as $$
  select translate(engine.plate_norm(p), 'OQDILZSBGFWNMU', '00011255866VVVV')
$$;

create or replace function engine.confusable(a text, b text)
returns boolean language sql immutable as $$
  select exists (
    select 1 from unnest(array['0ODQ', '1IL7', '2Z', '5S', '8B', '6G', 'PFR', 'VWNMU', 'EF']) g
    where strpos(g, a) > 0 and strpos(g, b) > 0)
$$;

-- Confusion-aware, confidence-weighted optimal-string-alignment distance.
-- Returns similarity in [0,1]: 1 - distance / max(len).
create or replace function engine.plate_similarity(
  x text, y text, cx real[] default null, cy real[] default null)
returns real language plpgsql immutable as $$
declare
  n int := length(x); m int := length(y);
  d real[]; w int := m + 1;
  i int; j int; cost real; ca real; cb real; a text; b text;
  ins_del constant real := 0.7;
begin
  if n = 0 or m = 0 then return 0; end if;
  if x = y then return 1; end if;
  d := array_fill(0::real, array[(n + 1) * (m + 1)]);
  for i in 0..n loop d[i * w + 1] := i * ins_del; end loop;
  for j in 0..m loop d[j + 1] := j * ins_del; end loop;
  for i in 1..n loop
    a := substr(x, i, 1);
    ca := coalesce(cx[i], 1.0);
    for j in 1..m loop
      b := substr(y, j, 1);
      cb := coalesce(cy[j], 1.0);
      if a = b then cost := 0;
      elsif engine.confusable(a, b) then cost := 0.25 * (0.4 + 0.6 * least(ca, cb));
      else cost := 1.0 * (0.4 + 0.6 * least(ca, cb));
      end if;
      d[i * w + j + 1] := least(d[(i - 1) * w + j + 1] + ins_del,
                                d[i * w + j] + ins_del,
                                d[(i - 1) * w + j] + cost);
      if i > 1 and j > 1 and a = substr(y, j - 1, 1) and substr(x, i - 1, 1) = b then
        d[i * w + j + 1] := least(d[i * w + j + 1], d[(i - 2) * w + j - 1] + 0.6);
      end if;
    end loop;
  end loop;
  return greatest(0, 1 - d[n * w + m + 1] / greatest(n, m));
end $$;

-- Count of non-confusable substitutions after aligning equal-length strings
-- (guard rail: never auto-match with > 2 confusable swaps, doc 03 §4.1).
create or replace function engine.confusable_swaps(x text, y text)
returns int language sql immutable as $$
  select case when length(x) <> length(y) then 99 else
    (select count(*)::int from generate_series(1, length(x)) i
      where substr(x, i, 1) <> substr(y, i, 1)) end
$$;

-- Evidence-weighted match score between two alternates lists (doc 03 §4.1).
create or replace function engine.match_score(
  e_plate text, e_conf real[], e_alts jsonb, x_plate text, x_conf real[], x_alts jsonb)
returns real language plpgsql immutable as $$
declare
  best real := engine.plate_similarity(e_plate, x_plate, e_conf, x_conf);
  ea record; xa record; s real;
begin
  if best >= 0.999 then return 1; end if;
  for ea in select value ->> 'text' t, (value ->> 'weight')::real w from jsonb_array_elements(coalesce(e_alts, '[]')) loop
    for xa in select value ->> 'text' t, (value ->> 'weight')::real w from jsonb_array_elements(coalesce(x_alts, '[]')) loop
      s := engine.plate_similarity(ea.t, xa.t) * (0.85 + 0.15 * sqrt(greatest(ea.w, 0) * greatest(xa.w, 0)));
      if s > best then best := s; end if;
    end loop;
  end loop;
  return least(best, 1);
end $$;

-- top-5 clean distinct reads weighted by summed confidence, relative to best = 1
create or replace function engine.alternates_from_reads(p_reads jsonb, p_plate text)
returns jsonb language sql immutable as $$
  with r as (
    select engine.plate_norm(e ->> 'text') t, coalesce((e ->> 'confidence')::real, 0) c
      from jsonb_array_elements(coalesce(p_reads, '[]')) e
     where coalesce(e ->> 'text', '') ~ '^[A-Za-z0-9]+$'
  ), g as (
    select t, sum(c) w from r where length(t) >= 4 group by t
    union all select engine.plate_norm(p_plate), 0.0001   -- consensus always present
  ), agg as (
    select t, max(w) w from g group by t order by max(w) desc limit 5
  ), norm as (
    select t, w, w / nullif(max(w) over (), 0) rel from agg
  )
  select coalesce(jsonb_agg(jsonb_build_object('text', t, 'weight', round(coalesce(rel, 1)::numeric, 4))
                            order by w desc), '[]')
    from norm
$$;

-- ---------------------------------------------------------------------------
-- Realtime: broadcasts must never break ingest (doc 04 §4.1 pitfall)
-- ---------------------------------------------------------------------------
create or replace function engine.safe_broadcast(p_topic text, p_event text, p_payload jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform realtime.send(p_payload, p_event, p_topic, true);
exception when others then
  null;
end $$;

-- ---------------------------------------------------------------------------
-- Pass building (doc 03 §3): reads -> passes with same-camera de-dup
-- ---------------------------------------------------------------------------
create or replace function engine.assign_read_to_pass(p_read public.plate_reads)
returns uuid language plpgsql as $$
declare
  win interval := make_interval(secs => engine.setting(p_read.lot_id, 'dedup_window_s', 30));
  thr real := engine.setting(p_read.lot_id, 'dedup_sim', 0.80);
  cand record; best_id uuid; best_s real := 0; s real;
begin
  for cand in
    select * from public.passes
     where lot_id = p_read.lot_id and camera_id = p_read.camera_id
       and event_at between p_read.event_at - win and p_read.event_at + win
  loop
    s := engine.match_score(cand.plate_norm, cand.char_conf, cand.plate_alternates,
                            p_read.plate_norm, p_read.char_conf, p_read.plate_alternates);
    if s > best_s then best_s := s; best_id := cand.pass_id; end if;
  end loop;

  if best_id is not null and best_s >= thr then
    update public.plate_reads set pass_id = best_id where read_id = p_read.read_id;
    perform engine.refresh_pass(best_id);
    return best_id;
  end if;

  insert into public.passes (pass_id, lot_id, camera_id, direction, event_at, plate_norm, plate_alternates,
                             char_conf, plate_confidence, quality, read_count, primary_read_id)
  values (p_read.read_id, p_read.lot_id, p_read.camera_id, p_read.direction, p_read.event_at,
          p_read.plate_norm, p_read.plate_alternates, p_read.char_conf, p_read.plate_confidence,
          p_read.quality, 1, p_read.read_id);
  update public.plate_reads set pass_id = p_read.read_id where read_id = p_read.read_id;
  return p_read.read_id;
end $$;

-- recompute a pass from its reads: primary = most evidence (confidence × frames)
create or replace function engine.refresh_pass(p_pass uuid)
returns void language plpgsql as $$
declare pr public.plate_reads; n int; first_at timestamptz;
begin
  select * into pr from public.plate_reads where pass_id = p_pass
   order by coalesce(plate_confidence, 0) * greatest(coalesce(num_frames_used, 1), 1) desc, event_at limit 1;
  select count(*), min(event_at) into n, first_at from public.plate_reads where pass_id = p_pass;
  update public.passes set
    plate_norm = pr.plate_norm, plate_alternates = pr.plate_alternates, char_conf = pr.char_conf,
    plate_confidence = pr.plate_confidence, quality = pr.quality, primary_read_id = pr.read_id,
    read_count = n, event_at = first_at, possible_fragment = n > 1
   where pass_id = p_pass;
end $$;

-- ---------------------------------------------------------------------------
-- Occupancy state machine (doc 03 §5)
-- ---------------------------------------------------------------------------
create or replace function engine.push_timeline(
  p_lot text, p_at timestamptz, p_raw int, p_unseen real, p_n_in int, p_n_out int, p_anchor timestamptz,
  p_cause text, p_pass uuid)
returns void language plpgsql as $$
declare
  cap int := engine.capacity_at(p_lot, p_at);
  m_in real := engine.setting(p_lot, 'miss_rate_in', 0.02);
  m_out real := engine.setting(p_lot, 'miss_rate_out', 0.03);
  half int := ceil(1.96 * sqrt(p_n_in * m_in / power(1 - m_in, 2) + p_n_out * m_out / power(1 - m_out, 2)));
  s2 int; occ int;
begin
  -- Headline = open sessions + unseen. Measured on the simulator (plan doc 14): with near-100 % pair
  -- recall, S2 tracks truth ~2x better than the flow count S1, because every orphan exit (a car whose
  -- entry was never read) permanently pulls S1 down. S1 stays as the drift cross-check.
  select count(*) into s2 from public.parking_sessions where lot_id = p_lot and status = 'open';
  occ := greatest(0, least(cap, round(s2 + p_unseen)::int));
  insert into public.occupancy_timeline (lot_id, valid_from, occupancy, raw_occupancy, unseen, band_low, band_high,
                                         open_sessions, n_in, n_out, anchor_at, cause, cause_pass_id)
  values (p_lot, p_at, occ, p_raw, p_unseen, greatest(0, occ - half), least(cap, occ + half), s2,
          p_n_in, p_n_out, p_anchor, p_cause, p_pass);
end $$;

-- ---------------------------------------------------------------------------
-- Sessionize one pass (doc 03 §4.2–4.3). Returns the S1 delta.
-- ---------------------------------------------------------------------------
create or replace function engine.process_pass(p_pass public.passes, out o_delta int, out o_reentry boolean, out o_orphan boolean)
language plpgsql as $$
declare
  min_dwell interval := make_interval(secs => engine.setting(p_pass.lot_id, 'min_dwell_s', 20));
  reentry_min interval := make_interval(secs => engine.setting(p_pass.lot_id, 'reentry_min_s', 300));
  t_auto real := engine.setting(p_pass.lot_id, 't_auto', 0.85);
  t_review real := engine.setting(p_pass.lot_id, 't_review', 0.65);
  margin real := engine.setting(p_pass.lot_id, 'margin', 0.15);
  bounce_max interval := make_interval(secs => engine.setting(p_pass.lot_id, 'bounce_max_s', 300));
  s public.parking_sessions; ov record; ep public.passes;
  c record; best_id uuid; best_s real := 0; second_s real := 0; sc real; n_exact int;
begin
  o_delta := 0; o_reentry := false; o_orphan := false;

  if p_pass.direction = 'in' then
    -- re-entry with an open session for the same plate => the exit was missed
    select * into s from public.parking_sessions
     where lot_id = p_pass.lot_id and status = 'open' and plate_norm = p_pass.plate_norm
       and entry_at < p_pass.event_at - reentry_min
     order by entry_at limit 1;
    if found then
      update public.parking_sessions
         set status = 'closed_inferred', closed_at = p_pass.event_at, closed_reason = 'reentry'
       where session_id = s.session_id;
      o_delta := o_delta - 1; o_reentry := true;
    end if;
    insert into public.parking_sessions (session_id, lot_id, plate_norm, entry_pass_id, entry_at, status)
    values (p_pass.pass_id, p_pass.lot_id, p_pass.plate_norm, p_pass.pass_id, p_pass.event_at, 'open')
    on conflict (session_id) do nothing;
    o_delta := o_delta + 1;
    return;
  end if;

  -- exit ------------------------------------------------------------------
  o_delta := -1;

  -- human override, keyed by read ids (stable across rebuilds)
  select mo.* into ov from public.match_overrides mo
    join public.plate_reads r on r.read_id = mo.exit_read_id
   where r.pass_id = p_pass.pass_id limit 1;
  if found then
    if ov.entry_read_id is not null then
      select se.* into s from public.parking_sessions se
        join public.plate_reads er on er.pass_id = se.entry_pass_id
       where er.read_id = ov.entry_read_id and se.status = 'open' limit 1;
      if found then
        update public.parking_sessions
           set exit_pass_id = p_pass.pass_id, exit_at = p_pass.event_at, closed_at = p_pass.event_at,
               status = 'closed', match_method = 'manual', match_score = 1,
               is_bounce = (p_pass.event_at - entry_at) < bounce_max
         where session_id = s.session_id;
        return;
      end if;
    end if;
    insert into public.parking_sessions (session_id, lot_id, plate_norm, exit_pass_id, exit_at, closed_at,
                                         status, match_method, closed_reason)
    values (p_pass.pass_id, p_pass.lot_id, p_pass.plate_norm, p_pass.pass_id, p_pass.event_at,
            p_pass.event_at, 'orphan_exit', 'manual', 'override_no_match')
    on conflict (session_id) do nothing;
    o_orphan := true;
    return;
  end if;

  -- exact match against the open set (latest unambiguous entry)
  select count(*) into n_exact from public.parking_sessions
   where lot_id = p_pass.lot_id and status = 'open' and plate_norm = p_pass.plate_norm
     and entry_at <= p_pass.event_at - min_dwell;
  if n_exact > 0 then
    select * into s from public.parking_sessions
     where lot_id = p_pass.lot_id and status = 'open' and plate_norm = p_pass.plate_norm
       and entry_at <= p_pass.event_at - min_dwell
     order by entry_at desc limit 1;
    update public.parking_sessions
       set exit_pass_id = p_pass.pass_id, exit_at = p_pass.event_at, closed_at = p_pass.event_at,
           status = 'closed', match_method = 'exact', match_score = 1,
           is_bounce = (p_pass.event_at - entry_at) < bounce_max
     where session_id = s.session_id;
    return;
  end if;

  -- fuzzy: score every open candidate (the open set is <= capacity, so this is cheap)
  for c in
    select se.session_id, ps.plate_norm, ps.char_conf, ps.plate_alternates
      from public.parking_sessions se
      join public.passes ps on ps.pass_id = se.entry_pass_id
     where se.lot_id = p_pass.lot_id and se.status = 'open'
       and se.entry_at <= p_pass.event_at - min_dwell
       and extensions.levenshtein(left(engine.plate_key(se.plate_norm), 255), left(engine.plate_key(p_pass.plate_norm), 255)) <= 3
  loop
    sc := engine.match_score(c.plate_norm, c.char_conf, c.plate_alternates,
                             p_pass.plate_norm, p_pass.char_conf, p_pass.plate_alternates);
    if length(p_pass.plate_norm) <= 4 then sc := least(sc, t_review); end if;   -- never auto-match short plates
    if sc > best_s then second_s := best_s; best_s := sc; best_id := c.session_id;
    elsif sc > second_s then second_s := sc; end if;
  end loop;

  if best_id is not null and best_s >= t_auto and best_s - second_s >= margin then
    update public.parking_sessions
       set exit_pass_id = p_pass.pass_id, exit_at = p_pass.event_at, closed_at = p_pass.event_at,
           status = 'closed', match_method = 'fuzzy', match_score = best_s,
           is_bounce = (p_pass.event_at - entry_at) < bounce_max
     where session_id = best_id;
  elsif best_id is not null and best_s >= t_review then
    -- best guess: counts as gone, but waits for an admin decision
    update public.parking_sessions
       set exit_pass_id = p_pass.pass_id, exit_at = p_pass.event_at, closed_at = p_pass.event_at,
           status = 'pending_review', match_method = 'fuzzy_pending', match_score = best_s,
           is_bounce = (p_pass.event_at - entry_at) < bounce_max
     where session_id = best_id;
  else
    insert into public.parking_sessions (session_id, lot_id, plate_norm, exit_pass_id, exit_at, closed_at,
                                         status, match_score)
    values (p_pass.pass_id, p_pass.lot_id, p_pass.plate_norm, p_pass.pass_id, p_pass.event_at,
            p_pass.event_at, 'orphan_exit', nullif(best_s, 0))
    on conflict (session_id) do nothing;
    o_orphan := true;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Rewind + replay (doc 03 §6)
-- ---------------------------------------------------------------------------
create or replace function engine.rebuild_lot(p_lot text, p_from timestamptz, p_broadcast boolean default true)
returns int language plpgsql as $$
declare
  t timestamptz := p_from - make_interval(secs => engine.setting(p_lot, 'dedup_window_s', 30) * 2);
  expire_after interval := make_interval(days => engine.setting(p_lot, 'expire_after_d', 30)::int);
  st record; raw int := 0; unseen real := 0; n_in int := 0; n_out int := 0; anchor timestamptz; s2 int;
  inp record; p public.passes; r public.plate_reads; res record; processed int := 0;
  last_row public.occupancy_timeline;
begin
  perform pg_advisory_xact_lock(hashtext('lot:' || p_lot));
  begin perform engine.maybe_refresh_survival(p_lot);   -- defined in the estimator migration
  exception when undefined_function then null; end;

  -- 1. rewind passes (reads keep their data; only their grouping is redone)
  update public.plate_reads set pass_id = null where lot_id = p_lot and event_at >= t;
  delete from public.passes ps where ps.lot_id = p_lot and ps.event_at >= t
     and not exists (select 1 from public.plate_reads r2 where r2.pass_id = ps.pass_id);
  for p in select * from public.passes where lot_id = p_lot and event_at >= t - interval '2 minutes' loop
    perform engine.refresh_pass(p.pass_id);   -- passes straddling t lost some reads
  end loop;

  -- 2. rewind sessions
  delete from public.parking_sessions where lot_id = p_lot and entry_at >= t;
  delete from public.parking_sessions where lot_id = p_lot and status = 'orphan_exit' and exit_at >= t;
  update public.parking_sessions
     set status = 'open', exit_pass_id = null, exit_at = null, closed_at = null,
         match_method = null, match_score = null, closed_reason = null, is_bounce = false
   where lot_id = p_lot and closed_at >= t and status <> 'orphan_exit';

  -- 3. rewind the occupancy timeline and restore the state just before t
  delete from public.occupancy_timeline where lot_id = p_lot and valid_from >= t;
  select * into last_row from public.occupancy_timeline
   where lot_id = p_lot order by valid_from desc, seq desc limit 1;
  if found then
    raw := last_row.raw_occupancy; unseen := last_row.unseen; n_in := last_row.n_in; n_out := last_row.n_out;
    anchor := last_row.anchor_at;
  end if;

  -- 4. rebuild passes from reads >= t, in time order
  for r in select * from public.plate_reads where lot_id = p_lot and event_at >= t order by event_at, read_id loop
    perform engine.assign_read_to_pass(r);
  end loop;

  -- 5. replay passes + calibrations in time order
  for inp in
    select 'pass' kind, ps.event_at at, ps.pass_id id, null::bigint cal_id
      from public.passes ps where ps.lot_id = p_lot and ps.event_at >= t
    union all
    select 'calibration', c.at, null, c.calibration_id
      from public.occupancy_calibrations c where c.lot_id = p_lot and c.at >= t
    order by 2, 1 desc   -- passes before a calibration at the same instant
  loop
    if inp.kind = 'pass' then
      select * into p from public.passes where pass_id = inp.id;
      select * into res from engine.process_pass(p);
      raw := raw + res.o_delta;
      if res.o_orphan and unseen >= 1 then unseen := unseen - 1; end if;   -- an unseen car left   -- an unseen car left
      if p.direction = 'in' then n_in := n_in + 1; else n_out := n_out + 1; end if;
      perform engine.push_timeline(p_lot, p.event_at, raw, unseen, n_in, n_out, anchor,
                                   case when res.o_reentry then 'reentry' else p.direction end, p.pass_id);
    else
      select * into st from public.occupancy_calibrations where calibration_id = inp.cal_id;
      update public.parking_sessions
         set status = 'closed_admin', closed_at = st.at, closed_reason = 'reconcile'
       where lot_id = p_lot and status = 'open' and session_id = any (st.closed_session_ids);
      -- the visual count is ground truth at that instant: if later admin decisions reopened sessions
      -- that were not in the original list, close the oldest extras so the count still holds on replay
      update public.parking_sessions
         set status = 'closed_admin', closed_at = st.at, closed_reason = 'reconcile_replay'
       where session_id in (select session_id from public.parking_sessions
                             where lot_id = p_lot and status = 'open'
                             order by entry_at
                             limit greatest((select count(*) from public.parking_sessions
                                              where lot_id = p_lot and status = 'open') - st.visual_count, 0));
      select count(*) into s2 from public.parking_sessions where lot_id = p_lot and status = 'open';
      -- anchor so the estimate equals the visual count at this instant (kept sessions may carry ghost probability)
      raw := st.visual_count; n_in := 0; n_out := 0; anchor := st.at;
      unseen := st.visual_count - s2;   -- kept sessions are confirmed present now (ghost prob restarts at 0)
      perform engine.push_timeline(p_lot, st.at, raw, unseen, 0, 0, anchor, 'calibration', null);
    end if;
    processed := processed + 1;
  end loop;

  -- 6. the only automatic closure: 30-day bound (D2/D6)
  update public.parking_sessions
     set status = 'expired', closed_at = entry_at + expire_after, closed_reason = 'retention_bound'
   where lot_id = p_lot and status = 'open' and entry_at + expire_after < now();

  if p_broadcast then perform engine.broadcast_update(p_lot, null); end if;
  return processed;
end $$;

-- compact live state for the realtime channel (CONTRACT §4)
create or replace function engine.broadcast_update(p_lot text, p_pass jsonb)
returns void language plpgsql as $$
declare tl public.occupancy_timeline; cap int := engine.capacity_at(p_lot, now()); eff real;
begin
  select * into tl from public.occupancy_timeline where lot_id = p_lot order by valid_from desc, seq desc limit 1;
  eff := engine.setting(p_lot, 'effective_pct', 0.85);
  perform engine.safe_broadcast('lot:' || p_lot, 'update', jsonb_build_object(
    'occupancy', coalesce(tl.occupancy, 0), 'band_low', coalesce(tl.band_low, 0),
    'band_high', coalesce(tl.band_high, 0), 'open_sessions', coalesce(tl.open_sessions, 0),
    'capacity', cap, 'state', engine.occupancy_state(coalesce(tl.occupancy, 0), cap, eff),
    'ts', coalesce(tl.valid_from, now()), 'pass', p_pass));
end $$;

create or replace function engine.occupancy_state(p_occ int, p_cap int, p_eff real)
returns text language sql immutable as $$
  select case when p_occ >= p_cap * 0.98 then 'full'
              when p_occ >= p_cap * p_eff then 'effectively_full'
              when p_occ >= p_cap * 0.60 then 'filling'
              else 'available' end
$$;

-- ---------------------------------------------------------------------------
-- Ingest trigger (doc 04 §4.1): validate, normalize, rebuild from capture time.
-- Engine failures are recorded, never allowed to fail the upload.
-- ---------------------------------------------------------------------------
create or replace function engine.on_event_insert()
returns trigger language plpgsql security definer set search_path = public, engine, extensions as $$
declare
  cam public.cameras; plate text; alts jsonb; conf real[]; q text;
  pass_json jsonb;
begin
  if new.schema_version is distinct from 2 then
    insert into public.ingest_errors (event_id, kind, detail)
    values (new.event_id, 'bad_schema_version', 'schema_version=' || coalesce(new.schema_version::text, 'null'));
    return new;
  end if;
  select * into cam from public.cameras where camera_id = new.camera_id and active;
  if not found then
    insert into public.ingest_errors (event_id, kind, detail)
    values (new.event_id, 'unknown_camera', 'camera_id=' || coalesce(new.camera_id, 'null'));
    return new;
  end if;
  if new.captured_at_utc > now() + interval '5 minutes' then
    insert into public.ingest_errors (event_id, kind, detail)
    values (new.event_id, 'clock_skew', 'captured_at_utc ahead of server by '
            || (new.captured_at_utc - now())::text);
  end if;

  plate := engine.plate_norm(new.plate_text);
  select array_agg(v::real order by o) into conf
    from jsonb_array_elements_text(coalesce(new.plate_confidence_per_char, '[]')) with ordinality as a(v, o);
  alts := engine.alternates_from_reads(new.reads, plate);
  q := case when coalesce(new.plate_confidence, 0) >= 0.90 and coalesce(new.num_frames_used_for_consensus, 0) >= 20 then 'high'
            when coalesce(new.plate_confidence, 0) >= 0.75 then 'medium' else 'low' end;

  insert into public.plate_reads (read_id, lot_id, camera_id, direction, event_at, plate_raw, plate_norm,
                                  plate_alternates, plate_confidence, char_conf, num_frames_used, quality, image_path)
  values (new.event_id, cam.lot_id, cam.camera_id, cam.direction, new.captured_at_utc, new.plate_text, plate,
          alts, new.plate_confidence, conf, new.num_frames_used_for_consensus, q, new.image_path)
  on conflict (read_id) do nothing;

  begin
    perform engine.rebuild_lot(cam.lot_id, new.captured_at_utc, false);
    select jsonb_build_object('pass_id', ps.pass_id, 'direction', ps.direction, 'event_at', ps.event_at,
                              'plate_norm', ps.plate_norm, 'plate_confidence', ps.plate_confidence,
                              'quality', ps.quality, 'read_id', new.event_id, 'image_path', new.image_path)
      into pass_json
      from public.plate_reads r join public.passes ps on ps.pass_id = r.pass_id
     where r.read_id = new.event_id;
    perform engine.broadcast_update(cam.lot_id, pass_json);
  exception when others then
    insert into public.ingest_errors (event_id, kind, detail) values (new.event_id, 'engine_error', sqlerrm);
  end;
  return new;
end $$;

create trigger events_ingest after insert on public.events
  for each row execute function engine.on_event_insert();
