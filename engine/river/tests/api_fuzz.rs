//! Robustness: the browser feeds arbitrary JSON/paths into `Session`. It must never panic (a wasm
//! panic poisons the worker), never hang, never exceed the budget and never emit NaN/inf.
use gto_river::api::Session;
use serde_json::{json, Value};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::time::Instant;

fn base() -> Value {
    json!({"board":"As Kd 7c 4h 2s","ranges":[{"AhAd":1,"QhQd":1,"JhTh":1},{"KhKc":1,"QsJs":0.5,"9h9d":1}],
        "streets":[{"pot":10,"stack":50,"sizes":[0.5],"raise_cap":1}],"budget_mb":256})
}
fn with(f: impl FnOnce(&mut Value)) -> Value { let mut v = base(); f(&mut v); v }

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 { self.0 ^= self.0 << 13; self.0 ^= self.0 >> 7; self.0 ^= self.0 << 17; self.0 }
    fn pick<'a, T>(&mut self, v: &'a [T]) -> &'a T { &v[(self.next() % v.len() as u64) as usize] }
}

/// Opens a session from `cfg` and exercises step/query; panics (test failure) on non-finite output.
fn exercise(cfg: &str, label: &str) {
    let t = Instant::now();
    let r = catch_unwind(AssertUnwindSafe(|| {
        let Ok(mut s) = Session::new(cfg) else { return };
        for n in [0u32, 1, 3] {
            let e = s.step(n);
            assert!(e.is_finite(), "non-finite exploitability {e}");
        }
        for p in ["[]", "[0]", "[0,0]", "[1]", "[99]", "[4294967295]", "[0,0,0,0,0,0,0,0,0,0]", "[-1]", "{}", "", "null", "[1.5]", "[\"a\"]", "[0,51]"] {
            if let Ok(js) = s.query(p) {
                assert!(!js.contains("null") && !js.contains("NaN") && !js.contains("inf"), "bad value in query {p}: {}", &js[..js.len().min(200)]);
            }
        }
        // walk every first-level child
        let _ = s.dump(2).map(|d| d.iter().for_each(|n| {
            assert!(n.view.strategy.iter().chain(&n.view.ev).chain(&n.view.range).all(|x| x.is_finite()));
        }));
    }));
    assert!(r.is_ok(), "PANIC [{label}] cfg={cfg}");
    assert!(t.elapsed().as_secs() < 30, "HANG [{label}] took {:?} cfg={cfg}", t.elapsed());
}

#[test]
fn malformed_json_and_shapes() {
    for (i, c) in ["", "{", "[]", "null", "42", "\"x\"", "{}", "{\"board\":1}", "\u{0}", "{\"board\":\"As Kd 7c\",\"ranges\":[],\"streets\":[]}",
        "{\"board\":\"As Kd 7c\",\"ranges\":[[],[]],\"streets\":[]}"].iter().enumerate() {
        exercise(c, &format!("shape{i}"));
        assert!(Session::new(c).is_err());
    }
    // extra / duplicate / wrongly-typed fields
    exercise(&with(|v| v["extra"] = json!({"a": [1, 2]})).to_string(), "extra");
    exercise(&with(|v| v["iso"] = json!("yes")).to_string(), "iso-type");
    assert!(Session::new(&with(|v| v["iso"] = json!("yes")).to_string()).is_err());
    exercise(&with(|v| v["streets"][0]["pot"] = json!("10")).to_string(), "pot-str");
    exercise(r#"{"board":"As Kd 7c 4h 2s","board":"2c 3c 4c","ranges":[{"AhAd":1},{"KhKc":1}],"streets":[{"pot":1,"stack":1,"sizes":[],"raise_cap":0}]}"#, "dup-key");
}

#[test]
fn boards() {
    for (i, b) in ["", "As", "As Kd", "As Kd 7c 4h 2s 3s", "As As Kd", "As Kd 7c 7c", "As Kd 7c 4h 4h", "Xx Kd 7c", "as kd 7c", "1s 2s 3s",
        "As Kd 7c 4h 2s 3s 4s 5s 6s", "Aé Kd 7c", "A\u{1F600} Kd 7c", "AsKd7c"].iter().enumerate() {
        let c = with(|v| v["board"] = json!(b)).to_string();
        exercise(&c, &format!("board{i}"));
        assert!(Session::new(&c).is_err(), "board {b:?} must be rejected");
    }
}

#[test]
fn ranges() {
    let dense = |f: &dyn Fn(usize) -> f64| json!((0..1326).map(f).collect::<Vec<_>>());
    let mut cases: Vec<(String, Value)> = vec![];
    for (n, w) in [("neg", -1.0), ("big", 2.0), ("huge", 1e30), ("tiny", 1e-40)] {
        cases.push((format!("sparse-{n}"), json!({"AhAd": w, "KhKc": 1})));
    }
    cases.push(("empty-sparse".into(), json!({})));
    cases.push(("all-zero".into(), dense(&|_| 0.0)));
    cases.push(("short".into(), json!([1, 1, 1])));
    cases.push(("long".into(), json!(vec![1.0; 2000])));
    cases.push(("dense-neg".into(), dense(&|i| if i == 5 { -1.0 } else { 1.0 })));
    cases.push(("dense-big".into(), dense(&|i| if i == 5 { 3.0 } else { 1.0 })));
    cases.push(("dense-1e39".into(), dense(&|_| 1e39))); // overflows f32 on parse
    cases.push(("blocked".into(), json!({"AsKd": 1, "As7c": 1, "Kd4h": 1}))); // every combo shares a board card
    for k in ["AhAh", "Ah", "AhAdKs", "é", "aéa", "Ah\u{1F600}", "AhXd", "ahad", "", "Ah Ad", "AhAd\n"] {
        cases.push((format!("key-{k:?}"), json!({ k: 1 })));
    }
    for (name, r) in cases {
        for side in 0..2 {
            let c = with(|v| v["ranges"][side] = r.clone()).to_string();
            exercise(&c, &format!("range-{name}-{side}"));
        }
    }
    // non-finite weights are not representable in JSON but may arrive as bare tokens
    for tok in ["NaN", "Infinity", "-Infinity", "1e999", "-1e999"] {
        let c = base().to_string().replace("\"AhAd\":1", &format!("\"AhAd\":{tok}"));
        exercise(&c, tok);
        assert!(Session::new(&c).is_err(), "{tok}");
    }
    // blocked / empty ranges are errors, not NaN exploitability
    for r in [json!({}), json!({"AsKd": 1}), json!(vec![0.0; 1326])] {
        assert!(Session::new(&with(|v| v["ranges"][0] = r.clone()).to_string()).is_err());
    }
    // weights above 1 / below 0 rejected
    for w in [json!(-0.5), json!(1.5)] {
        assert!(Session::new(&with(|v| v["ranges"][0]["AhAd"] = w.clone()).to_string()).is_err());
    }
}

#[test]
fn chips_sizes_caps_budget() {
    let st = |pot: Value, stack: Value, sizes: Value, cap: Value| json!([{"pot": pot, "stack": stack, "sizes": sizes, "raise_cap": cap}]);
    let mut cases: Vec<(&str, Value)> = vec![
        ("pot0", st(json!(0), json!(50), json!([0.5]), json!(1))),
        ("potneg", st(json!(-10), json!(50), json!([0.5]), json!(1))),
        ("pothuge", st(json!(1e30), json!(50), json!([0.5]), json!(1))),
        ("stack0", st(json!(10), json!(0), json!([0.5]), json!(1))),
        ("stackneg", st(json!(10), json!(-5), json!([0.5]), json!(1))),
        ("stackhuge", st(json!(10), json!(1e30), json!([0.5]), json!(1))),
        ("stack<bet", st(json!(10), json!(0.001), json!([2.0]), json!(3))),
        ("stack-tiny", st(json!(10), json!(1e-30), json!([0.5]), json!(1))),
        ("sizes-empty", st(json!(10), json!(50), json!([]), json!(3))),
        ("sizes-neg", st(json!(10), json!(50), json!([-0.5, -1e9]), json!(2))),
        ("sizes-zero", st(json!(10), json!(50), json!([0, 0]), json!(2))),
        ("sizes-huge", st(json!(10), json!(50), json!([1e30, 3.4e38]), json!(2))),
        ("sizes-dups", st(json!(10), json!(50), json!([0.5, 0.5, 0.5, 0.5]), json!(3))),
        ("sizes-many", st(json!(10), json!(50), json!((1..2000).map(|i| i as f64 / 7.0).collect::<Vec<_>>()), json!(3))),
        ("sizes-tiny", st(json!(10), json!(1e9), json!([1e-9]), json!(16))),
        ("cap0", st(json!(10), json!(50), json!([0.5]), json!(0))),
        ("cap-huge", st(json!(10), json!(50), json!([0.1, 0.2, 0.3]), json!(4294967295u64))),
        ("cap-over", st(json!(10), json!(50), json!([0.1, 0.2, 0.3]), json!(4294967296u64))),
        ("cap-neg", st(json!(10), json!(50), json!([0.5]), json!(-1))),
        ("cap-float", st(json!(10), json!(50), json!([0.5]), json!(1.5))),
        ("explode", st(json!(10), json!(1e9), json!((1..=16).map(|i| i as f64 * 0.1).collect::<Vec<_>>()), json!(16))),
    ];
    let too_many = json!([{"pot":10,"stack":50,"sizes":[0.5],"raise_cap":1}, {"pot":10,"stack":50,"sizes":[0.5],"raise_cap":1}]);
    cases.push(("too-many-streets", too_many));
    cases.push(("no-streets", json!([])));
    let accepted = ["stack<bet", "stack-tiny", "sizes-empty", "sizes-dups", "cap0", "pot-ok"];
    for (n, s) in cases {
        let c = with(|v| v["streets"] = s.clone()).to_string();
        exercise(&c, n);
        let ok = Session::new(&c).is_ok();
        // everything except benign shapes must be rejected cleanly
        if !accepted.contains(&n) && !matches!(n, "sizes-tiny" | "explode") {
            assert!(!ok, "{n} must be rejected");
        }
    }
    // budget
    for b in [json!(0), json!(1), json!(u64::MAX), json!(-1), json!(1e30), json!("big"), json!(null)] {
        exercise(&with(|v| v["budget_mb"] = b.clone()).to_string(), "budget");
    }
    assert!(Session::new(&with(|v| v["budget_mb"] = json!(0)).to_string()).is_err(), "0 MiB budget must reject");
    assert!(Session::new(&with(|v| v["budget_mb"] = json!(u64::MAX)).to_string()).is_ok(), "huge budget must not overflow to 0");
}

#[test]
fn buckets_and_flags() {
    for b in [json!(0), json!(1), json!(2), json!(1326), json!(1327), json!(100000), json!(usize::MAX as u64), json!(-1), json!(null)] {
        exercise(&with(|v| v["buckets"] = b.clone()).to_string(), &format!("buckets {b}"));
    }
    assert!(Session::new(&with(|v| v["buckets"] = json!(0)).to_string()).is_err());
    assert!(Session::new(&with(|v| v["buckets"] = json!(5000)).to_string()).is_err());
    for (iso, comp) in [(true, true), (false, true), (true, false)] {
        exercise(&with(|v| { v["iso"] = json!(iso); v["compress"] = json!(comp); }).to_string(), "flags");
    }
}

#[test]
fn step_and_query_misuse() {
    let mut s = Session::new(&base().to_string()).unwrap();
    let e0 = s.step(0);
    assert!(e0.is_finite());
    assert_eq!(s.iters(), 0);
    s.step(5);
    // step on a tree with no further decisions (river, all-in preflop equivalent): still fine
    let c = with(|v| v["streets"][0] = json!({"pot":10,"stack":0.5,"sizes":[],"raise_cap":0})).to_string();
    let mut s2 = Session::new(&c).unwrap();
    assert!(s2.step(10).is_finite());
    // walk into a terminal then keep going
    let v = s2.query("[0]");
    assert!(v.is_ok() || v.is_err());
    assert!(s2.query("[0,0,0]").is_err());
    // paths: deep, huge ids, negative, wrong types
    let long = format!("[{}]", vec!["0"; 100_000].join(","));
    assert!(s.query(&long).is_err());
    for p in ["[4294967296]", "[18446744073709551616]", "[null]", "[[0]]", "0", "[0,", "[0,]", "[ ]"] {
        let _ = s.query(p); // Ok or Err, never panic
    }
    // step u32::MAX is clamped, not an infinite loop (use a trivial tree)
    let c = with(|v| { v["streets"][0] = json!({"pot":10,"stack":10,"sizes":[],"raise_cap":0}); v["ranges"] = json!([{"AhAd":1},{"KhKc":1}]); }).to_string();
    let t = Instant::now();
    let mut s3 = Session::new(&c).unwrap();
    s3.step(u32::MAX);
    assert!(t.elapsed().as_secs() < 120);
    assert!(s3.iters() <= gto_river::api::MAX_STEP);
}

#[test]
fn seeded_random_mutations() {
    let mut rng = Rng(0x9E3779B97F4A7C15);
    let nums = [json!(0), json!(-1), json!(1e-30), json!(1e30), json!(0.5), json!(1), json!(7), json!(4294967295u64), json!(1e308), json!(-0.0), json!(null), json!("x"), json!([]), json!({}), json!(true)];
    let boards = ["As Kd 7c 4h 2s", "As Kd 7c 4h", "As Kd 7c", "As Kd 7c 4h 2s 2s", "2c 2d 2h 2s Ac", "As Ks Qs Js Ts"];
    for i in 0..300 {
        let mut v = base();
        let b = *rng.pick(&boards);
        v["board"] = json!(b);
        let n = b.split(' ').count();
        let streets: Vec<Value> = (0..(6 - n.min(5)).max(1)).map(|_| json!({"pot": 10, "stack": 50, "sizes": [0.5, 1.0], "raise_cap": 1})).collect();
        v["streets"] = Value::Array(streets);
        for _ in 0..(1 + rng.next() % 3) {
            let which = rng.next() % 8;
            let val = rng.pick(&nums).clone();
            let st = (rng.next() % v["streets"].as_array().unwrap().len() as u64) as usize;
            match which {
                0 => v["streets"][st]["pot"] = val,
                1 => v["streets"][st]["stack"] = val,
                2 => v["streets"][st]["raise_cap"] = val,
                3 => v["streets"][st]["sizes"] = json!([val]),
                4 => v["buckets"] = val,
                5 => v["budget_mb"] = val,
                6 => v["ranges"][(rng.next() % 2) as usize]["AhAd"] = val,
                _ => v["streets"][st]["sizes"] = json!([val, 0.5, val]),
            }
        }
        // flop/turn configs are far larger; keep them under a tight budget so rejection is exercised too
        if n < 5 { v["budget_mb"] = json!(64); }
        exercise(&v.to_string(), &format!("rand{i}"));
    }
}
