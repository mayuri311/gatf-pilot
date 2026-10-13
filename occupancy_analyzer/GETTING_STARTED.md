# Getting Started

Two ways to run the system:

| Mode | What it is | Needs |
|---|---|---|
| **A. Simulation** | Fake cameras feed a local database on your laptop. Good for trying things out. | Laptop only |
| **B. Real** | The two Jetson cameras feed the cloud database, and the dashboard runs on Vercel. | Jetsons, Supabase cloud, Vercel |

All commands start from the repo folder `gatf-pilot/` unless a step says otherwise.

---

## One-time setup (laptop)

Install these once:

1. **Docker Desktop**: open it and leave it running.
2. **Supabase CLI**: `brew install supabase/tap/supabase`
3. **Node.js 22**: needed for the dashboard.
4. **uv**: `brew install uv`. This runs the Python simulator.

Then install the dashboard's packages:

```bash
cd occupancy_analyzer/web
npm install
cp .env.example .env.local      # you'll fill this in at step A2
```

Finally, check that the repo-root `.env` has a line `BOOTSTRAP_ADMIN_PASSWORD=...`. That is the first password for the admin login.

---

## A. Simulation mode (everything on your laptop)

### A1. Start the local database

```bash
cd occupancy_analyzer
supabase start          # first time takes a few minutes (downloads images)
supabase db reset       # creates all tables + the lot and both cameras
```

### A2. Connect the dashboard to it

```bash
supabase status -o env
```

Copy these values into `occupancy_analyzer/web/.env.local`:

| Put in `.env.local` | Copy from `supabase status` |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `API_URL` (normally `http://127.0.0.1:54321`) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `ANON_KEY` |
| `SUPABASE_SERVICE_ROLE_KEY` | `SERVICE_ROLE_KEY` |

`READONLY_DATABASE_URL` is already filled in for local use.

### A3. Create your admin login

```bash
cd occupancy_analyzer/web
npm run bootstrap-admin
```

This creates the admin account set in `config/config.yaml` (`auth.bootstrap_admin_email`), using `BOOTSTRAP_ADMIN_PASSWORD` from `.env`.

### A4. Start the dashboard

```bash
cd occupancy_analyzer/web
npm run dev
```

Open **http://localhost:3000** and log in with the admin email and password. The app asks you to choose a new password the first time.

### A5. Start the simulated cameras

Open a **second terminal** and run:

```bash
cd occupancy_analyzer
eval "$(supabase status -o env | grep '^SERVICE_ROLE_KEY=')"   # loads the database key
cd simulator

# make 8 days of fake traffic, starting a week ago
uv run occsim generate --start $(date -v-7d +%F) --days 8 --seed 1 --out ../sim_out --force

# send it to the database: past days load at once, then cars keep arriving live
uv run occsim replay ../sim_out --target local --key "$SERVICE_ROLE_KEY" --rebase-now 7d
```

Leave this terminal running.
- History takes about 15–30 minutes to load.
- After that, cars arrive in real time, and the dashboard updates by itself.

**To stop the simulation:** press `Ctrl+C` in that terminal.

**To check accuracy (optional).** Load a few days at full speed, then score them:

```bash
uv run occsim generate --start 2026-10-01 --days 2 --seed 42 --out ../sim_eval
uv run occsim replay   ../sim_eval --target local --key "$SERVICE_ROLE_KEY" --fast
uv run occsim evaluate ../sim_eval --target local --key "$SERVICE_ROLE_KEY" --report ../sim_eval/report.md
```

**To start over with an empty database:**

```bash
cd occupancy_analyzer && supabase db reset
```

The reset also deletes users, so run `npm run bootstrap-admin` again afterwards.

---

## B. Real mode (cameras + cloud)

### B1. Set up the cloud database (once)

```bash
cd occupancy_analyzer
supabase login
supabase link --project-ref rfqdabtufcmkokuwflwo
supabase db push        # creates all tables (the old "events" table is kept as "events_v0")
```

Then open the Supabase dashboard → **SQL Editor** and run these two lines once. Pick your own strong password for the second line.

```sql
insert into private.app_secrets values ('plate_hmac_key', encode(extensions.gen_random_bytes(32), 'hex'));
alter role gatf_readonly with login password 'CHOOSE-A-STRONG-PASSWORD';
```

### B2. Put the dashboard on Vercel (once)

1. In Vercel, click **New Project**, import the GitHub repo `mayuri311/gatf-pilot`, and set **Root Directory** to `occupancy_analyzer/web`.
2. Under **Environment Variables**, add the variables below. The values come from Supabase → **Project Settings** → **API**, and **Database** for the read-only connection.

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://rfqdabtufcmkokuwflwo.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon / publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role / secret key |
| `READONLY_DATABASE_URL` | `postgresql://gatf_readonly.rfqdabtufcmkokuwflwo:<password>@<pooler-host>:6543/postgres` |
| `OPENAI_API_KEY` | your OpenAI key (for "Ask the lot") |
| `BOOTSTRAP_ADMIN_PASSWORD` | first admin password |

3. Click **Deploy**. Each deploy also copies the lot capacity and cameras from `config/config.yaml` into the database.
4. Create the admin login once, from your laptop. Temporarily point `web/.env.local` at the cloud values above, then:

   ```bash
   cd occupancy_analyzer/web && npm run bootstrap-admin
   ```

### B3. Start the cameras (each Jetson)

Do this on **both** Jetsons.

**Once per Jetson:**

```bash
git clone git@github.com:mayuri311/gatf-pilot.git && cd gatf-pilot
pip install --no-deps -r scripts/inductiverobo.txt
```

Then create a file named `.env` in the `gatf-pilot/` folder:

```
SUPABASE_URL=https://rfqdabtufcmkokuwflwo.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service_role key>
SUPABASE_BUCKET=event-snapshots
```

**Start the camera software:**

| Jetson | Command |
|---|---|
| **Entrance** (`jetson-in-01`) | `python scripts/plate_ocr_reader.py --camera-id inbound_cam_01 --source "rtsp://USER:PASS@INBOUND-CAMERA-IP/axis-media/media.amp" --headless` |
| **Exit** (`jetson-out-01`) | `python scripts/plate_ocr_reader.py --camera-id outbound_cam_01 --source "rtsp://USER:PASS@OUTBOUND-CAMERA-IP/axis-media/media.amp" --headless` |

What the software does:
- Every plate read is uploaded automatically.
- Every 60 s it sends a heartbeat.
- If a camera stops, the dashboard shows **"camera offline"** within about 3 minutes.

**If the network was down:** the Jetson keeps events on disk. To upload anything it missed:

```bash
python scripts/upload_events.py --events-dir events
```

### B4. Daily use

- Open your Vercel URL and log in.
- **When the "Reconcile recommended" banner appears**, an admin counts the cars in the lot and enters the number on **Reconcile**. This works from a phone.
- **To add staff accounts**, go to **Admin → Users**. Staff can see everything; only admins can change things.

---

## Changing settings

Edit `config/config.yaml` to change capacity, cameras, the AI model, or retention days.
- **Real mode:** commit and push, and Vercel applies the change on the next deploy.
- **Simulation mode:** run `npm run sync-config` in `occupancy_analyzer/web`.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Cannot find module '../lightningcss.darwin-x64.node'` | Stop the server and run `npm run dev` again. It switches to native mode by itself. If it still fails, delete `occupancy_analyzer/web/.next` and retry. |
| `Another next dev server is already running` | Press `Ctrl+C` in the old terminal, or `kill <PID shown in the message>`. |
| Can't log in after `supabase db reset` | The reset deletes users. Run `npm run bootstrap-admin` again. |
| Forgot the admin password | Run `npm run bootstrap-admin -- --reset-password`. That resets it to `BOOTSTRAP_ADMIN_PASSWORD`. |
| Dashboard shows **camera offline** | Check that the Jetson is on and `plate_ocr_reader.py` is running. Also check its `.env`. |
| "Ask the lot" says unavailable | Set a valid `OPENAI_API_KEY`. For offline use, put `AI_MOCK=1` in `web/.env.local`. |
| Docker / Supabase won't start | Open Docker Desktop first, then run `supabase start`. |

More detail: [README.md](README.md) and the design docs in [`../plan/`](../plan/README.md).
