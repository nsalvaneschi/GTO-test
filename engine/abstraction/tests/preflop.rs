use gto_abstraction::preflop::*;

fn weights(eq: &EquityTable) -> Vec<f64> {
    // class prior = sum_j W[i][j]
    (0..NC).map(|i| (0..NC).map(|j| eq.w[i * NC + j]).sum()).collect()
}

fn freq(eq: &EquityTable, strat: &[f64], _n: usize, acts: &[usize]) -> f64 {
    let w = weights(eq);
    let tot: f64 = w.iter().sum();
    (0..NC).map(|i| w[i] * acts.iter().map(|&a| strat[a * NC + i]).sum::<f64>()).sum::<f64>() / tot
}

#[test]
fn preflop_converges_and_is_sane() {
    let eq = EquityTable::compute(300);
    let cfg = PreflopConfig { open: 2.0, three_bet: 8.0, four_bet: 17.6, iso: 3.5, ..Default::default() };
    let mut s = PreflopSolver::new(&cfg, &eq);
    let mut prev = f64::MAX;
    for _ in 0..16 {
        s.solve(125);
        let e = s.exploitability() * 1000.0;
        println!("iters {} expl {e:.2} mbb/hand", s.iters);
        prev = e;
    }
    for l in &s.log { println!("t {} avg {:.2} cur {:.2} mbb", l.0, l.1, l.2); }
    monotone(&s);
    assert!(prev < 5.0, "exploitability {prev} mbb");
    let (p, labels, st) = s.strategy_at(&[]).unwrap();
    assert_eq!(p, 0);
    println!("SB root actions {labels:?}");
    let fold = freq(&eq, &st, labels.len(), &[0]);
    println!("SB fold {fold:.3}, limp {:.3}, raise {:.3}, jam {:.3}", freq(&eq, &st, labels.len(), &[1]),
        freq(&eq, &st, labels.len(), &[2]), freq(&eq, &st, labels.len(), &[3]));
    assert!(fold < 0.35, "SB should open wide");
    // BB vs min-raise (SB action 2 = raise 2)
    let (p, lb, st) = s.strategy_at(&[2]).unwrap();
    assert_eq!(p, 1);
    let defend = 1.0 - freq(&eq, &st, lb.len(), &[0]);
    println!("BB vs min-raise {lb:?} defend {defend:.3}");
    assert!((0.5..0.85).contains(&defend), "defend {defend}");
    // AA never folds anywhere
    let aa = 12 * 13 + 12;
    let mut stack: Vec<Vec<usize>> = vec![vec![]];
    while let Some(path) = stack.pop() {
        let Some((_, labels, st)) = s.strategy_at(&path) else { continue };
        assert!(st[aa] < 1e-3, "AA folds {} at {path:?}", st[aa]);
        for a in 0..labels.len() {
            let mut p2 = path.clone();
            p2.push(a);
            stack.push(p2);
        }
    }
}

fn monotone(s: &PreflopSolver) {
    let mut viol = 0;
    for (k, l) in s.log.iter().enumerate() {
        let m = s.log[..k].iter().map(|x| x.1).fold(f64::MAX, f64::min);
        if l.0 > 200 && l.1 > 1.2 * m + 1.0 { viol += 1; println!("violation at {} : {} vs min {m}", l.0, l.1); }
    }
    assert!(viol < 2, "{viol} monotone violations");
}

#[test]
fn bb_vs_25_open_rates() {
    let eq = EquityTable::compute(300);
    let mut s = PreflopSolver::new(&PreflopConfig::default(), &eq);
    s.solve(2000);
    for l in s.log.iter().filter(|l| l.0 % 250 == 0 || (700..=800).contains(&l.0)) { println!("t {} avg {:.2} cur {:.2} mbb", l.0, l.1, l.2); }
    println!("o=2.5 final expl {:.2} mbb", s.exploitability() * 1000.0);
    monotone(&s);
    let (_, lb, st) = s.strategy_at(&[2]).unwrap();
    let defend = 1.0 - freq(&eq, &st, lb.len(), &[0]);
    println!("BB vs 2.5 {lb:?} defend {defend:.3}");
    let (_, l0, st0) = s.strategy_at(&[]).unwrap();
    let f = |a: usize| freq(&eq, &st0, l0.len(), &[a]);
    println!("SB {l0:?} fold {:.3} limp {:.3} raise {:.3} jam {:.3} VPIP {:.3}", f(0), f(1), f(2), f(3), 1.0 - f(0));
    for (n, c) in [("72o", 0 * 13 + 5), ("32o", 0 * 13 + 1)] { println!("{n} BB fold vs 2.5: {:.3}", st[c]); }
    assert!(defend < 0.80);
    for c in [168usize, 11 * 13 + 11] { assert!(st[c] < 1e-3); assert!(st0[c] < 1e-3); }
}

#[test]
fn share_is_zero_sum_and_r1_is_raw_equity() {
    for (e, a, b) in [(0.3, 1.1, 0.7), (0.9, 0.5, 1.2), (0.5, 1.0, 1.0)] {
        // SB share from (e, a, b) + BB share from the mirrored call (1-e, b, a) = 1
        assert!((realised_share(e, a, b) + realised_share(1.0 - e, b, a) - 1.0).abs() < 1e-12);
        assert!((realised_share(e, 1.0, 1.0) - e).abs() < 1e-12);
    }
}

#[test]
fn rejects_wrong_table_shape() {
    let eq = EquityTable { eq: vec![0.5; NC * NC], w: vec![1.0 / (NC * NC) as f64; NC * NC] };
    assert!(PreflopSolver::with_r(&PreflopConfig::default(), &eq, vec![1.0; 10]).is_err());
}

/// 3 classes (AA, 72o-ish, 87s-ish) with synthetic equities; compare with vanilla CFR in gto_core.
#[test]
fn tiny_matches_vanilla_cfr() {
    let (cl, mut eqv, mut w) = ([168usize, 5, 7 * 13 + 6], vec![0.5; NC * NC], vec![0.0; NC * NC]);
    let e = [[0.5, 0.85, 0.80], [0.15, 0.5, 0.35], [0.20, 0.65, 0.5]];
    for a in 0..3 { for b in 0..3 { eqv[cl[a] * NC + cl[b]] = e[a][b]; w[cl[a] * NC + cl[b]] = 1.0 / 9.0; } }
    let eq = EquityTable { eq: eqv, w };
    let cfg = PreflopConfig { stack: 10.0, open: 2.0, three_bet: 3.5, four_bet: 3.9, iso: 2.0, iso_three_bet: 3.0, iso_four_bet: 3.9, ..Default::default() };
    let mut s = PreflopSolver::new(&cfg, &eq);
    s.solve(3000);
    let g = PreflopGame::new(&s);
    let mut v = gto_core::Solver::new(&g, gto_core::Params { alpha: 1.5, beta: 0.5, gamma: 2.0 });
    for _ in 0..3000 { v.iterate(); }
    let ours = gto_core::value(&g, &gto_core::Game::root(&g), &|k, n| g.strat(k, n));
    let (ex_o, ex_v) = (gto_core::exploitability(&g, &|k, n| g.strat(k, n)), v.exploitability());
    println!("tiny: value ours {ours:.5} vanilla {:.5}; expl ours(core br) {ex_o:.6} (own br {:.6}) vanilla {ex_v:.6}", v.game_value(), s.exploitability());
    assert!((ours - v.game_value()).abs() < 1e-3);
    assert!((ex_o - s.exploitability()).abs() < 1e-3);
    assert!(ex_o < 1e-3 && ex_v < 1e-3);
}
