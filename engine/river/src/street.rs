//! Multi-street (flop/turn/river) vector DCFR with chance nodes, suit isomorphism,
//! memory estimate, rayon parallelism over chance/action children, optional i16 storage.
use crate::cards::{combos, eval7};
use crate::tree::{TreeConfig, H};
use gto_core::Params;
#[cfg(feature = "rayon")]
use rayon::prelude::*;
#[cfg(not(feature = "rayon"))]
use crate::seq::*;
use std::cell::UnsafeCell;

#[derive(Clone)]
pub struct StreetConfig {
    /// 3 (flop), 4 (turn) or 5 (river) board cards.
    pub board: Vec<u8>,
    pub ranges: [Vec<f32>; 2],
    /// One betting config per remaining street (`6 - board.len()`); pot/stack of [0] are the start values.
    pub streets: Vec<TreeConfig>,
    /// Suit isomorphism: merges only under suit perms that fix the board and both ranges.
    pub iso: bool,
    /// i16 storage with per-node f32 scale.
    pub compress: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum K {
    Action,
    Fold,
    Showdown,
    Chance,
}

#[derive(Clone)]
struct N {
    kind: K,
    player: u8,
    pay: f32,
    child_off: u32,
    n: u32,
    data_off: usize,
    /// Showdown: board id. Chance: chance id.
    aux: u32,
}

/// Isomorphism class of dealt cards: canonical child plus (card, suit perm canon->card).
struct Orbit {
    card: u8,
    child: u32,
    members: Vec<(u8, u8)>,
}

struct Board {
    strength: Vec<u32>,
    order: Vec<u16>,
}

fn perms() -> Vec<[u8; 4]> {
    let mut v = vec![];
    for a in 0..4u8 {
        for b in 0..4u8 {
            for c in 0..4u8 {
                for d in 0..4u8 {
                    if a != b && a != c && a != d && b != c && b != d && c != d {
                        v.push([a, b, c, d]);
                    }
                }
            }
        }
    }
    v
}

fn map_card(p: &[u8; 4], c: u8) -> u8 {
    (c & !3) | p[(c & 3) as usize]
}

struct Builder<'a> {
    cfg: &'a StreetConfig,
    dry: bool,
    combos: &'a [(u8, u8)],
    hmap: &'a [Vec<u16>],
    perms: &'a [[u8; 4]],
    range_ok: Vec<bool>,
    nodes: Vec<N>,
    children: Vec<u32>,
    chances: Vec<Vec<Orbit>>,
    boards: Vec<Board>,
    data_len: usize,
    n_nodes: usize,
    n_action: usize,
    n_boards: usize,
}

struct Ctx {
    board: Vec<u8>,
    s: usize,
    pot: f32,
    stack: f32,
    bid: u32,
}

impl<'a> Builder<'a> {
    fn push(&mut self, kind: K, player: u8, pay: f32, ch: Vec<u32>, aux: u32) -> u32 {
        self.n_nodes += 1;
        if kind == K::Action {
            self.data_len += ch.len() * H;
            self.n_action += 1;
        }
        if self.dry {
            return 0;
        }
        let child_off = self.children.len() as u32;
        let n = ch.len() as u32;
        self.children.extend(ch);
        let data_off = if kind == K::Action { self.data_len - n as usize * H } else { 0 };
        self.nodes.push(N { kind, player, pay, child_off, n, data_off, aux });
        (self.nodes.len() - 1) as u32
    }

    fn street(&mut self, board: &[u8], s: usize, pot: f32, stack: f32) -> u32 {
        let mut bid = 0;
        if s + 1 == self.cfg.streets.len() {
            self.n_boards += 1;
            if !self.dry {
                let mut mask = 0u64;
                for &b in board {
                    mask |= 1 << b;
                }
                let mut strength = vec![0u32; H];
                let mut order: Vec<u16> = vec![];
                for (i, &(a, b)) in self.combos.iter().enumerate() {
                    if mask >> a & 1 == 1 || mask >> b & 1 == 1 {
                        continue;
                    }
                    strength[i] = eval7(&[a, b, board[0], board[1], board[2], board[3], board[4]]);
                    order.push(i as u16);
                }
                order.sort_by_key(|&i| strength[i as usize]);
                self.boards.push(Board { strength, order });
                bid = (self.boards.len() - 1) as u32;
            }
        }
        let ctx = Ctx { board: board.to_vec(), s, pot, stack, bid };
        self.go(&ctx, [0.0, 0.0], 0, 0)
    }

    fn close(&mut self, ctx: &Ctx, c: f32) -> u32 {
        if ctx.s + 1 == self.cfg.streets.len() {
            return self.push(K::Showdown, 0, ctx.pot / 2.0 + c, vec![], ctx.bid);
        }
        let orbits = self.orbits(ctx, c);
        let id = self.chances.len() as u32;
        if !self.dry {
            self.chances.push(orbits);
        }
        self.push(K::Chance, 0, 0.0, vec![], id)
    }

    fn orbits(&mut self, ctx: &Ctx, c: f32) -> Vec<Orbit> {
        let mut bmask = 0u64;
        for &b in &ctx.board {
            bmask |= 1 << b;
        }
        // Stabilizer of the board among range-preserving suit perms.
        let group: Vec<usize> = (0..self.perms.len())
            .filter(|&i| {
                (i == 0 || (self.cfg.iso && self.range_ok[i]))
                    && ctx.board.iter().all(|&b| bmask >> map_card(&self.perms[i], b) & 1 == 1)
            })
            .collect();
        let mut done = bmask;
        let mut out = vec![];
        for card in 0..52u8 {
            if done >> card & 1 == 1 {
                continue;
            }
            let mut members: Vec<(u8, u8)> = vec![];
            for &gi in &group {
                let ck = map_card(&self.perms[gi], card);
                if done >> ck & 1 == 0 {
                    done |= 1 << ck;
                    members.push((ck, gi as u8));
                }
            }
            let mut nb = ctx.board.clone();
            nb.push(card);
            let child = self.street(&nb, ctx.s + 1, ctx.pot + 2.0 * c, ctx.stack - c);
            out.push(Orbit { card, child, members });
        }
        out
    }

    fn go(&mut self, ctx: &Ctx, c: [f32; 2], me: usize, aggr: u32) -> u32 {
        let cfg = &self.cfg.streets[ctx.s];
        let (sizes, cap) = (cfg.sizes.clone(), cfg.raise_cap);
        let o = 1 - me;
        let half = ctx.pot / 2.0;
        let mut ch = vec![];
        if c[o] > c[me] {
            let f = self.push(K::Fold, me as u8, half + c[me], vec![], 0);
            ch.push(f);
            ch.push(self.close(ctx, c[o]));
        } else if me == 0 {
            ch.push(self.go(ctx, c, 1, aggr));
        } else {
            ch.push(self.close(ctx, c[me]));
        }
        if aggr < cap && c[o] < ctx.stack {
            let pot_now = ctx.pot + c[0] + c[1];
            let call = c[o] - c[me];
            let mut targets: Vec<f32> = vec![];
            for &s in &sizes {
                let mut to = c[o] + s * (pot_now + call);
                if to >= ctx.stack - 1e-3 {
                    to = ctx.stack;
                }
                if to > c[o] + 1e-3 && !targets.iter().any(|&x| (x - to).abs() < 1e-3) {
                    targets.push(to);
                }
            }
            targets.sort_by(|a, b| a.partial_cmp(b).unwrap());
            for to in targets {
                let mut nc = c;
                nc[me] = to;
                ch.push(self.go(ctx, nc, o, aggr + 1));
            }
        }
        self.push(K::Action, me as u8, 0.0, ch, 0)
    }
}

fn build_tables() -> (Vec<(u8, u8)>, Vec<[u8; 4]>, Vec<Vec<u16>>) {
    let cb = combos();
    let mut idx = vec![0u16; 52 * 52];
    for (i, &(a, b)) in cb.iter().enumerate() {
        idx[a as usize * 52 + b as usize] = i as u16;
        idx[b as usize * 52 + a as usize] = i as u16;
    }
    let ps = perms();
    let hm = ps.iter().map(|p| {
        cb.iter().map(|&(a, b)| idx[map_card(p, a) as usize * 52 + map_card(p, b) as usize]).collect()
    }).collect();
    (cb, ps, hm)
}

fn make<'a>(cfg: &'a StreetConfig, dry: bool, cb: &'a [(u8, u8)], ps: &'a [[u8; 4]], hm: &'a [Vec<u16>]) -> Builder<'a> {
    assert_eq!(cfg.streets.len() + cfg.board.len(), 6, "need one TreeConfig per remaining street");
    let range_ok = hm.iter().map(|m| {
        (0..2).all(|p| (0..H).all(|h| (cfg.ranges[p][h] - cfg.ranges[p][m[h] as usize]).abs() <= 1e-9))
    }).collect();
    Builder {
        cfg, dry, combos: cb, hmap: hm, perms: ps, range_ok, nodes: vec![], children: vec![], chances: vec![],
        boards: vec![], data_len: 0, n_nodes: 0, n_action: 0, n_boards: 0,
    }
}

fn run_build(b: &mut Builder) -> u32 {
    let cfg = b.cfg;
    let t = &cfg.streets[0];
    b.street(&cfg.board.clone(), 0, t.pot, t.stack)
}

/// Estimated bytes of solver state (regret + strategy sum, tree, boards); Err if above `budget_bytes`.
pub fn estimate_memory(cfg: &StreetConfig, budget_bytes: u64) -> Result<u64, String> {
    let (cb, ps, hm) = build_tables();
    let mut b = make(cfg, true, &cb, &ps, &hm);
    run_build(&mut b);
    let per = if cfg.compress { 4 } else { 8 };
    let bytes = (b.data_len * per + b.n_action * 8 + b.n_nodes * std::mem::size_of::<N>() + b.n_boards * H * 6) as u64;
    if bytes > budget_bytes {
        Err(format!("estimated {bytes} bytes exceeds budget {budget_bytes}"))
    } else {
        Ok(bytes)
    }
}

/// Shared mutable storage; tree traversal touches disjoint node ranges per thread.
struct Arr {
    f: UnsafeCell<Vec<f32>>,
    q: UnsafeCell<Vec<i16>>,
    sc: UnsafeCell<Vec<f32>>,
    comp: bool,
}
unsafe impl Sync for Arr {}

#[allow(dangerous_implicit_autorefs)]
impl Arr {
    fn new(len: usize, nodes: usize, comp: bool) -> Self {
        Arr {
            f: UnsafeCell::new(if comp { vec![] } else { vec![0.0; len] }),
            q: UnsafeCell::new(if comp { vec![0; len] } else { vec![] }),
            sc: UnsafeCell::new(vec![0.0; if comp { nodes } else { 0 }]),
            comp,
        }
    }
    fn load(&self, off: usize, node: usize, out: &mut [f32]) {
        unsafe {
            if self.comp {
                let s = (*self.sc.get())[node];
                let q = &(*self.q.get())[off..off + out.len()];
                for (o, &x) in out.iter_mut().zip(q) {
                    *o = x as f32 * s;
                }
            } else {
                out.copy_from_slice(&(*self.f.get())[off..off + out.len()]);
            }
        }
    }
    fn store(&self, off: usize, node: usize, src: &[f32]) {
        unsafe {
            if self.comp {
                let m = src.iter().fold(0.0f32, |a, &x| a.max(x.abs()));
                let s = m / 32767.0;
                (*self.sc.get())[node] = s;
                let q = &mut (*self.q.get())[off..off + src.len()];
                for (o, &x) in q.iter_mut().zip(src) {
                    *o = if s > 0.0 { (x / s).round() as i16 } else { 0 };
                }
            } else {
                (*self.f.get())[off..off + src.len()].copy_from_slice(src);
            }
        }
    }
}

pub struct StreetSolver {
    nodes: Vec<N>,
    children: Vec<u32>,
    chances: Vec<Vec<Orbit>>,
    boards: Vec<Board>,
    root: u32,
    combos: Vec<(u8, u8)>,
    hmap: Vec<Vec<u16>>,
    w: [Vec<f32>; 2],
    norm: f32,
    pot: f32,
    regret: Arr,
    sum: Arr,
    params: Params,
    pub iters: u32,
}

fn regret_match(r: &[f32], n: usize) -> Vec<f32> {
    let mut out = vec![0.0f32; n * H];
    for h in 0..H {
        let tot: f32 = (0..n).map(|a| r[a * H + h].max(0.0)).sum();
        for a in 0..n {
            out[a * H + h] = if tot > 0.0 { r[a * H + h].max(0.0) / tot } else { 1.0 / n as f32 };
        }
    }
    out
}

fn normalize(s: &[f32], n: usize) -> Vec<f32> {
    let mut out = vec![0.0f32; n * H];
    for h in 0..H {
        let tot: f32 = (0..n).map(|a| s[a * H + h]).sum();
        for a in 0..n {
            out[a * H + h] = if tot > 0.0 { s[a * H + h] / tot } else { 1.0 / n as f32 };
        }
    }
    out
}

impl StreetSolver {
    pub fn new(cfg: &StreetConfig, budget_bytes: u64) -> Result<Self, String> {
        estimate_memory(cfg, budget_bytes)?;
        let (cb, ps, hm) = build_tables();
        let mut b = make(cfg, false, &cb, &ps, &hm);
        let root = run_build(&mut b);
        let (nodes, children, chances, boards, data_len) = (b.nodes, b.children, b.chances, b.boards, b.data_len);
        let mut w = [cfg.ranges[0].clone(), cfg.ranges[1].clone()];
        for (i, &(a, c)) in cb.iter().enumerate() {
            if cfg.board.contains(&a) || cfg.board.contains(&c) {
                w[0][i] = 0.0;
                w[1][i] = 0.0;
            }
        }
        let n_nodes = nodes.len();
        let mut s = StreetSolver {
            nodes, children, chances, boards, root, combos: cb, hmap: hm, w, norm: 1.0, pot: cfg.streets[0].pot,
            regret: Arr::new(data_len, n_nodes, cfg.compress), sum: Arr::new(data_len, n_nodes, cfg.compress),
            params: Params::dcfr(), iters: 0,
        };
        let mut dead = 0u64;
        for &c in &cfg.board {
            dead |= 1 << c;
        }
        s.norm = s.norm_rec(dead, cfg.streets.len() - 1);
        Ok(s)
    }

    /// Sum over remaining runouts of sum_{compatible h0,h1} w0*w1.
    fn norm_rec(&self, dead: u64, left: usize) -> f32 {
        if left == 0 {
            let live = |w: &Vec<f32>| -> Vec<f32> {
                (0..H).map(|h| {
                    let (a, b) = self.combos[h];
                    if dead >> a & 1 == 1 || dead >> b & 1 == 1 { 0.0 } else { w[h] }
                }).collect()
            };
            let (w0, w1) = (live(&self.w[0]), live(&self.w[1]));
            let v = self.compat(&w1);
            return (0..H).map(|h| w0[h] * v[h]).sum();
        }
        (0..52u8).filter(|&c| dead >> c & 1 == 0).collect::<Vec<_>>().par_iter()
            .map(|&c| self.norm_rec(dead | 1 << c, left - 1)).sum()
    }

    fn compat(&self, opp: &[f32]) -> Vec<f32> {
        let mut cs = [0.0f32; 52];
        let mut tot = 0.0;
        for (i, &(a, b)) in self.combos.iter().enumerate() {
            cs[a as usize] += opp[i];
            cs[b as usize] += opp[i];
            tot += opp[i];
        }
        self.combos.iter().enumerate().map(|(i, &(a, b))| tot - cs[a as usize] - cs[b as usize] + opp[i]).collect()
    }

    fn showdown(&self, bd: &Board, opp: &[f32]) -> Vec<f32> {
        let mut out = vec![0.0f32; H];
        let n = bd.order.len();
        for dir in [1.0f32, -1.0] {
            let mut cum = [0.0f32; 52];
            let mut tot = 0.0;
            let idx = |k: usize| bd.order[if dir > 0.0 { k } else { n - 1 - k }] as usize;
            let mut k = 0;
            while k < n {
                let st = bd.strength[idx(k)];
                let mut e = k;
                while e < n && bd.strength[idx(e)] == st {
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

    fn terminal(&self, nd: &N, p: usize, opp: &[f32]) -> Vec<f32> {
        let mut v = if nd.kind == K::Showdown {
            self.showdown(&self.boards[nd.aux as usize], opp)
        } else {
            let sign = if nd.player as usize == p { -1.0 } else { 1.0 };
            self.compat(opp).into_iter().map(|x| x * sign).collect()
        };
        for x in v.iter_mut() {
            *x *= nd.pay;
        }
        v
    }

    fn mask(&self, v: &[f32], card: u8) -> Vec<f32> {
        v.iter().zip(&self.combos).map(|(&x, &(a, b))| if a == card || b == card { 0.0 } else { x }).collect()
    }

    /// Scatter canonical-coordinate values into member coordinates: out[perm(h)] += v[h].
    fn scatter(&self, out: &mut [f32], v: &[f32], perm: u8) {
        let m = &self.hmap[perm as usize];
        for h in 0..H {
            out[m[h] as usize] += v[h];
        }
    }

    fn cfr(&self, id: usize, p: usize, own: &[f32], opp: &[f32], disc: (f32, f32, f32)) -> Vec<f32> {
        let nd = &self.nodes[id];
        match nd.kind {
            K::Fold | K::Showdown => return self.terminal(nd, p, opp),
            K::Chance => {
                let res: Vec<Vec<f32>> = self.chances[nd.aux as usize].par_iter().map(|o| {
                    let (own2, opp2) = (self.mask(own, o.card), self.mask(opp, o.card));
                    let cv = self.cfr(o.child as usize, p, &own2, &opp2, disc);
                    self.mask(&cv, o.card)
                }).collect();
                let mut v = vec![0.0f32; H];
                for (o, cv) in self.chances[nd.aux as usize].iter().zip(&res) {
                    for &(_, perm) in &o.members {
                        self.scatter(&mut v, cv, perm);
                    }
                }
                return v;
            }
            K::Action => {}
        }
        let n = nd.n as usize;
        let off = nd.data_off;
        let mut r = vec![0.0f32; n * H];
        self.regret.load(off, id, &mut r);
        let strat = regret_match(&r, n);
        let kids = &self.children[nd.child_off as usize..nd.child_off as usize + n];
        let (fp, fneg, fa) = disc;
        let mut v = vec![0.0f32; H];
        if nd.player as usize == p {
            let own2: Vec<Vec<f32>> = (0..n).map(|a| (0..H).map(|h| own[h] * strat[a * H + h]).collect()).collect();
            let cvs: Vec<Vec<f32>> = (0..n).into_par_iter()
                .map(|a| self.cfr(kids[a] as usize, p, &own2[a], opp, disc)).collect();
            for a in 0..n {
                for h in 0..H {
                    v[h] += strat[a * H + h] * cvs[a][h];
                }
            }
            for a in 0..n {
                for h in 0..H {
                    let x = &mut r[a * H + h];
                    *x += cvs[a][h] - v[h];
                    *x *= if *x > 0.0 { fp } else { fneg };
                }
            }
            self.regret.store(off, id, &r);
            let mut s = vec![0.0f32; n * H];
            self.sum.load(off, id, &mut s);
            for a in 0..n {
                for h in 0..H {
                    s[a * H + h] = (s[a * H + h] + own2[a][h]) * fa;
                }
            }
            self.sum.store(off, id, &s);
        } else {
            let cvs: Vec<Vec<f32>> = (0..n).into_par_iter().map(|a| {
                let opp2: Vec<f32> = (0..H).map(|h| opp[h] * strat[a * H + h]).collect();
                self.cfr(kids[a] as usize, p, own, &opp2, disc)
            }).collect();
            for cv in &cvs {
                for h in 0..H {
                    v[h] += cv[h];
                }
            }
        }
        v
    }

    pub fn iterate(&mut self) {
        self.iters += 1;
        let t = self.iters as f64;
        let disc = (self.params.pos(t) as f32, self.params.neg(t) as f32, self.params.avg(t) as f32);
        for p in 0..2 {
            let (own, opp) = (self.w[p].clone(), self.w[1 - p].clone());
            self.cfr(self.root as usize, p, &own, &opp, disc);
        }
    }

    pub fn solve(&mut self, iters: u32) {
        for _ in 0..iters {
            self.iterate();
        }
    }

    /// Best response value per hand against the average strategy. Evaluates every dealt card
    /// (not just canonical ones), mapping reach through the suit perms.
    fn br(&self, id: usize, p: usize, opp: &[f32], best: bool) -> Vec<f32> {
        let nd = &self.nodes[id];
        match nd.kind {
            K::Fold | K::Showdown => return self.terminal(nd, p, opp),
            K::Chance => {
                let items: Vec<(usize, u8, u8)> = self.chances[nd.aux as usize].iter().enumerate()
                    .flat_map(|(i, o)| o.members.iter().map(move |&(c, pm)| (i, c, pm))).collect();
                let res: Vec<Vec<f32>> = items.par_iter().map(|&(i, ck, pm)| {
                    let o = &self.chances[nd.aux as usize][i];
                    let m = &self.hmap[pm as usize];
                    let oppk = self.mask(opp, ck);
                    let oppc: Vec<f32> = (0..H).map(|h| oppk[m[h] as usize]).collect();
                    self.mask(&self.br(o.child as usize, p, &oppc, best), o.card)
                }).collect();
                let mut v = vec![0.0f32; H];
                for (&(_, _, pm), cv) in items.iter().zip(&res) {
                    self.scatter(&mut v, cv, pm);
                }
                return v;
            }
            K::Action => {}
        }
        let n = nd.n as usize;
        let q = nd.player as usize;
        let mut s = vec![0.0f32; n * H];
        self.sum.load(nd.data_off, id, &mut s);
        let strat = normalize(&s, n);
        let kids = &self.children[nd.child_off as usize..nd.child_off as usize + n];
        let cvs: Vec<Vec<f32>> = (0..n).into_par_iter().map(|a| {
            if q == p {
                self.br(kids[a] as usize, p, opp, best)
            } else {
                let opp2: Vec<f32> = (0..H).map(|h| opp[h] * strat[a * H + h]).collect();
                self.br(kids[a] as usize, p, &opp2, best)
            }
        }).collect();
        let mut v = vec![if q == p && best { f32::NEG_INFINITY } else { 0.0 }; H];
        for (a, cv) in cvs.iter().enumerate() {
            for h in 0..H {
                if q == p && best { v[h] = v[h].max(cv[h]) }
                else if q == p { v[h] += strat[a * H + h] * cv[h] }
                else { v[h] += cv[h] }
            }
        }
        v
    }

    pub fn exploitability_pct(&self) -> f32 {
        let mut tot = 0.0f64;
        for p in 0..2 {
            let v = self.br(self.root as usize, p, &self.w[1 - p], true);
            tot += (0..H).filter(|&h| self.w[p][h] > 0.0).map(|h| (self.w[p][h] * v[h]) as f64).sum::<f64>();
        }
        (100.0 * tot / 2.0 / self.norm as f64 / self.pot as f64) as f32
    }

    /// Average-strategy view of the node reached by `path`: an action index at Action nodes,
    /// a (canonical) card at Chance nodes. `ev` is the acting player's per-combo value in raw
    /// chips under the average strategy, weighted by the opponent's reach (not renormalized).
    pub fn query(&self, path: &[u32]) -> Result<NodeView, String> {
        let mut id = self.root as usize;
        let mut reach = self.w.clone();
        for &x in path {
            let nd = &self.nodes[id];
            match nd.kind {
                K::Action => {
                    let n = nd.n as usize;
                    if x as usize >= n {
                        return Err(format!("action {x} out of range (node has {n})"));
                    }
                    let mut s = vec![0.0f32; n * H];
                    self.sum.load(nd.data_off, id, &mut s);
                    let strat = normalize(&s, n);
                    let q = nd.player as usize;
                    for h in 0..H {
                        reach[q][h] *= strat[x as usize * H + h];
                    }
                    id = self.children[nd.child_off as usize + x as usize] as usize;
                }
                K::Chance => {
                    let o = self.chances[nd.aux as usize].iter().find(|o| o.card as u32 == x)
                        .ok_or_else(|| format!("card {x} is not a canonical chance card here"))?;
                    for r in reach.iter_mut() {
                        *r = self.mask(r, o.card);
                    }
                    id = o.child as usize;
                }
                _ => return Err("path goes past a terminal node".into()),
            }
        }
        let nd = &self.nodes[id];
        Ok(match nd.kind {
            K::Action => {
                let n = nd.n as usize;
                let mut s = vec![0.0f32; n * H];
                self.sum.load(nd.data_off, id, &mut s);
                let q = nd.player as usize;
                NodeView { kind: "action".to_string(), player: nd.player, n, cards: vec![], strategy: normalize(&s, n),
                    ev: self.br(id, q, &reach[1 - q], false), range: reach[q].clone() }
            }
            K::Chance => NodeView { kind: "chance".to_string(), player: 0, n: 0,
                cards: self.chances[nd.aux as usize].iter().map(|o| o.card).collect(),
                strategy: vec![], ev: vec![], range: vec![] },
            K::Fold => NodeView { kind: "fold".to_string(), player: nd.player, n: 0, cards: vec![], strategy: vec![], ev: vec![], range: vec![] },
            K::Showdown => NodeView { kind: "showdown".to_string(), player: 0, n: 0, cards: vec![], strategy: vec![], ev: vec![], range: vec![] },
        })
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct NodeView {
    pub kind: String,
    pub player: u8,
    pub n: usize,
    pub cards: Vec<u8>,
    /// n * H, action-major.
    pub strategy: Vec<f32>,
    pub ev: Vec<f32>,
    /// Acting player's reach per combo.
    pub range: Vec<f32>,
}
