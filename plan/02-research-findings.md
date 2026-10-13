# 02 — Research Findings (synthesis)

> Desk research done 2026-10-12 across four tracks:
> 1. commercial parking/LPR analytics products and KPIs;
> 2. ALPR entry/exit matching, Pennsylvania plate formats and legal context;
> 3. the Supabase / Next.js backend stack;
> 4. dashboard UX and visualization.
>
> Claims marked *[unverified]* could not be confirmed from a primary source. **Nothing here is legal advice.**

---

## 1. Market scan: what comparable products do

### 1.1 The closest analog is ParkPow (Plate Recognizer)

ParkPow is an LPR-first parking dashboard built on almost exactly our topology: entrance and exit cameras, plate reads, and occupancy derived by subtracting exits from entries. Its feature set is a sensible **minimum bar** ([features](https://parkpow.com/features), [docs](https://guides.platerecognizer.com/docs/tags/parkpow)):

- **Dashboard.** A Visits/Occupancy chart toggle, a **Realtime mode** with a "last refresh N s ago" timer, and summary cards. The records table shows entrance, exit, duration and plate with a confidence badge; hovering a row shows the plate crop.
- **Filters.** Site, camera, plate, **confidence in 10 % steps**, and tag.
- **Occupancy model.**
  - Each site has a capacity, and each camera is assigned the Entrance or Exit role.
  - **Scheduled occupancy reset** (daily, weekly, monthly or quarterly), plus a one-time **"Update Occupancy"** that sets the count manually.
  - **"Absent Time"** merges repeat visits by the same plate within N minutes.
- **Matching.** Two cascaded thresholds. Below a *Fuzziness Score* it merges look-alike characters. Below a *Mismatch Score* it looks for existing vehicles at a small Levenshtein distance.
- **Vehicle CRM.** Visit history, comments, custom fields, tags (Employee/Visitor/Denied…), bulk import, and a "most frequent vehicles" report.
- **Alerts.**
  - Trigger types: Arrival, Arrival Frequency (circling), On-Premise-After-Time, and Parking Duration (overstay).
  - Each trigger can be filtered by tag, weekday or time window.
  - Delivery by email, webhook (with retries), MQTT, Slack, Teams and others.
- **Operations.** A visit **review tool** (split, merge, modify), **camera anomaly detection** (a 20-day model of visits per hour), an **Occupancy Sign** full-screen page, an audit log, 5 roles, CSV export with a timezone choice, and 365-day history.
- **Gaps we can beat.** ParkPow uses a single plate score, not per-character confidence. It shows no turnover, Peak Hour Factor or effective-capacity line, no dwell histogram, no forecasting, no entry/exit reconciliation view, and no data-quality KPIs beyond its anomaly alerts.

### 1.2 Other vendors (patterns worth borrowing)

| Vendor | Notable idea |
|---|---|
| **Genetec AutoVu Free-Flow** | Explicit occupancy semantics: every entry +1 (even misreads/NOPLATE), every exit −1 (even "unknown vehicle"). Stale sessions are closed by a **maximum session time** without changing occupancy. A scheduled "inventory reset". The **OCR-equivalence matcher** allows at most 2 equivalent-character differences ([docs](https://techdocs.genetec.com/r/en-US/Security-Center-Administrator-Guide-5.12/How-parking-zone-occupancy-is-calculated), [matcher](https://techdocs.genetec.com/r/en-US/Security-Center-Administrator-Guide-5.13/ALPR-matcher-technique-OCR-equivalence)). |
| **Density (Atlas)** | **"Replay any hour of any day"** (time travel); hour×day heatmaps; daily bars coloured against a target-utilization band ([Atlas](https://density.io/resources/atlas-heatmaps-observations-reporting)). |
| **Cleverciti / SKIDATA / INRIX / ParkHub Smarking** | Demand forecasting, predicted availability, "what-if" pricing simulation, utilization heatmaps. |
| **Parking BOXX / FlashParking (FlashIQ)** | Turnover, average length of stay, peak hours, **equipment-health** monitoring, lot-full alerts by email/SMS/in-app, scheduled emailed reports. |
| **Flowbird / Hikvision / Vaxtor** | Camera status heartbeats, guidance/LED availability signs, overstay ("Time-Cross") reports. |
| **Juniper Mist** | Simple occupancy bands: < 50 %, 50–80 %, > 80 %, > 100 %. |
| **Grafana** | `?kiosk` TV mode and dashboard playlists. |

### 1.3 Standard KPIs (definitions adopted in doc 06 §2)

Accumulation and occupancy %, peak occupancy and its time, **parking load** (vehicle-hours = the area under the occupancy curve), average/median/P90 duration, **turnover** (vehicles per space per day; garages typically see about 3–5), time-averaged **utilization** = load / (capacity × hours), **Peak Hour Factor** `PHF = V_hr / (4·V_15max)`, and **effective capacity** (85 % on-street / ~90 % off-street is treated as "functionally full"; Shoup's 85 % rule) ([NPTEL](https://archive.nptel.ac.in/content/storage2/courses/105101008/581_Parking/point6/point.html), [NIATT PHF](https://www.webpages.uidaho.edu/niatt_labmanual/Chapters/capacityandlos/theoryandconcepts/PeakHourFactor.htm), [SFpark evaluation](https://millardball.its.ucla.edu/wp-content/uploads/sites/22/2022/06/Millard-Ball_Weinberger_Hampshire_2014_Assessing_the_impacts_SFPark.pdf)). The exact Walker 85/90 split is cited only second-hand *[unverified]*.

---

## 2. Matching noisy plates between entry and exit

- **Equivalence classes are industry-standard.** Genetec's defaults are 0/O/D/Q, 1/I, 2/Z, 5/S, 8/B and 6/G. Our template track adds P/F and V/W/N from real data.
- **Academic evidence that edit distance plus timing works.** Oliveira-Neto et al. matched ~97 % of trucks between two LPR sites even though only ~60 % of plates were read correctly at each site, with a ~2 % false-match rate. The **weighted** edit distance from a learned character-association matrix outperformed plain Levenshtein ([TRID 882032](https://trid.trb.org/View/882032), [dissertation](https://trace.tennessee.edu/utk_graddiss/836)).
- **False matches distort dwell far more than they distort counts.** Fowkes (1983) showed this ([TRID](https://trid.trb.org/View/202738)). It justifies using the flow count as the headline occupancy figure and sessions for dwell (doc 03 §5).
- **Global re-matching beats greedy matching.** Watling & Maher (1992) search for the "most probable complete matching" ([RePEc](https://ideas.repec.org/a/eee/transb/v26y1992i3p171-193.html)). That is the basis for the nightly Hungarian re-match, now deferred per D10 (doc 12).
- **Our structural advantage.** We only ever match against **cars currently in the lot** (≤ capacity), not a regional population. That keeps false-match risk low.
- **Self-calibration.** Every matched visit is two independent reads of the same plate. The two strings let us measure per-camera read accuracy and a live confusion matrix **without manual ground truth**. No vendor we found exposes this, which makes it a differentiator.

---

## 3. Pennsylvania plates

- **Rear-only display.** 75 Pa.C.S. § 1332 together with 67 Pa. Code § 47.2 requires a single rear plate. **Truck-tractors display the plate on the front**, so rear cameras will miss them ([47.2](https://regulations.justia.com/states/pennsylvania/title-67/part-i/subpart-a/article-iii/chapter-47/section-47-2)).
- **Passenger plates are `ABC1234`.** The 2024+ "Let Freedom Ring" base began issuing around mid-2025 from about `MYR0200`. It prints **no hyphen** and uses **slashed zeros**, so normalization must map `Ø→0`. Older visitPA plates remain valid, so expect a mix of both bases ([Wikipedia](https://en.wikipedia.org/wiki/Vehicle_registration_plates_of_Pennsylvania), [PennDOT](https://www.pa.gov/agencies/dmv/vehicle-services/registration-plates/standard-issue-registration-plate)).
- **Other formats:**
  - Truck and apportioned: `AB12345`, plus a newer 3-letter + 4-digit series that collides with the passenger pattern.
  - Motorcycle: 5-character variants.
  - Dealer: `H12345H` style.
  - Many special plates: 2-letter prefix + 5 digits.
  - Vanity plates: up to 7 characters.
  - Excluded letters on current serials are unconfirmed *[unverified]*, so I/O/Q must **never be hard-rejected**.
- **Neighbouring states.** NJ `A12BCD` (our sample `Z94PVE` fits NJ), NY/OH `ABC1234`, MD `1AB2345` *[unverified]*.
- **Consequence.** Plate-format regexes serve as a **soft scoring prior**, never as a filter (doc 03 §2).

---

## 4. Legal and privacy context (not legal advice; verify with counsel)

- **PA has no ALPR statute in force** *[verify at palegis.us]*.
  - HB 1811 (2017–18), which would have required 60-day destruction, died in the Senate.
  - **2026 is very active.** At least 9 bills are in play. **HB 2771** was introduced 2026-09-14 ([BillTrack50](https://www.billtrack50.com/billdetail/2013588)). Per that summary it would:
    - allow ALPR only for listed purposes, with parking enforcement among them;
    - require **deletion within 72 h**, with exceptions;
    - ban front-facing and occupant imagery.
  - A Senate memo proposes audit trails, documented reasons for searches, retention standards and penalties ([PA Senate](https://pasenate.com/?p=151106)), and the Governor has signalled support for a bill.
  - Most of these proposals target government and Flock-style use. **Whether a final law reaches private lot operators is unknown.** We design for the strict case anyway.
- **Other states as benchmarks.** Connecticut (2026) sets 21-day retention. Arkansas sets 150 days and applies to private entities. California SB 34 requires private ALPR operators to publish a usage/privacy policy and keep access logs ([MultiState](https://www.multistate.us/insider/2026/9/23/automatic-license-plate-readers-face-growing-state-restrictions-in-2026)).
- **DPPA (18 U.S.C. § 2721).** Optical plate capture alone is generally outside its scope. It **applies once owner data is looked up** from PennDOT or a data broker, so: **no owner lookups.**
- **PA breach law** (73 P.S. § 2301, amended by Act 33 of 2024). A plate number is not listed as "personal information". Linking plates to names, payment details or accounts changes that, so keep permit-holder PII minimal and separate.
- **PA Consumer Data Privacy Act (HB 78).** Passed the House and is pending in the Senate; it may make plate-linked visits "personal data" if enacted.
- **Wiretap Act** (18 Pa.C.S. § 5703, all-party consent). Cameras **must not record audio**.
- **Best practice.** ACLU: retain non-hit data for days, not years. IACP: a written policy covering purpose, access, audit and retention. Plain hashes of plates are brute-forceable, because the PA passenger space is only ~176 M combinations. **Use a keyed HMAC with key rotation.**

---

## 5. Platform facts that shape the build (as of 2026-10-12)

| Fact | Impact |
|---|---|
| Supabase Realtime **Broadcast from database** is the recommended pattern. Postgres Changes runs per-subscriber RLS on a single thread ([docs](https://supabase.com/docs/guides/realtime/subscribing-to-database-changes)). | Use private broadcast channels. |
| `realtime.send` fails if no client has connected that day. | Wrap every send in an exception handler. |
| **TimescaleDB is deprecated** on Supabase and unavailable on PG17 ([docs](https://supabase.com/docs/guides/database/extensions/timescaledb)). | Use plain tables, BRIN indexes and rollup tables. |
| From **2026-10-30**, new tables in existing projects are not auto-exposed to the Data API ([changelog](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically)). | Every migration needs explicit GRANTs. |
| **Legacy anon/service_role keys are deprecated by end of 2026.** The replacements are `sb_publishable_…` and `sb_secret_…` ([docs](https://supabase.com/docs/guides/api/api-keys)). | Migrate keys; give each device its own key. |
| `getClaims()` verifies locally only with **asymmetric JWT keys**. | Switch the project's JWT signing keys. |
| Supabase Queues (pgmq) is durable; pg_net has no retries. | Relevant only if external notifications are added later (descoped for now, D12). |
| Edge Functions: 2 s CPU limit, SMTP ports blocked. | Run ML in a Python job (GitHub Actions). If email is added later, use an HTTP API such as Resend. |
| **Next.js 16.4** is current. An **out-of-band security release is scheduled for 2026-10-14**. `"use cache"` is stable behind `cacheComponents`. `revalidateTag` now requires a profile argument. | Upgrade from 16.2.12. Cache only historical queries. |
| **Supabase Free** (confirmed on [pricing page](https://supabase.com/pricing)): 500 MB DB, 1 GB storage, 5 GB egress, **no backups**, **paused after 1 week of inactivity**, 1-day logs, 200 concurrent Realtime connections, **2 M Realtime messages/month**, 500 k Edge Function invocations, 2 active projects. | Compact `reads[]`, nightly `pg_dump`, heartbeats keep the project active, one Realtime message per pass, audit kept in tables (doc 12 §4). |
| **Vercel**: functions on Hobby with Fluid Compute run up to 300 s ([limits](https://vercel.com/docs/functions/limitations), [changelog](https://vercel.com/changelog/higher-defaults-and-limits-for-vercel-functions-running-fluid-compute)). Hobby is described by third parties as **non-commercial only** ([Hobby docs](https://vercel.com/docs/accounts/plans/hobby), [fencode](https://www.fencode.dev/en/blog/vercel-free-vs-pro-2026-official-limits-pricing)). There is no localhost sidecar and no shared memory, and Vercel is IPv4-only, so Supabase direct (IPv6) connections need the Supavisor pooler. | Chat uses an in-process read-only SQL tool; rate limiter moves to Postgres; **Hobby for the PoC** (D19), Pro for production (doc 12 §5). |
| Prophet is in maintenance mode. statsforecast (ETS/MSTL) is the lightweight choice. | Forecasting stack (P2). |

---

## 6. UX and visualization findings

- **Three modes plus a wall mode.** Live (ops at a glance), Analytics (period comparison, URL-driven), Investigate (search-first tables), and a `?kiosk=1` TV mode, following Grafana's model.
- **Best "is today unusual?" chart.** A typical-day **p10–p90 band with the median, and today's line overlaid** (a fan chart). It beats any gauge.
- **Gauges waste space.** Use a big number with a bullet bar against capacity and the 85 % line.
- **Cumulative arrivals/departures curve.** The vertical gap between the two curves is occupancy. The curves should meet again overnight; **drift there exposes missed reads.**
- **Charting.**
  - Recharts v3 via **shadcn/ui charts** is the default.
  - Heatmaps and the calendar view are hand-built as CSS grids (Recharts has none).
  - ECharts 6 is lazy-loaded only if box plots, a Gantt chart or zoom are needed.
  - **Avoid `@tremor/react`**: its last release supports React 18 only.
  - AG Charts gates heatmaps behind its Enterprise licence.
- **Supporting libraries.** TanStack Table/Query, **nuqs** for URL state (saved views are just saved query strings), react-day-picker v9 with `timeZone`, date-fns v4 with `@date-fns/tz`, NumberFlow for animated counters, Sonner for exception toasts.
- **Honesty patterns.**
  - Show connection status and data freshness separately.
  - **Refetch the snapshot on every reconnect.**
  - Grey out the number and add an "as of" label when stale.
  - Never interpolate across gaps.
  - Show "estimated" next to uncertain figures.
- **Accessibility.**
  - WCAG 2.2: 2.2.2 requires a pause control for the live feed; 1.4.11 requires 3:1 contrast for chart marks.
  - Every chart gets a "view as table" option.
  - Occupancy states use colour **plus** a text label and a shape. Colours are from the Okabe-Ito palette: blue = available, orange = filling, vermillion = full.
  - Heatmaps use a single-hue sequential scale.
- **Timezone.** Store UTC. Bucket in SQL `AT TIME ZONE 'America/New_York'`. DST days have 23 or 25 hours, so charts use real instants rather than hour indexes. Labels show "ET".
