# 07 — Visualization & UX Guide

> Updated for [doc 12](12-decisions-and-constraints.md). Rules for how every number and chart is presented. The goal is a dashboard staff can read in two seconds from across the room, and an analyst can trust.

---

## 1. Design principles

1. **One question per chart.** Every chart title is phrased as the question it answers ("When does the lot fill up?").
2. **Never fake precision.** Show the uncertainty band, the "estimated" label and coverage gaps. A missing hour is drawn as a gap, never as a zero and never interpolated.
3. **Freshness is always visible.** Connection status and data freshness are shown separately: a healthy socket with a silent camera is still a problem.
4. **Context beats decoration.** Today's numbers are always shown against typical, capacity and the 85 % line. Skip gauges, 3-D and pie charts.
5. **Every chart is also data.** Each chart has "View as table" and "Download CSV", plus a tooltip giving the KPI definition from doc 06 §2.
6. **Server does the math.** Bucketing, percentiles and gap-filling happen in SQL. The browser receives at most about 2 000 points per chart.

---

## 2. Chart chooser

| Question | Chart | Spec notes |
|---|---|---|
| How full is it now? | **Big number + bullet bar** | Shows the band, the 85 % mark, a state label and shape. Kiosk mode may add a radial gauge, at most one. |
| Is today unusual? | **Fan chart**: today's step-line over the p10–p90 band and median for the same weekday | Needs a "now" marker. The forecast cone (P2) continues the band past now and is labelled as an estimate. |
| How did occupancy evolve? | **Step-line** (`stepAfter`) | Includes capacity and 85 % reference lines, a shaded "near full" zone, peak annotations and the coverage strip below. |
| When do cars arrive/leave? | **Diverging bars**: arrivals above the axis, departures below | A net-flow line is optional; buckets are 15 min or 1 h. |
| Does the count drift? | **Cumulative arrivals and departures curves** | The vertical gap between the curves is occupancy. The curves should meet overnight, and any residual gap is the drift. |
| Weekly pattern? | **7×24 heatmap**, built as a CSS grid | Uses a sequential single-hue palette. The metric can be switched between avg %, peak % and arrivals. |
| Long-term pattern / special days? | **Calendar heatmap** of daily peak % | Clicking a day drills into it. Annotations mark holidays and events. |
| How long do people stay? | **Bucketed histogram** (<15m, 15–60m, 1–2h, 2–4h, 4–8h, 8h+) | Show the median and P90. Use box plots for comparisons across groups; avoid violin plots. |
| Who parks when, for how long? | **Duration-by-arrival-hour heatmap** | Rows are arrival hour and columns are dwell bucket. |
| Who is in the lot now? | **Swimlane/Gantt** of open sessions | Bars are coloured by dwell bucket and virtualized when there are more than 100. |
| Are we meeting targets? | **Daily bars coloured by target band** (under, ideal 60–85 %, over) | This follows the Density pattern. |
| Rule-bending? | **Bars of overnight / multi-day sessions per night** | D3: shows how often the "no overnight" rule is broken. |
| Is the estimate drifting? | **Residual history** (estimate − admin visual count) with reconciliation markers on the occupancy chart | D2 |
| KPI trend at a glance | **Sparkline tiles** with a delta vs the comparison period | Each delta comes with an arrow and text such as "+12 % vs typical Tue". |
| Is the system healthy? | Status table, reads-per-hour line with expected band, confusion-matrix grid | |

Do not use Sankey charts: there is a single lot, so there are no flows between places. Do not use pie charts.

---

## 3. Colour & tokens

- **Occupancy states.** Colour always comes with a text label and a shape. The colours are from the Okabe-Ito palette:
  - **Available ●** blue `#0072B2`, below 60 %
  - **Filling ▲** orange `#E69F00`, 60 % up to the effective capacity
  - **Effectively full ■** vermillion `#D55E00`, at or above effective capacity
  - **Full ■■** dark vermillion plus the word "FULL", at 98 % or more
  - The thresholds are configurable per lot.
- **Directions.** IN is teal and OUT is purple. Every glyph also carries an ▶/◀ arrow, so colour is never the only cue.
- **Charts.** Use `--chart-1..8` CSS variables with light and dark variants. Every data mark must have at least 3:1 contrast against the background (WCAG 1.4.11).
- **Heatmaps.** Use a single-hue sequential ramp. Do not use red/green.
- **Confidence.** Show it as an icon plus a number, not colour alone. Classes are high ≥ 0.90, medium ≥ 0.75, and low.

---

## 4. Realtime UX patterns

| Pattern | Behaviour |
|---|---|
| Connection pill | `SUBSCRIBED` shows green "Live" with a pulsing dot (static if reduced motion). `TIMED_OUT`/`CLOSED` shows amber "Reconnecting…". `CHANNEL_ERROR` shows red "Offline". |
| Resync | On every `SUBSCRIBED`, refetch the snapshot and the last 15 minutes of the feed. |
| Freshness chips | Show "IN 12 s · OUT 3 min" per camera. Turn amber after 2× the expected gap and red when the camera-silent alert fires. |
| Stale state | Grey out the hero number and show "as of 10:31" plus the reason ("outbound camera silent 18 min"). |
| Number changes | NumberFlow digit roll. New feed rows highlight for 1.5 s. |
| Toasts / banners | In-app only (D12). Only for exceptions: approaching full, full, camera silent, reconcile recommended, DB size. Never for routine passes. |
| Pause | The live feed has a Pause/Resume control (WCAG 2.2.2). While paused, a counter shows "12 new". |
| Optimistic UI | Applies only to human actions: ack, confirm match, reconcile. Uses `useOptimistic`, with rollback on error. |

---

## 5. Accessibility checklist (WCAG 2.2 AA)

- **Live updates.** One throttled `role="status"` region announces meaningful changes, at most one per 30 s, for example "Lot 90 % full". There is no `aria-live` on fast-ticking tiles.
- **Chart alternatives.** Every chart offers a table view, and its SVG carries a `title` and `desc` summarizing the takeaway.
- **Keyboard.** The review queue, gallery and tables are fully keyboard-operable, with visible focus that is not obscured by sticky headers.
- **Targets and motion.** Interactive targets are at least 24 px, and `prefers-reduced-motion` is respected.
- **Testing.** Each page passes axe-core in CI (doc 10).

---

## 6. Time & number formatting

- Times are always shown in `America/New_York` with an "ET" suffix in labels. Exports let the user choose the timezone.
- Dwell is formatted as `1 h 52 m`, `52 m` or `3 d 4 h`.
- Percentages have no decimals in tiles and one decimal in tables.
- Counts use thousands separators.
- DST: charts use real instants, so the 23-hour and 25-hour days render correctly. Heatmaps bucket by local hour; on fall-back days the duplicated 01:00 hour is combined and noted.

---

## 7. Plate display rules (D4: two trusted roles)

| Context | Display |
|---|---|
| `staff`, `admin` | Full plate and crops. Plate searches, profile views, image views and exports are **audit-logged**; no reason prompt (keep it simple). |
| TV / kiosk mode (logged-in staff account) | Occupancy and charts only. **Hide plates and crops on the wall screen by default**, because passers-by can see it. Toggle in kiosk settings. |
| After 30 days (retention) | Pseudonym only, rendered as a short tag (e.g. `veh·7f3a`); crops gone after 14 days |

Plates use a monospace font. In the review UI, character differences are highlighted one character at a time.
