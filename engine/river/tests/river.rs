use gto_river::cards::{combos, parse_cards};
use gto_river::solver::{RiverConfig, RiverSolver};
use gto_river::tree::TreeConfig;

fn range(seed: u64) -> Vec<f32> {
    let mut x = seed;
    combos().iter().map(|_| {
        x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((x >> 40) as f32 / (1u64 << 24) as f32).powi(2) // skewed random weights
    }).collect()
}

#[test]
fn river_spot_under_0_3_pct_pot() {
    let b = parse_cards("As Kd 7c 4h 2s");
    let cfg = RiverConfig {
        board: [b[0], b[1], b[2], b[3], b[4]],
        ranges: [range(1), range(2)],
        tree: TreeConfig { pot: 100.0, stack: 200.0, sizes: vec![0.5, 1.0], raise_cap: 3 },
    };
    let mut s = RiverSolver::new(&cfg);
    let e0 = s.exploitability_pct();
    s.solve(1000);
    let e = s.exploitability_pct();
    println!("expl% pot: start {e0:.3}, after 1000 iters {e:.4}");
    assert!(e < 0.3, "exploitability {e}% pot");
}
