-- pgTAP scenario tests for the session engine (plan doc 10 §2). Run: supabase test db
-- Everything happens in an isolated lot inside a rolled-back transaction.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions, engine;
select plan(33);

insert into public.lots (lot_id, name, capacity) values ('t_lot', 'Test lot', 10);
insert into public.cameras (camera_id, lot_id, direction, device_id) values
  ('t_in', 't_lot', 'in', 't-dev-in'), ('t_out', 't_lot', 'out', 't-dev-out');

create function pg_temp.ev(cam text, plate text, at timestamptz, conf real default 0.97, id uuid default gen_random_uuid())
returns uuid language sql as $$
  insert into public.events (event_id, schema_version, event_type, camera_id, device_id, captured_at_utc, timestamp_utc,
     plate_text, plate_confidence, plate_confidence_per_char, num_frames_used_for_consensus, reads, image_path)
  values (id, 2, 'plate_track_finalized', cam, 'dev', at, at + interval '4 s', plate, conf,
          (select jsonb_agg(conf) from generate_series(1, length(plate))), 100,
          jsonb_build_array(jsonb_build_object('frame_index', 1, 'text', plate, 'confidence', conf, 'clean', true)),
          id || '.jpg')
  on conflict (event_id) do nothing
  returning id
$$;
create function pg_temp.t(p text) returns timestamptz language sql as $$
  select date_trunc('day', now() - interval '3 days') + p::interval $$;
create function pg_temp.occ() returns int language sql as $$
  select occupancy from engine.timeline_at('t_lot', 'infinity') $$;
create function pg_temp.st(p text) returns text language sql as $$
  select string_agg(status || '/' || coalesce(match_method, '-'), ',' order by coalesce(entry_at, exit_at))
    from public.parking_sessions where lot_id = 't_lot' and plate_norm = p $$;

-- similarity primitives -------------------------------------------------------
select ok(engine.plate_similarity('Z94PVE', 'Z94PWE') > 0.9, 'confusable V/W is cheap');
select ok(engine.plate_similarity('ABC1234', 'XYZ9876') < 0.3, 'different plates score low');
select ok(engine.plate_similarity('Z94PVE', '94PVE') > 0.8, 'dropped leading char tolerated');
select is(engine.plate_norm(' abc-12Ø4 '), 'ABC1204', 'normalization strips separators and slashed zero');

-- 1 happy path + 2 near-miss ---------------------------------------------------
select pg_temp.ev('t_in', 'AAA1111', pg_temp.t('08:00'));
select pg_temp.ev('t_out', 'AAA1111', pg_temp.t('10:00'));
select is(pg_temp.st('AAA1111'), 'closed/exact', 'happy path: exact match');
select pg_temp.ev('t_in', 'Z94PVE', pg_temp.t('08:05'));
select pg_temp.ev('t_out', 'Z94PWE', pg_temp.t('11:00'), 0.9);
select is(pg_temp.st('Z94PVE'), 'closed/fuzzy', 'OCR near-miss: fuzzy match');

-- 3 ambiguous twins -> review ---------------------------------------------------
select pg_temp.ev('t_in', 'ABC1234', pg_temp.t('08:10'));
select pg_temp.ev('t_in', 'ABC1284', pg_temp.t('08:11'));
select pg_temp.ev('t_out', 'ABC12B4', pg_temp.t('12:00'), 0.8);
select is((select count(*)::int from parking_sessions where lot_id = 't_lot' and status = 'pending_review'), 1,
          'ambiguous twins: never auto-matched (pending review)');

-- 4 fragment merge, 5 close-following not merged ------------------------------
select pg_temp.ev('t_in', 'FRG7777', pg_temp.t('09:00:00'));
select pg_temp.ev('t_in', 'RG7777', pg_temp.t('09:00:04'), 0.6);
select is((select count(*)::int from passes where lot_id = 't_lot' and plate_norm in ('FRG7777', 'RG7777')), 1,
          'fragmented track merged into one pass');
select pg_temp.ev('t_in', 'CLS1000', pg_temp.t('09:10:00'));
select pg_temp.ev('t_in', 'XYZ9999', pg_temp.t('09:10:02'));
select is((select count(*)::int from passes where lot_id = 't_lot' and plate_norm in ('CLS1000', 'XYZ9999')), 2,
          'two different cars 2 s apart stay separate');

-- 6 re-entry closes the old session ---------------------------------------------
select pg_temp.ev('t_in', 'REE5555', pg_temp.t('07:00'));
select pg_temp.ev('t_in', 'REE5555', pg_temp.t('1 day 07:00'));
select is(pg_temp.st('REE5555'), 'closed_inferred/-,open/-', 're-entry closes the earlier session as inferred');

-- 7 orphan exit -------------------------------------------------------------------
select pg_temp.ev('t_out', 'ORP0001', pg_temp.t('13:00'));
select is(pg_temp.st('ORP0001'), 'orphan_exit/-', 'exit without candidate becomes orphan');

-- 14 bounce -------------------------------------------------------------------------
select pg_temp.ev('t_in', 'BNC2222', pg_temp.t('14:00:00'));
select pg_temp.ev('t_out', 'BNC2222', pg_temp.t('14:01:30'));
select ok((select is_bounce from parking_sessions where lot_id = 't_lot' and plate_norm = 'BNC2222'), 'quick in/out flagged as bounce');

-- 10 duplicate delivery -----------------------------------------------------------
select pg_temp.ev('t_in', 'DUP3333', pg_temp.t('15:00'), 0.97, '00000000-0000-0000-0000-000000000001');
select pg_temp.ev('t_in', 'DUP3333', pg_temp.t('15:00'), 0.97, '00000000-0000-0000-0000-000000000001');
select is((select count(*)::int from plate_reads where lot_id = 't_lot' and plate_norm = 'DUP3333'), 1, 'duplicate event_id is a no-op');

-- 8 late arrival gives the same result as in-order ------------------------------
select pg_temp.ev('t_out', 'LATE888', pg_temp.t('16:00'));            -- exit arrives first (orphan for now)
select is(pg_temp.st('LATE888'), 'orphan_exit/-', 'exit uploaded before its entry is orphan at first');
select pg_temp.ev('t_in', 'LATE888', pg_temp.t('12:00'));              -- late entry (captured earlier)
select is(pg_temp.st('LATE888'), 'closed/exact', 'late entry is re-sequenced and pairs with the exit');

-- occupancy bookkeeping ------------------------------------------------------------
select is((select raw_occupancy from engine.timeline_at('t_lot', 'infinity')),
          (select (count(*) filter (where direction = 'in') - count(*) filter (where direction = 'out')
                   - (select count(*) from parking_sessions where lot_id = 't_lot' and status = 'closed_inferred'))::int
             from passes where lot_id = 't_lot'), 'S1 (flow cross-check) = entries - exits - re-entry corrections');
select ok((select expected_ghosts > 0 and occupancy < open_sessions from engine.timeline_at('t_lot', 'infinity')),
          'sessions open far longer than typical stays are discounted as probable missed exits');
select ok((select band_high >= occupancy and band_low <= occupancy from engine.timeline_at('t_lot', 'infinity')),
          'band brackets the estimate');

-- 12 admin reconciliation --------------------------------------------------------
set local request.jwt.claims = '{"role":"authenticated","email":"admin@test","app_metadata":{"role":"admin"}}';
select is((reconcile_preview('t_lot', 1) ->> 'to_close_count')::int,
          (select count(*)::int from parking_sessions where lot_id = 't_lot' and status = 'open') - 1,
          'preview proposes open - visual count sessions');
select reconcile_commit('t_lot', 1,
  array(select (e ->> 'session_id')::uuid from jsonb_array_elements(reconcile_preview('t_lot', 1) -> 'proposed') e), 'test');
select is(pg_temp.occ(), 1, 'reconciliation re-anchors S1 to the visual count');
select is((select count(*)::int from parking_sessions where lot_id = 't_lot' and status = 'open'), 1,
          'reconciliation closes the residue so S2 = visual count');
select is((select band_high - band_low from engine.timeline_at('t_lot', 'infinity')), 0, 'band collapses after reconciliation');
select ok((select count(*) > 0 from parking_sessions where lot_id = 't_lot' and status = 'closed_admin'), 'residue closed as closed_admin');

-- 13 override survives recompute ---------------------------------------------------
select resolve_match((select exit_pass_id from parking_sessions where lot_id = 't_lot' and status = 'pending_review' limit 1),
                     (select entry_pass_id from parking_sessions where lot_id = 't_lot' and plate_norm = 'ABC1234'), 'chose 1234');
select is(pg_temp.st('ABC1234'), 'closed/manual', 'admin decision applied');
select engine.rebuild_lot('t_lot', pg_temp.t('00:00'), false);
select is(pg_temp.st('ABC1234'), 'closed/manual', 'admin decision survives a full rebuild');
select is(pg_temp.occ(), 1, 'calibration replays during rebuild and still honours the visual count');
select reconcile_commit('t_lot', 3, '{}', 'two cars we never read');
select is(pg_temp.occ(), 3, 'visual count above open sessions => unseen cars counted');
select pg_temp.ev('t_out', 'NEVERSEEN1', now() + interval '1 second');
select is(pg_temp.occ(), 2, 'an unseen car leaving (orphan exit) decrements the unseen offset');

-- 18/20 contract validation ------------------------------------------------------
reset request.jwt.claims;
insert into public.events (event_id, schema_version, event_type, camera_id, device_id, captured_at_utc, timestamp_utc, plate_text)
values (gen_random_uuid(), 1, 'plate_track_finalized', 't_in', 'd', now(), now(), 'OLD0001'),
       (gen_random_uuid(), 2, 'plate_track_finalized', 'nope_cam', 'd', now(), now(), 'UNK0001');
select is((select count(*)::int from ingest_errors where kind in ('bad_schema_version', 'unknown_camera')
            and detail in ('schema_version=1', 'camera_id=nope_cam')), 2, 'bad schema / unknown camera quarantined');
select is((select count(*)::int from plate_reads where plate_norm in ('OLD0001', 'UNK0001')), 0, 'quarantined events do not affect occupancy');

-- role enforcement --------------------------------------------------------------
set local request.jwt.claims = '{"role":"authenticated","email":"staff@test","app_metadata":{"role":"staff"}}';
set local role authenticated;
select throws_ok($$select reconcile_commit('t_lot', 0, '{}', null)$$, '42501', null, 'staff cannot reconcile');
select throws_ok($$select resolve_match(gen_random_uuid(), null, null)$$, '42501', null, 'staff cannot resolve matches');
select lives_ok($$select get_live_snapshot('t_lot')$$, 'staff can read the live snapshot');
reset role;

select * from finish();
rollback;
