# 11 — Risks & Open Questions

> Updated 2026-10-12 after two rounds of stakeholder answers. Decisions D1–D28 are in [12-decisions-and-constraints.md](12-decisions-and-constraints.md).

---

## 1. Resolved

| Round | Questions | Decisions |
|---|---|---|
| 1 | Q1–Q15 (capacity, reset, overnight, roles, lists, retention, hosting, DB tier, producer fields, barrier, public page, notifications, revenue, multi-lot, legacy) | D1–D15 |
| 2 | Q-A legacy, Q-B config, Q-C LLM, Q-D Vercel plan, Q-E open hours, Q-F admin accounts, Q-G review rights, Q-H heartbeat, Q-I rejected tracks, Q-J keys | D16–D25 |

## 2. Still open

**None.** The last three confirmations were resolved on 2026-10-12:

| # | Item | Resolution |
|---|---|---|
| O1 | OpenAI model id | `gpt-5.6-terra` (D26) |
| O2 | Config v2 | Approved and **applied** to `config/config.yaml`; secrets moved to `.env` (D27) |
| O3 | Bootstrap admin | `mayuri.murugs@gmail.com`; no emails are sent (D28) |

**One housekeeping item:** `.gitignore` currently ignores `config/`. The Vercel build needs `config/config.yaml`, which now holds no secrets, so remove that line before the first deploy.

---

## 3. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | **Missed reads** (night, rain, glare, dirty plates) cause occupancy drift. Rejected tracks are not uploaded (D24). | High | High | Flow-count headline, uncertainty band, drift meter, **admin reconciliation** with a banner prompting it, and read-quality diagnostics to guide camera tuning |
| R2 | **False fuzzy matches** distort dwell times | Medium | Medium | Match only against cars in the lot, margin rule, ≤ 2 confusable substitutions, admin review queue |
| R3 | **Clock or timestamp errors** on the Jetsons | Medium | Medium | `captured_at_utc` (contract v2), clock offset derived from heartbeats, skew flag |
| R4 | **Edge offline** leads to late batches | Medium | Medium | Watermark plus re-sessionizing; `pending_uploads` in heartbeats; "catching up" banner |
| R5 | **Truck-tractors** (front plate only), plateless vehicles, temporary tags | Low–Medium | Low | Absorbed by reconciliation |
| R6 | **Pennsylvania legal change** (2026 ALPR bills) | Medium | Medium | Configurable retention, audit log, documented 72 h strict-mode option |
| R7 | **Supabase platform changes** (Data API grants on 2026-10-30, legacy key retirement, Realtime partition quirk) | High (known) | Medium | Phase 0 tasks; doc 04 §11 checklist |
| R8 | **Supabase Free limits** | Medium | High | Compaction, size gauge, nightly `pg_dump`, heartbeats as keep-alive, Pro upgrade trigger |
| R9 | **Secrets.** The owner accepts the current key handling (D25), but secrets in a committed YAML would leak through git. | Medium | High | Keep keys only in env vars and the Jetson `.env`; the committed YAML has none (doc 13 §3) |
| R10 | **Vercel Hobby** terms describe non-commercial use; serverless constraints apply | Medium | Low (PoC) | Fine for the PoC; move to Pro for production; in-process SQL; rate limiter in Postgres |
| R11 | **Plate data sent to OpenAI** through chat answers | Medium | Medium | Prefer aggregate views; disclose in the use policy; `ai.enabled` toggle |
| R12 | **Default admin password** left unchanged or leaked | Low | High | Password kept in an env var, forced change at first login, audit log |
| R13 | Camera fails without anyone noticing (no notifications, D12) | Medium | High | **Heartbeat-based offline banner**, freshness chips, daily habit of opening the dashboard |
| R14 | Scope creep pushes out accuracy work | Medium | High | Phase gates; "keep it simple" decisions |

---

## 4. Assumptions

- About 200–2 000 reads/day; capacity in the low hundreds; Supabase Free.
- One entry lane and one exit lane, each fully covered by its camera; no barrier.
- Jetsons are NTP-synced to within ~1 s and send heartbeats every 60 s.
- `event_id` is a uuid4 that stays stable across retries.
- Both roles are trusted internal users. Plate access is still audit-logged.
