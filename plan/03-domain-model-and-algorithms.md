# 03 — Domain Model & Core Algorithms

> Updated for the stakeholder decisions in [doc 12](12-decisions-and-constraints.md): admin-driven reconciliation instead of automatic resets (D2), overnight stays flagged but never dropped (D3), no barrier-specific rules (D10), no vehicle lists (D5).
>
> How raw plate reads become **parking sessions**, and how sessions become **occupancy**. This is the heart of the backend — every chart in the dashboard is downstream of it. Getting this right (and *honest about uncertainty*) matters more than any UI feature.

---

## 1. Domain vocabulary

| Term | Meaning |
|---|---|
| **Read** (`plate_reads`) | One finalized plate track from one camera = one `event.json`. Has `direction` (`in`/`out`, derived from `camera_id`), `event_at`, `plate_text`, confidences, alternates. |
| **Pass** | A physical vehicle passing a camera once. Usually 1 read; sometimes 2+ reads (tracker fragmentation) → de-duplicated into one *pass*. |
| **Session** (`parking_sessions`) | One stay in the lot: an **entry pass** paired with (eventually) an **exit pass**. Session id = entry read's `event_id` (deterministic, so re-derivation is stable). |
| **Orphan exit** | Exit pass that could not be paired with any open session (entry was missed/misread, or the vehicle entered before the system started). |
| **Suspect-stale session** | Open session older than `suspect_stale_after_h` (default 24 h). The exit was probably missed, *or* the car really is still there, since overnight and multi-day stays happen (D3). Flagged, still counted, cleared only by the admin during reconciliation. |
| **Vehicle** (`vehicles`) | A distinct canonical plate seen ≥ 1 time. Carries notes and stats. No allow/deny lists; every vehicle is treated the same (D5). |
| **Occupancy** | Number of vehicles in the lot at instant *t*. Reported as a **best estimate with a band**, never as a falsely-precise single number. |

### Lifecycle of a session

```
                     exit pass matched (exact/fuzzy ≥ T_auto)
   entry pass ──► OPEN ───────────────────────────────────────► CLOSED
                   │  │                                             ▲
                   │  │ fuzzy score in [T_review, T_auto)           │ admin confirms   
                   │  └──────────────► PENDING_REVIEW ──────────────┘
                   │
                   │ same plate enters again (missed exit)
                   ├────────────────► CLOSED_INFERRED   (exit_at = NULL, exit_reason='reentry')
                   │
                   │ admin reconciliation (visual count) selects it as residue
                   ├────────────────► CLOSED_ADMIN      (exit_at = NULL, closed_reason='reconcile')
                   │
                   │ age > 30 d (plaintext retention horizon) — the ONLY automatic closure
                   └────────────────► EXPIRED           (safety bound, kept for audit)

   flags on OPEN sessions (no state change): suspect_stale (> 24 h), overnight, multi_day

   exit pass, no candidate ≥ T_review ──► ORPHAN_EXIT (session row with entry_at = NULL)
```

---

## 2. Normalization (on insert, per read)

1. `plate_raw` = producer `plate_text` (kept verbatim, never mutated).
2. `plate_norm` = upper-case, map `Ø`→`0` (the 2024+ PA "Let Freedom Ring" base uses slashed zeros and no hyphen), strip everything not `[A-Z0-9]`.
3. `plate_key` = **confusion-collapsed blocking key** — maps visually ambiguous glyphs to one representative so near-misses land in the same index bucket:
   `O,Q,D → 0`  `I,L → 1`  `Z → 2`  `S → 5`  `B → 8`  `G → 6`  `F → P`  `W,N → V`  `M → N`(→V)  `U → V`?(evaluate)
   *Used only for candidate retrieval (index lookup), never for display or for the final match decision.*
4. `plate_alternates` = top-k (k=5) distinct **clean** strings from `reads[]`, weighted by Σ confidence, normalized to sum 1. Example from the template track: `Z94PVE 0.71, Z94PWE 0.12, Z94FWE 0.06, 294PVE 0.04, Z94FVE 0.02`. This is free extra signal the producer already ships — it lets an exit read `Z94PWE` match an entry whose consensus was `Z94PVE` with *evidence*, not guesswork.
5. `format_match` = which known plate syntax (PA passenger, PA other classes, other states — see doc 02 §plate formats) the string fits, if any. Used as a **soft prior**, never to reject or rewrite. The sample plate `Z94PVE` (6 chars) is not PA passenger format — out-of-state and specialty plates are normal.
6. `quality` tier: `high` (conf ≥ 0.90 and ≥ 20 consensus frames), `medium` (≥ 0.75), `low` (otherwise). Thresholds are config, tuned from ground truth (doc 10).
7. `event_at` = `captured_at_utc`, required in event contract v2 (doc 13). This fixes gap G5.

---

## 3. De-duplication (reads → passes)

Fragmentation produces two reads of one physical pass within seconds on the **same camera**.

```
for new read r on camera c:
    window = reads on c with |event_at - r.event_at| ≤ DEDUP_WINDOW (default 30 s; ParkPow merges same-camera visits within "a few seconds")
    best   = argmax similarity(r, w) over window
    if best and similarity ≥ DEDUP_SIM (0.80)  OR  frame ranges adjacent (gap ≤ 15 frames, same source):
        attach r to best.pass_id  (pass keeps the read with highest plate_confidence × num_frames_used as primary)
    else:
        new pass
```

Notes
- Two *different* cars can pass within 15 s (tailgating at the gate). That is why similarity is required, not just time — a short/empty fragment (e.g. `'77M'`) that does not resemble anything is kept as its own low-quality pass and flagged `possible_fragment`, mirroring the producer's "warn, don't silently merge" philosophy.
- Fragment reads are kept (never deleted) and visible in the read-level audit UI.
- **Rejected / unreadable tracks are not uploaded** (D24, bare minimum): they stay in the producer's local `rejected_dir`. The vehicles they represent are missed reads. The uncertainty band and admin reconciliation absorb that error. Uploading them as unknown-plate passes could be revisited after the pilot.

---

## 4. Matching an exit to an entry (the hard part)

### 4.1 Similarity function

Confusion-aware, confidence-weighted Damerau–Levenshtein over plate strings:

```
sub_cost(a, b, conf_a, conf_b):
    if a == b:                return 0
    if {a,b} in CONFUSABLE:   base = 0.25      # 0/O/D/Q, 1/I/L/7, 2/Z, 5/S, 8/B, 6/G, P/F/R, V/W/N/M/U, E/F, C/G
    else:                     base = 1.0
    # a low-confidence character is cheap to overrule; a 0.99 character is not
    return base * (0.4 + 0.6 * min(conf_a, conf_b))

ins_cost = del_cost = 0.7       # missing leading/trailing char is the most common OCR failure ('94PVE')
transposition = 0.6

similarity(x, y) = 1 - dist(x, y) / max(len(x), len(y))
```

Then use the alternates from **both** sides:

```
match_score(entry, exit) =
    max over (a_i ∈ entry.alternates, b_j ∈ exit.alternates) of
        similarity(a_i, b_j) * (0.7 + 0.3 * sqrt(w_i * w_j) / max_w)   # evidence-weighted
    + 0.05 if both reads fit the same plate format
```

**Syntax prior example:** for the template track, `294PVE` and `Z94PVE` differ by one confusable character. Only `Z94PVE` fits New Jersey's `A12BCD` pattern, so it wins. When a hypothesis fits a pattern except at confusable positions, add a **position-coerced variant** to the hypothesis set rather than replacing the original. In letter positions use 0→O, 1→I, 2→Z, 5→S, 8→B, 6→G; in digit positions use the inverse.

**Learned confusion matrix.** Every high-confidence exact or fuzzy match yields aligned (entry char, exit char) samples. Re-estimate `P(observed | true)` **per camera** monthly and replace the static `CONFUSABLE` weights with it. This is Oliveira-Neto's "character association matrix". In that work, edit distance plus timing matched ~97 % of vehicles between two LPR sites even though only ~60 % of plates were read correctly at each site ([TRID 882032](https://trid.trb.org/View/882032), [dissertation](https://trace.tennessee.edu/utk_graddiss/836)).

Guard rails borrowed from Genetec's OCR-equivalence matcher ([docs](https://techdocs.genetec.com/r/en-US/Security-Center-Administrator-Guide-5.13/ALPR-matcher-technique-OCR-equivalence)):
- Never allow more than **2 confusable substitutions** for an auto-match.
- Never fuzzy-match plates of ≤ 4 characters.

The exact weights are **starting values**; doc 10 describes how to fit them from labeled pairs (a small logistic regression over features {edit distance, confusable-sub count, min char conf, alternates overlap, dwell} works well and is easy to explain).

### 4.2 Candidate set and decision

```
on new exit pass x at time t:
    C = open sessions s with
          s.entry_at ≤ t - MIN_DWELL (default 20 s)
          AND (s.plate_key == x.plate_key
               OR levenshtein(s.plate_key, x.plate_key) ≤ 2       -- pg fuzzystrmatch, fast prefilter
               OR s.plate_key % x.plate_key)                       -- pg_trgm similarity, also fast
    score each candidate; sort desc → s1, s2

    if s1 is exact (plate_norm equal):                      MATCH(method='exact')
    elif score(s1) ≥ T_AUTO (0.85) and score(s1) - score(s2) ≥ MARGIN (0.10):
                                                            MATCH(method='fuzzy')
    elif score(s1) ≥ T_REVIEW (0.65):                       MATCH(method='fuzzy_pending') → review queue
    else:                                                   ORPHAN_EXIT
```

- **Uniqueness via the "open set"**: matching is only ever against vehicles *currently believed to be in the lot* (typically ≤ capacity, e.g. 100). That small candidate set is what makes fuzzy matching safe — a near-miss is rarely ambiguous among 100 cars, whereas it would be among a state's millions of plates.
- **Margin rule** protects against two similar plates in the lot simultaneously (e.g. `ABC1234` and `ABC1284`): when two candidates are close, we never auto-pick.
- `fuzzy_pending` sessions **do** count as closed for occupancy (best guess) but surface in a review queue; an admin confirm/reject re-runs matching for that exit (only admins resolve, D22).

### 4.3 Entry side rules

```
on new entry pass e:
    if an OPEN session s exists with exact/fuzzy-auto match to e and s.entry_at < e.at - REENTRY_MIN (5 min):
        close s as CLOSED_INFERRED (exit missed; exit_at NULL, exit_reason='reentry')
    open new session(session_id = e.primary_read_id)
    if e.at - (last orphan exit matching e) < ...:  nothing — orphans are never retro-matched to LATER entries
```

### 4.4 Special patterns worth detecting (become KPIs/alerts)

| Pattern | Rule | Meaning |
|---|---|---|
| **Pass-through / bounce** | session dwell < `BOUNCE_MAX` (5 min) | Driver entered and left — usually *couldn't find a space* (lot effectively full), dropped someone off, or was lost. Bounce rate is a superb "lot is full in practice" signal even when the count says 92%. |
| **Overnight** | session present at 03:00 local (D20: no open-hours config) | Not allowed, but it happens (D3). Shown as a KPI and a list; informational only, no enforcement. |
| **Multi-day** | open dwell > 24 h | Same as overnight. Usually also `suspect_stale`; the admin decides during reconciliation. |
| **Ghost exit** | orphan exit | Missed entry read OR vehicle pre-dated system start. |

*Removed per D10 (no barrier, keep it simple):* the tailgate and U-turn rules. Same-camera de-dup (§3) and the review queue cover those cases well enough for the pilot.

### 4.5 Orphan retry (+ deferred: nightly global re-match)

Online matching is greedy, so it can lock in a wrong pairing.

1. **Orphan retry window (in scope).** An orphan exit stays matchable for 5 min against *new* entries. This absorbs camera clock skew or an exit uploaded before its entry.
2. **Nightly batch re-match: DEFERRED (future, per D10 "keep it simple").** If the review queue proves too busy, add it later. A Python job runs a min-cost bipartite assignment over the day's orphan exits, auto-fuzzy matches and still-open/stale sessions. It uses Hungarian assignment via `scipy.optimize.linear_sum_assignment`.
   - Cost = `wDL + λ·|log dwell − μ_dwell|`.
   - Any cost above 1.5 is treated as infinite.
   - This is the "most probable complete matching" idea of Watling & Maher ([Transp. Res. B 1992](https://ideas.repec.org/a/eee/transb/v26y1992i3p171-193.html)).
   - Changes are written as `match_overrides(source='batch')`, so they are auditable and reversible. Human overrides always win over batch ones.

---

## 5. Occupancy estimation (honest, with a band)

**Key insight from research:** a *misread* plate still counts as one vehicle. So the **flow count is immune to OCR errors** and is only hurt by *missed detections* (and un-merged fragments). Session-based counts are hurt by missed detections **and** by mismatches. Fowkes (1983) showed false matches barely affect flow counts but badly distort dwell estimates ([TRID](https://trid.trb.org/View/202738)). Genetec AutoVu uses the same split. Every entry adds 1, including misreads. Every exit subtracts 1, including "unknown vehicle exited". Closing a stale session does **not** change occupancy ([Genetec docs](https://techdocs.genetec.com/r/en-US/Security-Center-Administrator-Guide-5.12/How-parking-zone-occupancy-is-calculated)).

Therefore:

| Signal | Definition | Role |
|---|---|---|
| **S1 — flow count (HEADLINE)** | `anchor_count + Σ in-passes − Σ out-passes − re-entry corrections` since last calibration anchor (after de-dup) | The big number on the dashboard. |
| **S2 — open sessions** | `count(sessions where status in ('open','pending_review'))` | Answers *which* cars are in, for how long. Drives dwell, overstay and "who's in the lot". |
| **Divergence** | `S2 − S1` | **Drift alarm.** Growing positive = missed exits; negative = missed entries. |

Re-entry correction: when a plate enters while an open session for the same plate exists, the old session closes as `CLOSED_INFERRED` **and S1 is decremented by 1**. The vehicle must have left unseen, so this is strong evidence. Flagging a session suspect-stale does *not* touch S1; the admin's reconciliation absorbs that error.

**Clamping:** the displayed value is clamped to `[0, capacity]`. The raw value is stored and every clamp is logged. Frequent clamping in one direction means the miss rate is biased on one camera.

**Confidence band** (statistical, not hand-wavy). Let `m_in` and `m_out` be the per-camera miss probabilities. Estimate them from orphan-exit and stale rates at first, then from video audits (doc 10). With `N` entries and `M` exits since the anchor:

```
bias-corrected  occ ≈ anchor + N/(1−m_in) − M/(1−m_out)
variance        Var ≈ N·m_in/(1−m_in)² + M·m_out/(1−m_out)²
band            ± 1.96·√Var          (clamped to [0, capacity])
```

The band grows like √(events since calibration). Example: N = M = 2 000 and m = 2 % give ≈ ±12. The width of the band therefore **tells the admin when to reconcile**: an in-app "Reconcile recommended" banner appears when the half-width exceeds 2 % of capacity (D2, D12). The UI renders "≈ 42 (38–46)" and greys out further as the band widens.

**Calibration = admin reconciliation only (D2).** No scheduled resets and no automatic stale expiry. The workflow is specified in [doc 12 §3](12-decisions-and-constraints.md):
1. The admin inspects the lot visually and enters the count N.
2. S1 re-anchors to N.
3. The system proposes which open sessions are "residue": suspect-stale and multi-day first, then the oldest, then the lowest-confidence entries.
4. The admin confirms or edits the proposal. The chosen sessions close as `CLOSED_ADMIN`, so that S2 = N.
5. `estimate_before − N` is stored as the **residual**. It is the single most useful accuracy metric for the pilot.

The only automatic closure is the 30-day retention bound (`EXPIRED`), which keeps the open set bounded.

**Occupancy timeline** (`occupancy_timeline` table, step function) is written on every session state change (`valid_from`, `occupancy_best`, `low`, `high`, `in_count`, `out_count`) so "what was occupancy at 2 pm last Tuesday" is an interval lookup, and charts never re-derive history in the browser.

---

### 5.1 Implementation note: estimator revised from simulator evidence (2026-10-13)

The simulator (`occsim`, doc 14) measured the engine against ground truth. The flow count S1 had a **3.3–5 % of capacity** MAE. It does well only when missed entries and missed exits happen to cancel out, so its error is a random walk. Open sessions S2 drift upward with every missed exit.

The implemented headline is therefore a **bias-corrected S2**:

```
P(ghost | open for age a) = m_out·F(a) / (m_out·F(a) + (1−m_out)·S(a))      S = dwell survival (learned hourly from closed sessions; prior until 200 exist)
estimate = S2 − Σ P(ghost) + S2_since_anchor·m_in/(1−m_in) + unseen        unseen = visual count − S2 at a reconciliation, −1 per orphan exit
band     = ±(1.96·√(Σ P(1−P) + S2_since_anchor·m_in/(1−m_in)² + (0.5·G)² + (0.5·missed_in)²) + 1)
```

Sessions an admin keeps at a reconciliation are confirmed present, so their ghost probability restarts from that moment. Measured over 2 and 5 simulated days with **no** reconciliation:
- auto-match precision 100 % / 99.9 %;
- occupancy MAE 1.8 % / 2.4 % of capacity;
- band coverage 97.7 % / 99.4 %.

All doc 10 targets pass. S1 is kept as `raw_occupancy` for the drift cross-check.

## 6. Ordering, idempotency and late data

- Ingest is **upsert on `event_id`** (already true) → re-delivery is harmless.
- Each lot keeps a **watermark** = max `event_at` processed. A read with `event_at` ≥ watermark − 2 min is processed incrementally (fast path, inside the insert trigger / queue consumer).
- A read older than that is **late**: it is stored, then a **re-sessionize job** recomputes sessions, passes and occupancy timeline for `[event_at − 48 h, now]` (sessions opened earlier are carried in as-is). At this lot's volume (≤ ~2 000 reads/day) recomputing 48 h is a sub-second SQL job, so correctness is achieved by recomputation, not by complicated incremental patching.
- Because `session_id` = entry read id and pass ids are derived from primary read ids, recomputation is **stable**: URLs, review decisions and admin notes stay attached. Human decisions (confirm/reject/manual-pair, and reconciliation closures) are stored separately in `match_overrides` / `occupancy_calibrations` and **replayed** by the job, so a re-run never undoes a human decision.
- A periodic safety sweep (pg_cron every 5 min) re-sessionizes the trailing 2 h regardless, absorbing any missed trigger.

---

## 7. Data-quality metrics (computed continuously; first-class dashboard citizens)

| Metric | Formula | Healthy target (initial guess, tune) |
|---|---|---|
| Read rate per camera | passes with `quality ≥ medium` / all passes | ≥ 95 % |
| Exit match rate | exits matched (exact+fuzzy) / exit passes | ≥ 95 % |
| Exact-match share | exact / matched | ≥ 85 % |
| Orphan-exit rate | orphan exits / exit passes | ≤ 3 % |
| Suspect-stale count | open sessions flagged `suspect_stale` at 06:00 | trend ↓ (each one is a probable missed exit or a real overnight stay) |
| Flow balance | Σin − Σout per day, adjusted for overnight carry-over | ≈ 0 |
| Calibration residual | estimate − manual count | abs(residual) ≤ 2 % of capacity |
| Fragmentation rate | reads merged by de-dup / reads | trend ↓ |
| Rejected-track rate | `rejected` reads / all reads | trend ↓ |
| Device health | heartbeat age (offline after 180 s), `status`, `camera_connected`; plus time since last read | offline → critical banner |

These numbers are what turns the pilot from "a dashboard" into **evidence the system works** — they belong on their own "System Health" page, not hidden in logs.

---

## 8. Configuration knobs (per lot; defaults in code, overrides in `config/config.yaml` → synced to `lots.settings`)

`dedup_window_s` 30 (tune 10–60) · `dedup_sim` 0.80 · `min_dwell_s` 20 · `reentry_min_s` 300 · `t_auto` 0.85 · `t_review` 0.65 · `margin` 0.10 · `bounce_max_s` 300 · `suspect_stale_after_h` 24 · `expire_after_d` 30 (= plaintext retention) · `effective_capacity_pct` 0.85 · `quality_thresholds` · `timezone` = `America/New_York`. **Capacity** comes from `parkinglot.capacity` (D1).

All thresholds are versioned (`settings_version`) and every session records the version it was derived with, so a threshold change is auditable and a re-run is reproducible.
