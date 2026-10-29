// Sure Shot League rules engine — the same method as the ssl-weekly-review skill.
// CBS projections on this league are already scored to league rules, so they are never re-scored.
// Only these adjustments move a number: injury haircuts, byes, and a small DST game-environment nudge.

const SKILL = new Set(['RB', 'WR', 'TE']);
const r1 = x => Math.round(x * 10) / 10;

function availability(inj) {
  const t = (inj || []).join('; ');
  if (!t) return { m: 1 };
  if (/\b(out|injured reserve|ir|exempt|suspended|pup|nfi)\b/i.test(t) && !/questionable|doubtful/i.test(t))
    return { m: 0, why: 'Out', note: t };
  if (/doubtful/i.test(t)) return { m: 0.25, why: 'Doubtful ×0.25', note: t };
  if (/questionable/i.test(t)) {
    if (/head|concussion/i.test(t)) return { m: 0.55, why: 'Questionable, head ×0.55', note: t };
    if (/knee|acl/i.test(t)) return { m: 0.85, why: 'Questionable, knee ×0.85', note: t };
    if (/groin|hamstring|toe|ankle|hip|calf|achilles|heel|abdom/i.test(t)) return { m: 0.8, why: 'Questionable, soft tissue ×0.80', note: t };
    return { m: 0.9, why: 'Questionable ×0.90', note: t };
  }
  return { m: 1, note: t };
}

// "DAL -3.5 O/U 47.5" and similar. Returns implied points per team, or null if unreadable.
function parseOdds(s, g) {
  if (!s) return null;
  const tot = (String(s).match(/(?:o\/u|\bou\b|total)\s*:?\s*(\d+(?:\.\d+)?)/i) || [])[1];
  if (!tot) return null;
  const T = +tot;
  const sp = String(s).match(/\b([A-Z]{2,4})\s*(-\d+(?:\.\d+)?)/);
  const fav = sp ? sp[1] : null, spread = sp ? Math.abs(+sp[2]) : 0;
  const implied = team => !fav || (fav !== g.home && fav !== g.away) ? T / 2 : (team === fav ? T / 2 + spread / 2 : T / 2 - spread / 2);
  return { total: T, implied };
}

function oprkFor(o, pos) {
  if (o == null) return null;
  if (typeof o === 'number' || typeof o === 'string') return +o || null;
  const v = o[pos] ?? o[pos === 'DST' ? 'DST' : pos] ?? o.rank ?? null;
  return v == null ? null : (+v || null);
}

function makeContext(lg) {
  const byTeam = {};
  lg.games.forEach(g => { byTeam[g.away] = { g, home: false }; byTeam[g.home] = { g, home: true }; });
  return { byTeam, fullSlate: lg.games.length >= 8 };
}

function evalPlayer(p, ctx) {
  const why = []; let m = 1;
  const av = availability(p.inj);
  m *= av.m; if (av.why) why.push(av.why);
  const gm = p.pro ? ctx.byTeam[p.pro] : null;
  if (ctx.fullSlate && p.pro && !gm) { m = 0; why.push('Bye week'); }
  let game = null, oprk = null, early = false, envNote = null;
  if (gm) {
    const { g, home } = gm, opp = home ? g.away : g.home;
    // awayOPRK is the AWAY team's defense rank, so it applies to HOME players (and vice versa).
    oprk = oprkFor(home ? g.awayOPRK : g.homeOPRK, p.pos);
    early = /^(tue|wed|thu)/i.test(g.day);
    game = { opp, home, day: g.day, time: g.time };
    if (p.pos === 'DST') {
      const o = parseOdds(g.odds, g);
      if (o) {
        const oppImp = o.implied(opp);
        if (oppImp <= 17.5) { m *= 1.06; envNote = `Opponent implied ${r1(oppImp)}, low ×1.06`; }
        else if (oppImp >= 26.5) { m *= 0.93; envNote = `Opponent implied ${r1(oppImp)}, yards bucket at risk ×0.93`; }
        if (envNote) why.push(envNote);
      }
    }
  }
  return { ...p, adj: r1((p.proj || 0) * m), mult: m, why, injNote: av.note || null, game, oprk, early };
}

function optimalLineup(players) {
  const used = new Set();
  const pick = (slot, cands) => { const p = cands.find(x => !used.has(x.id)); if (p) used.add(p.id); return { slot, player: p || null }; };
  const by = pos => players.filter(p => p.pos === pos).sort((a, b) => b.adj - a.adj);
  const flex = players.filter(p => SKILL.has(p.pos)).sort((a, b) => b.adj - a.adj);
  return [pick('QB', by('QB')), pick('RB', by('RB')), pick('WR', by('WR')), pick('TE', by('TE')),
          pick('FLEX', flex), pick('FLEX', flex), pick('K', by('K')), pick('DST', by('DST'))];
}
const sum = arr => r1(arr.reduce((a, p) => a + (p ? p.adj : 0), 0));
const fits = (slot, p) => slot === 'FLEX' ? SKILL.has(p.pos) : p.pos === slot;

function evalTeam(team, ctx) {
  const players = team.roster.map(p => evalPlayer(p, ctx));
  const slots = optimalLineup(players);
  const optIds = new Set(slots.filter(s => s.player).map(s => s.player.id));
  const current = players.filter(p => p.starter);
  return {
    id: team.id, name: team.name, owner: team.owner, legal: team.legal, players, slots, optIds,
    currentKnown: current.length > 0,
    currentTotal: current.length ? sum(current) : null,
    optimalTotal: sum(slots.map(s => s.player)),
  };
}

function baselines(allEval) {
  const all = allEval.flatMap(t => t.players);
  const nth = (arr, n) => { const s = arr.map(p => p.adj).sort((a, b) => b - a); return s[Math.min(n, s.length) - 1] ?? 0; };
  const skill = nth(all.filter(p => SKILL.has(p.pos)), 50);
  return { QB: nth(all.filter(p => p.pos === 'QB'), 10), K: nth(all.filter(p => p.pos === 'K'), 10),
           DST: nth(all.filter(p => p.pos === 'DST'), 10), RB: skill, WR: skill, TE: skill };
}

function moves(t) {
  if (!t.currentKnown) return null;
  const ins = t.players.filter(p => t.optIds.has(p.id) && !p.starter).sort((a, b) => b.adj - a.adj);
  const outs = t.players.filter(p => p.starter && !t.optIds.has(p.id));
  const res = [];
  for (const i of ins) {
    let k = outs.findIndex(o => o.pos === i.pos);
    if (k < 0 && SKILL.has(i.pos)) k = outs.findIndex(o => SKILL.has(o.pos));
    if (k < 0) k = 0;
    const o = outs.splice(k, 1)[0] || null;
    const reason = o && o.why.length ? `${o.name}: ${o.why.join(', ')}` :
      (i.pos === 'TE' ? 'Higher projection, and TEs get 1 pt per 8 yards here' : 'Higher projection this week');
    res.push({ start: i, bench: o, delta: r1(i.adj - (o ? o.adj : 0)), reason });
  }
  return res;
}

function closeCalls(t) {
  const bench = t.players.filter(p => !t.optIds.has(p.id) && p.adj > 0);
  const out = [];
  for (const s of t.slots) {
    if (!s.player) continue;
    const alt = bench.filter(b => fits(s.slot, b)).sort((a, b) => b.adj - a.adj)[0];
    if (alt && s.player.adj - alt.adj < 2)
      out.push({ slot: s.slot, starter: s.player, alt, diff: r1(s.player.adj - alt.adj) });
  }
  return out;
}

function riskFlags(t) {
  const flags = [];
  for (const s of t.slots) {
    const p = s.player;
    if (!p) { flags.push({ level: 'bad', text: `No eligible ${s.slot} on the roster.` }); continue; }
    if (p.adj === 0) flags.push({ level: 'bad', text: `${p.name} (${s.slot}) projects 0${p.why.length ? ': ' + p.why.join(', ') : ''}. Find a replacement.` });
    else if (p.mult < 1 && /Questionable|Doubtful/.test(p.why.join())) {
      const backup = t.players.some(b => b.id !== p.id && !t.optIds.has(b.id) && fits(s.slot, b) && b.adj > 0);
      flags.push({ level: 'warn', text: `${p.name} is ${p.injNote}.${p.early ? ' Plays ' + p.game.day + ', so decide before the news settles.' : ''}${backup ? '' : ' No healthy backup on the bench.'}` });
    } else if (p.early) flags.push({ level: 'info', text: `${p.name} plays ${p.game.day}. Lock in early.` });
  }
  return flags;
}

function waiverAdds(t, fa, base, week) {
  const mine = t.players;
  const count = pos => mine.filter(p => p.pos === pos).length;
  const bench = mine.filter(p => !t.optIds.has(p.id)).sort((a, b) => a.adj - b.adj);
  const needDrop = mine.length >= 14;
  const out = [];
  for (const f of fa) {
    const v = f.proj ?? f.avg ?? 0; // this week's CBS projection when synced from the Projections view
    const atPos = mine.filter(p => p.pos === f.pos).sort((a, b) => a.adj - b.adj);
    const worst = atPos[0] || null;
    const gain = r1(v - (worst ? worst.adj : 0));
    let drop = null;
    if (f.pos === 'K' || f.pos === 'DST') drop = worst; // one K and one DST only
    else if (needDrop) drop = bench.find(p => p.pos !== 'K' && p.pos !== 'DST' &&
      !(['QB', 'TE'].includes(p.pos) && count(p.pos) <= 1 && p.pos !== f.pos)) || null;
    if (gain <= 1 || (needDrop && !drop) || (drop && drop.adj >= v)) continue;
    out.push({ ...f, value: v, basis: f.proj != null ? 'proj' : 'avg', gain, vor: r1(v - (base[f.pos] ?? 0)), worst, drop,
               byeNow: week && f.bye === week });
  }
  return out.sort((a, b) => b.gain - a.gain).slice(0, 15);
}

function analyze(lg, teamId, faList, oppOverride) {
  const ctx = makeContext(lg);
  const all = lg.teams.map(t => evalTeam(t, ctx));
  const t = all.find(x => x.id === String(teamId));
  if (!t) return null;
  const base = baselines(all);
  const oppId = oppOverride || lg.matchups[t.id] || null;
  const o = oppId ? all.find(x => x.id === String(oppId)) : null;
  const myTot = t.optimalTotal, oppTot = o ? (o.currentKnown ? o.currentTotal : o.optimalTotal) : null;
  const mv = moves(t);
  return {
    week: lg.week,
    team: { id: t.id, name: t.name, owner: t.owner, legal: t.legal },
    lineup: t.slots, bench: t.players.filter(p => !t.optIds.has(p.id)).sort((a, b) => b.adj - a.adj),
    currentKnown: t.currentKnown, currentTotal: t.currentTotal, optimalTotal: t.optimalTotal,
    moves: mv, closeCalls: closeCalls(t), flags: riskFlags(t),
    baselines: base,
    adds: waiverAdds(t, faList, base, lg.week),
    opponent: o ? {
      id: o.id, name: o.name, owner: o.owner, total: oppTot, usesCurrent: o.currentKnown,
      lineup: o.currentKnown ? o.players.filter(p => p.starter) : o.slots.map(s => s.player).filter(Boolean),
      source: oppOverride ? 'picked' : 'auto',
      underdog: oppTot != null && oppTot - myTot >= 8,
      favorite: oppTot != null && myTot - oppTot >= 8,
    } : null,
    allFa: faList.map(f => ({ ...f, vor: r1((f.proj ?? f.avg ?? 0) - (base[f.pos] ?? 0)) })),
  };
}

function leagueSummary(lg) {
  const ctx = makeContext(lg);
  return lg.teams.map(t => evalTeam(t, ctx)).map(t => ({
    id: t.id, name: t.name, owner: t.owner, legal: t.legal,
    currentTotal: t.currentTotal, optimalTotal: t.optimalTotal,
    gap: t.currentTotal == null ? null : r1(t.optimalTotal - t.currentTotal),
    opponentId: lg.matchups[t.id] || null,
  })).sort((a, b) => b.optimalTotal - a.optimalTotal);
}

function teamRoster(lg, teamId) {
  const ctx = makeContext(lg);
  const t = lg.teams.find(x => x.id === String(teamId));
  if (!t) return null;
  const e = evalTeam(t, ctx);
  return { id: e.id, name: e.name, owner: e.owner, slots: e.slots, players: e.players,
           currentTotal: e.currentTotal, optimalTotal: e.optimalTotal };
}

module.exports = { analyze, leagueSummary, teamRoster, availability, parseOdds };
