use gto_river::cards::{combos, parse_cards};
use gto_river::street::{estimate_memory, StreetConfig, StreetSolver};
use gto_river::tree::TreeConfig;

fn hash(x: u64) -> f32 {
    let x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    let x = (x ^ (x >> 29)).wrapping_mul(0x9E3779B97F4A7C15);
    ((x >> 40) as f32 / (1u64 << 24) as f32).powi(2)
}
/// Invariant under suit permutations (depends on ranks and suitedness only).
fn sym_range(seed: u64) -> Vec<f32> {
    combos().iter().map(|&(a, b)| {
        let (ra, rb) = (a / 4, b / 4);
        hash(seed * 1000 + (ra.max(rb) as u64) * 16 + ra.min(rb) as u64 * 2 + ((a & 3) == (b & 3)) as u64)
    }).collect()
}
fn rnd_range(seed: u64) -> Vec<f32> {
    (0..1326u64).map(|i| hash(seed * 7919 + i)).collect()
}
fn tc(pot: f32, sizes: &[f32], cap: u32) -> TreeConfig {
    TreeConfig { pot, stack: 100.0, sizes: sizes.to_vec(), raise_cap: cap }
}
fn cfg(board: &str, r: [Vec<f32>; 2], iso: bool, compress: bool) -> StreetConfig {
    let board = parse_cards(board);
    let streets = if board.len() == 4 { vec![tc(20.0, &[0.5], 2), tc(20.0, &[0.5], 1)] }
        else { vec![tc(20.0, &[0.5], 1), tc(20.0, &[], 0), tc(20.0, &[], 0)] };
    StreetConfig { board, ranges: r, streets, iso, compress }
}
fn run(c: &StreetConfig, iters: u32) -> f32 {
    let mut s = StreetSolver::new(c, 8 << 30).unwrap();
    let t = std::time::Instant::now();
    println!("start expl {:.3}% pot", s.exploitability_pct());
    s.solve(iters);
    let e = s.exploitability_pct();
    println!("iters {iters} expl {e:.4}% pot ({:.1}s)", t.elapsed().as_secs_f32());
    e
}

#[test]
fn turn_solve_reaches_target() {
    let e = run(&cfg("As Kd 7c 4h", [rnd_range(1), rnd_range(2)], true, false), 200);
    assert!(e < 1.0, "{e}");
}

#[test]
fn iso_matches_unabridged() {
    let r = [sym_range(1), sym_range(2)];
    let a = run(&cfg("Ks Kh 7d 7c", r.clone(), true, false), 150);
    let b = run(&cfg("Ks Kh 7d 7c", r, false, false), 150);
    println!("iso {a:.4} vs full {b:.4}");
    assert!((a - b).abs() < 0.15 && a < 1.0 && b < 1.0);
    let r = [sym_range(1), sym_range(2)];
    let (mi, mf) = (estimate_memory(&cfg("Ks Kh 7d 7c", r.clone(), true, false), u64::MAX).unwrap(),
        estimate_memory(&cfg("Ks Kh 7d 7c", r, false, false), u64::MAX).unwrap());
    println!("iso mem {mi} vs full {mf}");
    assert!(mi < mf * 6 / 10);
}

#[test]
fn memory_estimate() {
    let c = cfg("As Kd 7c 4h", [rnd_range(1), rnd_range(2)], false, false);
    let m = estimate_memory(&c, u64::MAX).unwrap();
    let mut cc = c.clone();
    cc.compress = true;
    let mc = estimate_memory(&cc, u64::MAX).unwrap();
    println!("turn est {m} bytes, compressed {mc}");
    assert!(mc < m * 6 / 10 && estimate_memory(&c, m - 1).is_err() && StreetSolver::new(&c, 1000).is_err());
    let f = cfg("As Kd 7c", [rnd_range(1), rnd_range(2)], false, false);
    println!("flop est {} bytes", estimate_memory(&f, u64::MAX).unwrap());
    assert!(estimate_memory(&f, 1 << 20).is_err());
}

#[test]
fn compressed_close_to_f32() {
    let r = [rnd_range(3), rnd_range(4)];
    let a = run(&cfg("As Kd 7c 4h", r.clone(), true, false), 150);
    let b = run(&cfg("As Kd 7c 4h", r, true, true), 150);
    println!("f32 {a:.4} vs i16 {b:.4}");
    assert!((a - b).abs() < 0.2);
}

#[test]
fn flop_solve_runs() {
    let e = run(&cfg("Ks Qs 7s", [sym_range(1), sym_range(2)], true, true), 20);
    assert!(e < 5.0, "{e}");
}
