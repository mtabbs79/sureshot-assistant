// Sure Shot Assistant — research + lineup help for every Sure Shot League owner.
// League data reaches the app only through the CBS bookmarklet, which runs in the owner's own
// logged-in CBS tab. The server never holds CBS passwords and never changes anything on CBS.
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { normalizeLive, normPos } = require('./lib/normalize');
const engine = require('./lib/engine');
const ai = require('./lib/ai');
const AI_DAILY = +(process.env.AI_DAILY_LIMIT || 3);       // new write-ups per team per day
const AI_MONTHLY_USD = +(process.env.AI_MONTHLY_CAP_USD || 10); // app stops calling the API past this

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'commish';
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('ssl:' + ADMIN_PASSWORD).digest('hex');
const CBS_HOST = process.env.CBS_HOST || 'sureshot.football.cbssports.com';
const TOKEN_DAYS = 120;

// Optional seed: the Oct 28 free-agent pool from the draft app, used until the first CBS free-agent sync.
const SEED_FILE = path.join(__dirname, 'data', 'players.json');
const SEED = fs.existsSync(SEED_FILE) ? JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')) : null;

// ---------- storage: one key/value table (shares the draft app's database safely) ----------
let pool = null;
const mem = {};
const FILE = path.join(__dirname, 'data', 'store.json');
async function init() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    const host = new URL(process.env.DATABASE_URL).hostname;
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: host.includes('.') ? { rejectUnauthorized: false } : false });
    await pool.query('CREATE TABLE IF NOT EXISTS assistant_kv (key text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())');
    const r = await pool.query('SELECT key, data FROM assistant_kv');
    r.rows.forEach(x => { mem[x.key] = x.data; });
  } else if (fs.existsSync(FILE)) {
    Object.assign(mem, JSON.parse(fs.readFileSync(FILE, 'utf8')));
  }
}
async function put(k, v) {
  mem[k] = v;
  if (pool) await pool.query('INSERT INTO assistant_kv (key, data, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()', [k, JSON.stringify(v)]);
  else { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(mem)); }
}
let chain = Promise.resolve();
const locked = fn => (chain = chain.then(fn, fn));

// ---------- league data ----------
let cache = { at: null, val: null };
function league() {
  const L = mem.live;
  if (!L) return null;
  if (cache.at !== L.syncedAt) cache = { at: L.syncedAt, val: normalizeLive(L.raw, L.week) };
  return cache.val;
}
const nkey = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
function freeAgents(lg) {
  let list = [], source = null;
  const byPos = (mem.fa && mem.fa.byPos) || {};
  if (Object.keys(byPos).length) {
    for (const [pos, v] of Object.entries(byPos)) list.push(...v.players.map(p => ({ ...p, pos: normPos(p.pos || pos) })));
    source = { type: 'cbs', positions: Object.keys(byPos), at: Math.min(...Object.values(byPos).map(v => v.at)) };
  } else if (SEED) {
    list = SEED.slice(); source = { type: 'seed' };
  }
  if (lg) {
    const ids = new Set(), names = new Set();
    lg.teams.forEach(t => t.roster.forEach(p => { ids.add(p.id); names.add(nkey(p.name)); }));
    list = list.filter(p => !ids.has(String(p.id)) && !names.has(nkey(p.name)));
  }
  list = list.filter(p => (p.pts || 0) > 0 || (p.proj || 0) > 0 || (p.rost || 0) >= 3);
  return { list, source };
}

// ---------- auth ----------
const b64 = s => Buffer.from(s).toString('base64url');
const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
function makeToken(sub) { const body = b64(JSON.stringify({ sub, exp: Date.now() + TOKEN_DAYS * 864e5 })); return body + '.' + sign(body); }
function readToken(req) {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const [body, sig] = t.split('.');
  if (!body || !sig) return null;
  const good = sign(body);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try { const o = JSON.parse(Buffer.from(body, 'base64url').toString()); return o.exp > Date.now() ? o.sub : null; } catch { return null; }
}
function hashPin(pin, salt) { return crypto.scryptSync(String(pin), salt, 32).toString('hex'); }
const fails = {}; // teamId -> { n, until }
function pinsMeta() { return mem.pins || {}; }

// ---------- tiny router ----------
const routes = {};
const get = (p, h) => (routes['GET ' + p] = h), post = (p, h) => (routes['POST ' + p] = h);
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.mp3': 'audio/mpeg', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  res.json = (o, code = 200) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(o)); };
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const url = new URL(req.url, 'http://x');
  req.query = Object.fromEntries(url.searchParams);
  const h = routes[req.method + ' ' + url.pathname];
  if (h) {
    const limit = url.pathname === '/api/sync' ? 25e6 : 1e5;
    let body = '', size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { res.json({ error: 'Too much data in one request.' }, 413); req.destroy(); } else body += c; });
    req.on('end', async () => {
      try { req.body = body ? JSON.parse(body) : {}; } catch { req.body = {}; }
      req.sub = readToken(req);
      try { await h(req, res); } catch (e) { console.error(e); if (!res.writableEnded) res.json({ error: 'Server error: ' + e.message }, 500); }
    });
    return;
  }
  if (req.method !== 'GET') return res.json({ error: 'Not found' }, 404);
  const f = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!f.startsWith(PUBLIC) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end('Not found'); }
  res.setHeader('Content-Type', TYPES[path.extname(f)] || 'application/octet-stream');
  if (path.extname(f) === '.html' || f.endsWith('bm-src.js')) res.setHeader('Cache-Control', 'no-cache');
  fs.createReadStream(f).pipe(res);
});

const needTeam = (req, res) => { const s = req.sub; if (s && s.startsWith('team:')) return s.slice(5); res.json({ error: 'Log in with your team PIN.' }, 401); return null; };
const needAny = (req, res) => { if (req.sub) return req.sub; res.json({ error: 'Log in first.' }, 401); return null; };
const needAdmin = (req, res) => { if (req.sub === 'admin') return true; res.json({ error: 'Commissioner only.' }, 403); return false; };
const needData = res => { const lg = league(); if (!lg) res.json({ error: 'No league data yet. Sync from CBS with the bookmarklet first.' }, 409); return lg; };

// ---------- routes ----------
get('/healthz', (req, res) => res.end('ok'));

get('/api/status', (req, res) => {
  const lg = league(), L = mem.live || {};
  const pins = pinsMeta();
  res.json({
    host: L.host || CBS_HOST,
    week: lg ? lg.week : null, syncedAt: L.syncedAt || null, syncedBy: L.syncedBy || null,
    teams: lg ? lg.teams.map(t => ({ id: t.id, name: t.name, owner: t.owner, hasPin: !!pins[t.id] })) : [],
    fa: freeAgents(lg).source,
    ai: ai.enabled(),
    me: req.sub,
  });
});

post('/api/login', (req, res) => {
  const teamId = String(req.body.teamId || ''), pin = String(req.body.pin || '');
  const f = fails[teamId];
  if (f && f.until > Date.now()) return res.json({ error: `Too many wrong PINs. Try again in ${Math.ceil((f.until - Date.now()) / 60000)} min.` }, 429);
  const rec = pinsMeta()[teamId];
  if (!rec) return res.json({ error: 'This team has no PIN yet. Ask the commissioner to set one.' }, 403);
  if (hashPin(pin, rec.salt) !== rec.hash) {
    const n = (f ? f.n : 0) + 1;
    fails[teamId] = { n, until: n >= 5 ? Date.now() + 10 * 60000 : 0 };
    if (n >= 5) fails[teamId].n = 0;
    return res.json({ error: 'Wrong PIN.' }, 403);
  }
  delete fails[teamId];
  const lg = league();
  const t = lg && lg.teams.find(x => x.id === teamId);
  res.json({ token: makeToken('team:' + teamId), team: { id: teamId, name: t ? t.name : 'Team ' + teamId } });
});

post('/api/admin/login', (req, res) => {
  if (String(req.body.password || '') !== ADMIN_PASSWORD) return res.json({ error: 'Wrong commissioner password.' }, 403);
  res.json({ token: makeToken('admin') });
});

post('/api/admin/pin', (req, res) => locked(async () => {
  if (!needAdmin(req, res)) return;
  const teamId = String(req.body.teamId || ''), pin = req.body.pin;
  const pins = { ...pinsMeta() };
  if (pin == null || pin === '') delete pins[teamId];
  else {
    if (!/^\d{4,8}$/.test(String(pin))) return res.json({ error: 'PINs are 4 to 8 digits.' }, 400);
    const salt = crypto.randomBytes(16).toString('hex');
    pins[teamId] = { salt, hash: hashPin(pin, salt), setAt: Date.now() };
  }
  await put('pins', pins);
  delete fails[teamId];
  res.json({ ok: true });
}));

// The bookmarklet hands CBS data to the app's bridge window, which posts it here.
post('/api/sync', (req, res) => locked(async () => {
  const who = needAny(req, res); if (!who) return;
  const { live, fa, week, host } = req.body;
  const out = { live: false, faPositions: [] };
  if (live) {
    if (!live.league || !Array.isArray(live.league.teams) || !live.league.teams.length)
      return res.json({ error: 'That page had no league data. Open Live Scoring in your league on CBS and run the bookmarklet there.' }, 400);
    const prev = mem.live;
    const wk = Number(week) || normalizeLive(live).week || null;
    // A fetched copy of the page comes back without odds/OPRK; keep the ones from an earlier sync of the same week.
    if (prev && prev.week === wk && Array.isArray(live.games) && Array.isArray(prev.raw.games)) {
      const key = g => JSON.stringify([g.awayTeam, g.homeTeam]);
      const old = Object.fromEntries(prev.raw.games.map(g => [key(g), g]));
      live.games.forEach(g => {
        const o = old[key(g)]; if (!o) return;
        if (!(g.odds && g.odds.odds) && o.odds) g.odds = o.odds;
        if (g.awayOPRK == null && o.awayOPRK != null) g.awayOPRK = o.awayOPRK;
        if (g.homeOPRK == null && o.homeOPRK != null) g.homeOPRK = o.homeOPRK;
      });
    }
    const lgName = (() => { const lg = league(); const id = who.startsWith('team:') ? who.slice(5) : null; const t = lg && id && lg.teams.find(x => x.id === id); return t ? t.name : (who === 'admin' ? 'Commissioner' : who); })();
    await put('live', { raw: live, week: wk, host: /cbssports\.com$/.test(host || '') ? host : CBS_HOST, syncedAt: Date.now(), syncedBy: lgName });
    out.live = true;
  }
  if (fa && typeof fa === 'object') {
    const byPos = { ...((mem.fa && mem.fa.byPos) || {}) };
    for (const [pos, list] of Object.entries(fa)) {
      if (!Array.isArray(list) || !list.length) continue;
      const P = normPos(pos);
      byPos[P] = { at: Date.now(), players: list.slice(0, 600).map(p => ({
        id: String(p.id), name: String(p.name || ''), pos: normPos(p.pos || P), team: p.team || '',
        bye: p.bye ?? null, rost: p.rost ?? null, avg: p.avg ?? null, pts: p.pts ?? null,
        proj: p.proj ?? null, opp: p.opp || null, avail: p.avail || null })) };
      out.faPositions.push(P);
    }
    if (out.faPositions.length) await put('fa', { byPos });
  }
  if (!out.live && !out.faPositions.length) return res.json({ error: 'Nothing to sync on this page. Run the bookmarklet from Live Scoring or a Free Agents page.' }, 400);
  res.json({ ok: true, ...out, week: league() ? league().week : null, teams: league() ? league().teams.length : 0 });
}));

function myAnalysis(req, teamId) {
  const lg = league();
  const opp = mem.opp && mem.opp[teamId] && mem.opp[teamId].week === lg.week ? mem.opp[teamId].id : null;
  return engine.analyze(lg, teamId, freeAgents(lg).list, opp);
}

get('/api/me', (req, res) => {
  const id = needTeam(req, res); if (!id) return;
  const lg = needData(res); if (!lg) return;
  const a = myAnalysis(req, id);
  if (!a) return res.json({ error: 'Your team is not in the latest CBS data. Sync again from CBS.' }, 404);
  res.json({ ...a, fa: freeAgents(lg).source, host: (mem.live && mem.live.host) || CBS_HOST,
             teams: lg.teams.map(t => ({ id: t.id, name: t.name })) });
});

// The bookmarklet's on-page highlights come from this.
get('/api/plan', (req, res) => {
  const id = needTeam(req, res); if (!id) return;
  const lg = needData(res); if (!lg) return;
  const a = myAnalysis(req, id);
  if (!a) return res.json({ error: 'Team not found in CBS data.' }, 404);
  const mv = a.moves || [];
  res.json({ team: a.team, week: a.week, known: a.currentKnown,
    moves: mv.map(m => ({ start: { id: m.start.id, name: m.start.name, pos: m.start.pos }, bench: m.bench && { id: m.bench.id, name: m.bench.name, pos: m.bench.pos }, delta: m.delta })),
    startIds: mv.map(m => m.start.id), benchIds: mv.filter(m => m.bench).map(m => m.bench.id),
    optimalIds: a.lineup.filter(s => s.player).map(s => s.player.id),
    adds: a.adds.slice(0, 3).map(x => ({ name: x.name, pos: x.pos, gain: x.gain, drop: x.drop && x.drop.name })) });
});

post('/api/opponent', (req, res) => locked(async () => {
  const id = needTeam(req, res); if (!id) return;
  const lg = needData(res); if (!lg) return;
  const opp = { ...(mem.opp || {}) };
  if (req.body.opponentId) opp[id] = { id: String(req.body.opponentId), week: lg.week }; else delete opp[id];
  await put('opp', opp);
  res.json({ ok: true });
}));

get('/api/league', (req, res) => {
  if (!needAny(req, res)) return;
  const lg = needData(res); if (!lg) return;
  res.json({ week: lg.week, teams: engine.leagueSummary(lg) });
});

get('/api/team', (req, res) => {
  if (!needAny(req, res)) return;
  const lg = needData(res); if (!lg) return;
  const t = engine.teamRoster(lg, req.query.id);
  t ? res.json(t) : res.json({ error: 'Team not found.' }, 404);
});

// ---------- AI write-ups ----------
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const dataKey = () => `${(mem.live && mem.live.syncedAt) || 0}|${(freeAgents(league()).source || {}).at || 0}`;

get('/api/writeup', (req, res) => {
  const id = needTeam(req, res); if (!id) return;
  const w = (mem.ai || {})[id];
  res.json({ enabled: ai.enabled(), writeup: w || null, stale: !!w && w.key !== dataKey() });
});

post('/api/writeup', (req, res) => locked(async () => {
  const id = needTeam(req, res); if (!id) return;
  const lg = needData(res); if (!lg) return;
  const cache = { ...(mem.ai || {}) };
  const key = dataKey();
  if (cache[id] && cache[id].key === key) return res.json({ writeup: cache[id], cached: true });
  const month = today().slice(0, 7);
  let use = mem.aiuse && mem.aiuse.month === month ? { ...mem.aiuse } : { month, cost: 0, calls: 0, byTeam: {} };
  use.byTeam = { ...use.byTeam };
  const t = use.byTeam[id] && use.byTeam[id].day === today() ? use.byTeam[id] : { day: today(), n: 0 };
  if (t.n >= AI_DAILY) return res.json({ error: `You've used today's ${AI_DAILY} write-ups. Your last one is still below; new ones open tomorrow.` }, 429);
  if (use.cost >= AI_MONTHLY_USD) return res.json({ error: 'The league hit this month\u2019s AI budget. The commissioner can raise it.' }, 429);
  const a = myAnalysis(req, id);
  if (!a) return res.json({ error: 'Your team is not in the latest CBS data.' }, 404);
  let out;
  try { out = await ai.writeUp(a); } catch (e) { return res.json({ error: e.message }, 502); }
  cache[id] = { key, text: out.text, at: Date.now(), week: lg.week, model: out.model };
  t.n += 1; use.byTeam[id] = { ...t, total: ((use.byTeam[id] && use.byTeam[id].total) || 0) + 1 };
  use.calls += 1; use.cost = Math.round((use.cost + out.cost) * 10000) / 10000;
  await put('ai', cache); await put('aiuse', use);
  res.json({ writeup: cache[id], cached: false });
}));

get('/api/admin/ai', (req, res) => {
  if (!needAdmin(req, res)) return;
  const lg = league();
  const u = mem.aiuse || { month: today().slice(0, 7), cost: 0, calls: 0, byTeam: {} };
  res.json({ enabled: ai.enabled(), model: ai.MODEL, dailyLimit: AI_DAILY, monthlyCap: AI_MONTHLY_USD, month: u.month, cost: u.cost, calls: u.calls,
    byTeam: Object.entries(u.byTeam || {}).map(([id, v]) => ({ id, name: (lg && (lg.teams.find(t => t.id === id) || {}).name) || id, calls: v.total || v.n })) });
});

const PORT = process.env.PORT || 3000;
init().then(() => server.listen(PORT, () => console.log(`Sure Shot Assistant on :${PORT}`)))
  .catch(e => { console.error(e); process.exit(1); });
