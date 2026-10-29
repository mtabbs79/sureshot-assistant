// Turns the raw CBS `bootstrapLiveScoringData` blob into a stable shape.
// Field names follow what the weekly-review skill reads on the live site; every lookup is
// tolerant so a CBS rename degrades one field instead of breaking the app.
// The raw blob is stored as-is, so fixes here apply to old syncs without re-syncing.

const POS = { D: 'DST', DST: 'DST', 'D/ST': 'DST', DEF: 'DST', PK: 'K', K: 'K', QB: 'QB', RB: 'RB', WR: 'WR', TE: 'TE' };
const normPos = p => { const s = String(p || '').toUpperCase().trim(); return POS[s] || s; };
const num = v => { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : null; };
const abbr = t => (t && typeof t === 'object') ? String(t.abbr || t.abbreviation || t.code || t.id || '') : String(t || '');

function injuries(icons) {
  if (!icons) return [];
  const s = typeof icons === 'string' ? icons : JSON.stringify(icons);
  return [...s.matchAll(/title=\\?"([^"\\]+)\\?"/g)].map(m => m[1].trim())
    .filter(t => t && !/^(Hot|Cold) Player$/i.test(t));
}

function playerName(p) {
  const n = ((p.firstName || '') + ' ' + (p.lastName || '')).trim();
  return n || p.fullName || p.name || '';
}

// Look for fantasy matchups anywhere in the blob: objects holding exactly two team ids.
function findMatchups(raw, teamIds) {
  const ids = new Set(teamIds), pairs = [], seen = new Set();
  (function walk(o, d) {
    if (!o || typeof o !== 'object' || d > 6 || seen.has(o)) return;
    seen.add(o);
    if (!Array.isArray(o) && !('rosterPlayers' in o)) {
      const vals = [];
      for (const [k, v] of Object.entries(o)) {
        if (/^((away|home)team(id)?|team[12](id)?|(away|home)id)$/i.test(k) &&
            (typeof v === 'string' || typeof v === 'number') && ids.has(String(v))) vals.push(String(v));
        else if (/^(away|home)/i.test(k) && v && typeof v === 'object' && ids.has(String(v.id))) vals.push(String(v.id));
      }
      if (vals.length === 2 && vals[0] !== vals[1]) pairs.push(vals);
    }
    for (const v of Object.values(o)) walk(v, d + 1);
  })(raw, 0);
  const opp = {};
  for (const [a, b] of pairs) {
    if ((opp[a] && opp[a] !== b) || (opp[b] && opp[b] !== a)) return {}; // inconsistent: don't guess
    opp[a] = b; opp[b] = a;
  }
  return opp;
}

function detectWeek(raw) {
  for (const v of [raw.period, raw.week, raw.currentPeriod, raw.league && raw.league.period,
                   raw.league && raw.league.currentPeriod, raw.scoringPeriod]) {
    const n = num(v); if (n && n > 0 && n < 25) return n;
  }
  return null;
}

function normalizeLive(raw, weekHint) {
  const P = {};
  (raw.players || []).forEach(p => { P[String(p.id)] = p; });

  const games = (raw.games || []).map(g => ({
    away: abbr(g.awayTeam), home: abbr(g.homeTeam),
    day: g.dayOfTheWeek || '', time: g.gameTime || '',
    odds: (g.odds && (g.odds.odds || g.odds.line)) || (typeof g.odds === 'string' ? g.odds : null),
    awayOPRK: g.awayOPRK ?? null, homeOPRK: g.homeOPRK ?? null,
  }));

  const teams = ((raw.league && raw.league.teams) || []).map(t => ({
    id: String(t.id ?? t.teamId),
    name: String(t.name || t.longName || '').trim() || 'Team ' + (t.id ?? '?'),
    owner: Array.isArray(t.ownerNames) ? t.ownerNames.join(', ') : String(t.ownerNames || t.owner || ''),
    proj: num(t.projectedFPTS),
    legal: t.isRosterLegal !== false,
    roster: (t.rosterPlayers || []).map(r => {
      const p = P[String(r.id)] || {};
      return {
        id: String(r.id),
        name: playerName(p) || r.name || 'Player ' + r.id,
        pos: normPos(r.position || p.position),
        pro: abbr(p.proTeam || r.proTeam),
        proj: num(r.projectedFPTS) ?? 0,
        starter: !!r.hasBeenStarter,
        status: r.currentStatus ?? null,
        inj: injuries(r.icons),
      };
    }),
  }));

  return {
    week: weekHint || detectWeek(raw),
    teams, games,
    matchups: findMatchups(raw, teams.map(t => t.id)),
  };
}

module.exports = { normalizeLive, normPos, num };
