//! `gto solve --config x.json --out x.gtos [--iters N] [--target PCT] [--depth D]`
//! Config: `gto_river::api::JsonConfig` JSON. Output: `gto_river::api::Gtos` JSON
//! (format "gtos-1": config, iters, expl_pct, nodes = root + descendants to --depth, default 1).
//! `gto precompute --out DIR [--iters N] [--preflop-boards N] [--preflop-iters N]`
//! Writes a small library to DIR: `preflop-hu-100bb.json` (gto_abstraction::preflop::PreflopSolution),
//! `turn-AsKd7c4h-b50.gtos` (bucketed turn spot, 50 buckets/board, full-range vs full-range,
//! root + children) and `index.json` listing the files with their exploitability.
use gto_abstraction::preflop::{EquityTable, PreflopConfig, PreflopSolver};
use gto_river::api::{Gtos, JsonConfig, RangeJson, Session, StreetJson};

fn precompute(args: &[String]) -> Result<(), String> {
    let (mut out, mut iters, mut pb, mut pi) = (None, 150u32, 2000usize, 2000u32);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let v = it.next().ok_or(format!("missing value for {a}"))?;
        match a.as_str() {
            "--out" => out = Some(v.clone()),
            "--iters" => iters = v.parse().map_err(|_| "bad --iters")?,
            "--preflop-boards" => pb = v.parse().map_err(|_| "bad --preflop-boards")?,
            "--preflop-iters" => pi = v.parse().map_err(|_| "bad --preflop-iters")?,
            _ => return Err(format!("unknown flag {a}")),
        }
    }
    let dir = std::path::PathBuf::from(out.ok_or("--out required")?);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let eq = EquityTable::compute(pb);
    let mut pf = PreflopSolver::new(&PreflopConfig::default(), &eq);
    pf.solve(pi);
    let sol = pf.solution();
    let mut index = vec![serde_json::json!({"file": "preflop-hu-100bb.json", "kind": "preflop", "expl_mbb_per_hand": sol.expl_mbb})];
    std::fs::write(dir.join("preflop-hu-100bb.json"), serde_json::to_vec(&sol).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let st = |cap| StreetJson { pot: 20.0, stack: 100.0, sizes: vec![0.5], raise_cap: cap };
    let full = || RangeJson::Dense(vec![1.0; 1326]);
    let config = JsonConfig {
        board: "As Kd 7c 4h".into(), ranges: [full(), full()], streets: vec![st(2), st(1)],
        iso: true, compress: false, buckets: Some(50), budget_mb: None,
    };
    let mut s = Session::from_config(&config)?;
    s.step(iters);
    let expl = s.exploitability_pct();
    let g = Gtos { format: "gtos-1".into(), config, iters: s.iters(), expl_pct: expl, nodes: s.dump(1)? };
    std::fs::write(dir.join("turn-AsKd7c4h-b50.gtos"), serde_json::to_vec(&g).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    index.push(serde_json::json!({"file": "turn-AsKd7c4h-b50.gtos", "kind": "turn", "expl_pct_pot_real_game": expl}));
    std::fs::write(dir.join("index.json"), serde_json::to_vec_pretty(&index).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

fn run(args: &[String]) -> Result<(), String> {
    if args.first().map(String::as_str) == Some("precompute") {
        return precompute(&args[1..]);
    }
    if args.first().map(String::as_str) != Some("solve") {
        return Err("usage: gto solve --config x.json --out x.gtos [--iters N] [--target PCT] [--depth D] | gto precompute --out DIR".into());
    }
    let (mut cfg, mut out, mut iters, mut target, mut depth) = (None, None, 200u32, 0.3f32, 1u32);
    let mut it = args[1..].iter();
    while let Some(a) = it.next() {
        let v = it.next().ok_or(format!("missing value for {a}"))?;
        match a.as_str() {
            "--config" => cfg = Some(v.clone()),
            "--out" => out = Some(v.clone()),
            "--iters" => iters = v.parse().map_err(|_| "bad --iters")?,
            "--target" => target = v.parse().map_err(|_| "bad --target")?,
            "--depth" => depth = v.parse().map_err(|_| "bad --depth")?,
            _ => return Err(format!("unknown flag {a}")),
        }
    }
    let (cfg, out) = (cfg.ok_or("--config required")?, out.ok_or("--out required")?);
    let config: JsonConfig = serde_json::from_str(&std::fs::read_to_string(&cfg).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let mut s = Session::from_config(&config)?;
    let mut expl = s.exploitability_pct();
    while s.iters() < iters && expl > target {
        expl = s.step(10.min(iters - s.iters()));
        eprintln!("iters {} expl {expl:.4}% pot", s.iters());
    }
    let g = Gtos { format: "gtos-1".into(), config, iters: s.iters(), expl_pct: expl, nodes: s.dump(depth)? };
    std::fs::write(&out, serde_json::to_vec(&g).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Err(e) = run(&args) {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}
