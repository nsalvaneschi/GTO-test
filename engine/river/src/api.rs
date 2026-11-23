//! JSON-facing session API shared by the wasm bindings and the CLI.
//! Config JSON: see `JsonConfig`. Query path: JSON array of u32, an action index at Action
//! nodes and a (canonical) card id (rank*4+suit, 2c=0) at Chance nodes.
use crate::cards::{combos, parse_card};
use crate::street::{NodeView, StreetConfig, StreetSolver};
use crate::tree::{TreeConfig, H};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RangeJson {
    /// 1326 weights in combo order (c(a,b) with a<b over card ids, lexicographic).
    Dense(Vec<f32>),
    /// Sparse map such as {"AsKd": 1.0}; unlisted combos have weight 0.
    Sparse(HashMap<String, f32>),
}

#[derive(Clone, Serialize, Deserialize)]
pub struct StreetJson {
    pub pot: f32,
    pub stack: f32,
    pub sizes: Vec<f32>,
    pub raise_cap: u32,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct JsonConfig {
    /// e.g. "As Kd 7c 4h" (3-5 cards).
    pub board: String,
    /// [OOP, IP].
    pub ranges: [RangeJson; 2],
    /// One entry per remaining street.
    pub streets: Vec<StreetJson>,
    #[serde(default = "yes")]
    pub iso: bool,
    #[serde(default)]
    pub compress: bool,
    /// Memory budget in MiB (default 4096).
    pub budget_mb: Option<u64>,
}
fn yes() -> bool {
    true
}

fn card(s: &str) -> Result<u8, String> {
    let b = s.as_bytes();
    if b.len() != 2 || !"23456789TJQKA".contains(b[0] as char) || !"cdhs".contains(b[1] as char) {
        return Err(format!("bad card '{s}'"));
    }
    Ok(parse_card(s))
}

impl JsonConfig {
    pub fn to_street(&self) -> Result<StreetConfig, String> {
        let board = self.board.split_whitespace().map(card).collect::<Result<Vec<_>, _>>()?;
        if !(3..=5).contains(&board.len()) || self.streets.len() != 6 - board.len() {
            return Err("need 3-5 board cards and one street config per remaining street".into());
        }
        let cb = combos();
        let mut ranges: [Vec<f32>; 2] = [vec![], vec![]];
        for (i, r) in self.ranges.iter().enumerate() {
            ranges[i] = match r {
                RangeJson::Dense(v) if v.len() == H => v.clone(),
                RangeJson::Dense(_) => return Err(format!("range {i} must have {H} entries")),
                RangeJson::Sparse(m) => {
                    let mut v = vec![0.0f32; H];
                    for (k, &w) in m {
                        if k.len() != 4 {
                            return Err(format!("bad combo '{k}'"));
                        }
                        let (a, b) = (card(&k[..2])?, card(&k[2..])?);
                        let key = (a.min(b), a.max(b));
                        v[cb.iter().position(|&c| c == key).ok_or(format!("bad combo '{k}'"))?] = w;
                    }
                    v
                }
            };
        }
        let streets = self.streets.iter()
            .map(|s| TreeConfig { pot: s.pot, stack: s.stack, sizes: s.sizes.clone(), raise_cap: s.raise_cap })
            .collect();
        Ok(StreetConfig { board, ranges, streets, iso: self.iso, compress: self.compress })
    }
}

pub struct Session {
    solver: StreetSolver,
}

impl Session {
    pub fn new(config_json: &str) -> Result<Self, String> {
        let c: JsonConfig = serde_json::from_str(config_json).map_err(|e| e.to_string())?;
        let budget = c.budget_mb.unwrap_or(4096) << 20;
        Ok(Session { solver: StreetSolver::new(&c.to_street()?, budget)? })
    }
    pub fn from_config(c: &JsonConfig) -> Result<Self, String> {
        Ok(Session { solver: StreetSolver::new(&c.to_street()?, c.budget_mb.unwrap_or(4096) << 20)? })
    }
    /// Run `n` more iterations; returns exploitability in % of pot.
    pub fn step(&mut self, n: u32) -> f32 {
        self.solver.solve(n);
        self.solver.exploitability_pct()
    }
    pub fn iters(&self) -> u32 {
        self.solver.iters
    }
    pub fn exploitability_pct(&self) -> f32 {
        self.solver.exploitability_pct()
    }
    pub fn node(&self, path: &[u32]) -> Result<NodeView, String> {
        self.solver.query(path)
    }
    /// `path_json` is a JSON array of u32; returns the NodeView as JSON.
    pub fn query(&self, path_json: &str) -> Result<String, String> {
        let path: Vec<u32> = serde_json::from_str(path_json).map_err(|e| e.to_string())?;
        serde_json::to_string(&self.node(&path)?).map_err(|e| e.to_string())
    }
    /// All nodes at depth <= `depth` below the root (chance nodes count as one level).
    pub fn dump(&self, depth: u32) -> Result<Vec<DumpNode>, String> {
        let mut out = vec![];
        self.dump_rec(&mut vec![], depth, &mut out)?;
        Ok(out)
    }
    fn dump_rec(&self, path: &mut Vec<u32>, depth: u32, out: &mut Vec<DumpNode>) -> Result<(), String> {
        let view = self.node(path)?;
        let kids: Vec<u32> = match view.kind.as_str() {
            "action" => (0..view.n as u32).collect(),
            "chance" => view.cards.iter().map(|&c| c as u32).collect(),
            _ => vec![],
        };
        out.push(DumpNode { path: path.clone(), view });
        if depth > 0 {
            for k in kids {
                path.push(k);
                self.dump_rec(path, depth - 1, out)?;
                path.pop();
            }
        }
        Ok(())
    }
}

#[derive(Serialize, Deserialize)]
pub struct DumpNode {
    pub path: Vec<u32>,
    pub view: NodeView,
}

/// `.gtos` file: a single JSON document.
#[derive(Serialize, Deserialize)]
pub struct Gtos {
    /// Always "gtos-1".
    pub format: String,
    pub config: JsonConfig,
    pub iters: u32,
    pub expl_pct: f32,
    /// Average-strategy node views (root and descendants up to the dump depth).
    pub nodes: Vec<DumpNode>,
}
