# occupancy_analyzer

Plate-recognition parking occupancy for the GATF lot: an inbound camera and an outbound camera emit plate events. This app pairs them into parking sessions, keeps an **honest occupancy estimate with an uncertainty band**, and serves a realtime dashboard.

**New here? Start with [GETTING_STARTED.md](GETTING_STARTED.md)** for simple simulation and real-mode steps.

Design: [`../plan/`](../plan/README.md) (start with docs 12, 13 and 14). Integration contract: [`docs/CONTRACT.md`](docs/CONTRACT.md).

```
occupancy_analyzer/
├── supabase/     Postgres: schema, matching/session engine, RPC API, views, cron, pgTAP tests
├── web/          Next.js 16 dashboard (Vercel root directory)
├── simulator/    `occsim`: generates inbound/outbound camera JSON + heartbeats, replays, evaluates
├── tools/        backup.sh (pg_dump), crop_retention.py (14-day crop deletion)
└── docs/         CONTRACT.md
```

The edge producer (`../scripts/plate_ocr_reader.py`) emits event contract v2 and heartbeat v1 (see the root README, "Producer v2").

---

## Run everything offline (laptop)

Prerequisites: Docker running, Supabase CLI, Node 22, `uv`.

```bash
cd occupancy_analyzer

# 1. Database (Postgres + Realtime + Storage + Auth in Docker)
supabase start                 # first run pulls images
supabase db reset              # applies migrations + seed (lot gatf_main, both cameras)
supabase test db               # 30 engine scenario tests (pgTAP)
supabase status -o env         # shows API_URL, ANON_KEY, SERVICE_ROLE_KEY

# 2. Simulated cameras → database
cd simulator
uv run occsim generate --start 2026-10-13 --days 2 --seed 42 --out ../sim_out
uv run occsim replay ../sim_out --target local --key "$SERVICE_ROLE_KEY" --fast            # bulk load
uv run occsim replay ../sim_out --target local --key "$SERVICE_ROLE_KEY" --rebase-now --speed 60   # "live" demo
uv run occsim evaluate ../sim_out --target local --key "$SERVICE_ROLE_KEY" --report ../sim_out/report.md

# 3. Dashboard
cd ../web
cp .env.example .env.local     # fill in from `supabase status -o env`
npm install
npm run bootstrap-admin        # creates the default admin (config.yaml auth.bootstrap_admin_email)
npm run dev                    # http://localhost:3000
```

"Ask the lot" needs OpenAI (internet). Offline, set `AI_MOCK=1` or `ai.enabled: false` in `config/config.yaml`.

---

## Deploy (Supabase Free + Vercel Hobby)

1. **Database**
   - `supabase link --project-ref rfqdabtufcmkokuwflwo && supabase db push`.
   - This renames the old `events` table to `events_v0` (D16) and creates the new schema.
   - Then, in the SQL editor:
     - `insert into private.app_secrets values ('plate_hmac_key', encode(extensions.gen_random_bytes(32),'hex'));`
     - `alter role gatf_readonly with login password '<strong>';`
2. **Vercel**
   - Root Directory `occupancy_analyzer/web`; keep "include files outside root".
   - Env vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `READONLY_DATABASE_URL`, `OPENAI_API_KEY`, `BOOTSTRAP_ADMIN_PASSWORD`.
   - For `READONLY_DATABASE_URL`, use the Supavisor pooler with user `gatf_readonly.<project-ref>` on port 6543.
   - The prebuild step syncs `config/config.yaml` into `lots` and `cameras`.
3. **GitHub Actions** (`.github/workflows/oa-nightly.yml`)
   - Secrets: `OA_DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
   - Runs the nightly backup and crop retention.
4. **Jetsons**
   - `.env` with `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_BUCKET`.
   - Run `plate_ocr_reader.py --camera-id inbound_cam_01 …` / `--camera-id outbound_cam_01 …`.

---

## How the engine works (short)

- **Ingest.** An `AFTER INSERT` trigger on `events` validates the contract and normalizes the plate. It stores alternates from `reads[]`, then calls `engine.rebuild_lot(lot, captured_at)`.
- **Rewind and replay.** Derived state is rewound to the event's capture time and replayed forward in time order. An in-order event replays one pass; a late upload replays its window. Admin decisions (`match_overrides`, `occupancy_calibrations`) are inputs, so a replay never undoes them.
- **Matching.** A confusion-aware, confidence-weighted Damerau–Levenshtein distance runs against **only the cars currently in the lot**. It applies a margin rule (0.15). Ambiguous matches go to the admin review queue.
- **Occupancy.** The headline figure is S1 = entries − exits − re-entry corrections, clamped and with a statistical band. S2 = open sessions; the gap between S1 and S2 is the drift alarm. An admin reconciliation re-anchors both.
- **Retention (pg_cron).** Full `reads[]` are kept 7 days, plaintext plates 30 days (then HMAC pseudonyms), crops 14 days (via the tools job).
