//! Equity-based hand bucketing for one board (lossy abstraction, opt-in).
//! Feature per hand: histogram (BINS) of river equity-vs-uniform-random-hand over all remaining
//! runouts (flop/turn), or the scalar river equity (river board). Features are exact integer
//! ratios, so suit-isomorphic hands get identical features and therefore the same bucket.
//! Clustering: Lloyd k-means with 1-D earth mover's distance (L1 between CDFs) for histograms,
//! |a-b| for scalars. NOTE: the centroid is the mean histogram, not the true EMD barycenter
//! (cheaper; standard approximation). Initialisation is deterministic (equity quantiles).
//! Bucket ids are ordered by mean equity: higher id = stronger.
use crate::cards::{combos, eval7};
use crate::tree::H;

pub const NONE: u16 = u16::MAX;
const BINS: usize = 12;

/// River equity (diff, compat) per hand; compat = 0 for hands blocked by the board.
fn river_scores(board: &[u8], cb: &[(u8, u8)]) -> Vec<(i32, i32)> {
    let mask = board.iter().fold(0u64, |m, &b| m | 1 << b);
    let mut st = vec![0u32; H];
    let mut order: Vec<usize> = vec![];
    let mut cnt = [0i32; 52];
    for (i, &(a, b)) in cb.iter().enumerate() {
        if mask >> a & 1 == 1 || mask >> b & 1 == 1 {
            continue;
        }
        st[i] = eval7(&[a, b, board[0], board[1], board[2], board[3], board[4]]);
        order.push(i);
        cnt[a as usize] += 1;
        cnt[b as usize] += 1;
    }
    order.sort_by_key(|&i| st[i]);
    let n = order.len();
    let mut out = vec![(0i32, 0i32); H];
    for &i in &order {
        let (a, b) = cb[i];
        out[i].1 = n as i32 - cnt[a as usize] - cnt[b as usize] + 1;
    }
    for dir in [1i32, -1] {
        let (mut cum, mut tot) = ([0i32; 52], 0i32);
        let idx = |k: usize| order[if dir > 0 { k } else { n - 1 - k }];
        let mut k = 0;
        while k < n {
            let s = st[idx(k)];
            let mut e = k;
            while e < n && st[idx(e)] == s {
                e += 1;
            }
            for j in k..e {
                let (a, b) = cb[idx(j)];
                out[idx(j)].0 += dir * (tot - cum[a as usize] - cum[b as usize]);
            }
            for j in k..e {
                let (a, b) = cb[idx(j)];
                cum[a as usize] += 1;
                cum[b as usize] += 1;
                tot += 1;
            }
            k = e;
        }
    }
    out
}

fn runouts(dead: u64, need: usize, start: u8, cur: &mut Vec<u8>, out: &mut Vec<Vec<u8>>) {
    if need == 0 {
        out.push(cur.clone());
        return;
    }
    for c in start..52 {
        if dead >> c & 1 == 0 {
            cur.push(c);
            runouts(dead, need - 1, c + 1, cur, out);
            cur.pop();
        }
    }
}

/// Feature vector per hand (None if blocked by the board).
pub fn features(board: &[u8]) -> Vec<Option<Vec<f32>>> {
    let cb = combos();
    if board.len() == 5 {
        return river_scores(board, &cb).iter()
            .map(|&(d, c)| if c > 0 { Some(vec![(d + c) as f32 / (2 * c) as f32]) } else { None }).collect();
    }
    let dead = board.iter().fold(0u64, |m, &b| m | 1 << b);
    let mut ros = vec![];
    runouts(dead, 5 - board.len(), 0, &mut vec![], &mut ros);
    let mut hist = vec![[0u32; BINS]; H];
    for ro in &ros {
        let mut full = board.to_vec();
        full.extend(ro);
        for (h, &(d, c)) in river_scores(&full, &cb).iter().enumerate() {
            if c > 0 {
                hist[h][((d + c) as i64 * BINS as i64 / (2 * c as i64 + 1)) as usize] += 1;
            }
        }
    }
    hist.iter().map(|h| {
        let t: u32 = h.iter().sum();
        if t == 0 { None } else { Some(h.iter().map(|&x| x as f32 / t as f32).collect()) }
    }).collect()
}

fn dist(a: &[f32], b: &[f32]) -> f32 {
    if a.len() == 1 {
        return (a[0] - b[0]).abs();
    }
    let (mut ca, mut cbb, mut d) = (0.0, 0.0, 0.0);
    for i in 0..a.len() {
        ca += a[i];
        cbb += b[i];
        d += (ca - cbb as f32).abs();
    }
    d
}

fn score(a: &[f32]) -> f32 {
    if a.len() == 1 { a[0] } else { a.iter().enumerate().map(|(i, &p)| p * (i as f32 + 0.5) / a.len() as f32).sum() }
}

/// k-means labels (0..k, ordered by increasing mean equity, empty clusters removed).
pub fn kmeans(points: &[Vec<f32>], k: usize) -> Vec<usize> {
    let n = points.len();
    let k = k.min(n).max(1);
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| score(&points[a]).partial_cmp(&score(&points[b])).unwrap());
    let mut cent: Vec<Vec<f32>> = (0..k).map(|j| points[order[(2 * j + 1) * n / (2 * k)]].clone()).collect();
    let mut lab = vec![0usize; n];
    for _ in 0..25 {
        let mut changed = false;
        for (i, p) in points.iter().enumerate() {
            let mut best = (f32::INFINITY, 0);
            for (j, c) in cent.iter().enumerate() {
                let d = dist(p, c);
                if d < best.0 {
                    best = (d, j);
                }
            }
            changed |= lab[i] != best.1;
            lab[i] = best.1;
        }
        let dim = points[0].len();
        let mut sum = vec![vec![0.0f32; dim]; k];
        let mut m = vec![0usize; k];
        for (i, p) in points.iter().enumerate() {
            m[lab[i]] += 1;
            for d in 0..dim {
                sum[lab[i]][d] += p[d];
            }
        }
        for j in 0..k {
            if m[j] > 0 {
                cent[j] = sum[j].iter().map(|&x| x / m[j] as f32).collect();
            }
        }
        if !changed {
            break;
        }
    }
    let mut used: Vec<usize> = (0..k).filter(|&j| lab.iter().any(|&l| l == j)).collect();
    used.sort_by(|&a, &b| score(&cent[a]).partial_cmp(&score(&cent[b])).unwrap());
    lab.iter().map(|&l| used.iter().position(|&u| u == l).unwrap()).collect()
}

/// Bucket id per combo (1326, `NONE` if blocked) on `board` (3-5 cards), at most `k` buckets.
pub fn bucket_board(board: &[u8], k: usize) -> Vec<u16> {
    let f = features(board);
    let idx: Vec<usize> = (0..H).filter(|&h| f[h].is_some()).collect();
    let pts: Vec<Vec<f32>> = idx.iter().map(|&h| f[h].clone().unwrap()).collect();
    let lab = kmeans(&pts, k);
    let mut out = vec![NONE; H];
    for (&h, &l) in idx.iter().zip(&lab) {
        out[h] = l as u16;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cards::parse_cards;

    fn pos(a: &str, b: &str) -> usize {
        let (x, y) = (parse_cards(a)[0], parse_cards(b)[0]);
        combos().iter().position(|&c| c == (x.min(y), x.max(y))).unwrap()
    }

    #[test]
    fn strong_hands_higher_and_count_respected() {
        for (board, k) in [("As Kd 7c 4h", 12usize), ("As Kd 7c 4h 2s", 8), ("As Kd 7c", 10)] {
            let m = bucket_board(&parse_cards(board), k);
            let live: Vec<u16> = m.iter().copied().filter(|&b| b != NONE).collect();
            let mx = *live.iter().max().unwrap() as usize;
            // River scalars have many exact ties, so clusters may collapse; never exceed k.
            assert!(mx < k && mx + 1 >= k * 3 / 4, "{board}: {}", mx + 1);
            let n = board.split(' ').count();
            assert_eq!(live.len(), (52 - n) * (51 - n) / 2);
            assert!(m[pos("Ac", "Ad")] > m[pos("9c", "8d")], "{board}");
            assert!(m[pos("Ah", "Kh")] > m[pos("Qc", "Jd")], "{board}");
        }
    }

    #[test]
    fn suit_isomorphic_hands_share_bucket() {
        // Board stabilised by (s h)(d c): AsQd == AhQd == AsQc == AhQc.
        let b = parse_cards("Ks Kh 7d 7c");
        let m = bucket_board(&b, 10);
        let r = m[pos("As", "Qd")];
        assert_eq!(r, m[pos("Ah", "Qd")]);
        assert_eq!(r, m[pos("As", "Qc")]);
        assert_eq!(r, m[pos("Ah", "Qc")]);
        assert_eq!(m[pos("Ad", "Qs")], m[pos("Ac", "Qh")]);
    }
}
