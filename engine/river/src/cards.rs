//! Cards (id = rank*4 + suit, rank 0=2..12=A), 1326 combos, 7-card evaluator.

pub fn parse_card(s: &str) -> u8 {
    let b = s.as_bytes();
    let r = "23456789TJQKA".find(b[0] as char).expect("rank") as u8;
    let su = "cdhs".find(b[1] as char).expect("suit") as u8;
    r * 4 + su
}

pub fn parse_cards(s: &str) -> Vec<u8> {
    s.split_whitespace().map(parse_card).collect()
}

/// All 1326 two-card combos (c1 < c2), fixed order.
pub fn combos() -> Vec<(u8, u8)> {
    let mut v = Vec::with_capacity(1326);
    for a in 0..52u8 {
        for b in a + 1..52 {
            v.push((a, b));
        }
    }
    v
}

fn top(mut m: u16, k: u32) -> u32 {
    let mut v = 0;
    for _ in 0..k {
        if m == 0 {
            v <<= 4;
            continue;
        }
        let r = 15 - m.leading_zeros();
        v = (v << 4) | r;
        m &= !(1 << r);
    }
    v
}

/// Top rank of a straight in a 13-bit rank mask (ace also plays low).
fn straight_top(mask: u16) -> Option<u32> {
    let m = (mask << 1) | (mask >> 12 & 1); // bit i = rank i-1
    (4..=13u32).rev().find(|&i| (m >> (i - 4)) & 0x1f == 0x1f).map(|i| i - 1)
}

/// Higher is better. category<<20 | packed tiebreak nibbles.
pub fn eval7(c: &[u8; 7]) -> u32 {
    let mut suit = [0u16; 4];
    let mut cnt = [0u8; 13];
    for &x in c {
        suit[(x & 3) as usize] |= 1 << (x >> 2);
        cnt[(x >> 2) as usize] += 1;
    }
    let all = suit[0] | suit[1] | suit[2] | suit[3];
    let fm = suit.iter().copied().find(|m| m.count_ones() >= 5);
    if let Some(m) = fm {
        if let Some(t) = straight_top(m) {
            return (8 << 20) | t;
        }
    }
    let (mut quad, mut trips, mut pairs) = (None, vec![], vec![]);
    for r in (0..13u32).rev() {
        match cnt[r as usize] {
            4 => quad = quad.or(Some(r)),
            3 => trips.push(r),
            2 => pairs.push(r),
            _ => {}
        }
    }
    if let Some(q) = quad {
        return (7 << 20) | (q << 4) | top(all & !(1 << q), 1);
    }
    if let Some(&t) = trips.first() {
        let p = trips.get(1).copied().into_iter().chain(pairs.first().copied()).max();
        if let Some(p) = p {
            return (6 << 20) | (t << 4) | p;
        }
    }
    if let Some(m) = fm {
        return (5 << 20) | top(m, 5);
    }
    if let Some(t) = straight_top(all) {
        return (4 << 20) | t;
    }
    if let Some(&t) = trips.first() {
        return (3 << 20) | (t << 8) | top(all & !(1 << t), 2);
    }
    if pairs.len() >= 2 {
        let (a, b) = (pairs[0], pairs[1]);
        return (2 << 20) | (a << 8) | (b << 4) | top(all & !(1 << a) & !(1 << b), 1);
    }
    if let Some(&p) = pairs.first() {
        return (1 << 20) | (p << 12) | top(all & !(1 << p), 3);
    }
    top(all, 5)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ev(s: &str) -> u32 {
        let v = parse_cards(s);
        eval7(&[v[0], v[1], v[2], v[3], v[4], v[5], v[6]])
    }
    #[test]
    fn ordering_of_known_hands() {
        let hands = [
            "2c 3d 5h 9s Jc Qd Ks",       // high card
            "2c 2d 5h 9s Jc Qd Ks",       // pair
            "2c 2d 5h 5s Jc Qd Ks",       // two pair
            "2c 2d 2h 9s Jc Qd Ks",       // trips
            "Ac 2d 3h 4s 5c Qd Ks",       // wheel
            "6c 2d 3h 4s 5c Qd Ks",       // 6-high straight
            "2c 4c 6c 9c Jc Qd Ks",       // flush
            "2c 2d 2h 9s 9c Qd Ks",       // full house
            "2c 2d 2h 2s 9c Qd Ks",       // quads
            "Ac 2c 3c 4c 5c Qd Ks",       // steel wheel
            "9c Tc Jc Qc Kc 2d 2s",       // K-high straight flush
            "Tc Jc Qc Kc Ac 2d 2s",       // royal
        ];
        let s: Vec<u32> = hands.iter().map(|h| ev(h)).collect();
        for w in s.windows(2) {
            assert!(w[0] < w[1], "{:?}", s);
        }
    }
    #[test]
    fn kickers_and_ties() {
        assert!(ev("Ac Ad 5h 9s Jc 3d 2s") > ev("Kc Kd 5h 9s Jc 3d 2s"));
        assert!(ev("Ac Ad Kh 9s Jc 3d 2s") > ev("Ac Ad Qh 9s Jc 3d 2s"));
        // board plays: same strength regardless of irrelevant hole cards
        assert_eq!(ev("Tc Jd Qh Ks Ac 2d 3s"), ev("Tc Jd Qh Ks Ac 4d 5s"));
        // full house: trips rank dominates; best of two trips
        assert!(ev("3c 3d 3h 2s 2c 2d As") > ev("2c 2d 2h 3s 3c Ad Ks"));
        // three pairs picks top two, best kicker
        assert_eq!(ev("Ac Ad Kh Ks Qc Qd 2s") & 0xfffff, (12 << 8) | (11 << 4) | 10);
        // ace-low straight loses to 6-high
        assert!(ev("6c 2d 3h 4s 5c 9d Ks") > ev("Ac 2d 3h 4s 5c 9d Ks"));
    }
    #[test]
    fn combo_count() {
        assert_eq!(combos().len(), 1326);
    }
}
