# GTO server

Node 22, no dependencies (`node:http`, `node:sqlite`, `node:crypto`). Serves `web/dist` (SPA fallback) and the JSON API.

Run: `node server/src/index.js` (env: `PORT`, `DB_PATH` | `RAILWAY_VOLUME_MOUNT_PATH`/app.db | ./data/app.db, `WEB_DIST`). Test: `cd server && npm test`.

API: `POST /api/register|login|logout`, `GET /api/me`, `POST /api/drills/results`, `GET /api/progress`, `GET /api/health`.
Errors are `{error: code}` only (no display text).

Definitions: a drill answer is correct if solver freq of the chosen action >= 0.1 (mixed-aware); `meanChosenFreq` is also returned.
Streak = consecutive UTC days with >= 1 answer ending today (or yesterday). Spot type = part of `spotId` before the first `:`.

## Deploy on Railway (manual)
1. Nothing to build locally: the root Dockerfile builds the WASM solver and web app itself (multi-stage), so deploy straight from the repo.
2. Railway dashboard: New Project > Deploy from GitHub repo (or `railway up` after `railway login` on your own machine). `railway.json` selects the root Dockerfile.
3. Service > Volumes > Add Volume, mount path `/data`. Railway then sets `RAILWAY_VOLUME_MOUNT_PATH=/data` and the DB is `/data/app.db`. (Or set `DB_PATH` explicitly.)
4. Variables: nothing secret is required. `PORT` is injected by Railway. Optional: `WEB_DIST`, `DB_PATH`.
5. Settings > Networking > Generate Domain (HTTPS; the server sees `x-forwarded-proto` and sets the cookie `Secure`). Healthcheck: `/api/health`.
Use a single replica (SQLite + in-memory rate limiter).
