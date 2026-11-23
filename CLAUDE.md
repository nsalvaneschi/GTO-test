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
