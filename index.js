import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || 'clem2024';
const PORT = process.env.PORT || 3000;

if (!SUPABASE_URL || !SUPABASE_KEY || !ANTHROPIC_KEY) {
  console.error('Missing required env vars: SUPABASE_URL, SUPABASE_KEY, ANTHROPIC_KEY');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const app = express();

// ── CORS ──────────────────────────────────────────────────────────
// Only allow requests from our Netlify app
const ALLOWED_ORIGINS = [
  'https://clemsfoodlog2.netlify.app',
  'https://cbrlsn.github.io',
  'http://localhost:3000',
  'http://localhost:8080',
];
app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (e.g. curl, Render health checks)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json());

// ── Health check ──────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', service: 'foodlog-mcp' }));

// ── Anthropic proxy ───────────────────────────────────────────────
// Validates the access token, then forwards to Anthropic.
// The Anthropic API key never leaves this server.
app.post('/api/chat', async (req, res) => {
  // Check access token (sent in Authorization header as "Bearer <token>")
  const auth = req.headers['authorization'] || '';
  const token = auth.replace('Bearer ', '').trim();
  if (token !== ACCESS_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    console.error('Anthropic proxy error:', err);
    res.status(500).json({ error: 'Proxy error: ' + err.message });
  }
});

// ── Weekly insights digest ────────────────────────────────────────
// Server-side: queries the user's last 7 days across every stream, builds a
// byDay payload (mirrors the frontend buildPayloadForDates), and runs it
// through Sonnet for cross-stream correlations. Returns the raw model text.
const INSIGHTS_SYSTEM = `You are a sharp, honest health analyst reviewing a period (a week, up to a month) of a person's logged data. Your job is to find real patterns and correlations — not generic advice.
The user tracks: food (kcal, macros, caffeine, alcohol, dairy, gluten), activity, mood (1–5), weather, supplements, and substances.
Your response MUST be valid JSON with this exact structure:
{
"headline": "one punchy sentence summarising the period's biggest insight",
"patterns": [
{
"title": "short title",
"insight": "2–3 sentences. Be specific — name actual days, numbers, foods. Correlation must be supported by the data.",
"confidence": "high|medium|low",
"type": "positive|negative|neutral"
}
],
"watch": "one thing to pay attention to next week, specific",
"try": "one concrete action to try next week, specific",
"data_quality": "note if any stream had <3 days of data — affects confidence"
}
Return 3–5 patterns. Prioritise mood correlations. If data is thin, say so in data_quality and lower confidence accordingly. Never invent data. Be direct — no fluff, no disclaimers beyond data_quality.`;

function localDateInTz(iso, tz) {
  try { return new Date(iso).toLocaleDateString('en-CA', { timeZone: tz }); }
  catch (e) { return new Date(iso).toISOString().slice(0, 10); }
}

app.post('/api/insights', async (req, res) => {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace('Bearer ', '').trim();
  if (token !== ACCESS_TOKEN) return res.status(401).json({ error: 'Unauthorized' });

  const { user_id, timezone, from, to, debug } = req.body || {};
  if (!user_id) return res.status(400).json({ error: 'Missing user_id' });
  const tz = timezone || 'UTC';

  try {
    // Date list for the requested period (inclusive), bucketed in the user's
    // timezone. Frontend sends from/to per the chosen period; default = last 7
    // days. Capped at 40 days to bound the prompt size.
    const dates = [];
    const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
    if (isDate(from) && isDate(to)) {
      let d = new Date(from + 'T12:00:00Z');
      const end = new Date(to + 'T12:00:00Z');
      while (d <= end && dates.length < 40) { dates.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
    }
    if (!dates.length) {
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: tz });
      for (let i = 6; i >= 0; i--) {
        const d = new Date(todayStr + 'T12:00:00Z');
        d.setUTCDate(d.getUTCDate() - i);
        dates.push(d.toISOString().slice(0, 10));
      }
    }
    const lastDate = dates[dates.length - 1];
    const since = new Date(dates[0] + 'T00:00:00Z');
    since.setUTCDate(since.getUTCDate() - 1); // pad a day for timezone edges
    const sinceISO = since.toISOString();

    // select('*') so a single missing column can't error out a whole stream
    // (the table schemas vary slightly; we read fields defensively below).
    const [fe, fa, fmood, fweather, fsupp, fsuppLog, fsubst, fsubstLog, fweight] = await Promise.all([
      sb.from('entries').select('*').eq('user_id', user_id).gte('created_at', sinceISO),
      sb.from('activities').select('*').eq('user_id', user_id).gte('created_at', sinceISO),
      sb.from('mood_logs').select('*').eq('user_id', user_id).gte('logged_at', sinceISO),
      sb.from('weather_logs').select('*').eq('user_id', user_id).gte('log_date', dates[0]),
      sb.from('supplements').select('*').eq('user_id', user_id),
      sb.from('supplement_logs').select('*').eq('user_id', user_id).gte('taken_at', sinceISO),
      sb.from('substances').select('*').eq('user_id', user_id),
      sb.from('substance_logs').select('*').eq('user_id', user_id).gte('logged_at', sinceISO),
      sb.from('weight_logs').select('*').eq('user_id', user_id).gte('created_at', sinceISO),
    ]);

    if (debug) {
      const probe = await sb.from('entries').select('id,user_id,created_at').limit(3);
      const errOf = (r) => (r && r.error) ? (r.error.message || JSON.stringify(r.error)) : null;
      const nOf = (r) => (r && r.data) ? r.data.length : 0;
      return res.json({
        received_user_id: user_id,
        range: { from: dates[0], to: lastDate, since: sinceISO },
        counts: { entries: nOf(fe), activities: nOf(fa), mood: nOf(fmood), weather: nOf(fweather), supplements: nOf(fsupp), supplement_logs: nOf(fsuppLog), substances: nOf(fsubst), substance_logs: nOf(fsubstLog), weight: nOf(fweight) },
        errors: { entries: errOf(fe), activities: errOf(fa), mood: errOf(fmood), weather: errOf(fweather), supplements: errOf(fsupp), supplement_logs: errOf(fsuppLog), substances: errOf(fsubst), substance_logs: errOf(fsubstLog), weight: errOf(fweight) },
        probe_any_entries: { count: nOf(probe), error: errOf(probe), sample_user_ids: (probe.data || []).map(r => r.user_id) },
        entry_sample: (fe.data || []).slice(0, 1),
      });
    }

    const suppName = {}; (fsupp.data || []).forEach(s => { suppName[s.id] = s.name; });
    const substName = {}; (fsubst.data || []).forEach(s => { substName[s.id] = s.name; });
    const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const hydrationMl = (e) => {
      if (e.meal_type === 'water') return e.volume_ml || e.calories || 0;
      if (e.meal_type === 'drink' && !e.has_alcohol) return e.volume_ml || 330;
      return 0;
    };

    const byDay = dates.map(date => {
      const dayEntries = (fe.data || []).filter(e => localDateInTz(e.created_at, tz) === date);
      const food = dayEntries.filter(e => e.meal_type !== 'water');
      const sum = (k) => Math.round(food.reduce((s, e) => s + (e[k] || 0), 0));
      const flag = (k) => food.filter(e => e[k]).length;
      const acts = (fa.data || []).filter(a => localDateInTz(a.created_at, tz) === date)
        .map(a => a.activity_type + (a.duration_min ? ` ${a.duration_min}min` : '') + (a.distance_km ? ` ${a.distance_km}km` : '') + (a.intensity ? ` (${a.intensity})` : ''));
      const moodRow = (fmood.data || []).filter(m => localDateInTz(m.logged_at, tz) === date).map(m => m.rating);
      const wRow = (fweather.data || []).find(w => w.log_date === date);
      const supps = (fsuppLog.data || []).filter(l => localDateInTz(l.taken_at, tz) === date).map(l => suppName[l.supplement_id] || 'supplement');
      const substs = (fsubstLog.data || []).filter(l => localDateInTz(l.logged_at, tz) === date).map(l => (substName[l.substance_id] || 'substance') + (l.quantity > 1 ? ` x${l.quantity}` : ''));
      const weight = (fweight.data || []).filter(w => localDateInTz(w.created_at, tz) === date).map(w => w.weight_kg)[0] || null;
      const dow = DOW[new Date(date + 'T12:00:00Z').getUTCDay()];
      return {
        date, day: dow,
        kcal: sum('calories'), protein_g: sum('protein'), carbs_g: sum('carbs'), fat_g: sum('fat'),
        sugar_g: sum('sugar'), fibre_g: sum('fibre'), sodium_mg: sum('sodium'), caffeine_mg: sum('caffeine_mg'),
        hydration_ml: Math.round(dayEntries.reduce((s, e) => s + hydrationMl(e), 0)),
        flags: { dairy: flag('has_dairy'), gluten: flag('has_gluten'), acidic: flag('is_acidic'), alcohol: flag('has_alcohol'), nicotine: flag('has_nicotine'), cannabis: flag('has_cannabis') },
        foods: food.map(e => e.description).filter(Boolean).join('; ').slice(0, 180),
        activities: acts,
        mood: moodRow.length ? moodRow[0] : null,
        weather: wRow ? { temp_max: wRow.temp_max, temp_min: wRow.temp_min, precip_mm: wRow.precip_mm, sunshine_h: wRow.sunshine_hours } : null,
        supplements: supps,
        substances: substs,
        weight_kg: weight,
      };
    });

    const userMsg = `Period analysed: ${dates[0]} to ${lastDate} (${dates.length} days, timezone ${tz}).\n\nDays (oldest first), JSON:\n${JSON.stringify(byDay)}`;
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1200, system: INSIGHTS_SYSTEM, messages: [{ role: 'user', content: userMsg }] }),
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error || ('Anthropic error ' + response.status) });
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    res.json({ text, range: { from: dates[0], to: lastDate, days: dates.length } });
  } catch (err) {
    console.error('Insights error:', err);
    res.status(500).json({ error: 'Insights error: ' + err.message });
  }
});

// ── MCP Server ────────────────────────────────────────────────────
// A fresh server is built per SSE connection. The MCP SDK allows only ONE
// transport per server instance, so a single shared server throws
// "Already connected to a transport" on the 2nd client and crashes the
// process. buildServer() gives each connection its own instance.
function buildServer() {
const server = new McpServer({
  name: 'foodlog',
  version: '1.0.0',
});

// Log a food entry
server.tool(
  'log_food',
  'Log a food or drink entry to Clem\'s nutrition tracker',
  {
    meal_type: z.enum(['breakfast','lunch','dinner','snack','drink','water','other']),
    description: z.string().describe('Concise item list with quantities'),
    notes: z.string().optional().describe('Brief comment about the meal'),
    calories: z.number().optional().describe('kcal — for water entries, store ml amount here instead'),
    protein: z.number().optional().describe('grams'),
    carbs: z.number().optional().describe('grams'),
    fat: z.number().optional().describe('grams'),
    sugar: z.number().optional().describe('grams'),
    fibre: z.number().optional().describe('grams'),
    sodium: z.number().optional().describe('milligrams'),
    vitamin_c: z.number().optional().describe('mg'),
    vitamin_d: z.number().optional().describe('µg'),
    iron: z.number().optional().describe('mg'),
    calcium: z.number().optional().describe('mg'),
    omega3: z.number().optional().describe('grams'),
    entry_datetime: z.string().optional().describe('ISO datetime e.g. 2024-06-01T08:30:00'),
  },
  async (args) => {
    const payload = { ...args };
    if (args.entry_datetime) { payload.created_at = args.entry_datetime; delete payload.entry_datetime; }
    // Reclassify plain-water entries that arrive with the wrong meal_type
    if (payload.meal_type !== 'water' && /^\s*\d*[.,]?\d*\s*(l|ml|liter|litre|liters|litres)?\s*(of\s+)?water\s*$/i.test(payload.description || '')) {
      payload.meal_type = 'water';
    }
    if (payload.meal_type === 'water') {
      const ml = payload.calories || 0;
      payload.calories = ml;
      payload.protein = 0; payload.carbs = 0; payload.fat = 0;
      payload.sugar = 0; payload.fibre = 0; payload.sodium = 0;
    }
    const { data, error } = await sb.from('entries').insert(payload).select().single();
    if (error) return { content: [{ type: 'text', text: 'Error: ' + error.message }] };
    return { content: [{ type: 'text', text: `Logged: ${args.description} (${args.calories || '?'} kcal)` }] };
  }
);

// Log activity
server.tool(
  'log_activity',
  'Log a workout or physical activity',
  {
    activity_type: z.enum(['run','cycling','gym','walk','sport','other']),
    notes: z.string().describe('Description of the activity'),
    duration_min: z.number().optional(),
    distance_km: z.number().optional(),
    calories_burned: z.number().optional(),
    intensity: z.enum(['low','moderate','high']).optional(),
    entry_datetime: z.string().optional(),
  },
  async (args) => {
    const payload = { ...args };
    if (args.entry_datetime) { payload.created_at = args.entry_datetime; delete payload.entry_datetime; }
    const { data, error } = await sb.from('activities').insert(payload).select().single();
    if (error) return { content: [{ type: 'text', text: 'Error: ' + error.message }] };
    return { content: [{ type: 'text', text: `Logged: ${args.activity_type} ${args.distance_km ? args.distance_km+'km' : ''} ${args.duration_min ? args.duration_min+'min' : ''}` }] };
  }
);

// Log health event
server.tool(
  'log_health',
  'Log a health symptom, energy level, mood, or other health event',
  {
    event_type: z.enum(['stomach','energy','mood','headache','pain','sleep','symptom']),
    description: z.string(),
    severity: z.number().min(1).max(5).optional(),
    notes: z.string().optional(),
    entry_datetime: z.string().optional(),
  },
  async (args) => {
    const payload = { ...args };
    if (args.entry_datetime) { payload.created_at = args.entry_datetime; delete payload.entry_datetime; }
    const { data, error } = await sb.from('health_events').insert(payload).select().single();
    if (error) return { content: [{ type: 'text', text: 'Error: ' + error.message }] };
    return { content: [{ type: 'text', text: `Logged health event: ${args.event_type} — ${args.description}` }] };
  }
);

// Get today's summary
server.tool(
  'get_today',
  "Get Clem's food, activity and health log for today (or a specific date)",
  { date: z.string().optional().describe('YYYY-MM-DD, defaults to today') },
  async (args) => {
    const date = args.date || new Date().toISOString().slice(0, 10);
    const start = date + 'T00:00:00';
    const end = date + 'T23:59:59';
    const [fe, fa, fh] = await Promise.all([
      sb.from('entries').select('*').gte('created_at', start).lte('created_at', end).order('created_at'),
      sb.from('activities').select('*').gte('created_at', start).lte('created_at', end).order('created_at'),
      sb.from('health_events').select('*').gte('created_at', start).lte('created_at', end).order('created_at'),
    ]);
    const totalCals = (fe.data || []).filter(e => e.meal_type !== 'water').reduce((s, e) => s + (e.calories || 0), 0);
    const totalProt = (fe.data || []).filter(e => e.meal_type !== 'water').reduce((s, e) => s + (e.protein || 0), 0);
    const summary = { date, food: { entries: fe.data || [], totals: { calories: Math.round(totalCals), protein: Math.round(totalProt) } }, activities: fa.data || [], health_events: fh.data || [] };
    return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
  }
);

// Get history
server.tool(
  'get_history',
  'Get food/activity history for a date range',
  { days: z.number().default(7).describe('Number of past days to fetch') },
  async (args) => {
    const cutoff = new Date(Date.now() - (args.days || 7) * 86400000).toISOString();
    const [fe, fa] = await Promise.all([
      sb.from('entries').select('created_at,meal_type,description,calories,protein,carbs,fat').gte('created_at', cutoff).order('created_at', { ascending: false }),
      sb.from('activities').select('created_at,activity_type,duration_min,distance_km,calories_burned').gte('created_at', cutoff).order('created_at', { ascending: false }),
    ]);
    return { content: [{ type: 'text', text: JSON.stringify({ food: fe.data || [], activities: fa.data || [] }, null, 2) }] };
  }
);

// Delete entry
server.tool(
  'delete_entry',
  'Delete a food entry by ID',
  { id: z.string() },
  async (args) => {
    const { error } = await sb.from('entries').delete().eq('id', args.id);
    if (error) return { content: [{ type: 'text', text: 'Error: ' + error.message }] };
    return { content: [{ type: 'text', text: 'Deleted entry ' + args.id }] };
  }
);

  return server;
}

// ── SSE transport ─────────────────────────────────────────────────
const transports = {};

app.get('/sse', async (req, res) => {
  try {
    const transport = new SSEServerTransport('/messages', res);
    transports[transport.sessionId] = transport;
    res.on('close', () => delete transports[transport.sessionId]);
    // Fresh server per connection so multiple clients can connect safely.
    const server = buildServer();
    await server.connect(transport);
  } catch (err) {
    console.error('SSE connect error:', err);
    if (!res.headersSent) res.status(500).end();
  }
});

app.post('/messages', async (req, res) => {
  try {
    const sessionId = req.query.sessionId;
    const transport = transports[sessionId];
    if (!transport) return res.status(404).json({ error: 'Session not found' });
    await transport.handlePostMessage(req, res);
  } catch (err) {
    console.error('Message handling error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Message error' });
  }
});

// Safety net: a stray async error should never crash the whole server
// (which is what was generating the Render restart emails). Log instead.
process.on('unhandledRejection', (reason) => console.error('unhandledRejection:', reason));
process.on('uncaughtException', (err) => console.error('uncaughtException:', err));

app.listen(PORT, () => console.log(`foodlog server running on port ${PORT}`));
