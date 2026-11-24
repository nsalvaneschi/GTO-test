//! Realisation table fit (`gto precompute --realisation`): extract the equilibrium ranges at each
//! pot-type terminal of a preflop solution, solve a seeded sample of flops with the bucketed
//! `StreetSolver`, and fit `R[pot][pos][class] = realised pot share / raw equity` (doc preflop-design.md, sec. 2).
//! Positions: 0 = SB (IP postflop), 1 = BB (OOP postflop). Output is numbers only.
use crate::preflop::{class_of, EquityTable, PotSpot, NC, POT_TYPES};
use gto_river::cards::combos;
use gto_river::street::{estimate_memory, StreetConfig, StreetSolver};
use gto_river::tree::{TreeConfig, H};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const FORMAT: &str = "gto-realisation-1";
pub const R_LO: f32 = 0.3;
pub const R_HI: f32 = 1.6;
pub const MIN_REACH: f64 = 1e-4;

#[derive(Serialize, Deserialize)]
pub struct RealisationFile {
    pub format: String,
    /// `POT_TYPES*2*NC` values, index `(pot*2+pos)*NC+class` (same layout as `PreflopSolver::with_r`).
    pub r: Vec<f32>,
    pub meta: serde_json::Value,
}

/// Load an R table; rejects a wrong format tag, wrong shape or non-positive values.
pub fn parse_r(json: &str) -> Result<Vec<f32>, String> {
    let f: RealisationFile = serde_json::from_str(json).map_err(|e| e.to_string())?;
    if f.format != FORMAT {
        return Err(format!("unsupported realisation format '{}'", f.format));
    }
    if f.r.len() != POT_TYPES * 2 * NC || f.r.iter().any(|&x| !(x > 0.0)) {
        return Err("bad realisation table".into());
    }
    Ok(f.r)
}

pub fn load_r(path: &str) -> Result<Vec<f32>, String> {
    parse_r(&std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?)
}

/// Fit R for one (pot type, position) from per-class accumulated realised pot share.
/// `share[c]/weight[c]` = mean realised share of the pot; denominator = raw equity of `c` vs `opp_range`
/// (weighted by the matchup table). Classes with `reach < MIN_REACH`, no samples or no equity keep `prior`.
pub fn fit_r(eq: &EquityTable, pos: usize, opp_range: &[f64], reach: &[f64], share: &[f64], weight: &[f64], prior: &[f32]) -> Vec<f32> {
    (0..NC).map(|i| {
        if reach[i] < MIN_REACH || weight[i] <= 0.0 {
            return prior[i];
        }
        let (mut num, mut den) = (0.0, 0.0);
        for j in 0..NC {
            let w = if pos == 0 { eq.w[i * NC + j] } else { eq.w[j * NC + i] } * opp_range[j];
            num += w * eq.eq[i * NC + j];
            den += w;
        }
        if den <= 0.0 || num <= 0.0 {
            return prior[i];
        }
        ((share[i] / weight[i]) / (num / den)).clamp(R_LO as f64, R_HI as f64) as f32
    }).collect()
}

/// Seeded, suit-isomorphic flop sample: all canonical flops weighted by frequency, sorted by rank texture,
/// stratified-sampled with a seeded jitter. Every returned flop has equal weight (frequency-proportional sample).
pub fn sample_flops(n: usize, seed: u64) -> Vec<[u8; 3]> {
    let mut perms = vec![];
    for a in 0..4u8 {
        for b in 0..4u8 {
            for c in 0..4u8 {
                for d in 0..4u8 {
                    if a != b && a != c && a != d && b != c && b != d && c != d {
                        perms.push([a, b, c, d]);
                    }
                }
            }
        }
    }
    let mut cnt: HashMap<[u8; 3], u32> = HashMap::new();
    for a in 0..52u8 {
        for b in a + 1..52 {
            for c in b + 1..52 {
                let canon = perms.iter().map(|p| {
                    let mut f = [a, b, c].map(|x| (x & !3) | p[(x & 3) as usize]);
                    f.sort();
                    f
                }).min().unwrap();
                *cnt.entry(canon).or_default() += 1;
            }
        }
    }
    let mut v: Vec<([u8; 3], u32)> = cnt.into_iter().collect();
    v.sort_by_key(|(f, _)| ([f[2] / 4, f[1] / 4, f[0] / 4], *f));
    let total: u32 = v.iter().map(|x| x.1).sum();
    let mut s = seed | 1;
    let mut out = vec![];
    let (mut cum, mut k) = (0u64, 0usize);
    for (f, c) in &v {
        cum += *c as u64;
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        while k < n {
            // target point of stratum k, jittered by a seeded fraction fixed per stratum
            let mut t = s ^ (k as u64).wrapping_mul(0x9E3779B97F4A7C15);
            t ^= t >> 31;
            let u = (t % 1000) as f64 / 1000.0;
            let point = ((k as f64 + u) / n as f64 * total as f64) as u64;
            if point < cum {
                out.push(*f);
                k += 1;
            } else {
                break;
            }
        }
    }
    out
}

/// Per combo: sum over ordered turn/river cards (both not in `board` or the combo) of the opponent mass
/// compatible with the combo and runout. Converts `StreetSolver` root values (summed over runouts and
/// weighted by opponent range) into a per-combo expected value.
pub fn denominators(board: &[u8], opp: &[f32]) -> Vec<f64> {
    let cb = combos();
    let (mut cs, mut m, mut tot) = ([0.0f64; 52], [[0.0f64; 52]; 52], 0.0f64);
    for (h, &(a, b)) in cb.iter().enumerate() {
        if board.contains(&a) || board.contains(&b) {
            continue;
        }
        let w = opp[h] as f64;
        cs[a as usize] += w;
        cs[b as usize] += w;
        m[a as usize][b as usize] = w;
        m[b as usize][a as usize] = w;
        tot += w;
    }
    let free: Vec<u8> = (0..52u8).filter(|c| !board.contains(c)).collect();
    cb.iter().map(|&(a, b)| {
        if board.contains(&a) || board.contains(&b) {
            return 0.0;
        }
        let base = tot - cs[a as usize] - cs[b as usize] + m[a as usize][b as usize];
        let mut d = 0.0;
        for &c1 in free.iter().filter(|&&c| c != a && c != b) {
            for &c2 in free.iter().filter(|&&c| c != a && c != b && c != c1) {
                let (c1, c2, a, b) = (c1 as usize, c2 as usize, a as usize, b as usize);
                d += base - cs[c1] - cs[c2] + m[a][c1] + m[a][c2] + m[b][c1] + m[b][c2] + m[c1][c2];
            }
        }
        d
    }).collect()
}

#[derive(Clone, Debug)]
pub struct FitOpts {
    pub flops: usize,
    pub iters: u32,
    pub buckets: usize,
    /// Street menu level, see `street_menu`.
    pub menu: u8,
    pub seed: u64,
    pub budget_bytes: u64,
    /// Stop a solve early below this exploitability (% of pot); checked every 50 iterations.
    pub stop_pct: f32,
}

impl Default for FitOpts {
    fn default() -> Self {
        FitOpts { flops: 24, iters: 300, buckets: 32, menu: 0, seed: 1, budget_bytes: 1_500_000_000, stop_pct: 1.0 }
    }
}

/// Street menus. Level 0 = doc sec. 2 (the tree takes one size list for bets and raises, so the "3x raise" is
/// approximated by the same sizes, bet then one raise, cap 2); it needs 4-7 GB per flop, over the 1.5 GB budget.
/// Level 1/2 are reduced menus that fit: 1 = flop one bet size set (cap 1), turn/river jam only;
/// 2 = flop {50%, jam} cap 2, turn {75%, jam} cap 1, river jam only.
pub fn street_menu(pot_type: usize, pot: f32, stack: f32, level: u8) -> Vec<TreeConfig> {
    let flop: Vec<f32> = match (level, pot_type <= 1) {
        (0, true) | (1, true) => vec![0.33, 0.75, 100.0],
        (0, false) | (1, false) => vec![0.33, 100.0],
        _ => vec![0.5, 100.0],
    };
    let t = |sizes: Vec<f32>, raise_cap| TreeConfig { pot, stack, sizes, raise_cap };
    match level {
        0 => (0..3).map(|_| t(flop.clone(), 2)).collect(),
        1 => vec![t(flop, 1), t(vec![100.0], 1), t(vec![100.0], 1)],
        _ => vec![t(flop, 2), t(vec![0.75, 100.0], 1), t(vec![100.0], 1)],
    }
}

pub fn flop_config(spot: &PotSpot, stack: f64, flop: [u8; 3], buckets: usize, menu: u8) -> StreetConfig {
    let cb = combos();
    let rng = |p: usize| -> Vec<f32> { cb.iter().map(|&(a, b)| spot.range[p][class_of(a, b)] as f32).collect() };
    StreetConfig {
        board: flop.to_vec(), ranges: [rng(1), rng(0)], // [OOP = BB, IP = SB]
        streets: street_menu(spot.pot_type, 2.0 * spot.inv as f32, (stack - spot.inv) as f32, menu),
        iso: true, compress: true, buckets: Some(buckets),
    }
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct SolveStat {
    pub pot_type: usize,
    pub flop: [u8; 3],
    pub secs: f32,
    pub est_mem_bytes: u64,
    pub iters: u32,
    pub expl_pct: f32,
    /// Mean realised SB share over matchups (zero-sum check: should be ~0.5).
    pub mean_sb_share: f64,
}

/// Solve one flop for one pot type; adds per-class (share sum, weight) into `acc[pos]`.
pub fn solve_flop(spot: &PotSpot, stack: f64, flop: [u8; 3], o: &FitOpts, acc: &mut [(Vec<f64>, Vec<f64>); 2]) -> Result<SolveStat, String> {
    let cfg = flop_config(spot, stack, flop, o.buckets, o.menu);
    let est = estimate_memory(&cfg, o.budget_bytes)?;
    let t = std::time::Instant::now();
    let mut s = StreetSolver::new(&cfg, o.budget_bytes)?;
    let mut expl = f32::MAX;
    while s.iters < o.iters {
        s.solve(50.min(o.iters - s.iters));
        expl = s.exploitability_pct();
        if expl < o.stop_pct {
            break;
        }
    }
    let secs = t.elapsed().as_secs_f32();
    let (pot, cb) = (2.0 * spot.inv, combos());
    let mut sb_share = (0.0, 0.0);
    // postflop player index: 0 = OOP (BB, pos 1), 1 = IP (SB, pos 0)
    for q in 0..2 {
        let pos = 1 - q;
        let ev = s.root_ev(q);
        let d = denominators(&cfg.board, &cfg.ranges[1 - q]);
        for (h, &(a, b)) in cb.iter().enumerate() {
            let c = class_of(a, b);
            if cfg.ranges[q][h] <= 0.0 || d[h] <= 0.0 || cfg.board.contains(&a) || cfg.board.contains(&b) {
                continue;
            }
            let share = ev[h] as f64 / d[h] / pot + 0.5;
            acc[pos].0[c] += share;
            acc[pos].1[c] += 1.0;
            if pos == 0 {
                sb_share.0 += share * cfg.ranges[q][h] as f64;
                sb_share.1 += cfg.ranges[q][h] as f64;
            }
        }
    }
    let _ = H;
    Ok(SolveStat {
        pot_type: spot.pot_type, flop, secs, est_mem_bytes: est, iters: s.iters, expl_pct: expl,
        mean_sb_share: if sb_share.1 > 0.0 { sb_share.0 / sb_share.1 } else { 0.0 },
    })
}

/// Fit the full table from the aggregated preflop spots (one round, no blending; unreached keep `prior`).
/// Flops are solved one after another (each solve is rayon-parallel inside).
pub fn fit_table(spots: &[Option<PotSpot>], stack: f64, eq: &EquityTable, prior: &[f32], o: &FitOpts,
    mut log: impl FnMut(&SolveStat)) -> Result<(Vec<f32>, Vec<SolveStat>), String> {
    let flops = sample_flops(o.flops, o.seed);
    let mut r = prior.to_vec();
    let mut stats = vec![];
    for (pt, spot) in spots.iter().enumerate() {
        let Some(spot) = spot else { continue };
        let mut acc = [(vec![0.0; NC], vec![0.0; NC]), (vec![0.0; NC], vec![0.0; NC])];
        for &f in &flops {
            let st = solve_flop(spot, stack, f, o, &mut acc)?;
            log(&st);
            stats.push(st);
        }
        for pos in 0..2 {
            let base = (pt * 2 + pos) * NC;
            let fit = fit_r(eq, pos, &spot.range[1 - pos], &spot.reach[pos], &acc[pos].0, &acc[pos].1, &prior[base..base + NC]);
            r[base..base + NC].copy_from_slice(&fit);
        }
    }
    Ok((r, stats))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tiny_eq() -> EquityTable {
        let mut eq = vec![0.5; NC * NC];
        for i in 0..NC {
            for j in 0..NC {
                eq[i * NC + j] = 0.5 + 0.3 * (i as f64 - j as f64) / NC as f64;
            }
        }
        EquityTable { eq, w: vec![1.0 / (NC * NC) as f64; NC * NC] }
    }

    #[test]
    fn fit_recovers_known_r() {
        let eq = tiny_eq();
        let opp = vec![1.0; NC];
        let prior = vec![0.77f32; NC];
        for pos in 0..2 {
            let e: Vec<f64> = (0..NC).map(|i| {
                let (mut n, mut d) = (0.0, 0.0);
                for j in 0..NC {
                    let w = if pos == 0 { eq.w[i * NC + j] } else { eq.w[j * NC + i] };
                    n += w * eq.eq[i * NC + j];
                    d += w;
                }
                n / d
            }).collect();
            // classes 0..10 unreached, class 11 only has 1e-5 reach, others realise 0.9 of equity (x2 samples)
            let share: Vec<f64> = e.iter().map(|x| 2.0 * 0.9 * x).collect();
            let weight = vec![2.0; NC];
            let reach: Vec<f64> = (0..NC).map(|i| if i < 10 { 0.0 } else if i == 11 { 1e-5 } else { 0.5 }).collect();
            let r = fit_r(&eq, pos, &opp, &reach, &share, &weight, &prior);
            assert!((0..10).all(|i| r[i] == 0.77) && r[11] == 0.77);
            assert!((12..NC).all(|i| (r[i] - 0.9).abs() < 1e-4), "{:?}", &r[12..16]);
            // clamping
            let big: Vec<f64> = e.iter().map(|x| 5.0 * x).collect();
            let r = fit_r(&eq, pos, &opp, &reach, &big, &vec![1.0; NC], &prior);
            assert!((r[50] - R_HI).abs() < 1e-6);
        }
    }

    #[test]
    fn loader_rejects_bad_shape() {
        let ok = serde_json::json!({"format": FORMAT, "r": vec![1.0f32; POT_TYPES * 2 * NC], "meta": null});
        assert!(parse_r(&ok.to_string()).is_ok());
        let short = serde_json::json!({"format": FORMAT, "r": vec![1.0f32; 5], "meta": null});
        assert!(parse_r(&short.to_string()).is_err());
        let zero = serde_json::json!({"format": FORMAT, "r": vec![0.0f32; POT_TYPES * 2 * NC], "meta": null});
        assert!(parse_r(&zero.to_string()).is_err());
    }

    #[test]
    fn flops_deterministic_and_distinct() {
        let a = sample_flops(24, 1);
        assert_eq!(a.len(), 24);
        assert_eq!(a, sample_flops(24, 1));
        let mut u = a.clone();
        u.sort();
        u.dedup();
        assert_eq!(u.len(), 24);
    }

    #[test]
    fn denominators_match_norm_count() {
        // uniform opponent weights: sum over ordered runouts of compatible opponent combos is easy to count
        let board = [0u8, 5, 10];
        let opp = vec![1.0f32; H];
        let d = denominators(&board, &opp);
        // hand 2 cards + board 3 + 2 runout = 7 dead; opp combos from remaining 45-... brute force check
        let cb = combos();
        let h = cb.iter().position(|&(a, b)| a == 20 && b == 30).unwrap();
        let mut brute = 0.0;
        for c1 in 0..52u8 {
            for c2 in 0..52u8 {
                if [20u8, 30].contains(&c1) || [20u8, 30].contains(&c2) || board.contains(&c1) || board.contains(&c2) || c1 == c2 {
                    continue;
                }
                brute += cb.iter().filter(|&&(x, y)| ![x, y].iter().any(|k| board.contains(k) || [20u8, 30, c1, c2].contains(k))).count() as f64;
            }
        }
        assert_eq!(d[h], brute);
    }
}
