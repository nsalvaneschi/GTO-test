//! River betting tree in a flat arena (post-order; root is last node).

#[derive(Clone, Debug)]
pub struct TreeConfig {
    pub pot: f32,
    /// Effective stack behind (each player), at river start.
    pub stack: f32,
    /// Bet/raise sizes as pot fractions (raise: fraction of pot after calling).
    pub sizes: Vec<f32>,
    /// Max number of bets+raises on the street.
    pub raise_cap: u32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Action,
    Fold,
    Showdown,
}

#[derive(Clone, Debug)]
pub struct Node {
    pub kind: Kind,
    /// Acting player (Action) or folder (Fold). Player 0 = OOP, 1 = IP.
    pub player: u8,
    /// Chips lost by the loser (dead-pot half + loser's commitment).
    pub pay: f32,
    pub child_off: u32,
    pub n: u32,
    /// Offset into regret/strategy-sum arrays (n_actions * 1326 per Action node).
    pub data_off: u32,
}

pub struct Tree {
    pub nodes: Vec<Node>,
    pub children: Vec<u32>,
    pub data_len: usize,
    pub root: u32,
}

pub const H: usize = 1326;

pub fn build(cfg: &TreeConfig) -> Tree {
    let mut t = Tree { nodes: vec![], children: vec![], data_len: 0, root: 0 };
    t.root = go(&mut t, cfg, [0.0, 0.0], 0, 0, false);
    t
}

fn push(t: &mut Tree, kind: Kind, player: u8, pay: f32, ch: Vec<u32>) -> u32 {
    let child_off = t.children.len() as u32;
    let n = ch.len() as u32;
    t.children.extend(ch);
    let data_off = t.data_len as u32;
    if kind == Kind::Action {
        t.data_len += n as usize * H;
    }
    t.nodes.push(Node { kind, player, pay, child_off, n, data_off });
    (t.nodes.len() - 1) as u32
}

fn go(t: &mut Tree, cfg: &TreeConfig, c: [f32; 2], me: usize, aggr: u32, checked: bool) -> u32 {
    let o = 1 - me;
    let half = cfg.pot / 2.0;
    let mut ch = vec![];
    if c[o] > c[me] {
        let f = push(t, Kind::Fold, me as u8, half + c[me], vec![]);
        ch.push(f);
        ch.push(push(t, Kind::Showdown, 0, half + c[o], vec![]));
    } else if me == 0 {
        ch.push(go(t, cfg, c, 1, aggr, true));
    } else {
        ch.push(push(t, Kind::Showdown, 0, half + c[me], vec![]));
    }
    let _ = checked;
    if aggr < cfg.raise_cap && c[o] < cfg.stack {
        let pot_now = cfg.pot + c[0] + c[1];
        let call = c[o] - c[me];
        let mut targets: Vec<f32> = vec![];
        for &s in &cfg.sizes {
            let mut to = c[o] + s * (pot_now + call);
            if to >= cfg.stack - 1e-3 {
                to = cfg.stack;
            }
            if to > c[o] + 1e-3 && !targets.iter().any(|&x| (x - to).abs() < 1e-3) {
                targets.push(to);
            }
        }
        targets.sort_by(|a, b| a.partial_cmp(b).unwrap());
        for to in targets {
            let mut nc = c;
            nc[me] = to;
            ch.push(go(t, cfg, nc, o, aggr + 1, true));
        }
    }
    push(t, Kind::Action, me as u8, 0.0, ch)
}
