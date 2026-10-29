(async function () {
  var APP = '__APP__';
  if (!/(^|\.)cbssports\.com$/.test(location.hostname)) { alert('Open your Sure Shot League site on CBS first, then tap SSL Assistant.'); return; }
  var bridge = window.open(APP + '/?bridge=1', 'sslbridge', 'width=460,height=700');
  if (!bridge) { alert('Pop-ups are blocked. Allow pop-ups for this CBS site, then tap SSL Assistant again.'); return; }

  var old = document.getElementById('ssl-asst'); if (old) old.remove();
  var box = document.createElement('div');
  box.id = 'ssl-asst';
  box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:340px;max-width:calc(100vw - 32px);max-height:70vh;overflow:auto;background:#121b2e;color:#e8eefc;border:1px solid #25324f;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.45);font:14px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;text-align:left';
  box.innerHTML = '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:linear-gradient(90deg,#0f2a63,#123a8c);border-radius:12px 12px 0 0"><b>SSL Assistant</b><button id="ssl-x" style="background:none;border:0;color:#e8eefc;font-size:16px;cursor:pointer">\u2715</button></div><div id="ssl-body" style="padding:12px"></div>';
  document.body.appendChild(box);
  document.getElementById('ssl-x').onclick = function () { box.remove(); };
  function say(h) { document.getElementById('ssl-body').innerHTML = h; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function num(s) { if (s == null) return null; var x = parseFloat(String(s).replace(/[%,]/g, '')); return isNaN(x) ? null : x; }
  say('Reading league data\u2026');

  function blob(h) {
    var k = h.indexOf('bootstrapLiveScoringData'); if (k < 0) return null;
    var s = h.indexOf('{', k), d = 0, e = -1;
    for (var i = s; i < h.length; i++) {
      var c = h[i];
      if (c === '"') { i++; while (i < h.length && h[i] !== '"') { if (h[i] === '\\') i++; i++; } continue; }
      if (c === '{') d++; else if (c === '}') { d--; if (d === 0) { e = i + 1; break; } }
    }
    if (e < 0) return null;
    try { return JSON.parse(h.slice(s, e)); } catch (x) { return null; }
  }

  function parseFA(doc) {
    var out = [], seen = {};
    [].forEach.call(doc.querySelectorAll('table'), function (tb) {
      var hdr = null;
      [].forEach.call(tb.querySelectorAll('tr'), function (tr) {
        var cells = [].map.call(tr.children, function (c) { return c.textContent.replace(/\s+/g, ' ').trim(); });
        var a = tr.querySelector('a[href*="playerpage"]');
        if (!a) { if (cells.some(function (c) { return /^(fpts|fppg|avg|% ?rost|rost)/i.test(c); })) hdr = cells; return; }
        var id = (a.getAttribute('href').match(/playerpage\/(\d+)/) || [])[1];
        if (!id || seen[id]) return; seen[id] = 1;
        var td = a.closest('td'), txt = td ? td.textContent.replace(/\s+/g, ' ') : '';
        var pm = txt.match(/\b(QB|RB|WR|TE|K|DST|D\/ST|DEF)\b\s*[\u2022\u00b7|,-]?\s*([A-Z]{2,3})\b/);
        function col(re) { if (!hdr) return null; for (var j = 0; j < hdr.length; j++) if (re.test(hdr[j])) return cells[j]; return null; }
        var fpts = num(col(/^fpts$/i)), avgc = col(/^(fppg|avg)/i);
        var isProj = avgc == null && hdr && hdr.some(function (h) { return /^opp$/i.test(h); });
        out.push({ id: id, name: a.textContent.replace(/\s+/g, ' ').trim(),
          pos: pm ? pm[1].replace('D/ST', 'DST').replace('DEF', 'DST') : null, team: pm ? pm[2] : null,
          rost: num(col(/rost/i)), avg: num(avgc), pts: isProj ? null : fpts, proj: isProj ? fpts : null,
          opp: col(/^opp$/i), avail: col(/^avail$/i), bye: num(col(/^bye$/i)) });
      });
    });
    return out;
  }
  function posInUrl(u) { var m = u.match(/[\/:](QB|RB|WR|TE|K|DST)(?=[\/?&#:]|$)/); return m ? m[1] : null; }

  var ready = false, data = null, sent = false;
  function trySend() {
    if (ready && data && !sent) { sent = true; bridge.postMessage(data, APP); say('Sending to the app\u2026 Log in there with your team PIN if it asks.'); }
  }
  window.addEventListener('message', function (e) {
    if (e.origin !== APP) return;
    var d = e.data || {};
    if (d.type === 'ssl-ready') { ready = true; trySend(); }
    if (d.type === 'ssl-result') show(d);
  });

  var live = null, week = null, fa = {}, notes = [];
  var wm = location.pathname.match(/\/scoring\/live\/(\d+)/); if (wm) week = +wm[1];
  try { if (window.bootstrapLiveScoringData) live = JSON.parse(JSON.stringify(window.bootstrapLiveScoringData)); } catch (x) {}
  if (!live) {
    try {
      var r = await fetch('/scoring/live/' + (week ? week + '/1/' : ''), { credentials: 'include' });
      live = blob(await r.text());
      if (!week) { var mm = (r.url || '').match(/\/scoring\/live\/(\d+)/); if (mm) week = +mm[1]; }
      notes.push('Odds and matchup ranks only come through when you run this on the Live Scoring page itself.');
    } catch (x) {}
  }
  var here = parseFA(document), cur = posInUrl(location.href);
  if (here.length) {
    say('Reading free agents\u2026');
    if (cur) {
      fa[cur] = here;
      var POS = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];
      for (var i = 0; i < POS.length; i++) {
        var p = POS[i]; if (p === cur) continue;
        try {
          var u = location.href.replace(new RegExp('([/:])' + cur + '(?=[/?&#:]|$)'), '$1' + p);
          var t = await (await fetch(u, { credentials: 'include' })).text();
          var lst = parseFA(new DOMParser().parseFromString(t, 'text/html'));
          if (lst.length) fa[p] = lst;
        } catch (x) {}
      }
    } else {
      here.forEach(function (pl) { var k = pl.pos || 'ALL'; (fa[k] = fa[k] || []).push(pl); });
    }
  }
  data = { type: 'ssl-sync', week: week, live: live, fa: fa, host: location.hostname };
  trySend();
  setTimeout(function () { if (!ready) say('Waiting for the app window to open. On a free server it can take up to a minute to wake up.'); }, 4000);

  function mark(ids, color, label) {
    ids.forEach(function (id) {
      [].forEach.call(document.querySelectorAll('a[href*="playerpage/' + id + '"]'), function (a) {
        var row = a.closest('tr') || a.parentElement;
        if (!row || row.getAttribute('data-ssl')) return;
        row.setAttribute('data-ssl', '1');
        row.style.outline = '2px solid ' + color; row.style.outlineOffset = '-2px';
        var tag = document.createElement('span');
        tag.textContent = label;
        tag.style.cssText = 'background:' + color + ';color:#fff;font:700 10px system-ui;padding:1px 5px;border-radius:4px;margin-left:6px';
        a.after(tag);
      });
    });
  }

  function show(d) {
    if (!d.ok) { say('<div style="color:#fca5a5">' + esc(d.error || 'Sync failed.') + '</div>'); return; }
    var h = '<div style="color:#86efac;font-weight:600">Synced' + (d.week ? ' week ' + d.week : '') + '</div>';
    if (d.faPositions && d.faPositions.length) h += '<div style="color:#8fa0c2;font-size:12px">Free agents: ' + esc(d.faPositions.join(', ')) + '</div>';
    notes.forEach(function (n) { h += '<div style="color:#8fa0c2;font-size:12px;margin-top:4px">' + esc(n) + '</div>'; });
    var pl = d.plan;
    if (pl) {
      h += '<div style="margin-top:10px;font-weight:600">' + esc(pl.team.name) + '</div>';
      if (!pl.known) h += '<div style="color:#8fa0c2;font-size:12px">Couldn\u2019t read your current lineup. Open the app for the full optimal lineup.</div>';
      else if (!pl.moves.length) h += '<div>Your lineup is already optimal.</div>';
      else {
        h += '<div style="color:#8fa0c2;font-size:12px;margin:2px 0 6px">Make these on CBS, then press CBS\u2019s own Submit:</div>';
        pl.moves.forEach(function (m) { h += '<div style="padding:6px 0;border-top:1px solid #25324f">Start <b>' + esc(m.start.name) + '</b>' + (m.bench ? ' over ' + esc(m.bench.name) : '') + ' <span style="color:#86efac">+' + m.delta + '</span></div>'; });
        mark(pl.startIds, '#16a34a', 'START');
        mark(pl.benchIds, '#dc2626', 'BENCH');
      }
      if (pl.adds && pl.adds.length) {
        h += '<div style="margin-top:10px;font-weight:600">Top adds</div>';
        pl.adds.forEach(function (a) { h += '<div style="font-size:13px">' + esc(a.name) + ' (' + a.pos + ', +' + a.gain + ')' + (a.drop ? ' for ' + esc(a.drop) : '') + '</div>'; });
      }
    }
    h += '<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap"><a href="' + APP + '" target="_blank" style="background:#2f7bff;color:#fff;padding:6px 12px;border-radius:8px;text-decoration:none">Open the app</a><button id="ssl-save" style="background:#18233b;color:#e8eefc;border:1px solid #25324f;padding:6px 12px;border-radius:8px;cursor:pointer">Save page for setup</button></div>';
    say(h);
    document.getElementById('ssl-save').onclick = function () {
      var b = new Blob(['<!-- ' + location.href + ' -->\n' + document.documentElement.outerHTML], { type: 'text/html' });
      var a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'cbs-page-' + location.pathname.replace(/\W+/g, '-').replace(/^-|-$/g, '') + '.html';
      document.body.appendChild(a); a.click(); a.remove();
    };
  }
})();
