//! Sequential stand-ins for the rayon calls used in `street.rs` (feature `rayon` off, e.g. wasm).
pub trait SeqSlice<T> {
    fn par_iter(&self) -> std::slice::Iter<'_, T>;
    fn par_chunks_mut(&mut self, n: usize) -> std::slice::ChunksMut<'_, T>;
}
impl<T> SeqSlice<T> for [T] {
    fn par_iter(&self) -> std::slice::Iter<'_, T> {
        self.iter()
    }
    fn par_chunks_mut(&mut self, n: usize) -> std::slice::ChunksMut<'_, T> {
        self.chunks_mut(n)
    }
}
pub trait SeqInto: Iterator + Sized {
    fn into_par_iter(self) -> Self {
        self
    }
}
impl<I: Iterator> SeqInto for I {}
