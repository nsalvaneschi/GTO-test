import init, { Solver } from './wasm/gto_wasm.js';

let solver: Solver | null = null;
let run = 0;
const post = (m: unknown) => (self as unknown as Worker).postMessage(m);

self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  try {
    if (m.type === 'solve') {
      const id = ++run;
      await init();
      solver?.free();
      solver = new Solver(m.config);
      let iters = 0;
      let expl = 100;
      while (id === run && (expl > m.target || iters === 0) && iters < m.maxIters) {
        expl = solver.step(m.chunk);
        iters += m.chunk;
        post({ type: 'progress', expl, iters });
        await new Promise((r) => setTimeout(r, 0)); // let new messages in
      }
      if (id === run) post({ type: 'done', expl, iters });
    } else if (m.type === 'query' && solver) {
      post({ type: 'node', path: m.path, view: JSON.parse(solver.query(JSON.stringify(m.path))) });
    }
  } catch (err) {
    post({ type: 'error', message: String(err) });
  }
};
