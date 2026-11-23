use gto_core::{Game, Params, Solver};
use gto_games::{Kuhn, Leduc};

fn run<G: Game>(g: &G, p: Params, n: u32) -> Solver<'_, G> {
    let mut s = Solver::new(g, p);
    for _ in 0..n { s.iterate(); }
    s
}

#[test]
fn kuhn_value_and_expl() {
    let s = run(&Kuhn, Params::dcfr(), 10_000);
    assert!((s.game_value() + 1.0 / 18.0).abs() < 1e-3, "{}", s.game_value());
    assert!(s.exploitability() < 1e-3, "{}", s.exploitability());
}

#[test]
fn leduc_expl() {
    let s = run(&Leduc, Params::dcfr(), 10_000);
    assert!(s.exploitability() < 0.01, "{}", s.exploitability());
}

fn iters_to(p: Params, target: f64) -> u32 {
    let mut s = Solver::new(&Kuhn, p);
    for i in 1..=10_000 {
        s.iterate();
        if i % 10 == 0 && s.exploitability() < target { return i; }
    }
    u32::MAX
}

#[test]
fn dcfr_not_slower_than_cfr_plus_on_kuhn() {
    let (d, c) = (iters_to(Params::dcfr(), 1e-3), iters_to(Params::cfr_plus(), 1e-3));
    println!("dcfr {d} cfr+ {c}");
    assert!(d <= c && d != u32::MAX);
}
