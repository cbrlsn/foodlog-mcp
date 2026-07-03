# Changelog

All notable changes to **foodlog** are recorded here, newest first.

- **Frontend** = `index.html` (single-file PWA, served by GitHub Pages).
- **Backend** = `index.js` (Express proxy + MCP on Render).
- **Schema** = separate `.sql` files run manually in Supabase (not auto-deployed).

**Branches:** `main` holds the stable line through **v38.3**. Everything from **v39** onward lives on the **`redesign-v39`** branch (the current visual redesign), which is what GitHub Pages is presently building from. `redesign-v39` is not yet merged back into `main`.

> Keep this file updated on **every** change — add an entry under a new version heading whenever you bump `APP_BUILD`, before committing.

---

## redesign-v39 branch (v39 → present)

> `redesign-v39` was merged (fast-forward) into `main` at v41.5; both branches continue from there.

### [v43] — 2026-07-03
- **Fix: chat sometimes dumped the raw JSON log payload into the chat and logged nothing.** Root cause: the chat call was capped at `max_tokens: 2000`, so a large multi-day batch (e.g. 6 meals + workout + supplements) truncated the model's JSON mid-response; `JSON.parse` then failed and the fallback set `reply = raw`, printing the partial JSON and logging zero rows. Fixes: (1) raised the chat `max_tokens` to **8000** (verified Haiku 4.5 accepts it) so realistic batches fit; (2) the parse-failure fallback now distinguishes a genuine plain-text answer (no `{` → show it) from malformed/truncated JSON (has `{` → show a clear, recoverable "couldn't process that cleanly — try splitting it" message instead of dumping raw JSON or half-logging). No data is silently lost.
- **Supplement inline editing.** Each supplement row gets a pencil (SVG line icon) that swaps the row into an inline editor for the *definition* — name (text), dose (number), unit (select: pills/g/mg/mcg/ml/IU) — pre-filled. Save validates (name non-empty, dose > 0; invalid → shake, no write), `UPDATE`s the `supplements` row scoped to `id + user_id`, updates the in-memory object and re-renders that row (no full re-fetch), and shows an inline error on failure without losing input. Escape / tap-outside cancels; only one row edits at a time. Definition-only — `supplement_logs` and the streak calendar are untouched.

### [v42.4] — 2026-06-28
- **Fix: weekly digest saw zero data.** The `/api/insights` backend queries returned nothing because the server's Supabase client uses the **anon key**, so RLS (`auth.uid() = user_id`) blocked every read (no server-side user session). Confirmed via a debug probe: all stream counts 0, no errors, even an unfiltered probe returned 0 rows. Fix: the frontend now sends its live Supabase session JWT (`sb_token`); the backend builds a per-request client carrying that token so queries run **as the user** and RLS passes. Also switched the queries to `select('*')` so a single unexpected column can't error out a whole stream. (Temporary `debug` probe left in the endpoint for verification; to be removed once confirmed.)

### [v42.3] — 2026-06-28
- **Weather refresh cadence: hourly → every 15 min**, matching Open-Meteo's current-conditions update interval. The refresh timer and the on-resume staleness threshold both moved from 3600000 ms to 900000 ms. (Geolocation `maximumAge` left at 1h — that's fix freshness, not refresh rate.)

### [v42.2] — 2026-06-28
- **Weather strip now shows live current conditions** instead of the day's mean. The Open-Meteo call adds `current=temperature_2m,weather_code` (updates ~every 15 min); `loadWeather` always fetches fresh (cached daily row is now only an offline fallback) so the displayed temp/condition reflect *now* and refresh on the existing hourly timer + on app resume. The persisted `weather_logs` row still stores the **daily** aggregates (max/min/mean/precip/sunshine) so weekly insights correlate on day-level weather — no schema change.

### [v42.1] — 2026-06-28
- **Insights digest — period selector.** Added an intuitive segmented control to the Insights tab: **This week** (Mon→today), **Last week** (full Mon–Sun), **Last 30 days**. The active period is highlighted and periods that already have a cached digest show a small accent dot. Each period caches separately (`fl-insights-{period}-{endDate}`) so switching or returning doesn't re-call Sonnet; the hero badge + timestamp reflect the selected range.
- **Backend:** `/api/insights` now accepts an optional `from`/`to` date range (frontend computes it per period), capped at 40 days; falls back to last-7 if absent. System prompt generalised from "one week" to "a period (up to a month)".

### [v42] — 2026-06-28
- **Weekly AI insights digest** — the core thesis feature, now server-side end-to-end.
  - **Backend:** new `POST /api/insights` (`index.js`). Validates the `Bearer` access token, then uses the existing Supabase client (`sb`) to query the user's **last 7 days** across every stream (entries, activities, mood_logs, weather_logs, supplement_logs, substance_logs, weight_logs), buckets each into days **in the caller's timezone**, and builds a `byDay` payload mirroring the frontend `buildPayloadForDates`. Sends it to **Sonnet** (`claude-sonnet-4-6`, max_tokens 1200) with a "sharp honest analyst" correlation prompt, and returns the raw model text + the date range. No new deps or env vars (Supabase + Anthropic keys already present).
  - **Frontend:** the Insights tab now generates a current-week digest. "Generate this week's digest" / "↻ Refresh" button; result cached in `localStorage` per ISO week (`fl-insights-{YYYY-Www}`) so it doesn't re-call on tab switches. Loading state ("Analysing your week…" + spinner), graceful error card with Retry, and a render of all five sections: headline (with eat/move/feel triad accent), 3–5 pattern cards (confidence badge + positive/negative/neutral tint), Watch ⚠ / Try → cards, data-quality footnote, and a generated-at timestamp.
  - The previous client-side per-week insights generator (`/api/chat`-based, `generateInsightsForWeek` etc.) is left in place but no longer wired to the page.

### [v41.5] — 2026-06-27
- **PWA auto-update.** iOS keeps home-screen PWAs suspended, so resume / pull-to-refresh reloaded *data* but never the page — new deploys never loaded and the user was always a build behind. Added `checkForUpdate()`: fetches the live `index.html` (cache-busted), compares `APP_BUILD`, and hard-reloads if it changed. Runs on `visibilitychange`, `focus`, startup, and pull-to-refresh.
- **Service worker:** `?v=` (cache-busted) requests now bypass the cache entirely (network-only); cache bumped to `v4`.
- **Temporary diagnostic badge** (standalone PWA only): shows build + `env(safe-area-inset-bottom)` + `innerHeight` + `screen.height` to pin down the iOS bottom-strip numbers. Tap to dismiss.

### [v41.4] — 2026-06-27
- **Fixed the kcal arc fill.** The progress arc is a 180° semicircle (length ≈ π·78 ≈ 245), but the `stroke-dasharray`/offset math used `367` (a 270° arc's length), so the arc read as full once intake passed ~67% of target. Replaced with the correct `245.04`; fill is now exactly proportional (verified 1900/2350 → 80.9% drawn).

### [v41.3] — 2026-06-27
- **Removed `backdrop-filter` from the bottom nav.** A `position:fixed` bar with `backdrop-filter` is a known iOS Safari bug that fails to cover the home-indicator safe area, leaving a black strip. Now a solid opaque `--bg2` background.
- Manifest `background_color`/`theme_color` and the page `theme-color` aligned to `#131316` (nav color) so no near-black can show through; SW cache → `v3`.

### [v41.2] — 2026-06-25
- **Bottom nav** switched to `position:fixed` at the viewport bottom (canonical mobile pattern) so it reaches the physical screen bottom; SW cache → `v2`.
- **kcal arc ~20% bigger** (desktop 188→226px, mobile 170→204px) with the number font unchanged; desktop chat height re-matched (467→505px).
- **Chat input** single line on mobile: placeholder "log anything…" + min-height 46px (still auto-grows when typing).

### [v41.1] — 2026-06-25
- Pinned the app shell with `position:fixed; inset:0` on mobile so the nav reaches the physical bottom (`100dvh` can fall short in a standalone iOS PWA).
- Shortened the chat placeholder so it stops overflowing the field on mobile.

### [v41] — 2026-06-25
- **Editable goals.** The pencil on the Daily Goals card opens a goals editor: toggle any of the 6 auto-tracked goals on/off, and add/rename/delete custom daily check-off goals (tap on Today to mark done). Persisted in `localStorage` (`fl-goals` / `fl-goals-done`).
- **Pull-to-refresh** on mobile: pull down at the top of any page to reload data, with spinner + content drag + light haptic. Touch/≤760px only; skips when a modal or chat is scrolling.
- First pass at the mobile bottom-gap fix (match page bg to nav `--bg2`).

### [v40.2] — 2026-06-25
- **Hourly weather + location refresh.** `loadWeather(force)` re-fetches even when today's row is cached; an interval re-checks coords + weather every hour while open; `visibilitychange` refetches on re-open after >1h.

### [v40.1] — 2026-06-25
- Dropped the redundant kcal nutrient bar from the Daily Arc (the gauge already shows kcal vs target). FUEL is now protein/carbs/fibre; chat height re-matched (487→467px).

### [v40] — 2026-06-25
- **Today + Timeline polish.** % goal score is now the big headline; "Hey {name}." demoted to a subline. Chat card fixed height with internal scroll (no longer pushes the page down). kcal number lowered into the arc bowl + smaller. "Intake by meal" removed; full Macros & limits moved into the Daily Arc card. Goals → compact 2-col grid (KPI row shorter, so Water/Mood aren't forced tall). Mic/cam/send matched to input height. Location name shown next to weather (reverse-geocoded, cached).
- **Journal** gets a quick-note card on Today + a dedicated Journal page in the left nav (removed from the Timeline aside).
- **Timeline:** row columns aligned with the day header; kcal flush-right (action buttons now absolute); "This week at a glance" → "Last 7 days" with a caption. Removed a stray duplicate empty today-log card.

### [v39.3] — 2026-06-24
- **Trends** (Dashboard) rebuilt Revolut-style: eyebrow + 7d/30d/90d range pills, KPI row (avg kcal / avg protein / workouts / avg mood) with period-over-period delta chips, a stacked daily calories-&-macros bar chart with a dashed target line, and mini panels for weight, hydration, mood×protein correlation, plus stream cards for activity, supplement adherence, substances, and weather×mood. Sleep explicitly omitted (not in schema). Old renderer kept as `renderDashboardLegacy`.

### [v39.2] — 2026-06-24
- **Timeline** two-column layout: day-grouped list with per-day kcal/water/mood summary chips + a sticky aside (journal composer + "this week at a glance" heatmap). **Insights** restyled: AI-tinted hero with headline badge + highlighted figures, confidence-badged pattern cards, two-up "watch" / "try next week". View-only; payload + `/api/chat` unchanged.

### [v39.1] — 2026-06-24
- Inline greeting matching the mockup ("Hey {name}." + "You're X% to today's goals."). Collapsible desktop sidebar (66px icon rail), state persisted; disabled on mobile.

### [v39] — 2026-06-24
- **Visual redesign — Today bento.** New zinc/dark + light token palettes, Geist / Geist Mono fonts (incl. Chart.js). Today rebuilt as a bento: header (mono date/weather + search), hero (Daily Arc gauge + Coach chat), KPI strip (hydration + 7-day history · mood + 7-day sparkline · goals), today's log; details tucked below. Gauge rewritten to a gradient arc; water UI → figure + bar. Visual/layout only — ids, function names, and data paths preserved.

---

## main branch (through v38.3)

### [v38.3] — 2026-06-22
- Chat retry on cold start: `fetchRetry()` wraps `/api/chat` with backoff to handle "Failed to fetch" and 502/503/504 while the Render free tier boots. All 4 chat calls route through it.

### [v38.2] — 2026-06-21
- Killed horizontal scroll (`overflow-x:hidden` on html/body/.page/#page-log). Trends subtabs restyled to match Timeline filter chips for consistent top-of-page pills.

### [v38.1] — 2026-06-21
- Mobile safe-area handling, timeline width fix, weather relocation.

### [v38] — 2026-06-21
- **Structural redesign:** collapsed ~10 surfaces into 3 (Today · Timeline · Trends).

### [v37] — 2026-06-19
- **Almanac redesign:** warm ink-charcoal dark + warm-paper light palette, Fraunces/Inter/IBM Plex Mono type, and an eat (amber) / move (teal) / feel (rose) color triad across tags + macro bars. kcal gauge extended into the "Daily Arc" signature plotting eat/move/feel by time of day. Restyled charts/settings + ambient motion. Fixed a flexbox bug collapsing the gauge card to a sliver. CSS/markup only.

### [v36] — 2026-06-19
- Sage palette + de-slop pass (SVG nav icons, capitalised titles/entries, kcal glow). Substance date/quantity fix (logs inherit inferred date/time; quantity parsed from chat).

### [v35] — 2026-06-16
- UI/UX sweep: accessibility, `focus-visible`, touch targets, `transition:all` cleanup. Mobile fixes (chart button overlap, nav bg consistency, page padding).

### [v34] — 2026-06-15
- **Chat-page animations:** `animateValue`/`animateNumber` helpers (rAF, ease-out, reduced-motion aware); kcal arc sweep-in; kcal number count-up; macro/limit bars grow from 0%; water bottle fill + ml/% count-up.

### [v33] — 2026-06-15
- **Chat self-knowledge + persona:** added an ABOUT/VOICE block to the chat system prompt so it can explain foodlog and sound like a "sharp honest friend"; light not-a-doctor guardrail.

### [v32] — 2026-06-14
- **Mood + weather streams:** tappable 1–5 mood faces in the Today rail + "Log mood" goal; Open-Meteo weather strip; both folded into the insights `byDay` payload + Sonnet prompt (weather added to streams enum + correlation guidance).

### [v31] — 2026-06-14
- **Substances from chat:** chat returns a `substances` array `{name, quantity}`. Alcoholic drinks log BOTH a drink entry (kcal + volume_ml + has_alcohol, no hydration) AND a substance; pure substances (cigarette/snus/vape) log only to `substance_logs`; multiple per day allowed.

### [v30] — 2026-06-14
- Chat conversation memory (multi-turn context).

### [v29] — 2026-06-13
- Thinking fix + water fast-path.

### [v28] — 2026-06-13
- "No second-guess" chat behavior + kcal cleanup.

### [v27] — 2026-06-13
- Saved dishes (tap to re-log) + iOS app icon.

### [v26] — 2026-06-13
- PWA installable + offline support (service worker).

### [v25] — 2026-06-13
- Drink hydration fix.

### [v24] — 2026-06-13
- Daily tracker calendar.

### [v23] — 2026-06-13
- Supplements via chat + backend crash fix.

### [v22] — 2026-06-13
- Iteration / maintenance.

### [v19 — "Nocturne" redesign] — 2026-06-12
- Nocturne visual redesign (dark theme pass; iterated across several commits).

### [v18] — 2026-06-11
- Journal feature added. GitHub Pages origin added to backend CORS.

### [v17 / v17.1] — 2026-06-11
- Fixed hydration updates + light mode; warm, welcoming UI pass.

### [v16 → v16.5] — 2026-06-10
- Substances, chart drill-down, grouped nutrient bars, daily goals, substance tracking. Fixes: black bar (modal in wrong container), page background, favicon.

### [v15 → v15.6] — 2026-06-10
- Supplement tracking + calendar. Caffeine + sodium charts. Liquid-physics water bottles (tilt-dominant slosh). Bottle + bar redesign.

### [v14 → v14.2] — 2026-06-10
- Visual overhaul. Hydration includes drinks. BMI in the sidebar.

### [v13 / v13.1] — 2026-06-09
- Water bug fixed everywhere, weight tracking, mobile overhaul. Server-side water sanitization; water excluded from calorie totals.

### [v11] — 2026-06-08
- Frontend v11; Netlify URL + CORS updates.

### [Initial backend] — 2026-06-06 → 2026-06-07
- `init` repo. Added Anthropic proxy + CORS (the Express backend on Render).

---

*Versions v20, v21 were skipped in numbering; some early commits (favicon/CORS tweaks) are folded into the nearest version above.*
