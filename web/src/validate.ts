// Pure solver-form validation (no DOM, no text): returns a normalised value or an error code the UI maps to a locale key.
const CARD = /^[2-9TJQKA][cdhs]$/;
export type BoardErr = 'board.cards' | 'board.dup' | 'board.count';

/** Accepts "As Kd 7c 4h 2s", extra spaces, lowercase ("as kd ...") or no spaces ("AsKd7c4h2s"); river boards only (5 cards). */
export function normalizeBoard(raw: string): { ok: true; board: string } | { ok: false; err: BoardErr } {
  let toks = raw.trim().split(/[\s,]+/).filter(Boolean);
  if (toks.length === 1 && toks[0].length > 2 && toks[0].length % 2 === 0) toks = toks[0].match(/../g)!;
  toks = toks.map((x) => x.length === 2 ? x[0].toUpperCase() + x[1].toLowerCase() : x);
  if (toks.some((x) => !CARD.test(x))) return { ok: false, err: 'board.cards' };
  if (new Set(toks).size !== toks.length) return { ok: false, err: 'board.dup' };
  if (toks.length !== 5) return { ok: false, err: 'board.count' };
  return { ok: true, board: toks.join(' ') };
}

export const MAX_CHIPS = 1e6;
/** Pot / stack: finite number in (0, 1e6]. */
export const validChips = (x: number) => Number.isFinite(x) && x > 0 && x <= MAX_CHIPS;

/** Map an engine/worker error string (English, from Rust) to a locale key; never show raw engine text. */
export const engineErrKey = (msg: string): 'solver.err.board.cards' | 'solver.err.board.dup' | 'solver.err.chips' | 'engine.err.memory' | 'engine.err.generic' =>
  /duplicate board/i.test(msg) ? 'solver.err.board.dup' : /bad card|board cards|bad combo/i.test(msg) ? 'solver.err.board.cards'
  : /pot and stack|sizes must|raise_cap/i.test(msg) ? 'solver.err.chips' : /memory|budget|alloc|unreachable|RuntimeError|node cap/i.test(msg) ? 'engine.err.memory' : 'engine.err.generic';
