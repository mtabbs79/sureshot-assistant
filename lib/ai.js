// AI weekly write-ups. The rules engine makes the calls; Claude explains them in plain English,
// the way the weekly review does. Uses the commissioner's Anthropic API key (ANTHROPIC_API_KEY).
const MODEL = process.env.AI_MODEL || 'claude-sonnet-5-5';
// $ per million tokens, used only for the commissioner's running cost estimate.
const PRICES = { 'claude-sonnet-5-5': [2, 10], 'claude-haiku-5-5': [0.1, 0.5], 'claude-opus-5-5': [4, 20] };

const SYSTEM = `You write the weekly fantasy football review for one owner in the Sure Shot League, a 10-team full-PPR CBS league.

League scoring that matters:
- Tight ends get 1 pt per 8 receiving yards (others 1 per 10), so a 100-yard TE scores 12.5.
- Defenses score points-allowed (0-6 = 12 down to 28+ = 0) PLUS yards-allowed (0-99 = 18 down to 400+ = 0). Elite defenses can clear 25; a bend-don't-break defense loses the yards bucket.
- Passing TD 6. Lineup: QB, RB, WR, TE, 2 FLEX (RB/WR/TE), K, DST. 14-man roster, one K and one DST.
- CBS projections are already scored to these rules. Never re-score them or say CBS uses default scoring.

You are given the rules engine's output as JSON: CBS projection ("proj") and adjusted projection ("adj") for every player, the adjustments applied ("why"), the optimal lineup, recommended swaps, close calls, risk flags, waiver adds with paired drops, and the opponent.

Write the review:
1. **Lineup moves**: each swap with its point gain and a one-line reason. If none, say the lineup is already optimal in one sentence.
2. **Coin flips**: slots within ~2 points, named as toss-ups, with what would break the tie. If the owner is a clear underdog, lean to higher-ceiling players; if a clear favorite, floors are fine.
3. **Risk flags**: questionable starters, Thursday games, thin backups.
4. **Waiver moves**: up to 3 adds, each with its drop. Say whether the free agent's number is this week's projection or a season average.
5. **The matchup**: one or two sentences.
Mention the league-scoring reason whenever it drives a call (TE yardage bonus, the defense yards bucket).

Rules: use only the numbers and facts in the JSON; don't invent injuries, news, or stats. Don't claim any move was made; the owner makes every change on CBS himself. Address the owner as "you". Plain, direct, no hype, under 350 words. Format: a **bold** label for each section, then short "- " bullets.`;

function compact(a) {
  const P = p => p && { name: p.name, pos: p.pos, team: p.pro, proj: p.proj, adj: p.adj, why: p.why && p.why.length ? p.why : undefined,
    injury: p.injNote || undefined, game: p.game ? `${p.game.home ? 'vs' : '@'} ${p.game.opp} ${p.game.day}` : undefined,
    oppRankVsPos: p.oprk || undefined, setAsStarter: p.starter };
  return {
    team: a.team.name, week: a.week,
    optimalTotal: a.optimalTotal, currentTotal: a.currentKnown ? a.currentTotal : 'unknown',
    optimalLineup: a.lineup.map(s => ({ slot: s.slot, ...(P(s.player) || { empty: true }) })),
    bench: a.bench.map(P),
    swaps: a.moves ? a.moves.map(m => ({ start: m.start.name, bench: m.bench && m.bench.name, gain: m.delta, reason: m.reason })) : 'current lineup unknown',
    closeCalls: a.closeCalls.map(c => ({ slot: c.slot, starter: c.starter.name, alternative: c.alt.name, gap: c.diff })),
    riskFlags: a.flags.map(f => f.text),
    waiverAdds: a.adds.slice(0, 5).map(x => ({ add: x.name, pos: x.pos, team: x.team, value: x.value,
      valueIs: x.basis === 'proj' ? 'this week CBS projection' : 'season points per game',
      gainOverWorstAtPosition: x.gain, rostPct: x.rost, drop: x.drop ? `${x.drop.name} (${x.drop.pos}, adj ${x.drop.adj})` : 'open roster spot', byeThisWeek: x.byeNow || undefined })),
    opponent: a.opponent ? { name: a.opponent.name, projected: a.opponent.total, youAreUnderdog: a.opponent.underdog, youAreFavorite: a.opponent.favorite } : 'unknown',
  };
}

async function writeUp(analysis) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('AI write-ups are off. The commissioner needs to add an API key.');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 1200, system: SYSTEM,
      messages: [{ role: 'user', content: 'Rules engine output for this week:\n' + JSON.stringify(compact(analysis)) }],
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (j.error && j.error.message) || r.statusText;
    if (r.status === 401) throw new Error('The API key was rejected. The commissioner should check ANTHROPIC_API_KEY.');
    if (/credit|billing|balance/i.test(msg)) throw new Error('The AI account is out of credit. The commissioner needs to top it up.');
    throw new Error('AI service error: ' + msg);
  }
  const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  const u = j.usage || {};
  const [pi, po] = PRICES[MODEL] || PRICES['claude-sonnet-5-5'];
  const cost = ((u.input_tokens || 0) * pi + (u.output_tokens || 0) * po) / 1e6;
  return { text, model: MODEL, inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0, cost };
}

module.exports = { writeUp, enabled: () => !!process.env.ANTHROPIC_API_KEY, MODEL };
