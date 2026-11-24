//! Sweep of the P1 realisation prior; prints defend rates per setting.
use gto_abstraction::preflop::*;

fn freq(eq: &EquityTable, strat: &[f64], acts: &[usize]) -> f64 {
    let w: Vec<f64> = (0..NC).map(|i| (0..NC).map(|j| eq.w[i * NC + j]).sum()).collect();
    let tot: f64 = w.iter().sum();
    (0..NC).map(|i| w[i] * acts.iter().map(|&a| strat[a * NC + i]).sum::<f64>()).sum::<f64>() / tot
}

fn measure(eq: &EquityTable, cfg: &PreflopConfig, iters: u32) -> (f64, f64) {
    let mut s = PreflopSolver::new(cfg, eq);
    s.solve(iters);
    let (_, l, st) = s.strategy_at(&[2]).unwrap();
    let (_, l0, st0) = s.strategy_at(&[]).unwrap();
    let _ = (l, l0.len());
    (1.0 - freq(eq, &st, &[0]), 1.0 - freq(eq, &st0, &[0]))
}

fn main() {
    let eq = EquityTable::compute(300);
    let iters: u32 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(600);
    for &pen in &[3.5, 4.0, 4.5] {
        let mut base = PreflopConfig::default().r_base;
        base[1] = [1.02, 0.80];
        let c25 = PreflopConfig { r_base: base, r_eq_pen: pen, r_eq_floor: 0.50, ..Default::default() };
        let c20 = PreflopConfig { open: 2.0, three_bet: 8.0, four_bet: 17.6, ..c25.clone() };
        let (d25, vpip) = measure(&eq, &c25, iters);
        let (d20, _) = measure(&eq, &c20, iters);
        println!("pen {pen}: def2.0 {d20:.3} def2.5 {d25:.3} vpip2.5 {vpip:.3}");
        let r = prior_r(&c25, &eq);
        for (n, c) in [("AA", 12 * 13 + 12), ("72o", 5), ("T9s", 8 * 13 + 7), ("A5s", 12 * 13 + 3), ("22", 0)] {
            println!("  {n} Srp IP {:.2} OOP {:.2}", r[2 * NC + c], r[3 * NC + c]);
        }
    }
}
