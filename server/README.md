# GTO server

Node 22, no dependencies (`node:http`, `node:sqlite`, `node:crypto`). Serves `web/dist` (SPA fallback) and the JSON API.

Run: `node server/src/index.js` (env: `PORT`, `DB_PATH` | `RAILWAY_VOLUME_MOUNT_PATH`/app.db | ./data/app.db, `WEB_DIST`). Test: `cd server && npm test`.

API: `POST /api/register|login|logout`, `GET /api/me`, `POST /api/drills/results`, `GET /api/progress`, `GET /api/health`.
Hand history (all need auth, strictly per-user; other users' ids give 404; design in `docs/handhistory-design.md`):
`POST /api/hh` `{hands:[normalized Hand], keepRaw?:bool}` -> `{added,duplicates}` (dedupe on user+site+hand_id; `raw_text` kept only if `keepRaw:true`; names are stored as hashes only; 413 over 2 MB body / 500 hands / 64 KB per hand / 20k hands per user, 429 rate limit, 400 malformed),
`GET /api/hh?limit&offset&from&to&site&status&street&minEvLoss`, `GET /api/hh/:id`, `DELETE /api/hh` (hands + decisions),
`POST /api/hh/decisions` `{decisions:[{handRow,street,nodePath,actionIdx,status,reason?,solverFreqs?,evLoss?,rangePreset,engineVer}]}` (replaces rows for the same hand/street/nodePath), `GET /api/hh/decisions?status&street&minEvLoss&handRow&limit&offset`,
`DELETE /api/me/data` (hands, decisions and drill results; account kept), `GET /api/progress?source=hh` (status `ok` decisions only, plus `byStatus`; never mixed with drill totals; the default response is unchanged).
Errors are `{error: code}` only (no display text).

Definitions: a drill answer is correct if solver freq of the chosen action >= 0.1 (mixed-aware); `meanChosenFreq` is also returned.
Streak = consecutive UTC days with >= 1 answer ending today (or yesterday). Spot type = part of `spotId` before the first `:`.

## Deploy on Railway (manual)
1. Nothing to build locally: the root Dockerfile builds the WASM solver and web app itself (multi-stage), so deploy straight from the repo.
2. Railway dashboard: New Project > Deploy from GitHub repo (or `railway up` after `railway login` on your own machine). `railway.json` selects the root Dockerfile.
3. Service > Volumes > Add Volume, mount path `/data`. Railway then sets `RAILWAY_VOLUME_MOUNT_PATH=/data` and the DB is `/data/app.db`. (Or set `DB_PATH` explicitly.)
4. Variables: nothing secret is required. `PORT` is injected by Railway. Optional: `WEB_DIST`, `DB_PATH`, `TRUST_PROXY` (`1`/`0`). Static responses carry a CSP (`script-src 'self' 'wasm-unsafe-eval'`, `worker-src 'self'`, inline styles allowed), nosniff, X-Frame-Options DENY.
5. Settings > Networking > Generate Domain (HTTPS; Railway terminates TLS; the server trusts `x-forwarded-proto`/`x-forwarded-for` only when `TRUST_PROXY=1`, which is the default when `RAILWAY_ENVIRONMENT` is set, else off, so the cookie is `Secure` and the rate limiter sees the real client IP). Healthcheck: `/api/health`.
Use a single replica (SQLite + in-memory rate limiter).

## Static delivery
Text-like files (html, js, css, json, svg, wasm, txt, map; >= 1 KB) are served brotli (q5) or gzip per `Accept-Encoding`, compressed once per file version (path+mtime+size) and cached in memory; `Vary: Accept-Encoding`, exact `Content-Length`, HEAD parity. `/assets/*` (Vite content-hashed): `public, max-age=31536000, immutable`. Everything else (index.html, SPA fallback): `no-cache` with ETag (per encoding) and Last-Modified; `If-None-Match`/`If-Modified-Since` give 304 (CSP etc. kept). `Range` is ignored (full 200, `Accept-Ranges: none`). API responses: `no-store`.
