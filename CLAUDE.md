# GTO Solver App (GTO Wizard-style)

Goal: web app for poker strategy study: range viewer, preflop/postflop solutions, drills, hand analysis.
Solver: own CFR-based engine (CFR+ / DCFR, card abstraction + bucketing, Rust or TS->WASM later).

## Token rules (all agents)
- Read only files you need; use Grep/Glob before Read; read line ranges, not whole files.
- No re-reading files you just edited. No restating the task. Replies: result + file paths, <=10 lines.
- Prefer small, focused diffs. No speculative features, no extra docs.
- Keep this file short. Put detail in `docs/` and link it; read docs only when relevant.
- Delegate only when a task is large or isolated; otherwise work inline (subagents start cold = costly).

## Model routing
- haiku  -> `scout`: search, summaries, formatting, boilerplate, renames.
- sonnet -> default + `builder`: features, UI, tests, routine bugs.
- opus   -> `architect`: solver algorithm design, abstraction/perf decisions, hard bugs after 2 failed Sonnet attempts. Never for routine work.
Escalate only on failure or genuine design ambiguity; de-escalate once the design is written down.

## Layout (planned)
- `engine/`  solver core (game tree, CFR, equity, abstractions) + tests
- `web/`     frontend (range grid, strategy viewer, drills)
- `docs/`    design notes written by `architect`

## Localisation (requirement)
- App languages: English (default), Spanish (es), Italian (it).
- Engine/CLI/WASM stay language-neutral: return codes, numbers and card/action ids only, never display text.
- All UI strings live in `web/src/i18n/{en,es,it}.json` (same keys in all three); no hardcoded text in components.
- Use ICU-style plurals and locale number formatting (`Intl`). Keep poker terms in a shared glossary (`docs/glossary.md`) so es/it terminology stays consistent (e.g. fold/call/raise, pot, range, equity).
- Add a test that fails if any key is missing from a locale.

## Accounts and progress (requirement)
- Login: username + password. Passwords hashed (scrypt/argon2), never logged; httpOnly SameSite session cookie; rate-limit login.
- Backend: small Node server in `server/` serving `web/dist` + JSON API, SQLite on a persistent volume (path from env, e.g. `RAILWAY_VOLUME_MOUNT_PATH`); deploy target Railway. Never put secrets/tokens in the repo; deploy config via env vars.
- Progress tracked per user: drill results (spot, user action, solver frequencies, EV loss, time) first; hand-history analysis later (needs `architect` design).
- All new UI text goes through the en/es/it i18n rules above.

## Preflop 3-handed trainer (requirement)
- Product goal: preflop-only trainer, 3-handed BTN/SB/BB, stacks 20/18/16 BB (+ random mix), random spots, action chosen BEFORE the solution, scored against mixed GTO frequencies; permanent bottom counter (correct, incorrect, total, accuracy %). Design: `docs/preflop3-design.md`.
- DATA RULE: never invent ranges and never label a strategy GTO unless it comes from an external solver pack (`external-verified`). Self-computed packs must show a visible 'unverified' badge. Test fixtures (`test-fixture`) must never ship in production builds.
- Licensed third-party solutions stay in git-ignored `private-data/reference/` or are imported in the browser only.
