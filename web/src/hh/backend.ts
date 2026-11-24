// Solve backends for hand-history analysis. LocalBackend runs inside the WASM worker (and in tests); WorkerBackend
// (workerBackend.ts) forwards to it. Solves are cached by config hash so hands on the same board/ranges/line reuse them.
export interface NodeView { kind: string; player: number; n: number; strategy: number[]; range: number[]; action_ev?: number[]; opp_mass?: number[] }
/** maxMs: wall-time budget; the solve throws Error('timeout') once exceeded (checked between chunks). */
export interface SolveParams { target: number; chunk: number; maxIters: number; maxMs?: number }
export interface SolveInfo { cached: boolean; expl: number; iters: number; ms: number }
export interface SolveBackend {
  solve(key: string, config: string, p: SolveParams, onProgress?: (expl: number, iters: number) => void): Promise<SolveInfo>;
  query(key: string, path: number[]): Promise<NodeView>;
  cancel(): void;
}
export interface SolverLike { step(n: number): number; query(path: string): string; free(): void }

/** 53-bit string hash (cyrb53), hex. Cache keys also compare the full config, so a collision can only cost a miss. */
export function configHash(s: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) { const ch = s.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

export class LocalBackend implements SolveBackend {
  private cache = new Map<string, { config: string; solver: SolverLike; expl: number; iters: number }>();
  private run = 0;
  constructor(private make: (config: string) => SolverLike, private maxCached = 3) {}

  cancel() { this.run++; }

  async solve(key: string, config: string, p: SolveParams, onProgress?: (expl: number, iters: number) => void): Promise<SolveInfo> {
    const hit = this.cache.get(key);
    if (hit && hit.config === config) { this.cache.delete(key); this.cache.set(key, hit); return { cached: true, expl: hit.expl, iters: hit.iters, ms: 0 }; }
    if (hit) { hit.solver.free(); this.cache.delete(key); }
    const id = ++this.run, t0 = Date.now();
    const solver = this.make(config);
    let iters = 0, expl = 100;
    while ((expl > p.target || iters === 0) && iters < p.maxIters) {
      expl = solver.step(p.chunk); iters += p.chunk;
      onProgress?.(expl, iters);
      await new Promise((r) => setTimeout(r, 0)); // let a cancel message in
      if (id !== this.run) { solver.free(); throw new Error('cancelled'); }
      if (p.maxMs && Date.now() - t0 > p.maxMs && expl > p.target) { solver.free(); throw new Error('timeout'); }
    }
    this.cache.set(key, { config, solver, expl, iters });
    while (this.cache.size > this.maxCached) { const k = this.cache.keys().next().value!; this.cache.get(k)!.solver.free(); this.cache.delete(k); }
    return { cached: false, expl, iters, ms: Date.now() - t0 };
  }

  async query(key: string, path: number[]): Promise<NodeView> {
    const e = this.cache.get(key);
    if (!e) throw new Error('no_solve');
    return JSON.parse(e.solver.query(JSON.stringify(path)));
  }
}
