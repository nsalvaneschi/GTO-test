# Preflop solver v2: trustworthy HU 100bb strategies

**Problem.** `engine/abstraction/src/preflop.rs` scores every non-all-in terminal with one global realisation pair (`r_ip=1.0`, `r_oop=0.9`). Because almost any class has >25% raw equity against a wide SB range, BB defends 99.8% vs a 2bb open (published HU solvers show roughly 60-75%). Exploitability also jumps around (23 mbb near iter 750).

## 1. Decision: hybrid realisation table (class-dependent R, fitted from coarse postflop solves)
- Keep the zero-sum pot-share formula, but make R depend on hand class, position and pot type:
  `share_SB(i,j) = eq_ij*R_sb(i) / (eq_ij*R_sb(i) + (1-eq_ij)*R_bb(j))`, with `R = R[pot_type][pos][class]`.
  This is zero-sum for any positive R, so the CFR guarantees still hold. It also reduces exactly to the current model when R is constant.
- Pot types: `Limp` (limp/check), `Srp` (open/call), `ThreeBet`, `FourBet` (called, not all-in). 4 x 2 x 169 f32 values, stored in one JSON file.
- **Why not a full per-pair table?** A postflop EV depends on both ranges, not only on the class pair. Per-class R fitted against the equilibrium ranges captures the main effect (trash OOP realises badly) at 1/169 of the cost.
- **Why not parametric only?** Its coefficients would be guesses again. It is still useful as P1, as the prior, and as the fallback when the table is missing.
- **P1 parametric prior:** `R = base[pot][pos] + 0.08*suited + 0.05*pair + 0.03*connected(gap<=1) - 0.6*max(0, 0.40 - eq_vs_any)`, clamped to [0.4, 1.25].
  `base`: Srp IP 1.02 / OOP 0.80, Limp 1.00 / 0.85, ThreeBet 1.00 / 0.88, FourBet 0.98 / 0.94 (lower SPR means realisation closer to 1).
  The coefficients are approximate and live in `PreflopConfig`, so they are tunable.

## 2. Computing the table with existing code (`gto precompute --realisation`)
1. Solve preflop with the current R (prior on round 0). Then extract the combo ranges at each pot-type terminal: class strategy goes to its combos, and reach is weighted by node.
2. For each pot type, use 24 flops: a fixed, seeded, suit-isomorphic, weighted sample shared across pot types. Run `StreetSolver` (`river/src/street.rs`) from the flop with `buckets: Some(32)` (`bucket.rs`), `iso: true` and `compress: true`.
   Betting menu per street: Limp/Srp {check, 33%, 75%, jam}, then one raise of 3x plus jam. ThreeBet/FourBet {check, 33%, jam}.
   Run 300 iterations, or stop earlier at exploitability below 1% of pot.
3. Read root `NodeView.ev` per combo for each player, and average over flops (weight = flop frequency) and combos to get the class EV, `EV_c`.
   Then `R(c) = EV_c / (pot * eq(c vs opp range))`, with the denominator taken from the existing `EquityTable` weighted by opponent reach. Clamp to [0.3, 1.6]. Skip classes with reach below 1e-4 and keep their prior.
4. Fixed point: `R_new = 0.5*R_old + 0.5*R_fit`. Run 3 outer rounds, or stop when max |dR| < 0.02.
- **Budget:** call `estimate_memory` first and keep each solve under 1.5 GB. Target ≤20 s per flop solve, which gives 4 x 24 x 3 ≈ 290 solves, about 1.5 h single-threaded. The 24 flops are independent, so parallelise them.
  If this is over budget, drop to 16 flops / 24 buckets before cutting rounds. The output is deterministic (fixed seeds) and checked in as `data/realisation_v1.json`.

## 3. Game tree and sizing at 100bb (all values in `PreflopConfig`)
- SB: fold / limp / open `o` in {2.0, 2.5} (one size per solve, both solved) / jam.
- BB vs open: fold / call / 3-bet to 4.0x`o` (OOP sizing: 8 vs 2.0, 10 vs 2.5) / jam.
- BB vs limp: check / iso to 3.5 / jam. SB vs iso: fold / call / 3-bet to 2.5x iso / jam.
- SB vs 3-bet: fold / call / 4-bet to 2.2x the 3-bet (IP; 22 vs 10) / jam. BB vs 4-bet: fold / call / jam. Facing jam: fold / call.
- Jam rule: if a raise target exceeds 40% of the effective stack (SPR after a call < ~1.2), replace that raise by jam. Never keep a near-all-in raise alongside the jam.

## 4. Convergence
- Full-width alternating DCFR stays. Change the default to α=1.5, β=0.5, γ=2 (β=0 zeroes negative regrets too aggressively when many classes are near-indifferent, which is the 99.8% degenerate region).
  The table fix should remove most of that indifference by itself.
- Delayed averaging: do not accumulate `sum` for t ≤ 100, then use the γ weights from t=101.
- Measure exploitability of the average strategy every 25 iters, logged in mbb/hand. Also log the current-strategy exploitability, so the run can tell averaging lag apart from a real bug.
- Keep the best average snapshot seen and return it. Sampling is not needed: 169² full-width is cheap.
- Add a sanity test: on a tiny config (3 classes) the result must match the vanilla CFR in `engine/core` to within 1e-3.

## 5. Validation (no reference solver here; the targets below are approximate public HU 100bb solver ballparks, so tolerances are wide)
| Check | Target | Hard fail |
|---|---|---|
| BB defend (call+3b+jam) vs 2.0 open | 62-75% | <50% (MDF) or >85% |
| BB defend vs 2.5 open | 55-68% | <45% or >80% |
| SB total VPIP (raise+limp+jam), o=2.5 | 75-90% | <60% or >97% |
| SB limp freq (limp allowed) | 5-40% (mixed; solvers disagree) | none; report only |
| AA, KK fold freq at every node | 0 | >0.1% |
| 72o/32o BB vs 2.5 open | mostly fold (>50%) | defend 100% |
| Exploitability after 2000 it | <5 mbb/hand | >20 |
| Monotone-ish: for t>200, expl(t) ≤ 1.2·min_{s<t} + 1 mbb | holds | violated twice |
| Mean fitted R in Srp: IP / OOP | 1.0-1.15 / 0.70-0.90 | outside 0.6-1.3 |
- Unit tests: payoff is zero-sum at every terminal for random R; constant R=1 reproduces raw-equity payoffs; table loader rejects wrong shape; the fit on a synthetic `NodeView` gives the expected R.
- Integration test (`#[ignore]`, run in CI nightly): the table checks above, using the checked-in table.

## 6. Milestones (each one fits one Sonnet builder PR)
- **P1:** Class-dependent R plumbing plus the parametric prior. Includes the pot-type tag on terminals, the sizing menu from section 3, the jam rule, the DCFR/averaging/best-snapshot changes and the unit tests.
  Gate: BB vs 2.0 defend <85%, AA/KK never fold, the monotone check passes.
- **P2:** `gto precompute --realisation`. Covers range extraction, flop sampling, bucketed `StreetSolver` runs, R fit, JSON output and loader, behind a flag with the prior as fallback.
  Gate: the fit unit test, and one round finishes within budget.
- **P3:** Fixed-point rounds, the checked-in `data/realisation_v1.json`, and the section 5 validation test plus a report line in the CLI output (numbers only, no display text).
  Gate: every row in the table is in its target band, or a deviation is documented here.
