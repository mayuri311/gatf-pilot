-- occupancy_analyzer — bias-corrected occupancy estimator (plan doc 03 §5, revised from simulator evidence)
--
-- Simulator finding (plan doc 14): pair recall is ~100 % when both cameras read a car, so open
-- sessions (S2) are the best base signal — but they drift UP with every missed exit ("ghost"
-- sessions) and DOWN for every car whose entry was missed. Instead of hoping those cancel (the flow
-- count S1 does that, with a random-walk error), we estimate both explicitly:
--
--   P(ghost | open for age a) = m_out·F(a) / (m_out·F(a) + (1 − m_out)·S(a))
--       S(a) = share of real stays longer than a (dwell survival), F = 1 − S
--   estimate = S2 − Σ P(ghost) + S2_since_anchor · m_in/(1 − m_in) + unseen
--   variance = Σ P(1 − P) + S2_since_anchor · m_in/(1 − m_in)²
--
-- S(a) comes from the lot's own closed sessions (last 28 days) once there are enough of them,
-- otherwise from a prior shaped like a mixed commuter/visitor lot.

alter table public.occupancy_timeline add column if not exists expected_ghosts real not null default 0;
alter table public.occupancy_timeline add column if not exists expected_missed_in real not null default 0;

create table if not exists engine.dwell_survival (
  lot_id       text not null,
  age_h        numeric not null,      -- 0, 0.5, 1, ... 72
  survival     real not null,         -- share of stays longer than age_h
  source       text not null,         -- 'history' | 'prior'
  refreshed_at timestamptz not null default now(),
  primary key (lot_id, age_h)
);
grant all on engine.dwell_survival to service_role;

create or replace function engine.refresh_survival(p_lot text)
returns text language plpgsql as $$
declare n int;
begin
  select count(*) into n from public.parking_sessions
   where lot_id = p_lot and status = 'closed' and not is_bounce and exit_at > now() - interval '28 days';
  delete from engine.dwell_survival where lot_id = p_lot;
  if n >= 200 then
    insert into engine.dwell_survival (lot_id, age_h, survival, source)
    select p_lot, a, greatest((select count(*) filter (where extract(epoch from exit_at - entry_at) / 3600 > a)::real
                                      / count(*)
                                 from public.parking_sessions
                                where lot_id = p_lot and status = 'closed' and not is_bounce
                                  and exit_at > now() - interval '28 days'), 0.002), 'history'
      from generate_series(0, 72, 0.5) a;
    return 'history';
  end if;
  -- prior: short visits, half-day stays, commuters up to ~10 h, small overnight tail
  insert into engine.dwell_survival (lot_id, age_h, survival, source)
  select p_lot, a,
         greatest(case when a <= 1 then 1 - 0.30 * a
                       when a <= 3 then 0.70 - 0.12 * (a - 1)
                       when a <= 8 then 0.46 - 0.03 * (a - 3)
                       when a <= 10 then 0.31 - 0.13 * (a - 8)
                       when a <= 12 then 0.05 - 0.01 * (a - 10)
                       when a <= 40 then 0.03 - 0.0009 * (a - 12)
                       else 0.004 end, 0.002), 'prior'
    from generate_series(0, 72, 0.5) a;
  return 'prior';
end $$;

create or replace function engine.survival_at(p_lot text, p_age interval)
returns real language sql stable as $$
  select survival from engine.dwell_survival
   where lot_id = p_lot and age_h = least(greatest(floor(extract(epoch from p_age) / 1800) / 2, 0), 72)
$$;

-- P(the car already left unseen). p_age0 = age at which the car was last CONFIRMED present
-- (an admin kept it at a reconciliation); survival is then conditional on reaching p_age0.
create or replace function engine.ghost_prob(p_lot text, p_age interval, p_m_out real, p_age0 interval default null)
returns real language sql stable as $$
  with s as (select least(engine.survival_at(p_lot, p_age)
                          / coalesce(nullif(engine.survival_at(p_lot, p_age0), 0), 1), 1) v)
  select (p_m_out * (1 - v)) / nullif(p_m_out * (1 - v) + (1 - p_m_out) * v, 0) from s
$$;


-- learned distribution goes stale as history grows: refresh at most hourly, and immediately once
-- enough history exists to replace the prior
create or replace function engine.maybe_refresh_survival(p_lot text)
returns void language plpgsql as $$
declare r record;
begin
  select max(refreshed_at) at, bool_or(source = 'prior') prior into r from engine.dwell_survival where lot_id = p_lot;
  if r.at is null or r.at < now() - interval '1 hour'
     or (r.prior and r.at < now() - interval '5 minutes'
         and (select count(*) from public.parking_sessions where lot_id = p_lot and status = 'closed') >= 200) then
    perform engine.refresh_survival(p_lot);
  end if;
end $$;

create or replace function engine.push_timeline(
  p_lot text, p_at timestamptz, p_raw int, p_unseen real, p_n_in int, p_n_out int, p_anchor timestamptz,
  p_cause text, p_pass uuid)
returns void language plpgsql as $$
declare
  cap int := engine.capacity_at(p_lot, p_at);
  m_in real := engine.setting(p_lot, 'miss_rate_in', 0.02);
  m_out real := engine.setting(p_lot, 'miss_rate_out', 0.03);
  s2 int; s2_post int; g real; g_var real; g_lo real; g_hi real; miss_in real; est real; half int; occ int;
begin
  if not exists (select 1 from engine.dwell_survival where lot_id = p_lot) then
    perform engine.refresh_survival(p_lot);
  end if;
  select count(*),
         count(*) filter (where p_anchor is null or entry_at > p_anchor),
         coalesce(sum(gp), 0), coalesce(sum(gp * (1 - gp)), 0), coalesce(sum(gp_lo), 0), coalesce(sum(gp_hi), 0)
    into s2, s2_post, g, g_var, g_lo, g_hi
    from (select entry_at,
                 coalesce(engine.ghost_prob(p_lot, p_at - entry_at, m_out, a0), 0) gp,
                 coalesce(engine.ghost_prob(p_lot, p_at - entry_at, (m_out * 0.5)::real, a0), 0) gp_lo,
                 coalesce(engine.ghost_prob(p_lot, p_at - entry_at, least(m_out * 1.5, 0.5)::real, a0), 0) gp_hi
            from (select entry_at, case when p_anchor is not null and entry_at < p_anchor then p_anchor - entry_at end a0
                    from public.parking_sessions
                   where lot_id = p_lot and status = 'open' and entry_at <= p_at) x) o;
  miss_in := s2_post * m_in / (1 - m_in);
  est := s2 - g + miss_in + p_unseen;
  -- sampling variance + uncertainty in the miss rates themselves (m × 0.5 … m × 1.5). The parameter term is
  -- the actual spread of the ghost sum, so near-certain ghosts (open for days) add almost nothing, while
  -- ambiguous ones (a few hours past a typical stay) carry the doubt. Without it: 78 % coverage in simulation.
  half := ceil(1.96 * sqrt(g_var + s2_post * m_in / power(1 - m_in, 2) + power((g_hi - g_lo) / 2, 2) + power(0.5 * miss_in, 2))
               + case when g + miss_in > 0.5 then 1 else 0 end);   -- +1: rounding / pass-timing slack once any correction is active
  occ := greatest(0, least(cap, round(est)::int));
  insert into public.occupancy_timeline (lot_id, valid_from, occupancy, raw_occupancy, unseen, band_low, band_high,
                                         open_sessions, n_in, n_out, anchor_at, cause, cause_pass_id,
                                         expected_ghosts, expected_missed_in)
  values (p_lot, p_at, occ, p_raw, p_unseen, greatest(0, occ - half), least(cap, occ + half), s2,
          p_n_in, p_n_out, p_anchor, p_cause, p_pass, round(g::numeric, 2), round(miss_in::numeric, 2));
end $$;

-- hourly: re-learn the dwell distribution from the lot's own history
do $$
begin
  perform cron.schedule('oa_refresh_survival', '7 * * * *',
    $c$select engine.refresh_survival(lot_id) from public.lots$c$);
exception when others then
  raise notice 'pg_cron not available: %', sqlerrm;
end $$;
