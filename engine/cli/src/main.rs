//! `gto solve --config x.json --out x.gtos [--iters N] [--target PCT] [--depth D]`
//! Config: `gto_river::api::JsonConfig` JSON. Output: `gto_river::api::Gtos` JSON
//! (format "gtos-1": config, iters, expl_pct, nodes = root + descendants to --depth, default 1).
//! `gto precompute --out DIR [--iters N] [--preflop-boards N] [--preflop-iters N]`
//! Writes a small library to DIR: `preflop-hu-100bb.json` (gto_abstraction::preflop::PreflopSolution),
//! `gto precompute --realisation --out DIR [--r-file F] [--flops N] [--street-iters N] [--buckets N] [--menu 0|1|2] [--pots 0,1,2,3]`
//! instead fits the realisation table (one round) and writes DIR/realisation-fit.json (`RealisationFile`);
//! `--r-file F` (any precompute run) loads a fitted table instead of the parametric prior.
//! `turn-AsKd7c4h-b50.gtos` (bucketed turn spot, 50 buckets/board, full-range vs full-range,
//! root + children) and `index.json` listing the files with their exploitability.
use gto_abstraction::preflop::{prior_r, EquityTable, PreflopConfig, PreflopSolver, NC};
use gto_abstraction::realisation::{fit_table, load_r, FitOpts, RealisationFile, FORMAT};
use gto_river::api::{Gtos, JsonConfig, RangeJson, Session, StreetJson};

fn precompute(args: &[String]) -> Result<(), String> {
    let (mut out, mut iters, mut pb, mut pi) = (None, 150u32, 2000usize, 2000u32);
    let (mut real, mut rfile, mut fo, mut pots) = (false, None, FitOpts::default(), vec![0usize, 1, 2, 3]);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "--realisation" {
            real = true;
            continue;
        }
        let v = it.next().ok_or(format!("missing value for {a}"))?;
        match a.as_str() {
            "--out" => out = Some(v.clone()),
            "--iters" => iters = v.parse().map_err(|_| "bad --iters")?,
            "--preflop-boards" => pb = v.parse().map_err(|_| "bad --preflop-boards")?,
            "--preflop-iters" => pi = v.parse().map_err(|_| "bad --preflop-iters")?,
            "--r-file" => rfile = Some(v.clone()),
            "--flops" => fo.flops = v.parse().map_err(|_| "bad --flops")?,
            "--street-iters" => fo.iters = v.parse().map_err(|_| "bad --street-iters")?,
            "--buckets" => fo.buckets = v.parse().map_err(|_| "bad --buckets")?,
            "--menu" => fo.menu = v.parse().map_err(|_| "bad --menu")?,
            "--pots" => pots = v.split(',').map(|x| x.parse().map_err(|_| "bad --pots".to_string())).collect::<Result<_, _>>()?,
            _ => return Err(format!("unknown flag {a}")),
        }
    }
    let dir = std::path::PathBuf::from(out.ok_or("--out required")?);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let eq = EquityTable::compute(pb);
    let cfg = PreflopConfig::default();
    let mut pf = match &rfile {
        Some(f) => PreflopSolver::with_r(&cfg, &eq, load_r(f)?)?,
        None => PreflopSolver::new(&cfg, &eq),
    };
    pf.solve(pi);
    if real {
        let mut spots = pf.pot_spots();
        for (pt, s) in spots.iter_mut().enumerate() {
            if !pots.contains(&pt) {
                *s = None;
            }
        }
        let prior = match &rfile { Some(f) => load_r(f)?, None => prior_r(&cfg, &eq) };
        let (r, stats) = fit_table(&spots, cfg.stack, &eq, &prior, &fo, |s| {
            eprintln!("pot {} flop {:?} {:.1}s est {:.0}MB iters {} expl {:.2}% sbshare {:.3}",
                s.pot_type, s.flop, s.secs, s.est_mem_bytes as f64 / 1e6, s.iters, s.expl_pct, s.mean_sb_share);
        })?;
        let meta = serde_json::json!({"flops": fo.flops, "street_iters": fo.iters, "buckets": fo.buckets, "menu": fo.menu, "seed": fo.seed,
            "pots": pots, "preflop_iters": pf.iters, "classes": NC, "solves": stats.len(),
            "stats": stats.iter().map(|s| serde_json::to_value(s).unwrap()).collect::<Vec<_>>()});
        let f = RealisationFile { format: FORMAT.into(), r, meta };
        return std::fs::write(dir.join("realisation-fit.json"), serde_json::to_vec(&f).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string());
    }
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
