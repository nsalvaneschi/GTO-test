# Overnight work log

Rules: no deploys, no external accounts or credentials, no PRs, current branch only. Commit only verified work (all suites green). Stop and log at real design questions.

Queue:
1. Drill every decision node on the river (facing bets, raises) — builder
2. Hand-history import design — architect (design only)
3. Turn-street drills in the browser — builder
4. Hand-history parser + import API per the design — builder
5. Polish: rate-limit test, mobile layout check, i18n review notes

Status entries below, newest last.
- 2026-11-24: handhistory design written by architect (docs/handhistory-design.md). H1..H4 queued; H1 parser starts in parallel with river-drill builder (disjoint dirs).
- 2026-11-24: river drills on all decision nodes committed (server 10/10, vitest 7/7, wasm, browser, e2e all pass). Starting H2 (server) and turn drills in parallel; H1 parser still running.
- 2026-11-24: H1 parser committed (79/79 tests, 16 synthetic fixtures all marked). H3 waits for turn-drill builder (shares web/src/main.ts, worker.ts); H2 server and turn drills still running.
- 2026-11-24: H2 server storage/API committed (server tests 18/18). Waiting on turn-drill builder before starting H3 (web/src/main.ts, worker.ts shared).
- 2026-11-24: turn drills committed (engine opp_mass fix for turn nodes; all suites green: engine 0 fail, server 18/18, vitest 88/88, e2e ok; browser turn solves 1.7-3.4 s). OPEN: final exploitability of the in-browser turn solves was never recorded (300 iter cap) - EV loss on turn drills rests on unmeasured convergence. Starting H3.
- 2026-11-24: H3 committed (vitest 105, server 18, e2e incl. HH e2e green twice; builder saw one unreproduced es timeout in HH e2e). Ranges are hand-written presets, NOT validated vs a real solver; UI says so. Next: turn-convergence measurement (web/engine) + server untested-paths tests in parallel, then H4.
- 2026-11-24: server hardening committed (server 27/27; CSP + trustProxy default off, on via TRUST_PROXY=1 or RAILWAY_ENVIRONMENT). Full e2e passes with CSP active (en/es/it, login, drills, HH tab). KNOWN FLAKE: e2e occasionally times out under CPU load (seen once in es by H3 builder, once by me while another builder was running heavy jobs); passes on rerun, cause not found. Turn-convergence builder still running.
- 2026-11-24: convergence measured and committed. Turn drill (4-card boards, 3x3 presets, N=30): exploitability median 0.023% / p90 0.043% pot after 100 iters (wasm ~5.4 s); drill stops at 0.3% target so real solves end earlier (e2e 1.4-2.9 s). HH river (N=20): p90 0.40% at 100 iters, 0.07% at 300 (~1 s). No cap change. Test: MEASURE=<file> npx vitest run tests/convergence.test.ts (~16 min). Next: H4.
- 2026-11-24: FOUND+FIXED false-pass in web/tests/browser.cjs: a stale 'vite preview' held port 4173, the script waited forever on stdout and Node exited 0 with no output. Now fails with a clear error (verified with a deliberately busy port). My check of the browser test right after the convergence commit was affected by this; re-verified: browser OK (3 languages), e2e + HH e2e OK. Rule going forward: verify test output contains its OK line, not just exit code. Next: H4.
- 2026-11-24: H4 committed (server 27/27, vitest 113, build/wasm ok, browser OK, e2e 3 consecutive full passes with 8 OK lines each). Turn analysis in browser worker ~9 s p50/max 9.2 s (6 solves, small river menu [0.5,1] inside turn tree, raise cap 1); full-menu >20 s or over budget falls back to small menu + approx_only. FLAKE ROOT CAUSE FOUND+FIXED: e2e.cjs clicked #cancel via Playwright click on a ~0.2 s river solve; button is replaced when the solve finishes -> timeout (not load related). Now clicked in-page immediately. Remaining: polish (mobile layout, page title, i18n review notes). Untested: real hand histories, 3-bet pots on turn, cancel during turn solve, budget-exceeded fallback.
- 2026-11-24: polish committed (server 27/27, vitest 113, build/wasm ok, browser OK, e2e chain incl. mobile all OK, verified by me with real output lines). I viewed 2 mobile screenshots (Galaxy S5 drill result, progress played hands): fine.

## Summary (end of unattended queue)
Done and verified: river + turn drills (all decision nodes), accounts/progress backend (hardened, CSP, trustProxy), hand-history import H1-H4 (parser, storage, river+turn analysis, replay, filters, Played hands tab, delete controls), solver ~2.7x faster, mobile layout, titles, i18n review generator.

NEEDS YOU (I did not and will not do these without you):
1. Railway deploy: root Dockerfile (multi-stage, builds WASM + web) has NEVER been built (no Docker daemon here). Create a volume, set env vars per server/README.md. Send me the build log if it fails. TRUST_PROXY is automatic on Railway (RAILWAY_ENVIRONMENT); keep 1 replica (SQLite + in-memory rate limits).
2. Native-speaker review of es/it terms: docs/i18n-review.md (npm run i18n:review regenerates).
3. Trust decisions: preflop prior is tuned to ballpark figures, not validated; hand-history range presets are hand-written, not validated. UI labels them approximate; do not market as exact GTO until validated against a real solver.

Known gaps / ideas: realisation fit (P2) infeasible at design compute budget (flop solves too slow/large); only HU; flop only via precomputed library (not in UI yet); preflop drills not built; real hand histories never tested (only invented); 3-bet pots on turn untested; cancel during turn solve untested; tests are Playwright e2e that can be slow (~minutes).
