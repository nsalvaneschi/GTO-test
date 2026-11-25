# Preflop 3-handed trainer (BTN/SB/BB, 16-20 bb)

**Hard rule.** No range is ever invented. Every strategy shown comes from a *solution pack* with a `verification` status. Only `external-verified` packs may be called "GTO" in the UI. `self-computed-unverified` packs always show a badge and a disclaimer. `test-fixture` packs are rejected by production builds. Related docs: `preflop-design.md` (HU realisation model, still unvalidated), `glossary.md`.

## 1. Solution pack format (`preflop3-pack`, schemaVersion 1, one file per stack depth)
- `meta`: `{schemaVersion, packId, verification: 'external-verified'|'self-computed-unverified'|'test-fixture', source:{kind:'external'|'self', solver, version}, settings (free-form object), players:3, stacksBb:{BTN,SB,BB}, blinds:{sb:0.5,bb:1}, anteBb, rake:{pct,capBb}|null, payoff:'chipEV'|'ICM', icmPayouts:number[]|null, betMenu, convergence:{metric:'max-player-br-gain-mbb'|'exploitability-mbb'|'unknown', value}, date, license, notes}`.
- `classes`: the canonical 169-class order (`AA,AKs,AKo,...,22`), stored once. All per-class arrays use this order.
- `nodes[]`: `{id:'n12', actor:'BTN'|'SB'|'BB', history:[{pos,act:'F'|'C'|'R'|'A', toBb}], potBb, toCallBb, stacksBb:{...}, actions:[{id:'R2', kind:'fold'|'call'|'check'|'raise'|'allin', toBb, child:'n13'|null, terminal?:'showdown-allin'|'fold'|'flop'}], freq:number[169][A], ev?:number[169][A] (bb, hero-perspective)}`. Classes the actor never holds at that node get freq `null` (reach 0) and are still listed.
- **Size.** The small tree in section 3 has about 25-40 decision nodes x 169 x 2-4 actions, so roughly 20-25k numbers, or about 50k with EV. Freqs are stored as 3 decimals. That is about 150-300 KB raw and about 50-80 KB gzipped per stack. A larger menu (2-3 open sizes) stays under 1 MB.
- **Validator** (`web/src/preflop3/pack/validate.ts`, pure). It returns `{ok, errors:[{path, code, detail}]}` with codes like `E_SUM` and the path `nodes[n12].freq[AKo]`. Checks:
  - each non-null row sums to 1 ± 1e-3;
  - no NaN, Inf or negative values;
  - exactly 169 classes in canonical order;
  - every `child` exists and every node is reachable from the root;
  - `toBb` and `toCallBb` are consistent with `history` and stacks, and no action exceeds the stack;
  - action list matches the row width;
  - for ICM, the payouts are present;
  - `verification` and `schemaVersion` are known.
- **Versioning.** `migrations[schemaVersion] -> fn` upgrades older packs on load. Unknown major versions are rejected with `E_SCHEMA_VERSION`.
- **Storage.**
  - Self-computed packs live in `web/public/packs/preflop3/{20,18,16}.json` plus `index.json`, so they are static and cacheable.
  - Licensed third-party output is never committed. The user imports it in the browser only (IndexedDB) or keeps it in `private-data/reference/`, which is gitignored.
  - Test fixtures live only under `web/src/preflop3/__fixtures__/`. The loader throws on `test-fixture` when `import.meta.env.PROD`, and a build test greps `dist/` for fixture `packId`s.

## 2. Import
- `interface PackAdapter { id; detect(fileName, text): boolean; parse(text, opts): PackDraft; }`.
- `PackDraft` then goes through `normalize`, `validate` and the IndexedDB store. Imports are `external-verified` only if the user ticks "exported from solver X v.Y", and the source and settings are stored in `meta`.
- **Generic adapters**:
  - CSV: one row per `node,class,action,freq[,ev]`, plus a separate node/tree JSON;
  - JSON: our own schema.
- **Proprietary adapters** (PioSolver, HRC, GTO Wizard, Monker): not specified now. Each is written only when the owner supplies a real sample export and confirms a license to use it. No format guessing.

## 3. What our solver can honestly compute
- **Theory limits.**
  - A 3-player equilibrium is not unique, and CFR has no Nash convergence guarantee in multiplayer games. Its average strategy approaches a coarse correlated equilibrium at best.
  - So the reported figure is the **measured best-response gain per player** (mbb/hand) against the final profile. We never report "exploitability 0" or "GTO".
- **Payoff model is an owner decision.** 3-handed at 16-20 bb looks like a Spin&Go-style format, where ICM changes ranges materially. The owner must choose:
  - chip-EV;
  - ICM, which needs the payouts, e.g. winner-take-all or 3-way.
  The generator is blocked until this is answered. We default to chip-EV only if the owner confirms it.
- **Tractable tree, v1.**
  - BTN: fold / open 2.0 / shove.
  - SB: fold / call / 3-bet (vs open) or raise 3.0 (unopened) / shove.
  - BB: check or fold / call / raise (one size) / shove.
  - Facing a raise: fold / call / shove. One re-raise level, then all-in only.
- **Payoffs.** All-in terminals use exact preflop equity (3-way or 2-way enumeration over hand classes). Non-all-in terminals (limped or called pots that see a flop) would need the HU realisation model, which is unvalidated and has no 3-way version. Therefore:
  - **Pack A (honest first):** push/fold/call-shove only (BTN shove/fold, SB shove/fold/call-shove, BB call/fold). No flop terminals, so the only error is CFR convergence.
  - **Pack B (later):** the full v1 tree with `notes:'flop EV from unvalidated realisation model'`. It stays `self-computed-unverified` permanently.
- **Labels.** All self-computed packs are `self-computed-unverified`, with a visible badge and the disclaimer keys `preflop3.badge.unverified` and `preflop3.disclaimer.unverified`. Only imported external packs can show `preflop3.badge.verified`.

## 4. Trainer logic (`web/src/preflop3/trainer.ts`, pure TS, seeded RNG)
- **Spot sampling.** Candidate spots are the decision nodes in the pack. Each node's weight is its reach probability: the product of the predecessors' range-weighted action frequencies, combo-weighted. Two options:
  - `uniformSpots` gives equal weight per node;
  - `positionFilter` restricts to a hero position.
- **Mode.** `20|18|16|mix` picks the pack first, either uniformly or with owner-set weights.
- **Hero hand.** Sample a class by `reach(class, node)` × combos (6/4/12), then pick concrete suits uniformly. Classes with reach 0 are never dealt.
- **Button mapping.**

  | Pack `kind` | Button |
  | --- | --- |
  | `fold` | FOLD |
  | `call` / `check` | CALL (labelled CHECK when `toCallBb = 0`) |
  | `raise`, no prior raise | RAISE |
  | `raise`, after a raise | 3-BET |
  | `allin` (or raise ≥ 0.95 × stack) | ALL-IN |

  Only actions present in the node are rendered.
- **Correctness.**
  - **Default:** `correct = freq[chosen] >= T`, with T = 0.10 configurable.
  - **Close tier**, only if EV exists: incorrect, but `evLoss = maxEV - EV[chosen] <= 0.05 bb` is shown as "close" and counts as incorrect.
  - **Strict mode:** score = `freq[chosen]` (0..1). Accuracy = Σscore / total.
  - The pure-strategy best answer is always shown as well.
- **Persistence.** Reuse `POST /api/drills/results` with:
  - `spotId = preflop3:{stack}:{nodeId}:{hero}`, which `spotTypeOf` maps to `preflop3`;
  - `handCombo`, `action` (action id), `solverFreqs` (that node's row), `evLoss` (null if no EV);
  - `packId` and `verification`, kept in a new nullable `meta` JSON column (migration T3).
- **Counter.** The bottom bar shows correct / incorrect / total / accuracy %, with a session/all-time toggle:
  - session numbers come from local state;
  - all-time comes from `GET /api/progress` filtered on `spotType = preflop3`.
- **Explanation.** Templated i18n strings filled only from pack data:
  - freqs, best action, EV gap;
  - pot, to-call, pot odds = `toCall/(pot+toCall)`, SPR, position, hand class, and the class's rank in the node's range (percentile by frequency of the chosen line).
  - No free-form strategy claims.

## 5. UI (`web/src/preflop3/`)
- Table with 3 seats (BTN/SB/BB, dealer button, stack in bb, `Intl` number formatting), hero cards as tiles, rivals' prior actions as chips, and a pot display.
- Big action buttons. Shortcuts F / C / R / 3 / A, plus Space or Enter for the next hand.
- After answering: result banner, frequency bars per action, the explanation, and a 13×13 matrix of the node's range (colour = action mix).
- Mobile: seats in a triangle, buttons in a full-width sticky row above the score bar.
- All text uses `preflop3.*` keys in `en`, `es` and `it` (the key-parity test already exists). New poker terms go into `glossary.md`.

## 6. Milestones (one Sonnet builder each)
- **T1:** pack types, validator, migrations, loader, and a `test-fixture` pack (tiny 3-node tree). **Gate:**
  - the validator has unit tests per error code;
  - the PROD loader rejects the fixture;
  - the `dist/` grep test passes.
- **T2:** `trainer.ts` (sampling, mapping, scoring, explanation params). **Gate:** seeded tests:
  - reach-weighted sampling within χ² bounds;
  - no reach-0 deals;
  - threshold and strict scoring;
  - correct 3-BET/ALL-IN mapping.
- **T3:** UI, i18n, API `meta` column, score bar. **Gate:**
  - component tests;
  - locale parity;
  - the result POST round-trips;
  - the unverified badge renders for non-external packs.
- **T4:** after the owner answers chip-EV vs ICM, `gto preflop3 --stack N --tree pushfold` emits Pack A. **Gate:**
  - the output passes the validator;
  - the per-player BR gain is reported and decreases across checkpoints;
  - sanity checks: AA shove = 1 for BTN, BB call range is monotone in equity vs the shove range.
- **T5:** import UI, generic CSV/JSON adapters, then proprietary adapters per supplied sample. **Gate:** a round-trip test on the owner's sample, with the validator passing and no license-restricted file committed.

**Owner questions:** (a) chip-EV or ICM, and the payouts; (b) ante or rake; (c) open/3-bet sizes for Pack B; (d) which external solver and license, if any.
