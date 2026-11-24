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
