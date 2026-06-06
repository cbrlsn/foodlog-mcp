import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const PORT = process.env.PORT || 3000;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_KEY env vars');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const app = express();

// ── MCP Server ────────────────────────────────────────────────────
const server = new McpServer({
  name: 'foodlog',
  version: '1.0.0',
});

// ── Tools ─────────────────────────────────────────────────────────

// Log a food entry
server.tool(
  'log_food',
  'Log a food or drink entry to Clem\'s nutrition tracker',
  {
    meal_type: z.enum(['breakfast','lunch','dinner','snack','drink','other']),
    description: z.string().describe('Concise item list with quantities'),
    notes: z.string().optional().describe('Brief comment about the meal'),
    calories: z.number().optional(),
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
    entry_datetime: z.string().optional().describe('ISO datetime e.g. 2024-06-01T08:30:00 — use this if user specifies a time or past date'),
  },
  async (args) => {
    const payload = { ...args };
    if (args.entry_datetime) {
      payload.created_at = args.entry_datetime;
      delete payload.entry_datetime;
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
    entry_datetime: z.string().optional().describe('ISO datetime if user specifies time/date'),
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
    notes: z.string().optional().describe('Food/activity correlation if relevant'),
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
  {
    date: z.string().optional().describe('YYYY-MM-DD, defaults to today'),
  },
  async (args) => {
    const date = args.date || new Date().toISOString().slice(0, 10);
    const start = date + 'T00:00:00';
    const end = date + 'T23:59:59';
    const [fe, fa, fh] = await Promise.all([
      sb.from('entries').select('*').gte('created_at', start).lte('created_at', end).order('created_at'),
      sb.from('activities').select('*').gte('created_at', start).lte('created_at', end).order('created_at'),
      sb.from('health_events').select('*').gte('created_at', start).lte('created_at', end).order('created_at'),
    ]);
    const totalCals = (fe.data || []).reduce((s, e) => s + (e.calories || 0), 0);
    const totalProt = (fe.data || []).reduce((s, e) => s + (e.protein || 0), 0);
    const totalCarbs = (fe.data || []).reduce((s, e) => s + (e.carbs || 0), 0);
    const totalFat = (fe.data || []).reduce((s, e) => s + (e.fat || 0), 0);
    const summary = {
      date,
      food: { entries: fe.data || [], totals: { calories: Math.round(totalCals), protein: Math.round(totalProt), carbs: Math.round(totalCarbs), fat: Math.round(totalFat) } },
      activities: fa.data || [],
      health_events: fh.data || [],
    };
    return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
  }
);

// Get history range
server.tool(
  'get_history',
  "Get food/activity history for a date range",
  {
    days: z.number().default(7).describe('Number of past days to fetch'),
  },
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

// ── SSE transport ─────────────────────────────────────────────────
const transports = {};

app.get('/sse', async (req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  transports[transport.sessionId] = transport;
  res.on('close', () => delete transports[transport.sessionId]);
  await server.connect(transport);
});

app.post('/messages', express.json(), async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];
  if (!transport) return res.status(404).json({ error: 'Session not found' });
  await transport.handlePostMessage(req, res);
});

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'foodlog-mcp' }));

app.listen(PORT, () => console.log(`foodlog MCP server running on port ${PORT}`));
