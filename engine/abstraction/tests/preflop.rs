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
    let cfg = PreflopConfig { open: 2.0, three_bet: 7.0, four_bet: 18.0, iso: 3.5, ..Default::default() };
    let mut s = PreflopSolver::new(&cfg, &eq);
    let mut prev = f64::MAX;
    for _ in 0..16 {
        s.solve(125);
        let e = s.exploitability() * 1000.0;
        println!("iters {} expl {e:.2} mbb/hand", s.iters);
        prev = e;
    }
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
    assert!((0.7..1.0).contains(&defend), "defend {defend}");
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
