# Hand-History Import and Analysis (v1)

## Decision
Import PokerStars and GGPoker NLHE cash text hands. Store each hand as one normalized row per user. Analyse only **heads-up postflop decisions on the river, then the turn**, client-side in WASM, using **explicitly labelled approximate ranges**. Anything else gets a reason code instead of a result. Rationale: these are the only spots our solver models and solves in the browser. A confident wrong number is worse than "not analysed".

## 1. Formats (v1)
- PokerStars (`PokerStars Hand #<id>:`) and GGPoker (`Poker Hand #<id>:` or `#HD<id>`, `GGPoker` header). Detect by the first non-blank line regex. Split files on blank-line + header. Hands that don't match are counted `unsupported_format` and skipped.
- NLHE only. Tournaments, PLO, other sites and other languages are rejected with a code. GG often hides villain cards and rounds amounts; the parser must accept that (villain cards are optional).
- `web/src/hh/parse.ts` is pure TS with no I/O. It returns the `Hand` below plus `warnings[]` codes.
- **Tests use only synthetic hands we write ourselves** (`web/src/hh/fixtures/*.txt`, fake names `Hero`/`V1`). Never commit real hand histories. CI greps the fixtures for a `SYNTHETIC` header line.

## 2. Schema, storage, privacy
`Hand { site, hand_id, played_at, stakes:{sb,bb}, seats:[{seat,name_hash,stack,is_hero}], hero_cards, board[], actions:[{street,seat,kind:fold|check|call|bet|raise|allin,amount_to}], pot_by_street[] }`. Villain names are SHA-256 hashed client-side with a per-user salt. We never store or display opponents' plaintext names.

SQLite (migration replaces the `hand_histories` stub, which has no data yet):
- `hh_hands(id PK, user_id FK CASCADE, site, hand_id, played_at, imported_at, players INT, hero_pos, norm_json TEXT, raw_text TEXT NULL, UNIQUE(user_id, site, hand_id))`. Dedupe on the unique key with `INSERT OR IGNORE`, and the response reports `{added, duplicates}`.
- `hh_decisions(id PK, hand_row FK CASCADE, user_id, street, node_path TEXT, action_idx, status TEXT, reason TEXT NULL, solver_freqs TEXT NULL, ev_loss REAL NULL, range_preset TEXT, engine_ver TEXT, created_at)`. `status` is `ok` | `off_tree` | `unsupported` | `approx_only`.
- Limits: 2 MB per upload, at most 500 hands per request, 20k hands per user, 64 KB per raw hand. Uploads are rate-limited per user.
- Raw text: by default we **do not keep it** (only `norm_json`). A user opt-in "keep original text" fills `raw_text`.
- Privacy: every query is scoped by the session `user_id`; there are no sharing or public endpoints. `DELETE /api/hh` wipes the user's hands and decisions. `DELETE /api/me/data` wipes hands, decisions and drill results. Log counts only, never hand content.

## 3. What v1 analyses honestly
- **In scope:** at most two players see the decision street (preflop folds to two are fine), and hero is one of them. River decisions first (H3), turn decisions second (H4, turn+river solve). Stacks and pot come from the hand, in bb.
- **Out of scope, with reason codes:**
  - `multiway`: the engine is heads-up only (multiway is "later" in solver-design).
  - `preflop`: the HU preflop prior is not validated against a real solver, and 6-max preflop isn't modelled.
  - `flop`: only the precomputed library exists, and it rarely matches actual stacks, sizes and ranges.
  - Also: `allin_preflop`, `no_hero_decision`.
- **Bet mapping:** the tree's `sizes` are per street and configurable, so we add the observed bet/raise pot fractions on the analysed street to the standard menu (merging sizes within 5% pot). Off-tree cases are flagged `off_tree` with no EV: a later raise that the cap or all-in threshold can't represent, or an amount more than 10% pot from every menu size. We never snap silently.
- **Ranges (we have no real ones):** start from a hand-written preset table in `web/src/hh/ranges.ts`, keyed by (hero pos, villain pos, pot type SRP/3BP), based on typical opening and defending charts. Narrow it to the analysed street with a documented heuristic: keep the top X% by equity on the current board plus a fixed bluff share, with X set by line (bet, call, check). The user can override the preset or width per hand. Every result stores `range_preset` and is shown as **approximate**.

## 4. Pipeline (client-side, no server compute)
1. Paste or upload, then `parse.ts` in a Web Worker. Show a summary (formats, rejected-by-code counts), then `POST /api/hh` with normalized hands (and raw text if opted in).
2. Classify each hero decision (scope rules above) to get a status and reason.
3. For `ok` candidates, build a `JsonConfig` (board, approximate ranges with hero/board card removal, street pot/stack/sizes) and solve in the WASM worker. Cache solves by config hash so hands on the same board/line reuse the result.
4. Walk `node_path` to hero's node. EV loss uses **the same `evLossPct` as drills** (best `action_ev`/`opp_mass` minus chosen, % pot). `solver_freqs` = hero combo's strategy.
5. Send decision rows with `POST /api/hh/decisions`. Re-analysis replaces rows when `engine_ver` or `range_preset` changes.
- Progress: `GET /api/progress?source=hh` aggregates `hh_decisions` (status `ok` only) separately from `drill_results`. The progress page gets a "Played hands" tab. Drill and hand stats are never summed, because they come from different spot distributions and HH uses approximate ranges.

## 5. UX and i18n
- Pages: Import (paste or file, summary), Hands list (filters: status, street, EV loss >= x, date), and Hand replay. Replay steps through the actions; at analysed nodes it shows the hero action, solver frequencies, EV loss and the assumed ranges (editable, which triggers a re-solve).
- Reason codes, statuses and warnings map to i18n keys `hh.reason.<code>`, `hh.status.<s>` and `hh.warn.<code>` in en/es/it. Counts use ICU plurals; numbers use `Intl`. Engine and parser emit codes only. New poker terms go in `docs/glossary.md`.
- Disclaimer: a persistent banner `hh.disclaimer`, plus a badge on every result (`hh.badge.approx`). A tooltip lists the assumptions: preset name, width, bet-mapping deltas, and that it is a heads-up abstraction. Results are never labelled "GTO-exact".

## 6. Milestones (each Sonnet-sized)
- **H1 Parser:** `parse.ts` plus 12 or more synthetic fixtures (both sites, multiway, all-in, hidden cards, malformed input, tournament reject). Gate: golden JSON tests, the SYNTHETIC grep check, 100% of fixtures classified.
- **H2 Storage/API:** migration, `POST/GET/DELETE /api/hh`, `/api/hh/decisions`, limits, dedupe, user scoping. Gate: server tests for duplicate import, cross-user access (404), size limit (413), delete-my-data cascade.
- **H3 River analysis:** classifier, range presets and heuristic, size mapping, WASM worker, decision rows. Gate: synthetic river hands where hero's bluff with a blocker-free nut-low vs a polar range gives the expected sign of EV loss; `off_tree` and `multiway` fixtures produce no EV; i18n key-parity test passes.
- **H4 Turn plus UI:** turn+river solves (river decisions inside a turn hand reuse that solve), replay page, list filters, progress "Played hands" tab. Gate: Playwright import-to-replay flow on fixtures, turn solve under 10 s on the CI bench fixture, progress shows separate HH and drill totals.

## 7. iPoker adapter (Hold'em Manager 3 text export)
Site id `ipoker`, implemented in `web/src/hh/ipoker.ts` and dispatched from `parse.ts` by the first line `GAME #<id> Version:<v> [Uncalled:<Y|N>] Texas Hold'em NL <cur><sb>/<cur><bb> <date> <time>/<tz>`. Same normalized `Hand`, same reason codes (no new ones).
- Layout: `Table Size <n>`, `Table <name>, <id>`, `Seat <n>: <name> (<cur><stack> in chips)` with a `DEALER` suffix on the button seat (seat numbers may reach 10 on any table size), blinds as `<name>: Post SB|BB <amt>`, then `*** HOLE CARDS ***`, `*** FLOP|TURN|RIVER *** [..]` (turn and river list only the new card), `*** SUMMARY ***`.
- Actions: `Fold`, `Check`, `Call <chips added>`, `Bet <street total>`, `Raise (NF) <street total>`, `Allin <chips added>`. Totals are mapped to `amount_to` (bb); an `Allin` above the current level is kind `allin`, otherwise an all-in `call`.
- Cards are suit letter plus rank (`S`,`H`,`D`,`C`; ten is `10`), normalized to `Ts` style. Hero comes from `Dealt to <name> [..]`; hands without it parse with `no_hero`. `Shows [..]` and `Mucks [..]` may appear after the actions or after the pot line; only `Shows` counts as showdown.
- Uncalled bets are not printed. The summary pot excludes them, so the parser returns the top contributor's excess over the second highest live contribution and then requires `sum(wins) + rake == contributions` (else `pot_mismatch`).
- A late joiner can post `Post BB` for BB plus the missed SB; only the BB part is live (street level), the rest is dead money that is never returned (blind kind `sb+bb`).
- Strictness: calls must not exceed what is owed (shorter only when all-in), bets and raises must exceed the current level, unknown action or marker lines reject the hand with a reason code. Files may use CRLF.
- `npm run hh:check` prints aggregates only for any private directory of exports.
