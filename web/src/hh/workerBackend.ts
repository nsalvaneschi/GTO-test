import type { NodeView, SolveBackend, SolveInfo, SolveParams } from './backend';

/** Main-thread proxy for the LocalBackend living in worker.ts (own Worker instance, separate from the drill/solver one). */
export class WorkerBackend implements SolveBackend {
  private w = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' });
  private id = 0;
  private pend = new Map<number, { ok: (v: any) => void; err: (e: Error) => void; progress?: (expl: number, iters: number) => void }>();
  constructor() {
    this.w.onmessage = (e) => {
      const m = e.data;
      if (typeof m?.type !== 'string' || !m.type.startsWith('hh-')) return;
      const p = this.pend.get(m.id);
      if (!p) return;
      if (m.type === 'hh-progress') p.progress?.(m.expl, m.iters);
      else { this.pend.delete(m.id); if (m.type === 'hh-error') p.err(new Error(m.message)); else p.ok(m); }
    };
  }
  private send<T>(msg: Record<string, unknown>, progress?: (expl: number, iters: number) => void): Promise<T> {
    const id = ++this.id;
    return new Promise<T>((ok, err) => { this.pend.set(id, { ok, err, progress }); this.w.postMessage({ ...msg, id }); });
  }
  solve(key: string, config: string, p: SolveParams, onProgress?: (expl: number, iters: number) => void): Promise<SolveInfo> {
    return this.send<SolveInfo>({ type: 'hh-solve', key, config, params: p }, onProgress);
  }
  async query(key: string, path: number[]): Promise<NodeView> {
    return (await this.send<{ view: NodeView }>({ type: 'hh-query', key, path })).view;
  }
  cancel() { this.w.postMessage({ type: 'hh-cancel' }); }
}
