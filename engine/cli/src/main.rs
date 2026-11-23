//! `gto solve --config x.json --out x.gtos [--iters N] [--target PCT] [--depth D]`
//! Config: `gto_river::api::JsonConfig` JSON. Output: `gto_river::api::Gtos` JSON
//! (format "gtos-1": config, iters, expl_pct, nodes = root + descendants to --depth, default 1).
use gto_river::api::{Gtos, JsonConfig, Session};

fn run(args: &[String]) -> Result<(), String> {
    if args.first().map(String::as_str) != Some("solve") {
        return Err("usage: gto solve --config x.json --out x.gtos [--iters N] [--target PCT] [--depth D]".into());
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
