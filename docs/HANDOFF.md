# GATF parking occupancy system: handoff

Written 2026-11-17. Companion documents:

- [TECHNICAL.md](TECHNICAL.md): how every part works, for the engineer taking over.
- [../deploy/jetson/README.md](../deploy/jetson/README.md): running the pole computer unattended.
- The admin guide ("Parking Lot Camera System: How It Works"): for the lot admin who uses the dashboard.

Lines marked **FILL IN** are facts this document could not confirm from the code. Complete them before handing over.

---

## 1. In short

**What is being handed over.** A pole-mounted box with two cameras and a small computer reads the rear plate of every car entering and leaving the GATF lot. An online database pairs entries with exits to estimate how many cars are in the lot. A web dashboard, behind a login, shows the result.

**State today.** The system is installed and producing data, but it is not ready to hand over. Four things must be fixed first:

1. **The two cameras are labelled the wrong way round.** Every arrival is recorded as an exit. All data so far is unusable and must be wiped. The fix is written but not yet applied.
2. **Nothing restarts the pole computer's software after a power cut.** The fix (a systemd service) is written but not yet installed or tested on the Jetson.
3. **There are no database backups.** The nightly backup job has failed on every one of its 34 runs. The job that deletes old plate photos has therefore never run either.
4. **The code repository is public.** Once the backup job is repaired, it would publish a copy of the database, including plate numbers, for any GitHub user to download.
**What "done" looks like.** The four items above are fixed. Every account is owned by the new owner. Every password and key has been changed. The system has run unattended for two weeks, including a deliberate power cut, with an agreed accuracy.

---

## 2. Before handoff: ordered checklist

Work top to bottom. Later steps depend on earlier ones.

### A. Stop the data and privacy risks (do first)

- [ ] **Make the GitHub repository private** (Settings → General → Danger Zone), or move it to the new owner's organization as private. Do this *before* repairing the backup job.
  - The repository is `mayuri311/gatf-pilot`, and it is public today.
  - `config/config.yaml` in it shows the Supabase project address and a personal admin email.
  - If it must stay public, encrypt backups instead (see known issue 4) and remove the email from the config.
- [ ] **Repair the nightly job** (`.github/workflows/oa-nightly.yml`).
  - It fails at the "Install pg_dump 17" step. The failure log is under the repository's Actions tab.
  - After repair, confirm one run is green, one backup file exists, and it can be restored into a local database.
  - Confirm the "Crop retention" step ran and deleted photos older than 14 days.
- [ ] **Check the plate-scrambling key exists.** In the Supabase SQL editor:

  ```sql
  select count(*) from private.app_secrets where name = 'plate_hmac_key';
  ```

  It must return 1. If it returns 0, plates older than 30 days are *not* being scrambled, and nothing reports that. The command to create the key is in `occupancy_analyzer/README.md` under "Deploy".

### B. Fix the pole computer

- [ ] **Fix the swapped cameras and wipe the bad data.** Follow "Fixing swapped cameras" in `deploy/jetson/README.md`, all seven steps, in order.
- [ ] **Install the boot service:** `sudo deploy/jetson/install.sh --headless` on the Jetson. This has never been run. Expect to fix small problems the first time.
- [ ] **Power-cut test.** Unplug the whole box for one minute. With no one touching it, both cameras must show "online" on the dashboard within about 10 minutes.
- [ ] **Stop automatic system updates on the Jetson.**
  - They can download hundreds of megabytes over the 1 GB/month cellular plan.
  - They can also replace the NVIDIA packages the plate detector depends on.
  - Commands are in TECHNICAL.md, section 9.
- [ ] **Deploy the drive clean-up and upload fixes** (known issues 5 and 6) by pulling the latest code onto the Jetson. This also deploys the crop part of known issue 7 (memory growth).
- [ ] **Save a copy of the Jetson's local configuration** somewhere safe and private.
  - The file `scripts/video/recorder.config.json` exists only on the Jetson. It holds the camera addresses and the drive ID.
  - The example file in the repository is out of date and would not work if copied.
- [ ] **Set up remote access (Tailscale)** as described in `deploy/jetson/README.md`. Confirm you can log in from off-site.

### C. Add an alarm that reaches a person

- [ ] **Set up an outside alert.** Dashboard alerts appear only inside the dashboard, so if a camera dies and nobody opens the dashboard, nobody knows.
  - Use a service that emails when the system goes quiet, for example a healthchecks.io check pinged by the Jetson.
  - Decide who receives it: **FILL IN**.

### D. Move ownership

For each account, transfer ownership or re-create it under the new owner. Record the new owner in the last column.

| Account | Used for | Today | New owner |
|---|---|---|---|
| GitHub repository | Code, nightly jobs | Personal account `mayuri311` | **FILL IN** |
| Supabase project (`rfqdabtufcmkokuwflwo`) | Database, plate photos, logins | **FILL IN** | **FILL IN** |
| Vercel project | Hosts the dashboard | **FILL IN** | **FILL IN** |
| OpenAI API key | "Ask the lot" page | **FILL IN** | **FILL IN** |
| AT&T IoT SIM / plan | Cellular connection | **FILL IN** | **FILL IN** |
| Tailscale | Remote access to the Jetson | Not set up yet | **FILL IN** |
| Dashboard admin login | First admin account | Personal Gmail (in `config/config.yaml`) | **FILL IN** |

- [ ] Change `auth.bootstrap_admin_email` in `config/config.yaml` to a role address the new owner controls. Create the new owner's admin account on the dashboard's Users page.
- [ ] Check the hosting plans against the new owner's use.
  - The project runs on Supabase Free (500 MB database) and Vercel Hobby.
  - Vercel Hobby is for non-commercial use.
  - Agree who pays if either must be upgraded.

### E. Change every secret (on handoff day, after ownership moves)

Change each one, update it where it is used, and confirm the system still works after each change.

| Secret | Where it is used |
|---|---|
| Supabase service-role key | Jetson `.env`; Vercel; GitHub Actions secrets |
| `gatf_readonly` database password | Vercel (`READONLY_DATABASE_URL`) |
| Database connection string for backups | GitHub Actions secret `OA_DATABASE_URL` |
| OpenAI API key | Vercel |
| Camera passwords (both cameras) | Jetson `.env` (`CAM_IN_*`, `CAM_OUT_*`) and the cameras themselves |
| Router admin password | Teltonika router |
| Jetson user password / SSH access | Jetson |
| Dashboard passwords | Each user changes their own |

**Do not change `plate_hmac_key`.** It is what scrambles old plates. Changing it means a returning car no longer matches its own earlier visits.

### F. Prove it works (acceptance period)

- [ ] Run for two weeks without touching the Jetson.
- [ ] The admin reconciles (counts the cars and enters the number) twice a day. The difference between the system's estimate and the count is the accuracy measure.
- [ ] Agree a target before starting. **FILL IN** (for example: estimate within ±3 cars of the count on 9 of 10 reconciles).
- [ ] Check the cellular data used over the two weeks against the 1 GB/month plan. See TECHNICAL.md, section 9.
- [ ] Both parties sign off on this checklist.

---

## 3. Handoff day

1. Walk the new owner through the dashboard using the admin guide. Have them do one reconcile and clear one Review queue item themselves.
2. Walk the engineer through `TECHNICAL.md` section 9 (operations). Have them log in to the Jetson remotely, read the service status, and restart the service.
3. Change the secrets in section 2E together.
4. Record the deployed code version: tag the commit running on the Jetson and on Vercel. **FILL IN** tag name.
5. Hand over the physical items: enclosure key, the second SSD, any spare parts. **FILL IN** list.
6. Remove the previous owner's access from every account in section 2D.

---

## 4. What the new owner does afterwards

| How often | Who | Task |
|---|---|---|
| Daily | Admin | Glance at the Live page: both cameras online. Clear the Review queue. |
| When the banner appears | Admin | Reconcile occupancy from a visual count. |
| Weekly | Engineer | Check System health: upload backlog near 0, free space on the drive, temperature. |
| Weekly | Engineer | Confirm last night's backup job is green in GitHub Actions. |
| Monthly | Engineer | Check cellular data used. Check Supabase database size (alert fires near 500 MB). |
| Monthly | Engineer | Make any small commit to the repository, or re-enable the schedule if GitHub has paused it. GitHub pauses scheduled jobs on public repositories with no activity for 60 days. |
| After any camera work | Engineer | Run the lane check in `deploy/jetson/README.md`. |

---

## 5. Known issues, most serious first

Each was found by reading the code. None has been reproduced on the installed system unless it says so.

| # | Issue | What happens | Suggested fix |
|---|---|---|---|
| 1 | **Cameras swapped at install** (confirmed by the installer) | Arrivals recorded as exits; occupancy is wrong | Steps in `deploy/jetson/README.md`. Swap the two names in the Jetson's config, wipe data with `occupancy_analyzer/tools/reset_lot_data.sql`. |
| 2 | **No autostart** | After a power cut or reboot nothing runs until someone logs in | `deploy/jetson/install.sh`. Written, not yet run on the Jetson. |
| 3 | **Nightly job fails every run** (confirmed: 34 of 34 runs failed at "Install pg_dump 17") | No backups exist. Supabase Free keeps none of its own. Old plate photos are never deleted, which breaks the 14-day rule. | Read the failure log; repair the install step. Consider running the photo clean-up as its own job so a backup failure cannot block it. |
| 4 | **Public repository + backup artifacts** | Once issue 3 is fixed, each backup is attached to the job as a downloadable file. On a public repository, any signed-in GitHub user can download it. The backup includes plate numbers and the plate-scrambling key (`private` schema). | Make the repository private. Or set `BACKUP_AGE_RECIPIENT` so `backup.sh` encrypts the file; the workflow does not currently pass that setting or install the `age` tool. |
| 5 | **Drive fills up** — *fixed in code 2026-11-22, not yet deployed* | Clips, record folders and metrics were never deleted, so the drive would fill and recording stop. | `scripts/video/ssd_retention.py`, started hourly by `run_pipeline.sh`: deletes clips and uploaded records after 14 days, rejected reads and metrics after 30. Never deletes records still waiting to upload, or set-aside `*_failed/` folders. Still check free space weekly; the video ring uses whatever is left. |
| 6 | **One bad record blocks all uploads** — *fixed in code 2026-11-22, not yet deployed* | A half-written `event.json`, or a record the server always rejects, was retried forever and held back everything behind it. | `event.json` is now written atomically. The uploader moves a folder to `events/<camera>_failed/`, with `upload_error.json` explaining why: at once if it is unreadable or its photo is missing, or after 5 failures that a successful upload of the next folder proves are the folder's own. An outage never moves anything. Check `*_failed/` folders weekly; move a folder back to retry it. |
| 7 | **Memory growth when a plate stays in view** — *crop part fixed in code 2026-11-22, not yet deployed* | The reader kept a plate-photo crop for every frame until the plate left the picture, so a car stopped in view grew memory without limit. | Each plate now keeps crops only for the few frames that could become its saved photo (one per distinct reading, plus the best detection). The saved `plate.jpg` is identical to before. Still unbounded, but small: the per-frame text and confidence (a few hundred bytes a frame), and the `reads` list in `event.json`. If a stopped car is common, cap that list or finalize plates that stay in view for minutes. |
| 8 | **No alert for "cameras swapped" or "entry camera blind"** | Issue 1 was only noticed by a person looking at the data | Add an alert when most exits in a window have no matching entry. |
| 9 | **Alerts stay inside the dashboard** | A dead camera is unnoticed unless someone looks | Outside alert (section 2C). |
| 10 | **Cellular data cap (1 GB/month)** | Plate records, photos, check-ins, remote access and any system updates share it. Usage has not been measured. | Measure it (TECHNICAL.md section 9). Stop automatic updates. If needed, lengthen the check-in interval in `config/config.yaml`. |
| 11 | **Powerful database key on the pole** | The Jetson's `.env` holds the Supabase service-role key, which can read and change everything. Anyone who takes the Jetson or its drive has it. | Change the key at once if the box is ever opened by someone unknown. Longer term: give the Jetson a key that can only add records. |
| 12 | **Clip cutter slows over time** | For every plate it loads the full list of video segments for that camera. The list grows by about 8,640 rows per camera per day and is never trimmed. | Limit the query to the clip's time window. |
| 13 | **Out-of-date example config** | `scripts/video/recorder.config.example.json` shows one camera named `gatf-lot-01` and 300-second segments. The installed system uses two cameras and, per the README, 10-second segments. Copying the example produces a system that fails preflight. | Update the example from the Jetson's real file, without the secrets. |
| 14 | **Old code still in the repository** | A second, older dashboard (`frontend/`) whose home page has no login, and older scripts (`yolo_plate_reader.py`, `occupancy_demo.py`, `plate_reader.py`, `run_postgres_mcp.sh`, `lot_views.sql`, `readonly_role.sql`, `supabase_schema.sql`, `zones.json`). A newcomer cannot tell what is live. | Confirm the old dashboard is not deployed anywhere, then delete or move these to an `archive/` folder. |
| 15 | **No automatic tests on change** | Tests exist (edge unit tests, simulator tests, database tests) but nothing runs them when code changes | Add a GitHub Actions job that runs them on every push. |
| 16 | **Documents disagree on the check-in interval** | The README and contract say every 60 s. `config/config.yaml` says 120 s, which is what runs. "Offline" fires after 360 s, the value from `config/config.yaml`; each dashboard build copies it into the database, replacing the 180 s built-in default. | Correct the README and `CONTRACT.md` to 120 s. |

---

## 6. Facts to fill in before signing

- Jetson login user, hostname, and where the repository sits on it: **FILL IN**
- Code version (commit) running on the Jetson: **FILL IN**
- Code version deployed on Vercel, and the dashboard's address: **FILL IN**
- Camera addresses and which physical camera faces which lane: **FILL IN**
- Which cellular antenna is installed (Poynting OMNI-402 or the LINOVISION alternative): **FILL IN**
- Where the second SSD is kept: **FILL IN**
- Who holds the enclosure key, and who to call for pole or power problems: **FILL IN**
- Real number of parking spaces (the system is set to 100): **FILL IN**
