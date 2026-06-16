# CLAUDE.md — foodlog

Standing instructions for working on foodlog. Read this first every session.

## What this is
**foodlog** is a personal health AI web app. Thesis: **"feel your best"** — surface correlations across *eat / move / feel*, NOT calorie counting. The chat IS the product; every AI answer is grounded in the user's own logged data.

**Owner:** Clemens ("Clem"). **Non-technical** — he runs terminal commands and reviews diffs but does not write code from scratch. So:
- **Clem executes; you decide.** Make implementation calls and build them — don't ask his preference on small implementation details.
- Explain changes in plain language before pushing. Push back honestly, flag uncertainty, casual friendly tone.
- For anything touching git or that lands live, show the diff/summary and let him approve.

## Stack / architecture
- **Frontend:** single-file `index.html` (vanilla JS, no build step; supabase-js + Chart.js via CDN). PWA (manifest.webmanifest, sw.js, icons). Served by **GitHub Pages** — auto-deploys on push to `main`.
- **Backend:** `index.js` (Node/Express) on **Render** → `https://foodlog-mcp.onrender.com`. Proxies Anthropic at `/api/chat` (Bearer `clem2024`) + an MCP server (SSE). Free tier spins down when idle.
- **DB/Auth:** **Supabase** `https://klcyjsjkvckhufvvdixp.supabase.co`, RLS `auth.uid() = user_id`. Clem's user_id: `f3d4199b-556a-48ab-aed9-4833cf14c699`.
- **AI:** Haiku `claude-haiku-4-5` for in-app chat; Sonnet `claude-sonnet-4-6` for weekly insights.
- **Repo:** `github.com/cbrlsn/foodlog-mcp` (public). `index.html` (Pages) + `index.js` (Render) live in the SAME repo — one push deploys both.
- **Live app:** `https://cbrlsn.github.io/foodlog-mcp/?access=clem2024`

## Deploy workflow (Claude Code edits the real repo)
1. `git pull origin main` before starting — the repo is the source of truth, not a stale copy.
2. Make targeted edits to `index.html` / `index.js` in place.
3. **Validate every build** (see below).
4. Bump `APP_BUILD` (sidebar stamp confirms the deploy).
5. `git add -A && git commit -m "vXX: ..." && git push origin main`.
- **If push is rejected (divergence):** `git fetch origin && git reset --hard origin/main`, then re-apply edits. Local edits you just made are the intended source.
- Schema changes ship as separate `.sql` files → Clem runs them in the **Supabase SQL Editor** (they are NOT deployed).
- *(Obsolete note: the old "download to ~/Downloads, rm -f the dupe, cp into repo" dance only applied to the chat workflow. In Claude Code you edit the repo file directly — skip all of that.)*

## Validation ritual (run before every commit)
The frontend is one huge single-file. After edits:
- **Bracket balance** — baseline noise is **parens −3, braces 0, brackets 0**. Valid edits keep the delta at (−3, 0, 0):
  ```bash
  python3 -c "s=open('index.html').read(); print('parens',s.count('(')-s.count(')')); print('braces',s.count('{')-s.count('}')); print('brackets',s.count('[')-s.count(']'))"
  ```
- **JS syntax** — extract the largest inline `<script>` and `node --check` it:
  ```bash
  python3 -c "import re;s=open('index.html').read();open('/tmp/app.js','w').write(max(re.findall(r'<script>(.*?)</script>',s,re.S),key=len))" && node --check /tmp/app.js
  ```
- `grep -n` for any new identifiers to confirm they're wired in.
- Multiline JS replacements: use Python `str.replace` on the whole file as a string — `sed` fails on newline boundaries.

## Supabase tables
`entries`, `activities`, `health_events`, `profiles`, `weight_logs`, `supplements`, `supplement_logs`, `substances`, `substance_logs`, `journal_entries`, `saved_meals`, `mood_logs`, `weather_logs`.
- **Water** stores ml in BOTH `calories` (legacy) and `volume_ml`. Always filter `meal !== 'water'` before any kcal sum. `getHydrationMl()` is the single source for hydration.
- **mood_logs:** one rating (1–5) per day, app upserts the latest tap.
- **weather_logs:** one ambient row per day, `unique(user_id, log_date)` for upsert; filled from Open-Meteo (free, no key, browser CORS). Geolocation cached in `localStorage('foodlog_coords')`, rounded ~100m.

## Current state — v33
Recent log:
- **v31 · Substances from chat** — chat returns a `substances` array `{name, quantity}`; alcoholic drinks log BOTH a drink entry (kcal + volume_ml + has_alcohol, no hydration) AND a substance; pure substances (cigarette/snus/vape) log only to `substance_logs`; multiple/day allowed.
- **v32 · Mood + weather streams** — tappable 1–5 mood faces in Today rail + "Log mood" goal; Open-Meteo weather strip; both folded into the insights `byDay` payload + Sonnet prompt (added `weather` to streams enum + correlation guidance).
- **v33 · Chat self-knowledge + persona** — added ABOUT/VOICE block to the chat system prompt so it can explain foodlog and sound like a "sharp honest friend"; light not-a-doctor guardrail.

**Pending on Clem (do not assume done):** run `mood_logs.sql` + `weather_logs.sql` in Supabase; deploy v33 `index.html`; allow location once; smoke-test mood persistence + weather strip + substances-from-chat.

## Next up (lower priority, no strict order)
- **Chat-page animations** — bottle fill + count-ups, kcal arc, kcal number; shared `animateNumber()`, 0.5–1s.
- **API guardrails** — per-user auth + rate limiting on `/api/chat` (`index.js`); topic-restriction in the prompt.
- **Latency** — trim prompt (note: v33 added ~120 words), keep Render warm, optimistic UI.
- **Push notifications** — VAPID + subscription table + cron → Render `/cron/send-reminders` (test iOS delivery first).
- Backlog: barcode (Open Food Facts), photo logging, Oura sleep (Apple Health needs Capacitor; **Strava is OUT** — paid + AI-data ToS ban), pantry, PDF reports, accuracy audit vs USDA/OFF.

## Gotchas
- **Silent JS scope bugs:** a `const`/`var` scoped wrong makes a feature render *nothing* with no console error. Check scope first when something renders empty.
- **Modals/overlays must live OUTSIDE flex containers** like `#main`, or they cause layout bugs even when invisible.
- **CORS:** any new frontend host must be added to allowed origins in `index.js` on Render.
- Insights cache + geolocation use `localStorage` — fine here (real app, not a sandboxed artifact).

## Notion hub (external memory)
Page id `37d918e2-8632-81ff-bd6e-c4eb9a3e3686` ("foodlog hub"). Full dated build log + research + ideas. **Clem hand-edits this — ONLY ever INSERT (prepend a dated entry at the top); NEVER replace/overwrite page content.** Update it after each shipped change. (Requires the Notion MCP connector configured in Claude Code.)

## Infra TODO for Clem
Delete the orphaned **Railway** project (abandoned early backend target — source of the "build failed" emails).
