//! Vector DCFR over the river tree + best-response exploitability.
use crate::cards::{combos, eval7};
use crate::tree::{build, Kind, Tree, TreeConfig, H};
use gto_core::Params;

pub struct RiverConfig {
    pub board: [u8; 5],
    /// Per-player (0 = OOP, 1 = IP) weights over the 1326 combos.
    pub ranges: [Vec<f32>; 2],
    pub tree: TreeConfig,
}

pub struct RiverSolver {
    tree: Tree,
    combos: Vec<(u8, u8)>,
    /// Live combo indices sorted by strength ascending, and their strengths.
    order: Vec<usize>,
    strength: Vec<u32>,
    w: [Vec<f32>; 2],
    norm: f32,
    pot: f32,
    regret: Vec<f32>,
    sum: Vec<f32>,
    params: Params,
    pub iters: u32,
}

fn regret_match(r: &[f32], n: usize, out: &mut [f32]) {
    for h in 0..H {
        let mut tot = 0.0;
        for a in 0..n {
            tot += r[a * H + h].max(0.0);
        }
        for a in 0..n {
            out[a * H + h] = if tot > 0.0 { r[a * H + h].max(0.0) / tot } else { 1.0 / n as f32 };
        }
    }
}

fn normalize(s: &[f32], n: usize, out: &mut [f32]) {
    for h in 0..H {
        let tot: f32 = (0..n).map(|a| s[a * H + h]).sum();
        for a in 0..n {
            out[a * H + h] = if tot > 0.0 { s[a * H + h] / tot } else { 1.0 / n as f32 };
        }
    }
}

impl RiverSolver {
    pub fn new(cfg: &RiverConfig) -> Self {
        let tree = build(&cfg.tree);
        let combos = combos();
        let mut mask = 0u64;
        for &b in &cfg.board {
            mask |= 1 << b;
        }
        let mut strength = vec![0u32; H];
        let mut order = vec![];
        let mut w = [cfg.ranges[0].clone(), cfg.ranges[1].clone()];
        for (i, &(a, b)) in combos.iter().enumerate() {
            if mask >> a & 1 == 1 || mask >> b & 1 == 1 {
                w[0][i] = 0.0;
                w[1][i] = 0.0;
                continue;
            }
            let bd = cfg.board;
            strength[i] = eval7(&[a, b, bd[0], bd[1], bd[2], bd[3], bd[4]]);
            order.push(i);
        }
        order.sort_by_key(|&i| strength[i]);
        let mut s = RiverSolver {
            tree, combos, order, strength, w, norm: 1.0, pot: cfg.tree.pot,
            regret: vec![], sum: vec![], params: Params::dcfr(), iters: 0,
        };
        s.regret = vec![0.0; s.tree.data_len];
        s.sum = vec![0.0; s.tree.data_len];
        // normalizer: sum over compatible (h0, h1) of w0*w1
        let v = s.compat(&s.w[1].clone());
        s.norm = (0..H).map(|h| s.w[0][h] * v[h]).sum();
        s
    }

    /// For each h: sum of `opp` over hands not sharing a card with h.
    fn compat(&self, opp: &[f32]) -> Vec<f32> {
        let mut cs = [0.0f32; 52];
        let mut tot = 0.0;
        for (i, &(a, b)) in self.combos.iter().enumerate() {
            cs[a as usize] += opp[i];
            cs[b as usize] += opp[i];
            tot += opp[i];
        }
        self.combos.iter().enumerate()
            .map(|(i, &(a, b))| tot - cs[a as usize] - cs[b as usize] + opp[i])
            .collect()
    }

    /// For each live h: reach of opp hands h beats minus reach of those that beat h.
    fn showdown(&self, opp: &[f32]) -> Vec<f32> {
        let mut out = vec![0.0f32; H];
        for dir in [1.0f32, -1.0] {
            let mut cum = [0.0f32; 52];
            let mut tot = 0.0;
            let n = self.order.len();
            let mut k = 0;
            while k < n {
                let idx = |k: usize| if dir > 0.0 { self.order[k] } else { self.order[n - 1 - k] };
                let st = self.strength[idx(k)];
                let mut e = k;
                while e < n && self.strength[idx(e)] == st {
                    e += 1;
                }
                for j in k..e {
                    let h = idx(j);
                    let (a, b) = self.combos[h];
                    out[h] += dir * (tot - cum[a as usize] - cum[b as usize]);
                }
                for j in k..e {
                    let h = idx(j);
                    let (a, b) = self.combos[h];
                    cum[a as usize] += opp[h];
                    cum[b as usize] += opp[h];
                    tot += opp[h];
                }
                k = e;
            }
        }
        out
    }

    fn terminal(&self, id: usize, p: usize, opp: &[f32]) -> Vec<f32> {
        let nd = &self.tree.nodes[id];
        let mut v = if nd.kind == Kind::Showdown {
            self.showdown(opp)
        } else {
            let sign = if nd.player as usize == p { -1.0 } else { 1.0 };
            self.compat(opp).into_iter().map(|x| x * sign).collect()
        };
        for x in v.iter_mut() {
            *x *= nd.pay;
        }
        v
    }

    fn cfr(&mut self, id: usize, p: usize, own: &[f32], opp: &[f32]) -> Vec<f32> {
        let nd = self.tree.nodes[id].clone();
        if nd.kind != Kind::Action {
            return self.terminal(id, p, opp);
        }
        let n = nd.n as usize;
        let off = nd.data_off as usize;
        let mut strat = vec![0.0f32; n * H];
        regret_match(&self.regret[off..off + n * H], n, &mut strat);
        let q = nd.player as usize;
        let mut v = vec![0.0f32; H];
        let mut cvs = vec![];
        for a in 0..n {
            let c = self.tree.children[nd.child_off as usize + a] as usize;
            let sa = &strat[a * H..(a + 1) * H];
            if q == p {
                let own2: Vec<f32> = (0..H).map(|h| own[h] * sa[h]).collect();
                let cv = self.cfr(c, p, &own2, opp);
                for h in 0..H {
                    v[h] += sa[h] * cv[h];
                    self.sum[off + a * H + h] += own2[h];
                }
                cvs.push(cv);
            } else {
                let opp2: Vec<f32> = (0..H).map(|h| opp[h] * sa[h]).collect();
                let cv = self.cfr(c, p, own, &opp2);
                for h in 0..H {
                    v[h] += cv[h];
                }
            }
        }
        if q == p {
            for a in 0..n {
                for h in 0..H {
                    self.regret[off + a * H + h] += cvs[a][h] - v[h];
                }
            }
        }
        v
    }

    pub fn iterate(&mut self) {
        self.iters += 1;
        for p in 0..2 {
            let (own, opp) = (self.w[p].clone(), self.w[1 - p].clone());
            let root = self.tree.root as usize;
            self.cfr(root, p, &own, &opp);
        }
        let t = self.iters as f64;
        let (fp, fneg, fa) = (self.params.pos(t) as f32, self.params.neg(t) as f32, self.params.avg(t) as f32);
        for r in self.regret.iter_mut() {
            *r *= if *r > 0.0 { fp } else { fneg };
        }
        for s in self.sum.iter_mut() {
            *s *= fa;
        }
    }

    pub fn solve(&mut self, iters: u32) {
        for _ in 0..iters {
            self.iterate();
        }
    }

    fn br(&self, id: usize, p: usize, opp: &[f32]) -> Vec<f32> {
        let nd = &self.tree.nodes[id];
        if nd.kind != Kind::Action {
            return self.terminal(id, p, opp);
        }
        let n = nd.n as usize;
        let off = nd.data_off as usize;
        let q = nd.player as usize;
        let mut strat = vec![0.0f32; n * H];
        normalize(&self.sum[off..off + n * H], n, &mut strat);
        let mut v = vec![if q == p { f32::NEG_INFINITY } else { 0.0 }; H];
        for a in 0..n {
            let c = self.tree.children[nd.child_off as usize + a] as usize;
            if q == p {
                let cv = self.br(c, p, opp);
                for h in 0..H {
                    v[h] = v[h].max(cv[h]);
                }
            } else {
                let opp2: Vec<f32> = (0..H).map(|h| opp[h] * strat[a * H + h]).collect();
                let cv = self.br(c, p, &opp2);
                for h in 0..H {
                    v[h] += cv[h];
                }
            }
        }
        v
    }

    /// (BR_0 + BR_1) / 2 against the average strategy, in chips.
    pub fn exploitability(&self) -> f32 {
        let mut tot = 0.0f64;
        for p in 0..2 {
            let v = self.br(self.tree.root as usize, p, &self.w[1 - p]);
            tot += (0..H).filter(|&h| self.w[p][h] > 0.0).map(|h| (self.w[p][h] * v[h]) as f64).sum::<f64>();
        }
        (tot / 2.0 / self.norm as f64) as f32
    }

    pub fn exploitability_pct(&self) -> f32 {
        100.0 * self.exploitability() / self.pot
    }
}
