//! Heads-up (SB vs BB) preflop solver on 169 hand classes with a fixed action menu.
//!
//! Model (all amounts in bb; SB posts 0.5, BB posts 1; player 0 = SB, 1 = BB):
//! * Menu: SB fold/limp/raise `open`/jam; then raises by level: `open`, `three_bet`, `four_bet`
//!   (BB isolating a limp raises to `iso`), jam always available. Fixed targets, no other sizes.
//! * All-in terminals use raw class-vs-class equity (Monte-Carlo over boards, fixed seed).
//! * Non-all-in terminals (call/check, flop seen) use an equity realisation model instead of a
//!   postflop tree: SB is in position postflop (R=`r_ip`), BB is out of position (R=`r_oop`).
//!   Realised SB share of the pot is `eq*r_ip / (eq*r_ip + (1-eq)*r_oop)`; this keeps the game
//!   zero-sum (CFR guarantees hold) while giving the IP player a positional edge.
//! * Chance: class pair weight = number of disjoint combo pairs (card removal), normalised to 1.
//! Values are in bb per deal. Exploitability is measured inside this abstraction only.
use gto_core::Params;
use gto_river::cards::{combos, eval7};
use rayon::prelude::*;
use serde::Serialize;

pub const NC: usize = 169;
const RANKS: &[u8; 13] = b"23456789TJQKA";

/// Class id: pairs on the diagonal [r][r], suited [hi][lo], offsuit [lo][hi] (row*13+col).
pub fn class_of(a: u8, b: u8) -> usize {
    let (ra, rb) = ((a >> 2) as usize, (b >> 2) as usize);
    let (hi, lo) = (ra.max(rb), ra.min(rb));
    if hi == lo { hi * 13 + hi } else if a & 3 == b & 3 { hi * 13 + lo } else { lo * 13 + hi }
}

pub fn class_name(c: usize) -> String {
    let (r, k) = (c / 13, c % 13);
    let s = |i: usize| RANKS[i] as char;
    if r == k { format!("{}{}", s(r), s(r)) } else if r > k { format!("{}{}s", s(r), s(k)) } else { format!("{}{}o", s(k), s(r)) }
}

pub struct EquityTable {
    /// eq[i*NC+j]: all-in equity of class i vs class j.
    pub eq: Vec<f64>,
    /// Normalised matchup weights (sum 1).
    pub w: Vec<f64>,
}

fn rng(s: &mut u64) -> u64 {
    *s ^= *s << 13;
    *s ^= *s >> 7;
    *s ^= *s << 17;
    *s
}

impl EquityTable {
    /// Monte-Carlo equities, `boards` runouts per class pair (std error ~ 0.5/sqrt(boards)).
    pub fn compute(boards: usize) -> Self {
        let cb = combos();
        let mut cls: Vec<Vec<(u8, u8)>> = vec![vec![]; NC];
        for &(a, b) in &cb {
            cls[class_of(a, b)].push((a, b));
        }
        let disjoint = |x: (u8, u8), y: (u8, u8)| x.0 != y.0 && x.0 != y.1 && x.1 != y.0 && x.1 != y.1;
        let mut w = vec![0.0f64; NC * NC];
        for i in 0..NC {
            for j in 0..NC {
                let n = cls[i].iter().map(|&x| cls[j].iter().filter(|&&y| disjoint(x, y)).count()).sum::<usize>();
                w[i * NC + j] = n as f64;
            }
        }
        let tot: f64 = w.iter().sum();
        w.iter_mut().for_each(|x| *x /= tot);
        let pairs: Vec<(usize, usize)> = (0..NC).flat_map(|i| (i..NC).map(move |j| (i, j))).collect();
        let res: Vec<(usize, usize, f64)> = pairs.par_iter().filter_map(|&(i, j)| {
            if w[i * NC + j] == 0.0 {
                return None;
            }
            if i == j {
                return Some((i, j, 0.5));
            }
            let (x, y) = cls[i].iter().find_map(|&x| cls[j].iter().find(|&&y| disjoint(x, y)).map(|&y| (x, y)))?;
            let mut deck: Vec<u8> = (0..52).filter(|&c| c != x.0 && c != x.1 && c != y.0 && c != y.1).collect();
            let mut seed = 0x9E3779B97F4A7C15u64 ^ ((i * NC + j) as u64 + 1).wrapping_mul(0xBF58476D1CE4E5B9);
            let mut score = 0.0;
            for _ in 0..boards {
                for k in 0..5 {
                    let r = k + (rng(&mut seed) % (deck.len() - k) as u64) as usize;
                    deck.swap(k, r);
                }
                let b = &deck[..5];
                let sx = eval7(&[x.0, x.1, b[0], b[1], b[2], b[3], b[4]]);
                let sy = eval7(&[y.0, y.1, b[0], b[1], b[2], b[3], b[4]]);
                score += if sx > sy { 1.0 } else if sx == sy { 0.5 } else { 0.0 };
            }
            Some((i, j, score / boards as f64))
        }).collect();
        let mut eq = vec![0.5f64; NC * NC];
        for (i, j, e) in res {
            eq[i * NC + j] = e;
            eq[j * NC + i] = 1.0 - e;
        }
        EquityTable { eq, w }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct PreflopConfig {
    pub stack: f64,
    pub open: f64,
    pub three_bet: f64,
    pub four_bet: f64,
    /// BB raise size after an SB limp.
    pub iso: f64,
    /// Equity realisation factors: SB (in position postflop) and BB (out of position).
    pub r_ip: f64,
    pub r_oop: f64,
}

impl Default for PreflopConfig {
    fn default() -> Self {
        PreflopConfig { stack: 100.0, open: 2.5, three_bet: 8.0, four_bet: 20.0, iso: 4.0, r_ip: 1.0, r_oop: 0.9 }
    }
}

enum Nd {
    Act { player: usize, kids: Vec<usize>, labels: Vec<String> },
    Fold { u0: f64 },
    /// u0 for (SB class i, BB class j), row-major.
    Show { u: Vec<f64> },
}

struct Tree {
    nodes: Vec<Nd>,
    root: usize,
}

struct B<'a> {
    cfg: &'a PreflopConfig,
    eq: &'a EquityTable,
    nodes: Vec<Nd>,
}

impl B<'_> {
    fn show(&mut self, inv: f64) -> usize {
        let allin = inv >= self.cfg.stack - 1e-9;
        let pot = 2.0 * inv;
        let (a, b) = (self.cfg.r_ip, self.cfg.r_oop);
        let u = self.eq.eq.iter().map(|&e| {
            let share = if allin { e } else { e * a / (e * a + (1.0 - e) * b) };
            share * pot - inv
        }).collect();
        self.nodes.push(Nd::Show { u });
        self.nodes.len() - 1
    }

    fn build(&mut self, inv: [f64; 2], me: usize, raises: usize, root: bool, limped: bool) -> usize {
        let c = self.cfg;
        let o = 1 - me;
        let mut kids = vec![];
        let mut labels = vec![];
        if inv[o] > inv[me] + 1e-9 {
            self.nodes.push(Nd::Fold { u0: if me == 0 { -inv[0] } else { inv[1] } });
            kids.push(self.nodes.len() - 1);
            labels.push("fold".to_string());
            let mut ni = inv;
            ni[me] = inv[o];
            kids.push(if root { self.build(ni, 1, 0, false, true) } else { self.show(inv[o]) });
            labels.push("call".to_string());
        } else {
            kids.push(self.show(inv[me]));
            labels.push("check".to_string());
        }
        if inv[o] < c.stack - 1e-9 {
            let t = if limped && me == 1 && raises == 0 { Some(c.iso) }
                else { [c.open, c.three_bet, c.four_bet].get(raises).copied() };
            if let Some(t) = t {
                if t > inv[o].max(inv[me]) + 1e-9 && t < c.stack - 1e-9 {
                    let mut ni = inv;
                    ni[me] = t;
                    kids.push(self.build(ni, o, raises + 1, false, limped));
                    labels.push(format!("raise {t}"));
                }
            }
            let mut ni = inv;
            ni[me] = c.stack;
            kids.push(self.build(ni, o, raises + 1, false, limped));
            labels.push("jam".to_string());
        }
        self.nodes.push(Nd::Act { player: me, kids, labels });
        self.nodes.len() - 1
    }
}

pub struct PreflopSolver<'a> {
    tree: Tree,
    eq: &'a EquityTable,
    cfg: PreflopConfig,
    regret: Vec<Vec<f64>>,
    sum: Vec<Vec<f64>>,
    params: Params,
    pub iters: u32,
}

#[derive(Serialize)]
pub struct PfNode {
    pub path: Vec<String>,
    pub player: usize,
    pub actions: Vec<String>,
    /// actions.len() * 169, action-major, class order of `class_name`.
    pub strategy: Vec<f32>,
}

#[derive(Serialize)]
pub struct PreflopSolution {
    pub format: String,
    pub config: PreflopConfig,
    pub iters: u32,
    pub expl_mbb: f64,
    pub classes: Vec<String>,
    pub nodes: Vec<PfNode>,
}

fn rm(r: &[f64], n: usize) -> Vec<f64> {
    let mut out = vec![0.0; n * NC];
    for i in 0..NC {
        let t: f64 = (0..n).map(|a| r[a * NC + i].max(0.0)).sum();
        for a in 0..n {
            out[a * NC + i] = if t > 0.0 { r[a * NC + i].max(0.0) / t } else { 1.0 / n as f64 };
        }
    }
    out
}

fn norm(s: &[f64], n: usize) -> Vec<f64> {
    let mut out = vec![0.0; n * NC];
    for i in 0..NC {
        let t: f64 = (0..n).map(|a| s[a * NC + i]).sum();
        for a in 0..n {
            out[a * NC + i] = if t > 0.0 { s[a * NC + i] / t } else { 1.0 / n as f64 };
        }
    }
    out
}

impl<'a> PreflopSolver<'a> {
    pub fn new(cfg: &PreflopConfig, eq: &'a EquityTable) -> Self {
        let mut b = B { cfg, eq, nodes: vec![] };
        let root = b.build([0.5, 1.0], 0, 0, true, false);
        let regret = b.nodes.iter().map(|n| match n { Nd::Act { kids, .. } => vec![0.0; kids.len() * NC], _ => vec![] }).collect();
        let sum = b.nodes.iter().map(|n| match n { Nd::Act { kids, .. } => vec![0.0; kids.len() * NC], _ => vec![] }).collect();
        PreflopSolver { tree: Tree { nodes: b.nodes, root }, eq, cfg: cfg.clone(), regret, sum, params: Params::dcfr(), iters: 0 }
    }

    fn term(&self, nd: &Nd, p: usize, opp: &[f64]) -> Vec<f64> {
        let w = &self.eq.w;
        (0..NC).map(|i| {
            let mut s = 0.0;
            for j in 0..NC {
                let x = w[i * NC + j] * opp[j];
                if x == 0.0 {
                    continue;
                }
                s += x * match nd {
                    Nd::Fold { u0 } => if p == 0 { *u0 } else { -*u0 },
                    Nd::Show { u } => if p == 0 { u[i * NC + j] } else { -u[j * NC + i] },
                    Nd::Act { .. } => unreachable!(),
                };
            }
            s
        }).collect()
    }

    fn cfr(&mut self, id: usize, p: usize, own: &[f64], opp: &[f64], disc: (f64, f64, f64)) -> Vec<f64> {
        let (player, kids) = match &self.tree.nodes[id] {
            Nd::Act { player, kids, .. } => (*player, kids.clone()),
            t => return self.term(t, p, opp),
        };
        let n = kids.len();
        let strat = rm(&self.regret[id], n);
        let mut v = vec![0.0; NC];
        if player == p {
            let mut cvs = vec![];
            for a in 0..n {
                let own2: Vec<f64> = (0..NC).map(|i| own[i] * strat[a * NC + i]).collect();
                cvs.push((self.cfr(kids[a], p, &own2, opp, disc), own2));
            }
            for a in 0..n {
                for i in 0..NC {
                    v[i] += strat[a * NC + i] * cvs[a].0[i];
                }
            }
            for a in 0..n {
                for i in 0..NC {
                    let r = &mut self.regret[id][a * NC + i];
                    *r += cvs[a].0[i] - v[i];
                    *r *= if *r > 0.0 { disc.0 } else { disc.1 };
                    let s = &mut self.sum[id][a * NC + i];
                    *s = (*s + cvs[a].1[i]) * disc.2;
                }
            }
        } else {
            for a in 0..n {
                let opp2: Vec<f64> = (0..NC).map(|i| opp[i] * strat[a * NC + i]).collect();
                let cv = self.cfr(kids[a], p, own, &opp2, disc);
                for i in 0..NC {
                    v[i] += cv[i];
                }
            }
        }
        v
    }

    pub fn solve(&mut self, iters: u32) {
        for _ in 0..iters {
            self.iters += 1;
            let t = self.iters as f64;
            let d = (self.params.pos(t), self.params.neg(t), self.params.avg(t));
            for p in 0..2 {
                let (own, opp) = (vec![1.0; NC], vec![1.0; NC]);
                let root = self.tree.root;
                self.cfr(root, p, &own, &opp, d);
            }
        }
    }

    fn br(&self, id: usize, p: usize, opp: &[f64]) -> Vec<f64> {
        let (player, kids) = match &self.tree.nodes[id] {
            Nd::Act { player, kids, .. } => (*player, kids),
            t => return self.term(t, p, opp),
        };
        let n = kids.len();
        let st = norm(&self.sum[id], n);
        let mut v = vec![if player == p { f64::NEG_INFINITY } else { 0.0 }; NC];
        for a in 0..n {
            let cv = if player == p { self.br(kids[a], p, opp) } else {
                let o2: Vec<f64> = (0..NC).map(|i| opp[i] * st[a * NC + i]).collect();
                self.br(kids[a], p, &o2)
            };
            for i in 0..NC {
                if player == p { v[i] = v[i].max(cv[i]) } else { v[i] += cv[i] }
            }
        }
        v
    }

    /// (BR0 + BR1) / 2 against the average strategy, in bb per deal.
    pub fn exploitability(&self) -> f64 {
        let ones = vec![1.0; NC];
        (0..2).map(|p| self.br(self.tree.root, p, &ones).iter().sum::<f64>()).sum::<f64>() / 2.0
    }

    /// Average strategy (action-major, n*169) at the node reached by `path` of action indices.
    pub fn strategy_at(&self, path: &[usize]) -> Option<(usize, Vec<String>, Vec<f64>)> {
        let mut id = self.tree.root;
        for &a in path {
            match &self.tree.nodes[id] {
                Nd::Act { kids, .. } => id = *kids.get(a)?,
                _ => return None,
            }
        }
        match &self.tree.nodes[id] {
            Nd::Act { player, kids, labels } => Some((*player, labels.clone(), norm(&self.sum[id], kids.len()))),
            _ => None,
        }
    }

    pub fn solution(&self) -> PreflopSolution {
        let mut nodes = vec![];
        let mut stack: Vec<(usize, Vec<usize>, Vec<String>)> = vec![(self.tree.root, vec![], vec![])];
        while let Some((id, idx, names)) = stack.pop() {
            if let Nd::Act { player, kids, labels } = &self.tree.nodes[id] {
                nodes.push(PfNode {
                    path: names.clone(), player: *player, actions: labels.clone(),
                    strategy: norm(&self.sum[id], kids.len()).iter().map(|&x| x as f32).collect(),
                });
                for (a, &k) in kids.iter().enumerate() {
                    let (mut i2, mut n2) = (idx.clone(), names.clone());
                    i2.push(a);
                    n2.push(labels[a].clone());
                    stack.push((k, i2, n2));
                }
            }
        }
        PreflopSolution {
            format: "gto-preflop-1".into(), config: self.cfg.clone(), iters: self.iters,
            expl_mbb: self.exploitability() * 1000.0, classes: (0..NC).map(class_name).collect(), nodes,
        }
    }
}
