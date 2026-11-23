use gto_river::api::Gtos;
use std::process::Command;

#[test]
fn solve_and_reload() {
    let dir = std::env::temp_dir().join(format!("gto-cli-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let (cfg, out) = (dir.join("x.json"), dir.join("x.gtos"));
    std::fs::write(&cfg, r#"{"board":"As Kd 7c 4h 2s","ranges":[{"AhAd":1,"QhQd":1,"JhTh":1},{"KhKc":1,"QsJs":1,"9h9d":1}],
        "streets":[{"pot":10,"stack":50,"sizes":[0.5],"raise_cap":1}]}"#).unwrap();
    let st = Command::new(env!("CARGO_BIN_EXE_gto"))
        .args(["solve", "--config", cfg.to_str().unwrap(), "--out", out.to_str().unwrap(), "--iters", "100", "--target", "0"])
        .status().unwrap();
    assert!(st.success());
    let g: Gtos = serde_json::from_slice(&std::fs::read(&out).unwrap()).unwrap();
    assert_eq!(g.format, "gtos-1");
    assert_eq!(g.iters, 100);
    assert!(g.expl_pct < 5.0, "{}", g.expl_pct);
    let root = &g.nodes[0].view;
    assert_eq!(root.kind, "action");
    // Strategy rows sum to 1 for every combo.
    for h in 0..1326 {
        let t: f32 = (0..root.n).map(|a| root.strategy[a * 1326 + h]).sum();
        assert!((t - 1.0).abs() < 1e-3);
    }
    assert!(g.nodes.len() > 1);
    let _ = std::fs::remove_dir_all(&dir);
}
