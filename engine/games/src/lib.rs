//! Kuhn and Leduc poker implementing `gto_core::Game`.
use gto_core::{Game, Node};

pub struct Kuhn;

#[derive(Clone)]
pub struct KuhnState {
    cards: Vec<usize>,
    hist: String,
}

impl Game for Kuhn {
    type State = KuhnState;
    fn root(&self) -> KuhnState {
        KuhnState { cards: vec![], hist: String::new() }
    }
    fn node(&self, s: &KuhnState) -> Node {
        match s.cards.len() {
            0 => return Node::Chance(vec![1.0 / 3.0; 3]),
            1 => return Node::Chance(vec![0.5; 2]),
            _ => {}
        }
        let (c0, c1) = (s.cards[0] as f64, s.cards[1] as f64);
        let sd = |m: f64| Node::Terminal(if c0 > c1 { m } else { -m });
        match s.hist.as_str() {
            "pp" => sd(1.0),
            "bp" => Node::Terminal(1.0),
            "bb" | "pbb" => sd(2.0),
            "pbp" => Node::Terminal(-1.0),
            h => Node::Player(h.len() % 2, 2),
        }
    }
    fn apply(&self, s: &KuhnState, a: usize) -> KuhnState {
        let mut n = s.clone();
        if s.cards.len() < 2 {
            let mut rem: Vec<usize> = (0..3).filter(|c| !s.cards.contains(c)).collect();
            n.cards.push(rem.remove(a));
        } else {
            n.hist.push(if a == 0 { 'p' } else { 'b' });
        }
        n
    }
    fn infoset_key(&self, s: &KuhnState) -> String {
        format!("{}{}", s.cards[s.hist.len() % 2], s.hist)
    }
}

pub struct Leduc;

#[derive(Clone)]
pub struct LeducState {
    cards: Vec<usize>, // private cards dealt so far (0..6), rank = c/2
    board: Option<usize>,
    round: usize,
    to_move: usize,
    bets: [i32; 2],
    raises: usize,
    facing: bool,
    acted: usize,
    over: bool,
    folded: Option<usize>,
    hist: String,
}

impl LeducState {
    fn remaining(&self) -> Vec<usize> {
        (0..6).filter(|c| !self.cards.contains(c) && Some(*c) != self.board).collect()
    }
    fn end_round(&mut self) {
        if self.round == 0 {
            self.round = 1;
            self.acted = 0;
            self.raises = 0;
            self.facing = false;
            self.to_move = 0;
            self.hist.push('/');
        } else {
            self.over = true;
        }
    }
}

impl Game for Leduc {
    type State = LeducState;
    fn root(&self) -> LeducState {
        LeducState {
            cards: vec![], board: None, round: 0, to_move: 0, bets: [1, 1], raises: 0,
            facing: false, acted: 0, over: false, folded: None, hist: String::new(),
        }
    }
    fn node(&self, s: &LeducState) -> Node {
        if s.cards.len() < 2 || (s.round == 1 && s.board.is_none() && !s.over) {
            let n = s.remaining().len();
            return Node::Chance(vec![1.0 / n as f64; n]);
        }
        if let Some(f) = s.folded {
            return Node::Terminal(if f == 0 { -s.bets[0] as f64 } else { s.bets[1] as f64 });
        }
        if s.over {
            let b = s.board.unwrap() / 2;
            let st = |c: usize| if c / 2 == b { 100 + c / 2 } else { c / 2 };
            let (a, c) = (st(s.cards[0]), st(s.cards[1]));
            let m = s.bets[0] as f64;
            return Node::Terminal(if a > c { m } else if a < c { -m } else { 0.0 });
        }
        Node::Player(s.to_move, if s.facing { if s.raises < 2 { 3 } else { 2 } } else { 2 })
    }
    fn apply(&self, s: &LeducState, a: usize) -> LeducState {
        let mut n = s.clone();
        if n.cards.len() < 2 || (n.round == 1 && n.board.is_none()) {
            let c = s.remaining()[a];
            if n.cards.len() < 2 { n.cards.push(c) } else { n.board = Some(c) }
            return n;
        }
        let (tm, size) = (s.to_move, if s.round == 0 { 2 } else { 4 });
        let ch = if s.facing { ['f', 'c', 'r'][a] } else { ['k', 'b'][a] };
        n.hist.push(ch);
        match ch {
            'f' => n.folded = Some(tm),
            'c' => {
                n.bets[tm] = n.bets[1 - tm];
                n.end_round();
            }
            'k' => {
                n.acted += 1;
                if n.acted == 2 { n.end_round() } else { n.to_move = 1 - tm }
            }
            _ => {
                n.bets[tm] = n.bets[1 - tm] + size;
                n.raises += 1;
                n.facing = true;
                n.to_move = 1 - tm;
            }
        }
        n
    }
    fn infoset_key(&self, s: &LeducState) -> String {
        format!("{}:{}:{:?}:{}", s.to_move, s.cards[s.to_move] / 2, s.board.map(|b| b / 2), s.hist)
    }
}
