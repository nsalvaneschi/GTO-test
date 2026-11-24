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
