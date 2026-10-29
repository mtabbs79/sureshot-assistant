# Sure Shot Assistant

Lineup and waiver research for every Sure Shot League owner. Each owner logs in with a team PIN.
League data comes from CBS through a bookmarklet that runs in the owner's own logged-in CBS tab.
The app never stores CBS passwords and never submits anything on CBS: owners press CBS's own
Submit / Add / Drop buttons.

## Deploy (Render, same as the draft app)
1. Create a GitHub repo (e.g. `mtabbs79/sureshot-assistant`) and upload everything in this folder.
2. Copy `public/ssl-logo.jpg` from the `sureshot-draft` repo into `public/`.
   Optional: copy `data/players.json` from the draft repo into `data/`. It is the free-agent list
   until someone syncs a CBS Free Agents page (players now on rosters are filtered out).
3. Render: New > Blueprint > pick the repo. When asked:
   - ADMIN_PASSWORD: the commissioner password.
   - DATABASE_URL: the Internal Database URL of the existing `sureshot-draft-db`
     (Render dashboard > the database > Connections). This app uses its own table (`assistant_kv`)
     and doesn't touch the draft picks. Render allows one free Postgres per workspace.

## First run
1. Open the app > Commissioner > unlock with the password.
2. Connect CBS tab > drag "SSL Assistant" to the bookmarks bar.
3. On CBS, open the league's Live Scoring page and click the bookmark. In the window that opens,
   choose "I'm the commissioner". All ten teams load.
4. Commissioner tab > set a PIN for each team. Send each owner the app link and their PIN.
5. For waivers: CBS Players > Free Agents > Projections tab. Run the bookmark on All Offense, then K, then DST.

## AI write-ups (optional)
1. Sign in at https://platform.claude.com, add prepaid credits under Billing, and create an API key.
   Set a spend limit there too.
2. Render > sureshot-assistant > Environment: add ANTHROPIC_API_KEY. Optional settings:
   AI_MODEL (default claude-sonnet-5-5; claude-haiku-5-5 is much cheaper), AI_DAILY_LIMIT (new
   write-ups per team per day, default 3), AI_MONTHLY_CAP_USD (app stops calling the API past this, default 10).
Write-ups are saved and reused until the CBS data changes, so reopening one costs nothing.

## How it decides
Same method as the weekly review: CBS projections (already in league scoring) adjusted only for
injury designations (soft tissue x0.80, knee x0.85, other x0.90, head x0.55, doubtful x0.25, out/IR 0),
byes, and a small DST nudge from the opponent's implied total. Optimal lineup: QB, RB, WR, TE,
2 FLEX, K, DST. Waiver adds are ranked by gain over your worst player at that position and always
paired with a drop; K and DST swap one for one.

## Local
`node server.js` with no database (saves to data/store.json). Default commissioner password: commish.
