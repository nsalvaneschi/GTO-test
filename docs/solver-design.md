# Solver Engine Design

## Decision
- **Algorithm: DCFR** (alpha=1.5, beta=0, gamma=2), alternating updates, full-vector (range-vs-range) traversal. CFR+ is the same code path with alpha=inf, beta=-inf, gamma=2 (`Discount` enum). Why: DCFR converges faster than CFR+ on poker subgames, especially with large-bet mistakes early on, and it costs about the same per iteration. Vector traversal (all 1326 hands at once) works well with SIMD and avoids sampling noise. No MCCFR except as a later option for preflop.
- **Language: Rust.** Builds to `wasm32-unknown-unknown` (wasm-bindgen, single thread first, then rayon via wasm threads) for browser solving of small trees, and to a native CLI (rayon) for precomputing the preflop and flop libraries.

## Game tree and bet abstraction
- Heads-up first: `GameConfig { stacks, pot, board, ranges[2], street_sizes, raise_cap, allin_threshold, rake }`.
- Bet sizes per street and per player as % pot, e.g. flop `[33,75]`, raise `[2.5x]`, plus all-in. If a bet is >= `allin_threshold` (0.67) of the stack, it becomes all-in. Raises are capped at 3 per street.
- Preflop: a fixed action menu per position (open 2.5bb, 3b 3.5x IP / 4.5x OOP, 4b 2.3x, jam). Solve it offline with native CLI. Postflop nodes in the preflop solve use bucketed equity leaves (M5).
- Tree is an arena `Vec<Node>`, `Node { kind: Chance|Action|Terminal, player, pot, stacks, children: Range<u32>, actions: Range<u32>, data_off: u64 }`. The turn and river are chance nodes. Postflop dealing is lazy per runout, with isomorphic runouts merged.
- Multiway (later): `Node.player` is already an index and terminals are already per-player payoffs. Only the evaluator and the traversal need generalizing to N players.

## Card abstraction
- **Suit isomorphism (lossless, always on):** canonicalize the board by suit permutation. Turn and river cards that are equivalent under the board's suit symmetry are solved once, with a weight, and hands are mapped through a permutation table. Preflop: 169 classes.
- **Buckets (lossy, native library only):** use Expected Hand Strength (EHS) histograms with earth mover's distance (EMD) k-means. Defaults: flop 2000, turn 1000, river 500 by OCHS. Postflop browser solves stay unbucketed, with exact 1326 hands minus board blockers.
- Hand eval: 7-card lookup table (two-plus-two-style or perfect hash). River showdown uses O(n) sorted-strength sweep with card-removal correction.

## Storage and memory
- For each action node: `regret: [f32; A*H]`, `strat_sum: [f32; A*H]`, where H = hands for the acting player. Optional compression stores i16/u16 values with a per-node f32 scale (about half the memory).
- Estimate: `bytes = sum_nodes A*H*8`. Budget: browser at most 1.5 GB (wasm32 4 GB cap), with compression on by default. Native at most 32 GB. `estimate_memory(config)` runs before the solve and rejects configs that exceed the budget.
- Output: averaged strategy only (`f16` per action per hand) plus EV/equity per hand at queried nodes. Serialize with bincode+zstd to `.gtos` files for the library.

## Crate layout (`engine/`, cargo workspace)
- `core/` (cards, combos, isomorphism, hand eval)
- `tree/` (config, builder, arena)
- `cfr/` (DCFR, traversal, exploitability)
- `abstraction/` (EHS, buckets)
- `games/` (Kuhn, Leduc test games via a `Game` trait)
- `wasm/` (bindings)
- `cli/` (precompute, bench)

## Public interface
- `solve(cfg: &GameConfig, opts: SolveOpts{max_iters, target_expl_pct, threads}) -> Solution`
- `Solution::node(path: &[ActionId]) -> NodeView { player, actions, strategy: [H x A], range: [H] }`
- `Solution::ev(path, player) -> Vec<f32>`, `equity(path, player)`, `exploitability() -> f32` (% pot)
- WASM: `Solver.new(cfgJson)`, `.step(n)` (progressive, report expl), `.query(pathJson)`, `.free()`
- `Game` trait (`root`, `actions`, `apply`, `infoset_key`, `payoff`) is used only by the generic CFR for the test games.

## Milestones (each one is a Sonnet-sized PR)
- **M1:** `core` cards/combos/eval plus the `Game` trait, and scalar CFR/CFR+/DCFR on Kuhn and Leduc. Acceptance: Kuhn game value -1/18.
- **M2:** HU river-only tree builder, vector DCFR, showdown sweep, exploitability via best response.
- **M3:** turn/flop chance nodes, suit isomorphism, memory estimate, rayon, i16 compression.
- **M4:** `wasm` bindings plus the progressive `step`/`query` API, and the CLI `solve --config x.json --out x.gtos`.
- **M5:** EHS bucketing, preflop solve with bucketed postflop leaves, library precompute. Later: multiway.

## Test plan
- Kuhn: game value -1/18 +/- 1e-3 and expl < 1e-3 within 10k iterations, for each variant.
- Leduc: expl < 0.01 within 10k iterations. DCFR must reach the target in no more iterations than CFR+ (regression bench).
- Exploitability: (BR_0 + BR_1) / 2 / pot. On a fixed river spot (e.g. a 4-card board plus river, 2 sizes), expl < 0.3% pot in <= 1000 iterations.
- Unit: eval against a known table of 7-card categories, isomorphism round-trip, combo-blocker counts, and zero-sum EV.
- Property tests: strategies sum to 1 and payoffs are conserved. A golden-file test compares the strategy of a small spot to within 1e-3.
