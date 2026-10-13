# 08 — Security, Privacy & Compliance

> **Not legal advice.** Have counsel review before go-live, and check again in early 2027: Pennsylvania ALPR legislation is moving fast (doc 02 §4). This version reflects [doc 12](12-decisions-and-constraints.md):
> - two roles, with staff read-only;
> - a bootstrap admin;
> - retention of 30 days for plaintext plates and 14 days for crops;
> - Vercel Hobby plus Supabase Free;
> - OpenAI for the chat;
> - no public page;
> - you accept the current key handling (D25).

---

## 0. Secrets: the practical minimum (D25)

You've accepted the current handling of the Supabase and OpenAI keys, so the plan doesn't require rotating them. Two constraints still apply in practice:

1. **Vercel can only read secrets from project environment variables.** It can't read them from an untracked local file. The dashboard therefore needs `SUPABASE_SECRET_KEY`, `OPENAI_API_KEY`, `READONLY_DATABASE_URL`, `PLATE_HMAC_KEY` and `BOOTSTRAP_ADMIN_PASSWORD` set in Vercel. The admin *email* is not secret and lives in `config.yaml`.
2. **The config file gets committed** so the Vercel build can sync capacity and cameras. The committed `config/config.yaml` v2 therefore contains **no keys** (doc 13 §3). **Applied 2026-10-12:** the keys that used to be in the file are now in the repo-root `.env`, which is gitignored and has mode 600. The Jetsons read their key from their local `.env`. Remove `config/` from `.gitignore` before the first deploy.

Optional, cheap insurance: run gitleaks in CI.

---

## 1. Threat model (summary)

| Asset | Threats | Primary controls |
|---|---|---|
| Plate history (who parked when) | Misuse by insiders; leaks; keeping data too long | Admin-created accounts only, audit log, 30-day plaintext retention then HMAC pseudonyms, a written use policy |
| Plate crops | Bulk scraping; shared URLs | Private bucket; 5-minute signed URLs issued only through an audited route; 14-day retention; plates hidden by default on the wall screen |
| Ingest path | Spoofed device; stolen device key | Per-device key; validation and quarantine for unknown camera or schema version; heartbeat cross-check of `device_id` |
| Dashboard / API | Unauthenticated access (today `/` is public, gap G4); session theft | Supabase Auth, protect-by-default `proxy.ts`, server-side re-verification |
| Bootstrap admin | Default password left unchanged or leaked | Password kept in an env var, never in the repo; forced change at first login; audit log |
| NL chat (OpenAI) | Prompt injection, leading to data exfiltration or destructive SQL; plate data sent to a third party | Read-only role, view-only grants, statement timeout, loop bounds, history sanitization, aggregate-first views, `ai.enabled` toggle |
| Data durability | Supabase Free has **no backups** | Nightly `pg_dump` via GitHub Actions; a restore drill |
| Availability | Camera or edge outage; Free project paused | **Heartbeat-based offline banner**; heartbeats also count as project activity |

---

## 2. Authentication and authorization (D21, D22)

- **Supabase Auth with email + password**, and **public sign-up disabled**.
  - **Bootstrap admin:** `mayuri.murugs@gmail.com` (`auth.bootstrap_admin_email` in config). On first deploy, a server-side seed creates the account with the password from the `BOOTSTRAP_ADMIN_PASSWORD` env var. The seed is idempotent and sets `must_change_password = true`. The login flow forces a new password before any other page loads.
  - **No real emails are sent.** Accounts are created through the Supabase Auth admin API with `email_confirm: true`, so Supabase sends no confirmation, invite or magic-link mail. Because there is no "forgot password" flow, a locked-out user asks the admin to reset the password. If the bootstrap admin loses their password, the reset path is the Supabase dashboard (Authentication → Users). Adding email later means configuring a custom SMTP provider in Supabase.
  - **Other users:** the admin creates them in `/admin/users`, giving each an email, a temporary password and a role. No outbound email is needed.
- **`proxy.ts` protects everything except `/login`.** Route handlers and RPCs re-verify the session themselves.
- **Roles are stored in `app_metadata.role`**, which only the server can set, and are checked by `authorize()`:

| Permission | staff | admin |
|---|:-:|:-:|
| Live view, analytics, sessions, reads, crops, plate search, vehicle profile (audited) | ✔ | ✔ |
| Export CSV/PDF (audited) | ✔ | ✔ |
| Ask the lot (chat) | ✔ | ✔ |
| View review queue, alerts, health | ✔ (read-only) | ✔ |
| **Resolve matches, correct plates, ack/resolve alerts** | | ✔ |
| **Reconcile occupancy** | | ✔ |
| Users, config view, audit log, system status | | ✔ |

- Use **asymmetric JWT signing keys**, and keep access-token lifetime at 15 minutes or less.

---

## 3. Keys and environments

| Where | Secrets |
|---|---|
| Vercel project env | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (public), `SUPABASE_SECRET_KEY`, `READONLY_DATABASE_URL` (`gatf_readonly` via Supavisor), `OPENAI_API_KEY`, `PLATE_HMAC_KEY`, `BOOTSTRAP_ADMIN_PASSWORD` |
| Each Jetson `.env` | `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (one per device if possible) |
| GitHub Actions secrets | `DATABASE_URL` (backup), `SUPABASE_SECRET_KEY` (crop deletion) |

The browser only ever receives the publishable key. Migrate to publishable and secret keys before the legacy keys retire at the end of 2026.

---

## 4. Data retention and minimization (D6)

| Data | Retention | Then |
|---|---|---|
| Plate crops (about 3.4 KB each) | **14 days** | Deleted through the Storage API (GitHub Actions) |
| Per-frame OCR array `reads[]` | **7 days** in full | Compacted to the top-5 alternates; nulled at 30 days |
| Plaintext plates | **30 days** | Replaced by the pseudonym `HMAC-SHA256(k_period, plate_norm)` |
| Pseudonymized sessions | 13 months | Deleted |
| Aggregates | Indefinitely | — |
| Audit log | 2 years | Archived |
| Heartbeats | Latest row per device only | Overwritten |
| Backups (`pg_dump`) | 14 days | Rotated (they contain at most 30 days of plaintext) |
| Old `events_v0` table | Until the pilot runs | Dropped (D16) |

- **Keyed HMAC, not a plain hash.** The roughly 176 M possible PA plates can be brute-forced if hashed without a key. The key rotates quarterly.
- **No owner lookups**, which keeps the DPPA out of scope. There are no PII tables at all, since D5 means no lists.
- **No audio** (PA Wiretap Act).
- **OpenAI processing.** Chat answers can include plates from query results. Disclose this in the use policy. Keep the chat views aggregate-first. `ai.enabled: false` turns the chat off. Check OpenAI's current API data-retention terms *[verify]*.
- **Future option:** a 72-hour strict mode, should a PA bill be enacted that covers private operators.

---

## 5. Audit and accountability

`audit_log` is append-only. It records:
- plate searches;
- vehicle profile views;
- image views;
- exports;
- match resolutions and plate corrections;
- alert acknowledgements;
- **reconciliations**;
- user creation and role changes;
- bootstrap-admin creation;
- config syncs.

Admins view it at `/admin/audit`. It lives in a table because Supabase Free keeps logs for only 1 day.

---

## 6. Policy and transparency deliverables (non-code)

1. **ALPR Use & Privacy Policy**, covering:
   - purpose: occupancy analytics;
   - users: admin and staff;
   - retention: 30 days for plates, 14 days for crops;
   - **AI processing by OpenAI for chat questions**;
   - no sharing without legal process;
   - security, audit and a contact.
2. **Entrance signage:** "License plate recognition in use for parking occupancy. Data retained up to 30 days. Contact: …". Signage is best practice; whether PA requires it is *[unverified]*.
3. **A procedure for law-enforcement requests.**
4. **An annual review.**

---

## 7. Application security checklist

- RLS on every table, with **explicit GRANTs** (required from 2026-10-30). Use `security invoker` functions. The two `security definer` functions (`report_heartbeat` and the bootstrap seed) set `search_path = ''` and run explicit checks.
- Validate inputs with zod. Rate-limit through Postgres. Cap exports.
- Headers: CSP, `frame-ancestors 'none'`, HSTS, `Referrer-Policy: no-referrer`.
- Apply the **2026-10-14 Next.js security release**. Use Renovate or Dependabot.
- Nightly `pg_dump`, plus a restore drill during the pilot.
- No credentials in event `source` URLs (contract v2).
