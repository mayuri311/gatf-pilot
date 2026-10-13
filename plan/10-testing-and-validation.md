# 10 — Testing, Validation & Accuracy Measurement

> Updated for [doc 12](12-decisions-and-constraints.md). A parking dashboard is only as credible as the number in the big tile. This doc covers how we prove the numbers, not just that the code runs.

---

## 1. Test pyramid

| Layer | Tooling | What is covered |
|---|---|---|
| **SQL unit** | `pgTAP` via `supabase test db` (local `supabase start`) | Normalization (`plate_norm`, `plate_key`), similarity function (table-driven: `Z94PVE`/`Z94PWE` ≥ 0.85; `ABC1234`/`ABC1284` margin rule), de-dup, session state transitions, occupancy timeline, RLS policies (**`staff` is read-only**: cannot resolve matches, correct plates, ack alerts, reconcile or manage users; anonymous users see nothing), `report_heartbeat` contract, RPC contracts, config-sync idempotency, `reads[]` compaction, retention/pseudonymization. |
| **Sessionizer scenario tests** | pgTAP + fixture loader | Scripted event sequences → expected sessions/occupancy. See §2. |
| **Frontend unit** | Vitest + React Testing Library | Formatters (local time, dwell), chart data transforms, kiosk plate-hiding, reconcile-proposal UI logic. |
| **API / integration** | Vitest against local Supabase | RPC + route handlers, auth cookies, signed URL issuance, CSV export, **chat route** with the OpenAI client mocked: tool-call loop bounds, the in-process read-only SQL tool (writes rejected by role, `statement_timeout` enforced, row caps), Postgres rate limiter. Config-sync script against fixtures. Bootstrap-admin creation is idempotent and forces a password change. |
| **E2E** | Playwright | Login → live dashboard updates when a fixture event is inserted (realtime) → search a plate → open vehicle profile → export CSV → **admin reconciles from a mobile viewport** (count entry, proposal, confirm, residual shown) → staff login sees review cards read-only. Visual regression on the TV/kiosk view. |
| **Accessibility** | `@axe-core/playwright` | WCAG 2.2 AA on every page. |
| **Load / budget** | Python replayer | 10× expected peak (e.g. 300 reads/min burst) with 20 concurrent dashboards. Verify the Realtime message count per pass is 1 per subscriber, so 30 days of projected traffic stays under the Free tier's 2 M msgs/month. Projects DB growth against the 500 MB limit with compaction on. |

---

## 2. Scenario fixtures (golden tests for the sessionizer)

Each fixture = ordered list of reads + expected end state. Minimum set:

1. **Happy path** — 3 cars in, 3 out, exact plates → 3 closed sessions, occupancy back to 0.
2. **OCR near-miss** — entry `Z94PVE`, exit `Z94PWE` → fuzzy match, method=`fuzzy`.
3. **Ambiguous twins** — `ABC1234` and `ABC1284` both parked; exit reads `ABC12B4` → `fuzzy_pending`, never auto.
4. **Fragmented track** — two entry reads 4 s apart (`Z94PVE`, `'94PVE'`) → 1 pass.
5. **Two cars close together** — two different plates 2 s apart → 2 passes (not merged; similarity gate, no special tailgate rule per D10).
6. **Missed exit then re-entry** — A in (day 1), A in (day 2) → day-1 session `CLOSED_INFERRED`.
7. **Missed entry** — exit with no candidate → orphan; occupancy best estimate decrements, band widens.
8. **Late arrival** — exit read uploaded 3 h late (offline edge) → re-sessionize yields same result as in-order.
9. **Out-of-order within batch** — catch-up uploader sends in reverse order → identical result.
10. **Duplicate delivery** — same `event_id` twice → no change.
11. **Overnight / multi-day flags** — A enters 18:00, no exit → flagged `overnight` at closing/03:00, `suspect_stale` and `multi_day` after 24 h. **Still open and still counted**; nothing auto-closes (D2/D3).
12. **Admin reconciliation** — S1 = 47, S2 = 52, admin enters 41. Proposal ranks suspect-stale and multi-day sessions first. Admin keeps one and closes 11 → S2 = 41 (closed as `closed_admin`), S1 re-anchors to 41, residual = 6 recorded, band collapses to ±0. Re-running the sessionizer afterwards preserves all of this.
13. **Staff override survives recompute** — manual pair, then late event triggers re-run → pair preserved.
14. **Bounce** — in and out in 90 s → counted as bounce, excluded from dwell stats by default.
15. **DST boundary** — sessions spanning 2026-11-01 02:00 fall-back render the right local hours and dwell.
16. **30-day bound** — a session open for 31 days → `expired` by retention (the only automatic closure); plate pseudonymized.
17. **Heartbeat offline/online**: heartbeats stop for 180 s → device `offline`, in-app critical banner, one `device` broadcast; beats resume → auto-resolve, one broadcast. Steady heartbeats produce **no** broadcasts.
18. **Contract validation**: event with `schema_version` ≠ 2, or an unknown `camera_id`, or `captured_at_utc` 10 min in the future → quarantined in `ingest_errors` / flagged as skew; occupancy unchanged.
19. **Capacity change** — config capacity 100 → 120 at time T: % full before T uses 100, after T uses 120.
20. **Role enforcement**: a staff JWT calling `resolve_match`, `reconcile_commit`, `correct_plate` or `ack_alert` → permission denied; the same calls succeed for admin.

---

## 3. Synthetic data generator (`occupancy_analyzer/simulator`, `occsim`; full spec in [doc 14](14-implementation-layout-offline-testing-simulator.md) §3)

Needed for development, demos and load tests long before months of real data exist.

- Arrival process: non-homogeneous Poisson with a weekday/hour profile (morning peak, lunch churn, evening drain), weekends lighter.
- Dwell: mixture (short 5–30 min visitors, 1–3 h, 8–9 h commuters, and a **small overnight/multi-day tail even though it's not allowed** (D3)).
- Plate pool: realistic PA passenger formats + some out-of-state + a "regulars" pool (repeat visitors).
- **Noise injection** mirroring real producer behaviour: per-char confusion substitutions, dropped leading char, missed reads (configurable rate per camera), fragmentation, close-following cars, late uploads. It also simulates **periodic admin reconciliations** (visual count = ground truth) to measure the residual.
- Emits *exactly* **event contract v2** and **heartbeat v1** (doc 13), including `camera_id`, `device_id`, `captured_at_utc` and `reads[]`. It can also simulate a device going offline. and can (a) write folders for `upload_events.py`, or (b) insert directly, or (c) replay at N× real time to exercise realtime UI.
- Because ground truth is known, the generator reports the sessionizer's **match precision/recall** and occupancy error — this is how thresholds in doc 03 §8 get tuned before field data exists.

---

## 4. Field validation protocol (the pilot's credibility)

1. **Ground truth = admin reconciliations (D2)**. For the first 2–3 weeks, the admin reconciles at least daily, ideally 2–3× per day (e.g. 07:00, 12:00, 17:00), from a phone in the lot. Each reconciliation records the residual (estimate − visual count) **before** correcting, which makes it the primary accuracy measurement. The dashboard shows the residual history.
2. **Labeled pairs**: the review queue doubles as a labeling tool — every confirm/reject becomes a training example for the match model (doc 03 §4.1). Target: 300+ labeled exit→entry pairs.
3. **Read-accuracy audit**: weekly random sample of 50 reads → staff compare crop vs `plate_text` (in the Reads gallery) → per-character accuracy, confusion matrix (feeds `CONFUSABLE` weights).
4. **Video cross-check**: for a sampled hour, count passes in the archived video (`scripts/video` index) vs passes in DB → miss rate per camera, by lighting condition (day / dusk / night / rain).
5. Publish an **Accuracy Report** page (auto-generated weekly) — read rate, match rate, occupancy MAE vs manual counts, by condition. This is a stakeholder-facing deliverable.

### Acceptance targets for "pilot success" (proposed — confirm with stakeholders)

| Metric | Target |
|---|---|
| Reconciliation residual (abs mean, vs admin visual counts) | ≤ 3 % of capacity |
| Exit match rate | ≥ 95 % |
| False auto-match rate (labeled) | ≤ 0.5 % |
| Dashboard live latency (read on edge → tile update) | p95 ≤ 5 s (online) |
| Dashboard availability (07:00–19:00 local) | ≥ 99.5 % |

---

## 5. CI

GitHub Actions: gitleaks + lint + typecheck + Vitest + config-schema validation of `config/config.yaml`; spin up `supabase start` → apply migrations → pgTAP → Playwright against `next build && next start`. Migrations are the only way schema changes (no dashboard-SQL-editor drift once the project is past the pilot setup).
