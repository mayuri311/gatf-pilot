# 06 — Feature Catalog, KPI Dictionary, Alerts

> Every planned capability, prioritized. Updated for [doc 12](12-decisions-and-constraints.md), D1–D28 ("keep it simple").
>
> **Priorities:**
> - **MVP**: the first usable pilot dashboard.
> - **P1**: needed to call the pilot complete.
> - **P2**: differentiators.
> - **P3 / Post-pilot**: later, including multi-lot.
> - **Descoped**: removed by a stakeholder decision; kept in a list so the decision is visible.
>
> Vendor precedents are in doc 02 §1.

---

## 1. Feature catalog

### A. Real-time operations

| # | Feature | Pri | Notes |
|---|---|---|---|
| A1 | Live occupancy, % full and spaces free (capacity from `config/config.yaml`) | MVP | Flow count S1, clamped, with a state label. |
| A2 | **Uncertainty band**, shown as "≈ 42 (39–46)" | MVP | Doc 03 §5. |
| A3 | Realtime push, connection pill, **per-device heartbeat chips** and last-read freshness | MVP | Refetch the snapshot on reconnect; one message per pass (Free tier). |
| A4 | Live pass feed with crops, confidence, match badge and a pause control | MVP | |
| A5 | "In the lot now" swimlanes, with overnight/multi-day badges | MVP | |
| A6 | Today-vs-typical-day fan chart | P1 | Shows the median only until ~3 weeks of data exist. |
| A7 | Effective-capacity (85 %) line and an "effectively full" state | MVP | |
| A8 | Bounce counter (in and out within 5 min) as a "practically full" signal | P1 | |
| A9 | Time-to-full ETA | P2 | |
| A10 | Internal TV/kiosk mode (`?kiosk=1`, logged in) | P1 | |
| A11 | **"Reconcile recommended" banner** | MVP | Raised by band width, drift or suspect-stale sessions (D2). |

### B. Historical analytics

| # | Feature | Pri |
|---|---|---|
| B1 | Occupancy over time, with capacity (history-aware) and 85 % lines | MVP |
| B2 | Arrivals and departures per hour or 15 min | MVP |
| B3 | Hour × weekday heatmap | MVP |
| B4 | Dwell distribution, median/P90, duration-by-arrival heatmap | P1 |
| B5 | Calendar heatmap of daily peaks | P1 |
| B6 | Cumulative flow diagram | P1 |
| B7 | KPI tiles with period-over-period deltas | MVP |
| B8 | Compare two periods | P1 |
| B9 | Peak Hour Factor, turnover, utilization, parking load | P1 |
| B10 | Hours at or above effective capacity | P1 |
| B11 | **Overnight / multi-day trend**: how often the "no overnight" rule is broken (D3) | P1 |
| B12 | Forecast: next-7-day peaks and an intraday forecast cone | P2 |
| B13 | Anomaly highlighting against the weekday-slot baseline | P2 |
| B14 | Annotations for special days: holidays, events, closures | P2 |
| B15 | Lot replay time-travel scrubber | P2 |
| B16 | Reconciliation markers on charts, showing the residual at each one | P1 |
| B18 | Weather overlay | P3 |

### C. Vehicle / plate level

| # | Feature | Pri |
|---|---|---|
| C1 | Plate search, exact and similar, with character diffs highlighted (audited) | MVP |
| C2 | Session drawer: entry and exit crops, per-character confidence, raw reads timeline | MVP |
| C3 | Vehicle profile: history, dwell trend, usual arrival time, aliases, overnight history | P1 |
| C4 | Plate correction and alias merge (**admin only**, audited) | P1 |
| C5 | Frequent-visitor ranking | P2 |
| C6 | Plate jurisdiction guess from the format prior (estimate only) | P2 |

### D. Data quality, health and reconciliation

| # | Feature | Pri |
|---|---|---|
| D1 | **Device health from heartbeats** (online/offline, status, camera connected, fps, pending uploads, clock offset) + last-read freshness | MVP |
| D2 | Coverage strip under each chart; "no data" is never shown as "zero" | MVP |
| D3 | Match review queue (**resolve: admin only**; staff view) | MVP |
| D4 | **Admin reconciliation page** (visual count, proposed residue, residual history) | MVP |
| D5 | Data-quality KPIs: read rate, match rate, orphan rate, suspect-stale count, fragmentation, rejected-track rate | P1 |
| D6 | Drift meter (S2 − S1) and flow balance | P1 |
| D7 | Self-calibrating OCR accuracy (confusion matrix learned from entry/exit pairs) | P2 |
| D8 | Read quality by hour of day, to spot glare and night problems | P2 |
| D9 | Camera anomaly detection (reads per hour vs baseline) | P1 |
| D10 | Health grade A–F | P2 |
| D11 | Weekly accuracy report page | P1 |
| D12 | **Supabase Free guards**: DB size gauge, storage gauge, backup status, cron failures | MVP |
| D13 | **Config view and sync status** (capacity, cameras, heartbeat and retention settings from `config/config.yaml`, synced at Vercel build) | MVP |
| D15 | Jump to archived video at a read's timestamp | P3 |

### E. Alerts (in-app only, D12)

| # | Feature | Pri |
|---|---|---|
| E1 | In-app banner, bell and inbox; staff view, **admin acknowledges and resolves** | MVP |
| E2 | Rule catalog with config-driven thresholds (§4) | MVP / P1 |

### F. Reporting and export

| # | Feature | Pri |
|---|---|---|
| F1 | CSV export of any filtered table, with a timezone choice | MVP |
| F2 | On-demand "Parking Pulse" summary as PDF or CSV | P1 |
| F3 | Saved views and shareable URLs | P1 |
| F4 | XLSX export | P2 |

### G. Ask the lot (AI)

| # | Feature | Pri |
|---|---|---|
| G1 | Natural-language Q&A over the rewritten views, checking coverage first. **OpenAI** (D18), in-process read-only SQL on Vercel. | P1 |
| G2 | Chat-to-chart | P2 |
| G3 | AI-written narrative in the on-demand Parking Pulse report | P2 |

### H. Admin, security and platform

| # | Feature | Pri |
|---|---|---|
| H1 | Supabase Auth (email + password). **Bootstrap admin from env** with a forced password change; the admin creates staff accounts; no public sign-up; roles `admin` and `staff` (staff read-only); everything protected by default | MVP |
| H2 | Config sync from `config/config.yaml` in the **Vercel pre-build step**, with capacity history | MVP |
| H3 | Audit log (plate search, image view, export, override, reconcile, role change) | P1 |
| H4 | Retention jobs: 30-day plaintext → HMAC pseudonym, 14-day crops, 7-day `reads[]` compaction | P1 (compaction MVP if volume is high) |
| H5 | Nightly backup (`pg_dump`) via GitHub Actions; heartbeats keep the Free project awake | MVP |
| H7 | **Multi-lot**: lot switcher, per-user lot access, per-lot config | Post-pilot |

### Descoped by stakeholder decision (kept for traceability)

| Item | Decision |
|---|---|
| Permit, staff, VIP, watch and banned lists; list alerts; permit-violation rule; visitor segmentation by privilege | D5: every vehicle is treated the same |
| Email, Slack, SMS and Web Push notifications; scheduled email reports | D12: in-app only for now |
| Public status page, embed, QR code, `/sign` kiosk tokens | D11 |
| Revenue / shadow-pricing simulator | D13 |
| Scheduled or automatic occupancy reset; automatic stale expiry | D2: the admin reconciles |
| Legacy data migration | D16: fresh start with event contract v2 |
| Uploading rejected tracks / unknown-plate passes | D24: bare minimum |
| Open-hours configuration | D20: overnight means present at 03:00 local |
| Tailgate and U-turn rules; nightly Hungarian re-match | D10: keep it simple (the re-match could return later if the review queue gets too busy) |
| Viewer / operator / investigator roles and plate masking by role | D4: just `admin` and `staff` |

---

## 2. KPI dictionary

These definitions are used everywhere: UI tooltips, reports and chat views.

- All time-bucketing uses `America/New_York`.
- "Sessions" excludes bounces unless stated otherwise.
- **Dwell metrics** use closed sessions only (`closed`, `closed_inferred`). They exclude `closed_admin`, `expired` and `orphan_exit`, because those have no true exit time.
- Capacity `C(t)` comes from `lot_capacity_history`.

| KPI | Definition / formula |
|---|---|
| Occupancy `Occ(t)` | Flow count S1 at t (doc 03 §5), clamped to `[0, C(t)]` |
| Occupancy % | `Occ(t) / C(t)` |
| Spaces free | `C(t) − Occ(t)` |
| Effective capacity | `C × effective_capacity_pct` (default 0.85, from config) |
| Peak occupancy (and its time) | `max Occ(t)` in the period, and when it happened |
| Hours effectively full | `Σ Δt where Occ(t) ≥ effective capacity` |
| Entries / Exits | Passes by direction, after de-dup |
| Net flow | Entries − exits per bucket |
| Parking load (vehicle-hours) | `∫ Occ(t) dt` |
| Utilization (time-averaged) | `load / (C × hours_in_period)` |
| Turnover | `sessions started in the period / C`, per day |
| Average / median / P90 dwell | Over the closed sessions defined above |
| Peak Hour Factor | `V_hr / (4 × V_15max)` on entries in the peak hour |
| Bounce rate | Sessions with dwell < `bounce_max` / all sessions |
| **Overnight count** | Sessions present at 03:00 local, per night (D3, D20). The rule says it shouldn't happen; this KPI shows how often it does. |
| **Multi-day count** | Open sessions older than 24 h |
| Unique vehicles | Distinct `plate_norm`, or pseudonym after 30 days |
| Visits per vehicle | Sessions / unique vehicles |
| Repeat-visitor rate | Vehicles with ≥ 2 distinct visit-days / unique vehicles. Only meaningful within the 30-day plaintext window, or within a pseudonym key period. |
| Flow balance | `exits / entries` per day |
| **Reconciliation residual** | `estimate_before − visual_count` at each admin reconciliation |
| **Days since last reconciliation** | Shown next to the hero number |
| Match rate, orphan rate, read rate, etc. | Doc 03 §7 |
| Forecast MAE (P2) | Mean of `abs(forecast − actual)` per slot over the last 4 weeks |

---

## 3. Visitor segmentation: descoped (D5)

Behaviour-based segmentation (commuter, regular, one-time) was planned for P2. Given "everyone is equal, keep it simple", it is **descoped**. The simple KPIs (unique vehicles, repeat-visitor rate, frequent-visitor ranking in P2) cover the useful part. It can be revisited after the pilot.

---

## 4. Alert rules (in-app only)

| Rule | Default params (overridable in config) | Severity | Pri |
|---|---|---|---|
| Lot approaching full | Occ ≥ 85 % for 5 min | info | MVP |
| Lot full | Occ ≥ 98 % | warning | MVP |
| **Camera / device offline** | No heartbeat for 180 s (3 × 60 s), or `camera_connected = false` | critical (banner) | MVP |
| Unknown `camera_id` / bad `schema_version` | Event quarantined | critical (banner) | MVP |
| **Reconcile recommended** | Band half-width > 2 % of C, `abs(S2 − S1)` > 3, or suspect-stale sessions at 06:00 | warning (banner) | MVP |
| **DB size** | > 70 % of the 500 MB Free limit | warning (banner) | MVP |
| Backup failed or missing | No successful backup in 36 h | critical (admin) | MVP |
| Device degraded | heartbeat `status = degraded/error` | warning | MVP |
| Upload backlog / clock skew | `pending_uploads` > 50 or `abs(clock_offset)` > 5 s (from heartbeats) | warning | P1 |
| Review queue backlog | > 20 pending, or oldest > 24 h | info | P1 |
| Overnight vehicles | ≥ 1 overnight session (morning summary) | info | P1 |
| Demand anomaly | Robust z ≥ 3 against the weekday-slot baseline | info | P2 |
| Read-quality degradation | Median confidence down > 15 % vs the 7-day same-hour value | warning | P2 |

Each rule has an `alert_key` used for de-duplication, a cooldown, and auto-resolve when its condition clears. Nothing is delivered outside the app. Only admins acknowledge or resolve alerts (D22).

---

## 5. "Wow" list for stakeholder demos

1. **Honest occupancy:** the uncertainty band, the drift meter, and the residual history from admin reconciliations, which shows how close the system is to the visual count.
2. **One-screen reconciliation:** the admin types the count, and the system proposes which ghost sessions to clear, with thumbnails.
3. **Today vs typical** fan chart, plus a time-to-full ETA (P2).
4. **Lot replay** scrubber for any past day (P2).
5. **Self-calibrating OCR accuracy** from entry/exit pairs (P2).
6. **Bounce rate** as the "practically full" signal.
7. **Overnight / multi-day** visibility for a rule people bend.
8. **Ask the lot**, with charts (P2).
