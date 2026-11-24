//! Multi-street (flop/turn/river) vector DCFR with chance nodes, suit isomorphism,
//! memory estimate, rayon parallelism over chance/action children, optional i16 storage.
use crate::cards::{combos, eval7};
use crate::tree::{TreeConfig, H};
use gto_core::Params;
#[cfg(feature = "rayon")]
use rayon::prelude::*;
#[cfg(not(feature = "rayon"))]
use crate::seq::*;
use std::cell::{RefCell, UnsafeCell};

/// Scratch floats per thread, in units of H (a few dozen live buffers per recursion depth).
const SCRATCH_H: usize = 192;

thread_local! {
    /// Per-thread bump scratch for the sequential part of the traversal (no malloc in the hot loop:
    /// glibc arena locks made 4 threads scale at ~1.7x).
    static SCRATCH: RefCell<Vec<f32>> = const { RefCell::new(Vec::new()) };
}

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
    /// Opt-in lossy abstraction: at most this many equity buckets per board (see `bucket`).
    /// Hands of one bucket share a strategy at every action node of that street.
    pub buckets: Option<usize>,
}

const NOB: u32 = u32::MAX;

struct BMap {
    map: Vec<u16>,
    k: usize,
    /// Live hands and their slots, round-robin over slots (each slot keeps ascending hand order, so
    /// per-slot sums are bit-identical, but consecutive updates hit different slots: no store-forward chain).
    rounds: Vec<(u16, u16)>,
}

fn make_rounds(map: &[u16]) -> Vec<(u16, u16)> {
    let mut by: Vec<Vec<u16>> = vec![];
    for (h, &m) in map.iter().enumerate() {
        if m != crate::bucket::NONE {
            if by.len() <= m as usize {
                by.resize(m as usize + 1, vec![]);
            }
            by[m as usize].push(h as u16);
        }
    }
    let mut out = vec![];
    for r in 0..by.iter().map(|v| v.len()).max().unwrap_or(0) {
        for (j, v) in by.iter().enumerate() {
            if r < v.len() {
                out.push((v[r], j as u16));
            }
        }
    }
    out
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
    /// Action/Chance: fan out over children with rayon (first street only).
    par: bool,
    /// Showdown: board id. Chance: chance id. Action: bucket map id (`NOB` = none).
    aux: u32,
}

/// Isomorphism class of dealt cards: canonical child plus (card, suit perm canon->card).
struct Orbit {
    card: u8,
    child: u32,
    members: Vec<(u8, u8)>,
}

struct Board {
    /// Live combos sorted by strength.
    order: Vec<u16>,
    /// Exclusive end position (in `order`) of each group of equal strength.
    ends: Vec<u16>,
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
    bmaps: Vec<BMap>,
    bcache: std::collections::HashMap<u64, u32>,
    board_cache: std::collections::HashMap<u64, u32>,
    /// Dry run: distinct boards that need a bucket map (computed in parallel before the real build).
    dry_keys: Vec<Vec<u8>>,
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
    bm: u32,
}

impl<'a> Builder<'a> {
    fn push(&mut self, kind: K, player: u8, pay: f32, ch: Vec<u32>, aux: u32) -> u32 {
        self.n_nodes += 1;
        let w = if kind != K::Action || aux == NOB { H } else if self.dry { self.cfg.buckets.unwrap() } else { self.bmaps[aux as usize].k };
        if kind == K::Action {
            self.data_len += ch.len() * w;
            self.n_action += 1;
        }
        if self.dry {
            return 0;
        }
        let child_off = self.children.len() as u32;
        let n = ch.len() as u32;
        self.children.extend(ch);
        let data_off = if kind == K::Action { self.data_len - n as usize * w } else { 0 };
        self.nodes.push(N { kind, player, pay, child_off, n, data_off, par: false, aux });
        (self.nodes.len() - 1) as u32
    }

    fn street(&mut self, board: &[u8], s: usize, pot: f32, stack: f32) -> u32 {
        let mut bid = 0;
        if s + 1 == self.cfg.streets.len() {
            let mut mask = 0u64;
            for &b in board {
                mask |= 1 << b;
            }
            let mut fresh = false;
            // One Board per distinct 5-card set (the same river is reached via many tree paths).
            if let Some(&i) = self.board_cache.get(&mask) {
                bid = i;
            } else {
                bid = self.boards.len() as u32;
                self.board_cache.insert(mask, bid);
                self.n_boards += 1;
                fresh = true;
            }
            if !self.dry && fresh {
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
                let mut ends = vec![];
                for k in 1..=order.len() {
                    if k == order.len() || strength[order[k] as usize] != strength[order[k - 1] as usize] {
                        ends.push(k as u16);
                    }
                }
                self.boards.push(Board { order, ends });
            }
        }
        let mut bm = NOB;
        if let Some(k) = self.cfg.buckets {
            bm = 0;
            if self.dry {
                let key = board.iter().fold(0u64, |m, &b| m | 1 << b);
                if self.bcache.insert(key, 0).is_none() {
                    self.dry_keys.push(board.to_vec());
                }
            } else {
                let key = board.iter().fold(0u64, |m, &b| m | 1 << b);
                bm = match self.bcache.get(&key) {
                    Some(&i) => i,
                    None => {
                        let map = crate::bucket::bucket_board(board, k);
                        let kk = map.iter().filter(|&&x| x != crate::bucket::NONE).map(|&x| x as usize + 1).max().unwrap_or(1);
                        let rounds = make_rounds(&map);
                        self.bmaps.push(BMap { map, k: kk, rounds });
                        self.bcache.insert(key, self.bmaps.len() as u32 - 1);
                        self.bmaps.len() as u32 - 1
                    }
                };
            }
        }
        let ctx = Ctx { board: board.to_vec(), s, pot, stack, bid, bm };
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
        let nid = self.push(K::Chance, 0, 0.0, vec![], id);
        if !self.dry {
            // Only the first street fans out (tasks below are small; fine-grained rayon thrashes futexes).
            self.nodes[nid as usize].par = ctx.s == 0;
        }
        nid
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
        let id = self.push(K::Action, me as u8, 0.0, ch, ctx.bm);
        if !self.dry {
            self.nodes[id as usize].par = ctx.s == 0;
        }
        id
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
        boards: vec![], bmaps: vec![], bcache: Default::default(), board_cache: Default::default(), dry_keys: vec![], data_len: 0, n_nodes: 0, n_action: 0, n_boards: 0,
    }
}

fn run_build(b: &mut Builder) -> u32 {
    let cfg = b.cfg;
    let t = &cfg.streets[0];
    b.street(&cfg.board.clone(), 0, t.pot, t.stack)
}

/// Estimated bytes of solver state (regret + strategy sum, tree, boards); Err if above `budget_bytes`.
pub fn estimate_memory(cfg: &StreetConfig, budget_bytes: u64) -> Result<u64, String> {
    estimate_keys(cfg, budget_bytes).map(|x| x.0)
}

fn estimate_keys(cfg: &StreetConfig, budget_bytes: u64) -> Result<(u64, Vec<Vec<u8>>), String> {
    let (cb, ps, hm) = build_tables();
    let mut b = make(cfg, true, &cb, &ps, &hm);
    run_build(&mut b);
    let per = if cfg.compress { 4 } else { 8 };
    let bytes = (b.data_len * per + b.n_action * 8 + b.n_nodes * std::mem::size_of::<N>() + b.n_boards * H * 6) as u64;
    if bytes > budget_bytes {
        Err(format!("estimated {bytes} bytes exceeds budget {budget_bytes}"))
    } else {
        Ok((bytes, std::mem::take(&mut b.dry_keys)))
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
    bmaps: Vec<BMap>,
    root: u32,
    combos: Vec<(u8, u8)>,
    hmap: Vec<Vec<u16>>,
    /// Identity slot map for unbucketed nodes (and its rounds list).
    ident: Vec<u16>,
    ident_rounds: Vec<(u16, u16)>,
    /// Per card: combos containing it.
    card_hands: Vec<Vec<u16>>,
    w: [Vec<f32>; 2],
    norm: f32,
    pot: f32,
    /// Board cards (bitmask) and number of chance streets below the root.
    dead0: u64,
    left0: usize,
    regret: Arr,
    sum: Arr,
    params: Params,
    pub iters: u32,
}

fn regret_match_into(r: &[f32], n: usize, w: usize, out: &mut [f32]) {
    for h in 0..w {
        let tot: f32 = (0..n).map(|a| r[a * w + h].max(0.0)).sum();
        for a in 0..n {
            out[a * w + h] = if tot > 0.0 { r[a * w + h].max(0.0) / tot } else { 1.0 / n as f32 };
        }
    }
}

fn normalize(s: &[f32], n: usize, w: usize) -> Vec<f32> {
    let mut out = vec![0.0f32; n * w];
    for h in 0..w {
        let tot: f32 = (0..n).map(|a| s[a * w + h]).sum();
        for a in 0..n {
            out[a * w + h] = if tot > 0.0 { s[a * w + h] / tot } else { 1.0 / n as f32 };
        }
    }
    out
}

impl StreetSolver {
    pub fn new(cfg: &StreetConfig, budget_bytes: u64) -> Result<Self, String> {
        let (_, keys) = estimate_keys(cfg, budget_bytes)?;
        let (cb, ps, hm) = build_tables();
        let mut b = make(cfg, false, &cb, &ps, &hm);
        if let Some(k) = cfg.buckets {
            let maps: Vec<Vec<u16>> = keys.par_iter().map(|bd| crate::bucket::bucket_board(bd, k)).collect();
            for (bd, map) in keys.iter().zip(maps) {
                let kk = map.iter().filter(|&&x| x != crate::bucket::NONE).map(|&x| x as usize + 1).max().unwrap_or(1);
                let rounds = make_rounds(&map);
                b.bmaps.push(BMap { map, k: kk, rounds });
                b.bcache.insert(bd.iter().fold(0u64, |m, &c| m | 1 << c), b.bmaps.len() as u32 - 1);
            }
        }
        let root = run_build(&mut b);
        let (nodes, children, chances, boards, data_len) = (b.nodes, b.children, b.chances, b.boards, b.data_len);
        let bmaps = b.bmaps;
        let mut w = [cfg.ranges[0].clone(), cfg.ranges[1].clone()];
        for (i, &(a, c)) in cb.iter().enumerate() {
            if cfg.board.contains(&a) || cfg.board.contains(&c) {
                w[0][i] = 0.0;
                w[1][i] = 0.0;
            }
        }
        let n_nodes = nodes.len();
        let mut s = StreetSolver {
            nodes, children, chances, boards, bmaps, root, card_hands: (0..52u8).map(|c| (0..H as u16).filter(|&h| { let (a, b) = cb[h as usize]; a == c || b == c }).collect()).collect(),
            ident: (0..H as u16).collect(),
            ident_rounds: (0..H as u16).map(|h| (h, h)).collect(),
            combos: cb, hmap: hm, w, norm: 1.0, pot: cfg.streets[0].pot, dead0: cfg.board.iter().fold(0u64, |d, &c| d | 1 << c), left0: cfg.streets.len() - 1,
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

    fn bmap(&self, nd: &N) -> Option<&BMap> {
        if nd.aux == NOB { None } else { Some(&self.bmaps[nd.aux as usize]) }
    }

    /// Per-hand strategy (n*H, action-major) from a per-slot (hand or bucket) strategy.
    fn expand(&self, nd: &N, sb: Vec<f32>) -> Vec<f32> {
        let Some(bm) = self.bmap(nd) else { return sb };
        let n = nd.n as usize;
        let mut out = vec![1.0 / n as f32; n * H];
        for h in 0..H {
            if bm.map[h] != crate::bucket::NONE {
                for a in 0..n {
                    out[a * H + h] = sb[a * bm.k + bm.map[h] as usize];
                }
            }
        }
        out
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

    /// Showdown values scaled by `pay`, written to `out`.
    /// out[h] = ((sum of weaker opp) - (sum of stronger opp), card-blocked removed) * pay. The forward
    /// and backward sweeps run interleaved (independent dependency chains) with the same per-hand
    /// arithmetic as two sequential sweeps, so results are bit-identical.
    fn showdown(&self, bd: &Board, opp: &[f32], pay: f32, out: &mut [f32]) {
        assert!(opp.len() == H && out.len() == H);
        let combos = &self.combos[..];
        out.fill(0.0);
        let mut y = [0.0f32; H];
        let (mut cf, mut cb) = ([0.0f32; 64], [0.0f32; 64]);
        let (mut tf, mut tb) = (0.0f32, 0.0f32);
        // One group of the sweep; `rev` walks the group backwards. Indices are < H by construction.
        #[inline(always)]
        fn step(grp: &[u16], rev: bool, combos: &[(u8, u8)], opp: &[f32], cum: &mut [f32; 64], tot: &mut f32, dst: &mut [f32]) {
            if grp.len() == 1 {
                let h = grp[0] as usize;
                let (a, b) = unsafe { *combos.get_unchecked(h) };
                let (a, b) = (a as usize & 63, b as usize & 63);
                let o = unsafe { *opp.get_unchecked(h) };
                unsafe { *dst.get_unchecked_mut(h) = *tot - cum[a] - cum[b] };
                cum[a] += o;
                cum[b] += o;
                *tot += o;
                return;
            }
            let t0 = *tot;
            for &h in grp {
                let h = h as usize;
                let (a, b) = unsafe { *combos.get_unchecked(h) };
                unsafe { *dst.get_unchecked_mut(h) = t0 - cum[a as usize & 63] - cum[b as usize & 63] };
            }
            let mut t = t0;
            let mut upd = |h: u16| {
                let h = h as usize;
                let (a, b) = unsafe { *combos.get_unchecked(h) };
                let o = unsafe { *opp.get_unchecked(h) };
                cum[a as usize & 63] += o;
                cum[b as usize & 63] += o;
                t += o;
            };
            if rev { grp.iter().rev().for_each(|&h| upd(h)) } else { grp.iter().for_each(|&h| upd(h)) }
            *tot = t;
        }
        let ng = bd.ends.len();
        let end = |g: usize| bd.ends[g] as usize;
        for i in 0..ng {
            let (gf, gb) = (i, ng - 1 - i);
            let (sf, sb) = (if gf == 0 { 0 } else { end(gf - 1) }, if gb == 0 { 0 } else { end(gb - 1) });
            step(&bd.order[sf..end(gf)], false, combos, opp, &mut cf, &mut tf, out);
            step(&bd.order[sb..end(gb)], true, combos, opp, &mut cb, &mut tb, &mut y);
        }
        for &h in &bd.order {
            let h = h as usize;
            out[h] = (out[h] + -1.0 * y[h]) * pay;
        }
    }

    fn terminal_into(&self, nd: &N, p: usize, opp: &[f32], out: &mut [f32]) {
        if nd.kind == K::Showdown {
            return self.showdown(&self.boards[nd.aux as usize], opp, nd.pay, out);
        }
        let sign = if nd.player as usize == p { -1.0 } else { 1.0 };
        let mut cs = [0.0f32; 52];
        let mut tot = 0.0;
        for (&(a, b), &o) in self.combos.iter().zip(opp) {
            cs[a as usize] += o;
            cs[b as usize] += o;
            tot += o;
        }
        for ((d, &(a, b)), &o) in out.iter_mut().zip(&self.combos).zip(opp) {
            *d = (tot - cs[a as usize] - cs[b as usize] + o) * sign * nd.pay;
        }
    }

    fn terminal(&self, nd: &N, p: usize, opp: &[f32]) -> Vec<f32> {
        let mut out = vec![0.0f32; H];
        self.terminal_into(nd, p, opp, &mut out);
        out
    }

    fn mask(&self, v: &[f32], card: u8) -> Vec<f32> {
        let mut out = v.to_vec();
        self.zero_card(&mut out, card);
        out
    }

    fn zero_card(&self, v: &mut [f32], card: u8) {
        for &h in &self.card_hands[card as usize] {
            v[h as usize] = 0.0;
        }
    }

    /// Scatter canonical-coordinate values into member coordinates: out[perm(h)] += v[h].
    fn scatter(&self, out: &mut [f32], v: &[f32], perm: u8) {
        if perm == 0 {
            for (o, &x) in out.iter_mut().zip(v) {
                *o += x;
            }
            return;
        }
        let m = &self.hmap[perm as usize];
        for h in 0..H {
            out[m[h] as usize] += v[h];
        }
    }

    /// Entry for a (possibly parallel) task: sequential subtrees use the thread's scratch.
    fn run(&self, id: usize, p: usize, own: &[f32], opp: &[f32], disc: (f32, f32, f32), out: &mut [f32]) {
        if self.nodes[id].par {
            return self.cfr(id, p, own, opp, disc, out, &mut []);
        }
        SCRATCH.with(|s| {
            let mut s = s.borrow_mut();
            if s.is_empty() {
                s.resize(SCRATCH_H * H, 0.0);
            }
            self.cfr(id, p, own, opp, disc, out, &mut s)
        });
    }

    /// Counterfactual values of `p`'s hands at node `id` into `out` (H). `sc` is bump scratch.
    /// On x86_64 with AVX2 the body is compiled for it (no FMA, so results equal the SSE2 build bit for bit).
    #[allow(clippy::too_many_arguments)]
    fn cfr(&self, id: usize, p: usize, own: &[f32], opp: &[f32], disc: (f32, f32, f32), out: &mut [f32], sc: &mut [f32]) {
        #[cfg(target_arch = "x86_64")]
        if std::is_x86_feature_detected!("avx2") {
            // SAFETY: feature checked above.
            return unsafe { self.cfr_avx2(id, p, own, opp, disc, out, sc) };
        }
        self.cfr_impl(id, p, own, opp, disc, out, sc)
    }

    #[cfg(target_arch = "x86_64")]
    #[target_feature(enable = "avx2")]
    #[allow(clippy::too_many_arguments)]
    unsafe fn cfr_avx2(&self, id: usize, p: usize, own: &[f32], opp: &[f32], disc: (f32, f32, f32), out: &mut [f32], sc: &mut [f32]) {
        self.cfr_impl(id, p, own, opp, disc, out, sc)
    }

    #[inline(always)]
    #[allow(clippy::too_many_arguments)]
    fn cfr_impl(&self, id: usize, p: usize, own: &[f32], opp: &[f32], disc: (f32, f32, f32), out: &mut [f32], sc: &mut [f32]) {
        let nd = &self.nodes[id];
        match nd.kind {
            K::Fold | K::Showdown => return self.terminal_into(nd, p, opp, out),
            K::Chance => {
                out.fill(0.0);
                let os = &self.chances[nd.aux as usize];
                if nd.par {
                    let mut res = vec![0.0f32; os.len() * H];
                    res.par_chunks_mut(H).zip(os.par_iter()).for_each(|(cv, o)| {
                        let (own2, opp2) = (self.mask(own, o.card), self.mask(opp, o.card));
                        self.run(o.child as usize, p, &own2, &opp2, disc, cv);
                        self.zero_card(cv, o.card);
                    });
                    for (o, cv) in os.iter().zip(res.chunks(H)) {
                        for &(_, perm) in &o.members {
                            self.scatter(out, cv, perm);
                        }
                    }
                } else {
                    let mut heap;
                    let sc = if sc.len() >= 3 * H { sc } else { heap = vec![0.0f32; 3 * H]; &mut heap[..] };
                    let (own2, sc) = sc.split_at_mut(H);
                    let (opp2, sc) = sc.split_at_mut(H);
                    let (cv, sc) = sc.split_at_mut(H);
                    for o in os {
                        own2.copy_from_slice(own);
                        opp2.copy_from_slice(opp);
                        self.zero_card(own2, o.card);
                        self.zero_card(opp2, o.card);
                        self.cfr(o.child as usize, p, own2, opp2, disc, cv, sc);
                        self.zero_card(cv, o.card);
                        for &(_, perm) in &o.members {
                            self.scatter(out, cv, perm);
                        }
                    }
                }
                return;
            }
            K::Action => {}
        }
        let n = nd.n as usize;
        let off = nd.data_off;
        let (map, w, rounds): (&[u16], usize, &[(u16, u16)]) = match self.bmap(nd) {
            Some(b) => (&b.map, b.k, &b.rounds),
            None => (&self.ident, H, &self.ident_rounds),
        };
        let need = 3 * n * H + 3 * n * w + 3 * (w + 1);
        let mut heap;
        let sc = if !nd.par && sc.len() >= need { sc } else { heap = vec![0.0f32; need]; &mut heap[..] };
        let (strat, sc) = sc.split_at_mut(n * H);
        let (sl, sc) = sc.split_at_mut(n * H); // own2 (player node) or opp2 (opponent node)
        let (cvs, sc) = sc.split_at_mut(n * H);
        let (r, sc) = sc.split_at_mut(n * w);
        let (sb, sc) = sc.split_at_mut(n * w);
        let (sm, sc) = sc.split_at_mut(n * w);
        let (ext, sc) = sc.split_at_mut(w + 1);
        let (rr, sc) = sc.split_at_mut(w + 1);
        let (ss, sc) = sc.split_at_mut(w + 1);
        self.regret.load(off, id, r);
        regret_match_into(r, n, w, sb);
        // Per-hand strategy rows (blocked hands, slot >= w, get the uniform entry).
        for a in 0..n {
            ext[..w].copy_from_slice(&sb[a * w..(a + 1) * w]);
            ext[w] = 1.0 / n as f32;
            for (o, &m) in strat[a * H..(a + 1) * H].iter_mut().zip(map) {
                *o = ext[(m as usize).min(w)];
            }
        }
        let kids = &self.children[nd.child_off as usize..nd.child_off as usize + n];
        let (fp, fneg, fa) = disc;
        let is_p = nd.player as usize == p;
        if is_p {
            for a in 0..n {
                for ((o, &x), &s) in sl[a * H..(a + 1) * H].iter_mut().zip(own).zip(&strat[a * H..(a + 1) * H]) {
                    *o = x * s;
                }
            }
        } else {
            for a in 0..n {
                for ((o, &x), &s) in sl[a * H..(a + 1) * H].iter_mut().zip(opp).zip(&strat[a * H..(a + 1) * H]) {
                    *o = x * s;
                }
            }
        }
        if nd.par {
            let sl = &*sl;
            cvs.par_chunks_mut(H).enumerate().for_each(|(a, o)| {
                let k = kids[a] as usize;
                let x = &sl[a * H..(a + 1) * H];
                if is_p { self.run(k, p, x, opp, disc, o) } else { self.run(k, p, own, x, disc, o) }
            });
        } else {
            for a in 0..n {
                let k = kids[a] as usize;
                let x = &sl[a * H..(a + 1) * H];
                let o = &mut cvs[a * H..(a + 1) * H];
                if is_p { self.cfr(k, p, x, opp, disc, o, sc) } else { self.cfr(k, p, own, x, disc, o, sc) }
            }
        }
        out.fill(0.0);
        if is_p {
            for a in 0..n {
                for ((vv, &s), &c) in out.iter_mut().zip(&strat[a * H..(a + 1) * H]).zip(&cvs[a * H..(a + 1) * H]) {
                    *vv += s * c;
                }
            }
            self.sum.load(off, id, sm);
            for a in 0..n {
                rr[..w].copy_from_slice(&r[a * w..(a + 1) * w]);
                ss[..w].copy_from_slice(&sm[a * w..(a + 1) * w]);
                rr[w] = 0.0;
                ss[w] = 0.0;
                let (cv, o2) = (&cvs[a * H..(a + 1) * H], &sl[a * H..(a + 1) * H]);
                for &(h, j) in rounds {
                    let (h, j) = (h as usize, j as usize);
                    rr[j] += cv[h] - out[h];
                    ss[j] += o2[h];
                }
                for (d, x) in r[a * w..(a + 1) * w].iter_mut().zip(rr.iter()) {
                    *d = *x * if *x > 0.0 { fp } else { fneg };
                }
                for (d, x) in sm[a * w..(a + 1) * w].iter_mut().zip(ss.iter()) {
                    *d = *x * fa;
                }
            }
            self.regret.store(off, id, r);
            self.sum.store(off, id, sm);
        } else {
            for cv in cvs.chunks(H) {
                for (vv, &c) in out.iter_mut().zip(cv) {
                    *vv += c;
                }
            }
        }
    }

    pub fn iterate(&mut self) {
        self.iters += 1;
        let t = self.iters as f64;
        let disc = (self.params.pos(t) as f32, self.params.neg(t) as f32, self.params.avg(t) as f32);
        for p in 0..2 {
            let mut out = vec![0.0f32; H];
            self.run(self.root as usize, p, &self.w[p], &self.w[1 - p], disc, &mut out);
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
                let f = |&(i, ck, pm): &(usize, u8, u8)| {
                    let o = &self.chances[nd.aux as usize][i];
                    let m = &self.hmap[pm as usize];
                    let oppk = self.mask(opp, ck);
                    let oppc: Vec<f32> = (0..H).map(|h| oppk[m[h] as usize]).collect();
                    self.mask(&self.br(o.child as usize, p, &oppc, best), o.card)
                };
                let res: Vec<Vec<f32>> = if nd.par { items.par_iter().map(f).collect() } else { items.iter().map(f).collect() };
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
        let w = self.bmap(nd).map_or(H, |b| b.k);
        let mut s = vec![0.0f32; n * w];
        self.sum.load(nd.data_off, id, &mut s);
        let strat = self.expand(nd, normalize(&s, n, w));
        let kids = &self.children[nd.child_off as usize..nd.child_off as usize + n];
        let f = |a: usize| {
            if q == p {
                self.br(kids[a] as usize, p, opp, best)
            } else {
                let opp2: Vec<f32> = (0..H).map(|h| opp[h] * strat[a * H + h]).collect();
                self.br(kids[a] as usize, p, &opp2, best)
            }
        };
        let cvs: Vec<Vec<f32>> = if nd.par { (0..n).into_par_iter().map(f).collect() } else { (0..n).map(f).collect() };
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

    /// Root value of player `p` (0 = OOP, 1 = IP) per combo under the average strategy, in raw chips
    /// weighted by the opponent's range (same convention as `NodeView.ev`, but for either player).
    pub fn root_ev(&self, p: usize) -> Vec<f32> {
        self.br(self.root as usize, p, &self.w[1 - p], false)
    }

    /// Per-combo total opponent weight compatible with the combo, summed over all deals of the `left`
    /// remaining chance cards (same weighting as `br` / `norm`), so `ev / opp_mass` is chips per unit deal.
    fn opp_mass_rec(&self, opp: &[f32], dead: u64, left: usize) -> Vec<f32> {
        if left == 0 {
            let mut cs = [0.0f32; 52];
            let mut tot = 0.0;
            for (&(a, b), &o) in self.combos.iter().zip(opp) { cs[a as usize] += o; cs[b as usize] += o; tot += o; }
            return self.combos.iter().zip(opp).map(|(&(a, b), &o)| tot - cs[a as usize] - cs[b as usize] + o).collect();
        }
        let mut out = vec![0.0f32; H];
        for c in (0..52u8).filter(|&c| dead >> c & 1 == 0) {
            let sub = self.opp_mass_rec(&self.mask(opp, c), dead | 1 << c, left - 1);
            for h in 0..H {
                let (a, b) = self.combos[h];
                if a != c && b != c { out[h] += sub[h]; }
            }
        }
        out
    }

    /// Average-strategy view of the node reached by `path`: an action index at Action nodes,
    /// a (canonical) card at Chance nodes. `ev` is the acting player's per-combo value in raw
    /// chips under the average strategy, weighted by the opponent's reach (not renormalized).
    pub fn query(&self, path: &[u32]) -> Result<NodeView, String> {
        let mut id = self.root as usize;
        let mut reach = self.w.clone();
        let (mut dead, mut left) = (self.dead0, self.left0);
        for &x in path {
            let nd = &self.nodes[id];
            match nd.kind {
                K::Action => {
                    let n = nd.n as usize;
                    if x as usize >= n {
                        return Err(format!("action {x} out of range (node has {n})"));
                    }
                    let w = self.bmap(nd).map_or(H, |b| b.k);
                    let mut s = vec![0.0f32; n * w];
                    self.sum.load(nd.data_off, id, &mut s);
                    let strat = self.expand(nd, normalize(&s, n, w));
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
                    dead |= 1 << o.card; left -= 1;
                    id = o.child as usize;
                }
                _ => return Err("path goes past a terminal node".into()),
            }
        }
        let nd = &self.nodes[id];
        Ok(match nd.kind {
            K::Action => {
                let n = nd.n as usize;
                let w = self.bmap(nd).map_or(H, |b| b.k);
                let mut s = vec![0.0f32; n * w];
                self.sum.load(nd.data_off, id, &mut s);
                let q = nd.player as usize;
                let kids = &self.children[nd.child_off as usize..nd.child_off as usize + n];
                let action_ev: Vec<f32> = kids.iter().flat_map(|&k| self.br(k as usize, q, &reach[1 - q], false)).collect();
                let opp = &reach[1 - q];
                let opp_mass = self.opp_mass_rec(opp, dead, left);
                NodeView { kind: "action".to_string(), player: nd.player, n, cards: vec![], strategy: self.expand(nd, normalize(&s, n, w)),
                    ev: self.br(id, q, &reach[1 - q], false), range: reach[q].clone(), action_ev, opp_mass }
            }
            K::Chance => NodeView { kind: "chance".to_string(), player: 0, n: 0,
                cards: self.chances[nd.aux as usize].iter().map(|o| o.card).collect(),
                strategy: vec![], ev: vec![], range: vec![], action_ev: vec![], opp_mass: vec![] },
            K::Fold => NodeView { kind: "fold".to_string(), player: nd.player, n: 0, cards: vec![], strategy: vec![], ev: vec![], range: vec![], action_ev: vec![], opp_mass: vec![] },
            K::Showdown => NodeView { kind: "showdown".to_string(), player: 0, n: 0, cards: vec![], strategy: vec![], ev: vec![], range: vec![], action_ev: vec![], opp_mass: vec![] },
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
    /// Action nodes: n * H, action-major per-combo value (raw chips, same convention as `ev`) of each action.
    #[serde(default)]
    pub action_ev: Vec<f32>,
    /// Action nodes: opponent reach not blocked by each combo; divide `action_ev` by it for chips.
    #[serde(default)]
    pub opp_mass: Vec<f32>,
}
