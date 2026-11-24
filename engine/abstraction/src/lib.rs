//! Abstraction layer: equity bucketing lives in `gto_river::bucket` (it is used by the street
//! solver); this crate holds the heads-up preflop solver built on 169 hand classes.
pub mod preflop;
pub mod realisation;
pub use gto_river::bucket;
