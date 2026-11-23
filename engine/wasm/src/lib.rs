//! wasm-bindgen bindings (single-threaded; rayon is disabled for this crate).
//! JS: `const s = new Solver(cfgJson); s.step(50) -> expl % pot; s.query("[0,1]") -> JSON; s.free()`.
use gto_river::api::Session;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct Solver(Session);

#[wasm_bindgen]
impl Solver {
    #[wasm_bindgen(constructor)]
    pub fn new(config_json: &str) -> Result<Solver, String> {
        Session::new(config_json).map(Solver)
    }
    pub fn step(&mut self, n: u32) -> f32 {
        self.0.step(n)
    }
    pub fn query(&self, path_json: &str) -> Result<String, String> {
        self.0.query(path_json)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn step_and_query() {
        let cfg = r#"{"board":"As Kd 7c 4h 2s","ranges":[{"AhAd":1,"QhQd":1,"JhTh":1},{"KhKc":1,"QsJs":1,"9h9d":1}],
            "streets":[{"pot":10,"stack":50,"sizes":[0.5],"raise_cap":1}]}"#;
        let mut s = Solver::new(cfg).unwrap();
        let e0 = s.step(1);
        let e1 = s.step(100);
        assert!(e1 < e0, "{e0} -> {e1}");
        let v: serde_json_shim::V = serde_json_shim::parse(&s.query("[]").unwrap());
        assert_eq!(v.0, "action");
        assert!(s.query("[99]").is_err());
        assert!(Solver::new("{").is_err());
    }
    // Avoid a serde_json dev-dependency: just check the kind field textually.
    mod serde_json_shim {
        pub struct V(pub String);
        pub fn parse(s: &str) -> V {
            let i = s.find("\"kind\":\"").unwrap() + 8;
            V(s[i..].split('"').next().unwrap().to_string())
        }
    }
}
