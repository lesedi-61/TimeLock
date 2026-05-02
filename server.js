'use strict';

const express   = require('express');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const helmet    = require('helmet');

const app = express();

// ── Config ────────────────────────────────────────────
const SUPABASE_URL     = 'https://udbjpjjbzlamfjogwiqt.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVkYmpwampiemxhbWZqb2d3aXF0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc3MjU2MTMsImV4cCI6MjA5MzMwMTYxM30.lZ4E3_789_JfXhP_5NMJD7cXhqrstlX9ICGKQWN3pj4';
const PORT = process.env.PORT || 3001;
// ── Middleware ────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '50kb' }));
app.use('/api', rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false }));

// ── Supabase helpers ──────────────────────────────────

// Build headers — pass a user JWT to use RLS, otherwise anon
function sbHeaders(userToken) {
  return {
    'Content-Type':  'application/json',
    'apikey':        SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${userToken || SUPABASE_ANON_KEY}`,
    'Prefer':        'return=representation'
  };
}

// Generic Supabase REST call
async function sb(path, options = {}, userToken) {
  const url = `${SUPABASE_URL}/rest/v1${path}`;
  const res  = await fetch(url, { ...options, headers: { ...sbHeaders(userToken), ...(options.headers || {}) } });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw { status: res.status, message: data?.message || data?.error || 'Supabase error' };
  return data;
}

// Supabase Auth REST
async function sbAuth(path, body) {
  const url = `${SUPABASE_URL}/auth/v1${path}`;
  const res  = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY },
    body:    JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw { status: res.status, message: data.error_description || data.msg || data.message || 'Auth error' };
  return data;
}

// Extract Bearer token from request
function getToken(req) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

// Auth guard middleware
function requireAuth(req, res, next) {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: 'Unauthorised' });
  req.token = token;
  next();
}

// ══════════════════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════════════════

// POST /api/auth/signup
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { first_name, last_name, email, password } = req.body;
    if (!first_name || !last_name || !email || !password)
      return res.status(400).json({ error: 'All fields are required' });

    const data = await sbAuth('/signup', {
      email,
      password,
      data: { first_name, last_name }
    });

    const user = {
      id:         data.user.id,
      email:      data.user.email,
      first_name: data.user.user_metadata?.first_name || first_name,
      last_name:  data.user.user_metadata?.last_name  || last_name
    };

    return res.status(201).json({ token: data.access_token, user });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password are required' });

    const data = await sbAuth('/token?grant_type=password', { email, password });

    const user = {
      id:         data.user.id,
      email:      data.user.email,
      first_name: data.user.user_metadata?.first_name || '',
      last_name:  data.user.user_metadata?.last_name  || ''
    };

    return res.json({ token: data.access_token, user });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /api/auth/me
app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const url = `${SUPABASE_URL}/auth/v1/user`;
    const r   = await fetch(url, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${req.token}` } });
    const data = await r.json();
    if (!r.ok) return res.status(401).json({ error: 'Invalid token' });

    return res.json({
      user: {
        id:         data.id,
        email:      data.email,
        first_name: data.user_metadata?.first_name || '',
        last_name:  data.user_metadata?.last_name  || ''
      }
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════
//  MOODS
// ══════════════════════════════════════════════════════

app.get('/api/moods', async (req, res) => {
  try {
    const moods = await sb('/moods?select=*&order=id.asc');
    return res.json({ moods });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════
//  CAPSULES
// ══════════════════════════════════════════════════════

// Helper: compute status + progress for a capsule
function enrichCapsule(c) {
  const now      = new Date();
  const unlock   = new Date(c.unlock_date);
  const created  = new Date(c.created_at);
  const total    = unlock - created;
  const elapsed  = now - created;
  const progress = Math.min(100, Math.max(0, Math.round((elapsed / total) * 100)));
  const daysLeft = Math.ceil((unlock - now) / 86_400_000);

  let status = 'sealed';
  if (unlock <= now)           status = 'unlocked';
  else if (daysLeft <= 30)     status = 'soon';

  return { ...c, status, progress };
}

// GET /api/capsules
app.get('/api/capsules', requireAuth, async (req, res) => {
  try {
    const raw = await sb(
      '/capsules?select=*,moods(emoji,label)&order=unlock_date.asc',
      {}, req.token
    );
    const capsules = (raw || []).map(c => {
      const enriched = enrichCapsule(c);
      const preview  = enriched.status === 'unlocked'
        ? (c.message || '').slice(0, 120)
        : null;
      return {
        id:          c.id,
        title:       c.title,
        preview,
        unlock_date: c.unlock_date,
        created_at:  c.created_at,
        status:      enriched.status,
        progress:    enriched.progress,
        notify_pref: c.notify_pref,
        mood_emoji:  c.moods?.emoji || null,
        mood_label:  c.moods?.label || null
      };
    });
    return res.json({ capsules });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /api/capsules/:id
app.get('/api/capsules/:id', requireAuth, async (req, res) => {
  try {
    const rows = await sb(
      `/capsules?select=*,moods(emoji,label)&id=eq.${req.params.id}&limit=1`,
      {}, req.token
    );
    if (!rows || rows.length === 0)
      return res.status(404).json({ error: 'Capsule not found' });

    const c        = rows[0];
    const enriched = enrichCapsule(c);

    const capsule = {
      id:          c.id,
      title:       c.title,
      message:     enriched.status === 'unlocked' ? c.message : null,
      preview:     enriched.status === 'unlocked' ? (c.message || '').slice(0, 120) : null,
      unlock_date: c.unlock_date,
      created_at:  c.created_at,
      status:      enriched.status,
      progress:    enriched.progress,
      notify_pref: c.notify_pref,
      mood_emoji:  c.moods?.emoji || null,
      mood_label:  c.moods?.label || null
    };

    return res.json({ capsule });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/capsules
app.post('/api/capsules', requireAuth, async (req, res) => {
  try {
    const { title, message, mood_id, unlock_date, notify_pref } = req.body;
    if (!title || !message || !unlock_date)
      return res.status(400).json({ error: 'title, message and unlock_date are required' });
    if (new Date(unlock_date) <= new Date())
      return res.status(400).json({ error: 'unlock_date must be in the future' });

    // Get user id from token
    const meUrl  = `${SUPABASE_URL}/auth/v1/user`;
    const meRes  = await fetch(meUrl, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${req.token}` } });
    const meData = await meRes.json();
    if (!meRes.ok) return res.status(401).json({ error: 'Invalid token' });

    const row = {
      user_id:     meData.id,
      title,
      message,
      mood_id:     mood_id || null,
      unlock_date,
      notify_pref: notify_pref || 'on_unlock'
    };

    const created = await sb('/capsules', {
      method: 'POST',
      body:   JSON.stringify(row)
    }, req.token);

    const c        = Array.isArray(created) ? created[0] : created;
    const enriched = enrichCapsule(c);

    return res.status(201).json({
      message: 'Capsule sealed successfully',
      capsule: { ...c, status: enriched.status, progress: enriched.progress }
    });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
});

// DELETE /api/capsules/:id
app.delete('/api/capsules/:id', requireAuth, async (req, res) => {
  try {
    await sb(`/capsules?id=eq.${req.params.id}`, { method: 'DELETE' }, req.token);
    return res.json({ message: 'Capsule deleted' });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════
//  DASHBOARD
// ══════════════════════════════════════════════════════

app.get('/api/dashboard', requireAuth, async (req, res) => {
  try {
    const raw = await sb(
      '/capsules?select=*,moods(emoji,label)&order=unlock_date.asc',
      {}, req.token
    );

    const capsules = (raw || []).map(c => {
      const enriched = enrichCapsule(c);
      return {
        id:          c.id,
        title:       c.title,
        preview:     enriched.status === 'unlocked' ? (c.message || '').slice(0, 120) : null,
        unlock_date: c.unlock_date,
        created_at:  c.created_at,
        status:      enriched.status,
        progress:    enriched.progress,
        mood_emoji:  c.moods?.emoji || null,
        mood_label:  c.moods?.label || null
      };
    });

    const total         = capsules.length;
    const unlocked      = capsules.filter(c => c.status === 'unlocked').length;
    const opening_soon  = capsules.filter(c => c.status === 'soon').length;
    const sealed        = capsules.filter(c => c.status === 'sealed').length;

    const next_capsule = capsules.find(c => c.status !== 'unlocked') || null;

    return res.json({
      stats:       { total, unlocked, opening_soon, sealed, streak_days: 0 },
      next_capsule,
      capsules
    });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
});

// ── 404 & error handlers ──────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => console.log(`✦ Vaulted API → http://localhost:${PORT}`));