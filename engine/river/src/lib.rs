//! Heads-up river subgame: cards/eval, tree builder, vector DCFR, best-response exploitability.
pub mod cards;
pub mod solver;
pub mod tree;
pub mod street;
pub mod bucket;
#[cfg(not(feature = "rayon"))]
pub mod seq;
pub mod api;
