//! Heads-up (SB vs BB) preflop solver on 169 hand classes with a fixed action menu.
//!
//! Model (all amounts in bb; SB posts 0.5, BB posts 1; player 0 = SB, 1 = BB):
//! * Menu: SB fold/limp/raise `open`/jam; then raises by level: `open`, `three_bet`, `four_bet`
//!   (BB isolating a limp raises to `iso`), jam always available. Fixed targets, no other sizes.
//! * All-in terminals use raw class-vs-class equity (Monte-Carlo over boards, fixed seed).
//! * Non-all-in terminals (call/check, flop seen) use an equity realisation model instead of a
//!   postflop tree: R = R[pot_type][pos][class] (pot type Limp/Srp/3bet/4bet, pos 0 = SB in position,
//!   1 = BB out of position). Realised SB share is `eq*R_sb(i) / (eq*R_sb(i) + (1-eq)*R_bb(j))`;
//!   zero-sum for any positive R (CFR guarantees hold). Default R = parametric prior
//!   (docs/preflop-design.md section 1). A raise target above `jam_frac` of the stack becomes a jam.
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
    /// BB raise size after an SB limp, then SB 3-bet and BB 4-bet targets in that line.
    pub iso: f64,
    pub iso_three_bet: f64,
    pub iso_four_bet: f64,
    /// Raise targets above this fraction of the stack are replaced by the jam.
    pub jam_frac: f64,
    /// Prior R: base[pot_type][pos] (pot types Limp, Srp, ThreeBet, FourBet; pos 0 = SB IP, 1 = BB OOP).
    pub r_base: [[f64; 2]; 4],
    pub r_suited: f64,
    pub r_pair: f64,
    pub r_conn: f64,
    pub r_eq_pen: f64,
    pub r_eq_floor: f64,
    pub r_min: f64,
    pub r_max: f64,
}

impl Default for PreflopConfig {
    fn default() -> Self {
        PreflopConfig {
            stack: 100.0, open: 2.5, three_bet: 10.0, four_bet: 22.0, iso: 3.5, iso_three_bet: 8.75, iso_four_bet: 19.25,
            jam_frac: 0.4,
            // Tuned with examples/prior_sweep: base unchanged; a steep penalty below 50% raw equity (not lower BB base)
            // trims BB defence into the doc section 5 bands without pushing SB VPIP over 90%. Only trash (72o) hits the 0.4 clamp.
            r_base: [[1.00, 0.85], [1.02, 0.80], [1.00, 0.88], [0.98, 0.94]],
            r_suited: 0.08, r_pair: 0.05, r_conn: 0.03, r_eq_pen: 4.0, r_eq_floor: 0.50, r_min: 0.4, r_max: 1.25,
        }
    }
}

pub const POT_TYPES: usize = 4;

/// Zero-sum realised SB share of the pot for raw equity `e` and realisation factors `r_sb`, `r_bb` > 0.
pub fn realised_share(e: f64, r_sb: f64, r_bb: f64) -> f64 {
    e * r_sb / (e * r_sb + (1.0 - e) * r_bb)
}

/// Parametric prior R table, index `(pot*2 + pos)*NC + class`.
pub fn prior_r(cfg: &PreflopConfig, eq: &EquityTable) -> Vec<f32> {
    let mut r = vec![0f32; POT_TYPES * 2 * NC];
    for c in 0..NC {
        let (a, b) = (c / 13, c % 13);
        let (hi, lo) = (a.max(b), a.min(b));
        let tw: f64 = (0..NC).map(|j| eq.w[c * NC + j]).sum();
        let ev = if tw > 0.0 { (0..NC).map(|j| eq.w[c * NC + j] * eq.eq[c * NC + j]).sum::<f64>() / tw } else { 0.5 };
        let feat = if a > b { cfg.r_suited } else { 0.0 } + if a == b { cfg.r_pair } else { 0.0 }
            + if a != b && hi - lo <= 1 { cfg.r_conn } else { 0.0 } - cfg.r_eq_pen * (cfg.r_eq_floor - ev).max(0.0);
        for pt in 0..POT_TYPES {
            for pos in 0..2 {
                r[(pt * 2 + pos) * NC + c] = (cfg.r_base[pt][pos] + feat).clamp(cfg.r_min, cfg.r_max) as f32;
            }
        }
    }
    r
}

enum Nd {
    Act { player: usize, kids: Vec<usize>, labels: Vec<String> },
    Fold { u0: f64 },
    /// u0 for (SB class i, BB class j), row-major.
    /// `pot` = pot-type tag, `inv` = chips each player has in; `allin` terminals use raw equity.
    Show { u: Vec<f64>, pot: u8, inv: f64, allin: bool },
}

struct Tree {
    nodes: Vec<Nd>,
    root: usize,
}

struct B<'a> {
    cfg: &'a PreflopConfig,
    eq: &'a EquityTable,
    r: &'a [f32],
    nodes: Vec<Nd>,
}

impl B<'_> {
    /// `raises` = number of raises so far (0 = limp/check, 1 = Srp, 2 = 3-bet, 3+ = 4-bet).
    fn show(&mut self, inv: f64, raises: usize) -> usize {
        let allin = inv >= self.cfg.stack - 1e-9;
        let pot = 2.0 * inv;
        let pt = raises.min(POT_TYPES - 1);
        let u = self.eq.eq.iter().enumerate().map(|(k, &e)| {
            let (i, j) = (k / NC, k % NC);
            let share = if allin { e } else {
                realised_share(e, self.r[(pt * 2) * NC + i] as f64, self.r[(pt * 2 + 1) * NC + j] as f64)
            };
            share * pot - inv
        }).collect();
        self.nodes.push(Nd::Show { u, pot: pt as u8, inv, allin });
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
            kids.push(if root { self.build(ni, 1, 0, false, true) } else { self.show(inv[o], raises) });
            labels.push("call".to_string());
        } else {
            kids.push(self.show(inv[me], raises));
            labels.push("check".to_string());
        }
        if inv[o] < c.stack - 1e-9 {
            let lv = if limped { [c.iso, c.iso_three_bet, c.iso_four_bet] } else { [c.open, c.three_bet, c.four_bet] };
            if let Some(&t) = lv.get(raises) {
                if t > inv[o].max(inv[me]) + 1e-9 && t <= c.jam_frac * c.stack + 1e-9 {
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

/// Aggregated non-all-in showdown spot of one pot type. Players: 0 = SB (IP), 1 = BB (OOP).
pub struct PotSpot {
    pub pot_type: usize,
    /// Chips each player has in (pot = 2 * inv), mass-weighted mean over the aggregated terminals.
    pub inv: f64,
    /// Probability that a deal reaches these terminals.
    pub mass: f64,
    /// Per-class range weight (conditional on being dealt, mass-weighted mean over terminals), in [0, 1].
    pub range: [Vec<f64>; 2],
    /// Per-class probability of reaching the terminals given the class is dealt.
    pub reach: [Vec<f64>; 2],
}

pub struct PreflopSolver<'a> {
    tree: Tree,
    eq: &'a EquityTable,
    cfg: PreflopConfig,
    regret: Vec<Vec<f64>>,
    sum: Vec<Vec<f64>>,
    params: Params,
    pub iters: u32,
    best: Option<(f64, Vec<Vec<f64>>)>,
    /// (iteration, average-strategy expl, current-strategy expl) in mbb/hand, every 25 iters after 100.
    pub log: Vec<(u32, f64, f64)>,
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
        Self::with_r(cfg, eq, prior_r(cfg, eq)).unwrap()
    }

    /// Custom R table (`POT_TYPES*2*NC` values, index `(pot*2+pos)*NC+class`, all > 0).
    pub fn with_r(cfg: &PreflopConfig, eq: &'a EquityTable, r: Vec<f32>) -> Result<Self, String> {
        if r.len() != POT_TYPES * 2 * NC || r.iter().any(|&x| !(x > 0.0)) {
            return Err("bad realisation table".into());
        }
        let mut b = B { cfg, eq, r: &r, nodes: vec![] };
        let root = b.build([0.5, 1.0], 0, 0, true, false);
        let regret = b.nodes.iter().map(|n| match n { Nd::Act { kids, .. } => vec![0.0; kids.len() * NC], _ => vec![] }).collect();
        let sum = b.nodes.iter().map(|n| match n { Nd::Act { kids, .. } => vec![0.0; kids.len() * NC], _ => vec![] }).collect();
        Ok(PreflopSolver {
            tree: Tree { nodes: b.nodes, root }, eq, cfg: cfg.clone(), regret, sum,
            params: Params { alpha: 1.5, beta: 0.5, gamma: 2.0 }, iters: 0, best: None, log: vec![],
        })
    }

    /// Strategy source for output: best average snapshot if any, else the running sums.
    fn out(&self) -> &[Vec<f64>] {
        self.best.as_ref().map_or(&self.sum, |b| &b.1)
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
                    Nd::Show { u, .. } => if p == 0 { u[i * NC + j] } else { -u[j * NC + i] },
                    Nd::Act { .. } => unreachable!(),
                };
            }
            s
        }).collect()
    }

    fn cfr(&mut self, id: usize, p: usize, own: &[f64], opp: &[f64], disc: (f64, f64, f64, f64)) -> Vec<f64> {
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
                    *s = (*s + disc.3 * cvs[a].1[i]) * disc.2;
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
            // Delayed averaging: no accumulation for t <= 100.
            let acc = if self.iters > 100 { 1.0 } else { 0.0 };
            let d = (self.params.pos(t), self.params.neg(t), self.params.avg(t), acc);
            for p in 0..2 {
                let (own, opp) = (vec![1.0; NC], vec![1.0; NC]);
                let root = self.tree.root;
                self.cfr(root, p, &own, &opp, d);
            }
            if self.iters > 100 && self.iters % 25 == 0 {
                self.snapshot();
            }
        }
        if self.iters > 100 && self.log.last().map_or(true, |l| l.0 != self.iters) {
            self.snapshot();
        }
    }

    fn snapshot(&mut self) {
        let avg = self.expl(Some(&self.sum)) * 1000.0;
        let cur = self.expl(None) * 1000.0;
        self.log.push((self.iters, avg, cur));
        if self.best.as_ref().map_or(true, |b| avg < b.0) {
            self.best = Some((avg, self.sum.clone()));
        }
    }

    fn br(&self, id: usize, p: usize, opp: &[f64], src: Option<&[Vec<f64>]>) -> Vec<f64> {
        let (player, kids) = match &self.tree.nodes[id] {
            Nd::Act { player, kids, .. } => (*player, kids),
            t => return self.term(t, p, opp),
        };
        let n = kids.len();
        let st = match src { Some(s) => norm(&s[id], n), None => rm(&self.regret[id], n) };
        let mut v = vec![if player == p { f64::NEG_INFINITY } else { 0.0 }; NC];
        for a in 0..n {
            let cv = if player == p { self.br(kids[a], p, opp, src) } else {
                let o2: Vec<f64> = (0..NC).map(|i| opp[i] * st[a * NC + i]).collect();
                self.br(kids[a], p, &o2, src)
            };
            for i in 0..NC {
                if player == p { v[i] = v[i].max(cv[i]) } else { v[i] += cv[i] }
            }
        }
        v
    }

    /// (BR0 + BR1) / 2 in bb per deal; `src` = strategy sums, None = current regret-matching strategy.
    fn expl(&self, src: Option<&[Vec<f64>]>) -> f64 {
        let ones = vec![1.0; NC];
        (0..2).map(|p| self.br(self.tree.root, p, &ones, src).iter().sum::<f64>()).sum::<f64>() / 2.0
    }

    /// Exploitability (bb per deal) of the returned (best average snapshot) strategy.
    pub fn exploitability(&self) -> f64 {
        self.expl(Some(self.out()))
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
            Nd::Act { player, kids, labels } => Some((*player, labels.clone(), norm(&self.out()[id], kids.len()))),
            _ => None,
        }
    }

    /// Range extraction for the realisation fit: per pot type, the non-all-in showdown terminals
    /// aggregated under the returned strategy. `None` if the pot type is never reached.
    pub fn pot_spots(&self) -> Vec<Option<PotSpot>> {
        let mut nodes: Vec<(u8, f64, [Vec<f64>; 2])> = vec![];
        let ones = vec![1.0; NC];
        self.collect_show(self.tree.root, [ones.clone(), ones], &mut nodes);
        (0..POT_TYPES).map(|pt| {
            let ns: Vec<_> = nodes.iter().filter(|n| n.0 as usize == pt).collect();
            let (mut mass, mut inv) = (0.0, 0.0);
            let (mut range, mut reach) = ([vec![0.0; NC], vec![0.0; NC]], [vec![0.0; NC], vec![0.0; NC]]);
            let node_mass: Vec<f64> = ns.iter().map(|n| (0..NC * NC).map(|k| self.eq.w[k] * n.2[0][k / NC] * n.2[1][k % NC]).sum()).collect();
            let tot: f64 = node_mass.iter().sum();
            if tot <= 0.0 {
                return None;
            }
            for (n, &m) in ns.iter().zip(&node_mass) {
                mass += m;
                inv += m * n.1;
                for p in 0..2 {
                    let o = 1 - p;
                    for i in 0..NC {
                        // P(class i reaches this node | class i dealt) = r_i * sum_j w_ij r_o[j] / sum_j w_ij
                        let (mut a, mut b) = (0.0, 0.0);
                        for j in 0..NC {
                            let w = if p == 0 { self.eq.w[i * NC + j] } else { self.eq.w[j * NC + i] };
                            a += w * n.2[o][j];
                            b += w;
                        }
                        range[p][i] += m / tot * n.2[p][i];
                        reach[p][i] += if b > 0.0 { n.2[p][i] * a / b } else { 0.0 };
                    }
                }
            }
            Some(PotSpot { pot_type: pt, inv: inv / mass, mass, range, reach })
        }).collect()
    }

    fn collect_show(&self, id: usize, r: [Vec<f64>; 2], out: &mut Vec<(u8, f64, [Vec<f64>; 2])>) {
        match &self.tree.nodes[id] {
            Nd::Show { pot, inv, allin: false, .. } => out.push((*pot, *inv, r)),
            Nd::Act { player, kids, .. } => {
                let st = norm(&self.out()[id], kids.len());
                for (a, &k) in kids.iter().enumerate() {
                    let mut r2 = r.clone();
                    for i in 0..NC {
                        r2[*player][i] *= st[a * NC + i];
                    }
                    self.collect_show(k, r2, out);
                }
            }
            _ => {}
        }
    }

    pub fn solution(&self) -> PreflopSolution {
        let mut nodes = vec![];
        let mut stack: Vec<(usize, Vec<usize>, Vec<String>)> = vec![(self.tree.root, vec![], vec![])];
        while let Some((id, idx, names)) = stack.pop() {
            if let Nd::Act { player, kids, labels } = &self.tree.nodes[id] {
                nodes.push(PfNode {
                    path: names.clone(), player: *player, actions: labels.clone(),
                    strategy: norm(&self.out()[id], kids.len()).iter().map(|&x| x as f32).collect(),
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

/// Scalar `gto_core::Game` view of a solver's tree (for cross-checking against vanilla CFR on tiny configs).
pub struct PreflopGame<'a> {
    s: &'a PreflopSolver<'a>,
    pairs: Vec<(usize, usize)>,
}

impl<'a> PreflopGame<'a> {
    pub fn new(s: &'a PreflopSolver<'a>) -> Self {
        let pairs = (0..NC * NC).filter(|&k| s.eq.w[k] > 0.0).map(|k| (k / NC, k % NC)).collect();
        PreflopGame { s, pairs }
    }

    /// Average (returned) strategy for infoset key "node:class".
    pub fn strat(&self, key: &str, n: usize) -> Vec<f64> {
        let (id, c) = key.split_once(':').map(|(a, b)| (a.parse::<usize>().unwrap(), b.parse::<usize>().unwrap())).unwrap();
        let st = norm(&self.s.out()[id], n);
        (0..n).map(|a| st[a * NC + c]).collect()
    }
}

impl gto_core::Game for PreflopGame<'_> {
    /// (node id, dealt pair index; usize::MAX before the deal)
    type State = (usize, usize);
    fn root(&self) -> Self::State {
        (usize::MAX, usize::MAX)
    }
    fn node(&self, s: &Self::State) -> gto_core::Node {
        use gto_core::Node;
        if s.0 == usize::MAX {
            return Node::Chance(self.pairs.iter().map(|&(i, j)| self.s.eq.w[i * NC + j]).collect());
        }
        let (i, j) = self.pairs[s.1];
        match &self.s.tree.nodes[s.0] {
            Nd::Act { player, kids, .. } => Node::Player(*player, kids.len()),
            Nd::Fold { u0 } => Node::Terminal(*u0),
            Nd::Show { u, .. } => Node::Terminal(u[i * NC + j]),
        }
    }
    fn apply(&self, s: &Self::State, a: usize) -> Self::State {
        if s.0 == usize::MAX {
            return (self.s.tree.root, a);
        }
        match &self.s.tree.nodes[s.0] {
            Nd::Act { kids, .. } => (kids[a], s.1),
            _ => unreachable!(),
        }
    }
    fn infoset_key(&self, s: &Self::State) -> String {
        let (i, j) = self.pairs[s.1];
        match &self.s.tree.nodes[s.0] {
            Nd::Act { player, .. } => format!("{}:{}", s.0, if *player == 0 { i } else { j }),
            _ => unreachable!(),
        }
    }
}
