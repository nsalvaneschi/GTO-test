//! Generic game trait + scalar CFR/CFR+/DCFR and exploitability.
use std::collections::HashMap;

pub enum Node {
    /// Chance node: probability of each outcome.
    Chance(Vec<f64>),
    /// Decision node: (player, number of actions).
    Player(usize, usize),
    /// Terminal: payoff to player 0 (zero-sum).
    Terminal(f64),
}

pub trait Game {
    type State: Clone;
    fn root(&self) -> Self::State;
    fn node(&self, s: &Self::State) -> Node;
    /// Apply action index (or chance outcome index).
    fn apply(&self, s: &Self::State, a: usize) -> Self::State;
    /// Key of the acting player's information set.
    fn infoset_key(&self, s: &Self::State) -> String;
}

#[derive(Clone, Copy, Debug)]
pub struct Params {
    pub alpha: f64,
    pub beta: f64,
    pub gamma: f64,
}

impl Params {
    pub fn dcfr() -> Self {
        Params { alpha: 1.5, beta: 0.0, gamma: 2.0 }
    }
    pub fn cfr_plus() -> Self {
        Params { alpha: f64::INFINITY, beta: f64::NEG_INFINITY, gamma: 2.0 }
    }
    fn pos(&self, t: f64) -> f64 {
        if self.alpha.is_infinite() { 1.0 } else { let a = t.powf(self.alpha); a / (a + 1.0) }
    }
    fn neg(&self, t: f64) -> f64 {
        if self.beta == f64::NEG_INFINITY { 0.0 } else { let b = t.powf(self.beta); b / (b + 1.0) }
    }
    fn avg(&self, t: f64) -> f64 {
        (t / (t + 1.0)).powf(self.gamma)
    }
}

struct Info {
    regret: Vec<f64>,
    sum: Vec<f64>,
    // Deltas applied after each pass so the strategy is fixed within a pass.
    dr: Vec<f64>,
    ds: Vec<f64>,
}

pub struct Solver<'a, G: Game> {
    game: &'a G,
    params: Params,
    info: HashMap<String, Info>,
    pub iters: u32,
}

fn regret_match(r: &[f64]) -> Vec<f64> {
    let tot: f64 = r.iter().map(|x| x.max(0.0)).sum();
    if tot > 0.0 {
        r.iter().map(|x| x.max(0.0) / tot).collect()
    } else {
        vec![1.0 / r.len() as f64; r.len()]
    }
}

impl<'a, G: Game> Solver<'a, G> {
    pub fn new(game: &'a G, params: Params) -> Self {
        Solver { game, params, info: HashMap::new(), iters: 0 }
    }

    /// One alternating-update iteration followed by discounting.
    pub fn iterate(&mut self) {
        self.iters += 1;
        let root = self.game.root();
        for p in 0..2 {
            self.traverse(&root, p, 1.0, 1.0);
            for i in self.info.values_mut() {
                for a in 0..i.regret.len() {
                    i.regret[a] += std::mem::take(&mut i.dr[a]);
                    i.sum[a] += std::mem::take(&mut i.ds[a]);
                }
            }
        }
        let t = self.iters as f64;
        let (fp, fn_, fa) = (self.params.pos(t), self.params.neg(t), self.params.avg(t));
        for i in self.info.values_mut() {
            for r in i.regret.iter_mut() {
                *r *= if *r > 0.0 { fp } else { fn_ };
            }
            for s in i.sum.iter_mut() {
                *s *= fa;
            }
        }
    }

    /// Value for player `p`. `pi` = p's own reach, `po` = opponent*chance reach.
    fn traverse(&mut self, s: &G::State, p: usize, pi: f64, po: f64) -> f64 {
        match self.game.node(s) {
            Node::Terminal(v) => if p == 0 { v } else { -v },
            Node::Chance(probs) => {
                let mut v = 0.0;
                for (a, pr) in probs.iter().enumerate() {
                    let c = self.game.apply(s, a);
                    v += pr * self.traverse(&c, p, pi, po * pr);
                }
                v
            }
            Node::Player(q, n) => {
                let key = self.game.infoset_key(s);
                let strat = {
                    let e = self.info.entry(key.clone()).or_insert_with(|| Info {
                        regret: vec![0.0; n],
                        sum: vec![0.0; n],
                        dr: vec![0.0; n],
                        ds: vec![0.0; n],
                    });
                    regret_match(&e.regret)
                };
                if q == p {
                    let mut u = vec![0.0; n];
                    let mut v = 0.0;
                    for a in 0..n {
                        let c = self.game.apply(s, a);
                        u[a] = self.traverse(&c, p, pi * strat[a], po);
                        v += strat[a] * u[a];
                    }
                    let e = self.info.get_mut(&key).unwrap();
                    for a in 0..n {
                        e.dr[a] += po * (u[a] - v);
                        e.ds[a] += pi * strat[a];
                    }
                    v
                } else {
                    let mut v = 0.0;
                    for a in 0..n {
                        let c = self.game.apply(s, a);
                        v += strat[a] * self.traverse(&c, p, pi, po * strat[a]);
                    }
                    v
                }
            }
        }
    }

    /// Average strategy at an infoset (uniform if unseen).
    pub fn average(&self, key: &str, n: usize) -> Vec<f64> {
        match self.info.get(key) {
            Some(i) => {
                let t: f64 = i.sum.iter().sum();
                if t > 0.0 { i.sum.iter().map(|x| x / t).collect() } else { vec![1.0 / n as f64; n] }
            }
            None => vec![1.0 / n as f64; n],
        }
    }

    pub fn game_value(&self) -> f64 {
        value(self.game, &self.game.root(), &|k, n| self.average(k, n))
    }

    /// (BR_0 + BR_1) / 2 against the average strategy.
    pub fn exploitability(&self) -> f64 {
        exploitability(self.game, &|k, n| self.average(k, n))
    }
}

/// Expected payoff to player 0 under strategy `strat(key, n_actions)`.
pub fn value<G: Game>(g: &G, s: &G::State, strat: &dyn Fn(&str, usize) -> Vec<f64>) -> f64 {
    match g.node(s) {
        Node::Terminal(v) => v,
        Node::Chance(pr) => pr.iter().enumerate().map(|(a, p)| p * value(g, &g.apply(s, a), strat)).sum(),
        Node::Player(_, n) => {
            let st = strat(&g.infoset_key(s), n);
            (0..n).map(|a| st[a] * value(g, &g.apply(s, a), strat)).sum()
        }
    }
}

pub fn exploitability<G: Game>(g: &G, strat: &dyn Fn(&str, usize) -> Vec<f64>) -> f64 {
    (best_response(g, 0, strat) + best_response(g, 1, strat)) / 2.0
}

/// Value to player `b` of a best response against `strat` for the other player.
pub fn best_response<G: Game>(g: &G, b: usize, strat: &dyn Fn(&str, usize) -> Vec<f64>) -> f64 {
    // Collect b's infosets with member states weighted by opponent*chance reach.
    let mut sets: HashMap<String, Vec<(G::State, f64)>> = HashMap::new();
    collect(g, &g.root(), b, 1.0, strat, &mut sets);
    let mut choice: HashMap<String, usize> = HashMap::new();
    let v = br_val(g, &g.root(), b, strat, &sets, &mut choice);
    if b == 0 { v } else { -v }
}

fn collect<G: Game>(
    g: &G, s: &G::State, b: usize, reach: f64,
    strat: &dyn Fn(&str, usize) -> Vec<f64>,
    sets: &mut HashMap<String, Vec<(G::State, f64)>>,
) {
    match g.node(s) {
        Node::Terminal(_) => {}
        Node::Chance(pr) => for (a, p) in pr.iter().enumerate() {
            collect(g, &g.apply(s, a), b, reach * p, strat, sets);
        },
        Node::Player(q, n) => {
            if q == b {
                sets.entry(g.infoset_key(s)).or_default().push((s.clone(), reach));
                for a in 0..n {
                    collect(g, &g.apply(s, a), b, reach, strat, sets);
                }
            } else {
                let st = strat(&g.infoset_key(s), n);
                for a in 0..n {
                    collect(g, &g.apply(s, a), b, reach * st[a], strat, sets);
                }
            }
        }
    }
}

/// Payoff to player 0 given b plays its best response; opponent plays `strat`.
fn br_val<G: Game>(
    g: &G, s: &G::State, b: usize,
    strat: &dyn Fn(&str, usize) -> Vec<f64>,
    sets: &HashMap<String, Vec<(G::State, f64)>>,
    choice: &mut HashMap<String, usize>,
) -> f64 {
    match g.node(s) {
        Node::Terminal(v) => v,
        Node::Chance(pr) => pr.iter().enumerate().map(|(a, p)| p * br_val(g, &g.apply(s, a), b, strat, sets, choice)).sum(),
        Node::Player(q, n) => {
            if q == b {
                let key = g.infoset_key(s);
                let a = match choice.get(&key) {
                    Some(&a) => a,
                    None => {
                        let sign = if b == 0 { 1.0 } else { -1.0 };
                        let mut best = (f64::NEG_INFINITY, 0);
                        for a in 0..n {
                            let tot: f64 = sets[&key].iter()
                                .map(|(h, r)| r * br_val(g, &g.apply(h, a), b, strat, sets, choice))
                                .sum::<f64>() * sign;
                            if tot > best.0 + 1e-12 { best = (tot, a); }
                        }
                        choice.insert(key, best.1);
                        best.1
                    }
                };
                br_val(g, &g.apply(s, a), b, strat, sets, choice)
            } else {
                let st = strat(&g.infoset_key(s), n);
                (0..n).map(|a| st[a] * br_val(g, &g.apply(s, a), b, strat, sets, choice)).sum()
            }
        }
    }
}
