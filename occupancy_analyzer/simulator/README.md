# occsim — offline camera simulator

Generates producer-identical camera output (event contract v2 + heartbeat v1,
see `plan/13-data-contracts.md` and `occupancy_analyzer/docs/CONTRACT.md`) with
a known ground truth. It can replay that output into local or hosted Supabase,
and it scores the DB engine against the truth. Spec: `plan/14-…simulator.md` §3.

```
occsim generate  → sim_out/ (files only, no network)
occsim scenario  → the 20 golden fixtures from plan/10 §2
occsim replay    → Supabase REST (Storage + PostgREST + report_heartbeat RPC)
occsim evaluate  → markdown report: precision/recall, occupancy MAE, band coverage …
occsim validate  → check every event.json / heartbeat against the contracts
```

Requirements: Python ≥ 3.11 and [uv](https://docs.astral.sh/uv/). Dependencies
are `pyyaml`, `pillow`, `httpx` and `python-dotenv`; `supabase-py` and numpy
are not needed.

```bash
cd occupancy_analyzer/simulator
uv sync
uv run pytest          # 103 tests, ~12 s, no network
```

## Quickstart

### 1. Generate (L0, files only)

```bash
uv run occsim generate --start 2026-10-13 --days 3 --seed 42 --out sim_out/
```

It prints the arrivals, bounces, events per camera, heartbeats and injected
imperfections. Everything is deterministic for a given `--seed`: running it
twice gives byte-identical output.

Camera ids, device ids, capacity, timezone and the heartbeat interval come from
the repo-root `config/config.yaml`. Override this with `--config PATH` (alias
`--capacity-from`) or `$OCCSIM_CONFIG`. If the file is missing (for example
`config/` is gitignored on a fresh clone), built-in defaults identical to config
v2 are used, with a warning.

World knobs (defaults shown):

```
--profile auto|weekday|weekend      auto = by day of week (weekend at --weekend-factor 0.4)
--arrivals-per-day N                weekday volume, default 2.4 × capacity (≈245 incl. close followers)
--regulars-share 0.40 --regulars-pool 1.5×capacity
--close-follow-rate 0.03            a second car 1–3 s behind
--overnight-rate 0.02               12–40 h stays ("not allowed but happens")
--capacity N                        override config capacity
```

Noise knobs (doc 14 §3.2, defaults shown):

```
--miss-rate-in 0.02 --miss-rate-out 0.03      pass produces no event
--confusion-rate 0.08                          consensus gets one confusable swap (0/O/D/Q, 1/I/L, 2/Z, 5/S, 8/B, 6/G, P/F/R, V/W/N/M/U)
--drop-edge-char-rate 0.02                     'Z94PVE' -> '94PVE' (70 %) or 'Z94PV'
--fragment-rate 0.03                           extra partial-plate event 2–8 s later, new track_id
--late-upload-rate 0.01 --late-upload-max 3h   release_at = finalize + U(5 min, max)
--clock-skew-ms 0                              '250' = all devices, or 'jetson-out-01=-1500' (repeatable)
--outage inbound_cam_01@2026-10-14T10:00/20m   repeatable; lot-local unless an offset is given
--min-plate-chars 5                            producer's validate_plate gate (short reads are rejected locally)
```

How the per-frame noise works: every track's `reads[]` (60–200 frames, empty
leading and trailing frames, edge-weighted confidences, `clean` flag) is built
around an *observed* plate. The consensus is then computed with a verbatim copy
of `scripts/plate_ocr_reader.py::best_reading` (`occsim/consensus.py`). An
injected confusion makes the swapped plate the frame majority, while the true
plate is still present in a minority of frames. So a consensus error only
happens when the noise really outvotes the truth. Spontaneous errors from the
background noise are counted separately in the manifest, and with the default
settings they are about 0.

**Outage modes.** `--outage CAM@START/DUR` defaults to **backlog** mode: the
device keeps capturing, but no heartbeats or uploads get through. At the end of
the outage the queued events are released in a burst (0.25 s apart). The first
heartbeat after it reports `pending_uploads` (`status: degraded` when the
backlog is ≥ 5). Append `:lost` (`…/20m:lost`) to model the camera itself being
down: passes during the window are never captured, and uptime resets afterwards.

### 2. Inspect

```
sim_out/
├── manifest.json                 seed, params, counts, outages, release_schedule[] (release_at per event), rebase
├── ground_truth/
│   ├── visits.csv                plate, true entry/exit, dwell, bounce/overnight/multi-day flags, per-pass outcome
│   ├── passes.csv                every true pass: outcome (emitted|missed|rejected|lost_outage), plate read, event_ids
│   └── occupancy.csv             true occupancy after each change
├── inbound_cam_01/
│   ├── events/20261013T071203512000Z_plate_track17/{event.json, plate.jpg}
│   └── heartbeats.jsonl
└── outbound_cam_01/…
```

```bash
uv run occsim validate sim_out/                                # contract check for every file
jq '.counts' sim_out/manifest.json
jq '.release_schedule[] | select(.late or .backlog)' sim_out/manifest.json
```

`plate.jpg` is the same 96×48 grey "SIM" JPEG (about 0.6 KB) for every event.
The folder name is `timestamp_utc` (the finalize time) formatted like the
producer formats it. `release_at` exists only in the manifest, never in
`event.json`.

### 3. Replay into local Supabase (L1/L2)

```bash
cd ../ && supabase start                              # in occupancy_analyzer/
export LOCAL_SERVICE_ROLE_KEY=$(supabase status -o env | grep '^SERVICE_ROLE_KEY=' | cut -d= -f2- | tr -d '"')
cd simulator

uv run occsim replay sim_out/ --target local --fast              # engine tests, as fast as possible
uv run occsim replay sim_out/ --target local --speed 60          # 1 sim-hour per real minute
uv run occsim replay sim_out/ --target local --rebase-now 2h     # "live" demo (see below)
```

- **Order.** Events are sent in `release_at` order, so late uploads and outage
  bursts arrive late. Heartbeats are sent at `sent_at_utc`, and scenario
  actions at their `at`. For each event the crop goes first:
  `POST /storage/v1/object/event-snapshots/<event_id>.jpg` with
  `x-upsert: true`. Then the row:
  `POST /rest/v1/events?on_conflict=event_id` with
  `Prefer: resolution=merge-duplicates`. The row contains only the contract
  columns plus `image_path`. Heartbeats go to
  `POST /rest/v1/rpc/report_heartbeat` with body `{"hb": …}`. 5xx and network
  errors are retried 3×. 4xx errors are counted and logged, and the replay
  continues (`--stop-on-error` stops it instead).
- **Keys.** For `--target local` (`http://127.0.0.1:54321`, override with
  `--url`) the key comes from `--key`, then `$LOCAL_SERVICE_ROLE_KEY`, then
  `$SUPABASE_SERVICE_ROLE_KEY`. For `--target hosted` the repo-root `.env` is
  loaded to get `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Hosted replay
  also needs `--yes`. The bucket is `$SUPABASE_BUCKET` (default
  `event-snapshots`) or `--bucket`.
- **`--rebase-now [LEAD]`.** Shifts `captured_at_utc`, `timestamp_utc`,
  `sent_at_utc`, `last_event_at_utc` and action times so the first event lands
  at now − LEAD (default 0). The offset is floored to whole minutes. Items
  already in the past are sent immediately; heartbeats older than 5 minutes are
  skipped. Everything else is paced in **real time**, so a replayed day shows
  up live on the dashboard. The offset is written to
  `manifest.json["rebase"]`, and `evaluate` uses it. To load a whole day "in
  the past" quickly, use `--rebase-now 26h --fast`.
- **Other options:**
  - `--new-ids` re-keys event ids (uuid5 of id + offset). The same `sim_out/`
    can then be replayed again as new rows; the events trigger is
    AFTER INSERT, so re-upserting identical ids changes nothing.
  - `--shuffle SEED` delivers events in random order, to check the "identical
    results when replayed shuffled" exit criterion.
  - `--until TIME` stops at that sim time.
  - `--no-heartbeats` skips heartbeats.
  - `--dry-run` makes no HTTP calls.

### 4. Evaluate

```bash
uv run occsim evaluate sim_out/ --target local --report sim_out/report.md --json sim_out/metrics.json \
                       --reconcile-every 24h
```

`evaluate` reads `parking_sessions`, `passes`, `occupancy_timeline` and
`device_heartbeats` (CONTRACT §2) with the service key and filters them to the
lot and the simulated window (±1 h, after undoing the rebase offset). Each DB
pass is mapped to the true pass in the same direction within ±30 s
(`--tolerance-s`, widened by any configured clock skew). The plate is the
tie-break. The report then gives:

| Metric | How |
|---|---|
| Auto-match precision / false auto-match rate | exact + fuzzy sessions whose entry and exit map to the same true visit |
| Recall | correct pairs / true visits with entry and exit. Also "observable recall", counting only visits where both passes were emitted |
| Occupancy MAE / max / bias | `occupancy_timeline.occupancy` (S1) vs `ground_truth/occupancy.csv`, sampled every minute. S2 (`open_sessions`) MAE is also reported |
| Band coverage | share of minutes where the truth is in `[band_low, band_high]` |
| Drift before reconciliation | `--reconcile-every 24h`: residual (estimate − truth) at each tick (see Deviations) |
| Dwell error | median and p90 absolute dwell error on correctly matched sessions |
| Flags | bounce / overnight (covers 03:00 local) / multi-day / orphan exits, truth vs DB |
| Passes | DB passes per true pass, fragments flagged, plate accuracy |
| Device health | injected outages + latest `device_heartbeats` rows |

It also prints PASS/FAIL for the Phase-1 targets: auto precision ≥ 99.5 %,
MAE ≤ 3 % of capacity, band coverage ≥ 95 %.

The evaluator assumes a database that holds only this simulation's data
(e.g. a fresh `supabase db reset`). Other data in the same window skews the
occupancy numbers.

### 5. Golden scenarios

```bash
uv run occsim scenario list
uv run occsim scenario run ocr_near_miss --out sim_out/ocr_near_miss/   # by name or number ("2")
uv run occsim scenario run all --out sim_out/scenarios/                 # one folder per scenario
uv run occsim scenario run dst_boundary --out x/ --date 2027-11-07      # re-anchor the date
```

All 20 scenarios from `plan/10` §2 live in `occsim/scenarios/NN_name.yaml`;
the YAML reference is in the `occsim/scenario.py` docstring. Each one writes
the same layout as `generate`, with exact reads: `observe_as` is exactly what
the consensus outputs. The manifest carries `scenario.expect`, so pgTAP can
assert against the same fixtures.

| mode | meaning | scenarios |
|---|---|---|
| `replay` | events + heartbeats only | 1–11, 14, 15, 17, 18 |
| `partial` | needs a DB-side `action:` that replay executes | 12 `reconcile` (reconcile_preview → reconcile_commit with the top-N proposed), 13 `resolve_match` (pass ids looked up by plate), 16 retention job (manual; not automated), 19 `set_capacity` (PATCH `lots` + insert `lot_capacity_history`) |
| `engine_only` | auth/RLS, covered by pgTAP / web tests; the fixture only creates data to act on | 20 |

Actions run with the service key, which the engine's `require_role` accepts.
Pass `--admin-jwt` or set `$OCCSIM_ADMIN_JWT` to run them as a real admin user.
`reconcile_*` work at the DB's `now()`. For scenario 12, replay with `--fast`
into an otherwise empty DB, or with `--rebase-now` so that the 12:00
reconciliation happens at the matching wall-clock time.

Scenario 18's three bad events are flagged `contract_valid: false` in the
manifest. `occsim validate` skips them.

## Feeding the existing uploader

Each `<camera>/events/` folder is exactly what `scripts/upload_events.py`
expects (`event.json` + `plate.jpg`, `image_filename: "plate.jpg"`, contract
keys only). From the repo root:

```bash
SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_ROLE_KEY=$LOCAL_SERVICE_ROLE_KEY \
  python -m scripts.upload_events --events-dir occupancy_analyzer/simulator/sim_out/inbound_cam_01/events
SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_ROLE_KEY=$LOCAL_SERVICE_ROLE_KEY \
  python -m scripts.upload_events --events-dir occupancy_analyzer/simulator/sim_out/outbound_cam_01/events
```

It needs `supabase` and `python-dotenv` installed. Variables already exported
win over `.env`. The uploader sends one camera at a time in folder-name order
(no interleaving, no `release_at`, no heartbeats); the engine re-sequences by
`captured_at_utc`. It also writes `.uploaded` marker files into the folders.
Use `occsim replay` when release timing matters.

## Deviations from the spec / notes

- **Arrival volume.** Defaults to 2.4 × capacity per weekday (≈245 arrivals
  for capacity 100) rather than a fixed number. At about 3× capacity, the
  dwell mixture makes 10–15 % of arrivals bounce.
- **Dwell mixture.** It is conditioned on arrival hour: commuters (7.5–9.5 h)
  mostly arrive 05–09. Over a day this gives roughly 30 / 35 / 33 / 2 % short
  / medium / commuter / overnight; the morning has more commuters and the
  evening fewer. The overnight share is exactly `--overnight-rate`.
- **Horizon.** The lot starts empty at local midnight of `--start`. Cars still
  parked at the end have an empty `exit_at` in `visits.csv`.
- **Rejected tracks.** A track whose consensus fails `validate_plate` (e.g. a
  4-char vanity plate, or a fragment shorter than 5) is not emitted, the same
  as the producer's local `rejected_dir` (D24). It is counted in the manifest.
- **`--outage`.** The doc says both "no events emitted" and "burst of backlog
  uploads". The default `backlog` mode implements the burst; `:lost` implements
  "nothing captured".
- **`--reconcile-every` in `evaluate`** is passive. It records the
  pre-reconciliation residual at each tick but never calls `reconcile_commit`,
  because that would change the DB being measured. Simulated admin
  reconciliations that do write to the DB are scenario `action: reconcile`
  steps run by `replay`.
- **Device health.** `device_heartbeats` keeps only the latest row per device,
  so `evaluate` cannot score historical offline windows. It lists the injected
  outages and the current device rows; scenario 17 covers the banner behaviour.
- **Extras not in the spec:**
  - `occsim validate`
  - `ground_truth/passes.csv`
  - the replay options `--new-ids`, `--shuffle`, `--until` and `--dry-run`
- **The packaging diverges from doc 14 §1.** That section lists `numpy` and
  `supabase` as dependencies. Neither is used: the stdlib `random` (string
  seeds, so not dependent on `PYTHONHASHSEED`) and `httpx` replace them.

## Layout

```
occsim/
  cli.py        argparse entry point (`occsim`)
  config.py     config.yaml v2 loader (repo-root default, built-in fallback)
  world.py      arrivals (NHPP), dwell mixture, capacity/bounce, regulars, close-following -> visits/passes
  plates.py     PA/NJ/NY/MD/vanity formats, confusion groups
  consensus.py  verbatim copy of the producer's best_reading / validate_plate
  camera.py     true pass -> event v2 (reads[], consensus, timestamps, misses, fragments, late, outages)
  heartbeat.py  heartbeat v1 stream with backlog-driven pending_uploads / degraded
  generate.py   orchestration + --outage / --clock-skew-ms parsing
  writer.py     folder layout, placeholder JPEG, ground truth, manifest
  scenario.py   YAML scenarios -> exact fixtures
  replay.py     httpx Supabase REST client + paced replayer (+ actions)
  evaluate.py   metrics + markdown report
  contract.py   event v2 / heartbeat v1 validators, events-row projection
  scenarios/    01_happy_path.yaml … 20_role_enforcement.yaml
tests/          pytest (determinism, contracts, consensus, noise rates, layout, scenarios, replay via httpx.MockTransport, evaluate)
```
