//! Reproducible benchmark: `cargo run --release --example bench -- [flop|turn] [iters] [dumpfile]`.
//! Fixed boards, deterministic pseudo-random ranges. Prints phase timings, expl, and writes a strategy dump.
use gto_river::cards::{combos, parse_cards};
use gto_river::street::{StreetConfig, StreetSolver};
use gto_river::tree::TreeConfig;
use std::time::Instant;

fn range(seed: u64, frac: f64) -> Vec<f32> {
    combos().iter().enumerate().map(|(i, _)| {
        let mut x = (i as u64 + 1).wrapping_mul(0x9E3779B97F4A7C15) ^ seed.wrapping_mul(0xD1B54A32D192ED03);
        x ^= x >> 29; x = x.wrapping_mul(0xBF58476D1CE4E5B9); x ^= x >> 32;
        let u = (x >> 11) as f64 / (1u64 << 53) as f64;
        if u < frac { (0.25 + 0.75 * ((x & 255) as f64 / 255.0)) as f32 } else { 0.0 }
    }).collect()
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let mode = a.get(1).map(|s| s.as_str()).unwrap_or("flop");
    let iters: u32 = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(300);
    let t = |sizes: Vec<f32>, cap| TreeConfig { pot: 6.0, stack: 97.0, sizes, raise_cap: cap };
    let (board, streets) = if mode == "flop" {
        ("Ks 8d 3c", vec![t(vec![0.33, 0.75, 100.0], 1), t(vec![100.0], 1), t(vec![100.0], 1)])
    } else {
        ("Ks 8d 3c 9h", vec![t(vec![0.75, 100.0], 1), t(vec![100.0], 1)])
    };
    let cfg = StreetConfig { board: parse_cards(board), ranges: [range(1, 0.5), range(2, 0.4)], streets, iso: true, compress: true, buckets: Some(16) };
    let t0 = Instant::now();
    let mut s = StreetSolver::new(&cfg, 4 << 30).unwrap();
    let build = t0.elapsed().as_secs_f32();
    let t1 = Instant::now();
    s.solve(iters);
    let solve = t1.elapsed().as_secs_f32();
    let t2 = Instant::now();
    let e = s.exploitability_pct();
    let ex = t2.elapsed().as_secs_f32();
    let t3 = Instant::now();
    let (e0, e1) = (s.root_ev(0), s.root_ev(1));
    let rev = t3.elapsed().as_secs_f32();
    println!("{mode} build {build:.2}s solve {solve:.2}s ({:.2} it/s) expl_call {ex:.2}s root_ev x2 {rev:.2}s expl {e:.6}%", iters as f32 / solve);
    if let Some(p) = a.get(3) {
        let mut out = String::new();
        out += &format!("expl {e:.6}\n");
        for (name, v) in [("ev0", &e0), ("ev1", &e1)] { out += &format!("{name} {:?}\n", v); }
        let mut d = vec![];
        for path in [vec![], vec![0], vec![1], vec![0, 0], vec![1, 0], vec![1, 1]] {
            if let Ok(n) = s.query(&path) { d.push((path, n.strategy, n.ev)); }
        }
        out += &format!("{:?}\n", d);
        std::fs::write(p, out).unwrap();
    }
}
