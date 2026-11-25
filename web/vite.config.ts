import { defineConfig } from 'vite';
import { e2ePacksPlugin } from './scripts/e2e-packs.mjs';
// `--mode e2e` (npm run build:e2e) is the ONLY build that accepts and serves the synthetic test pack (see .env.e2e).
export default defineConfig(({ mode }) => ({ worker: { format: 'es' }, build: { target: 'es2022' }, plugins: mode === 'e2e' ? [e2ePacksPlugin()] : [] }));
