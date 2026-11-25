import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));

describe('check:dist script', () => {
  const run = (dir) => { try { execFileSync('node', ['scripts/check-dist.cjs', dir], { cwd: root, stdio: 'pipe' }); return 0; } catch (e) { return e.status; } };
  it('fails when the marker is present and passes when absent', () => {
    const d = mkdtempSync(join(tmpdir(), 'dist-'));
    writeFileSync(join(d, 'a.js'), 'console.log(1)');
    expect(run(d)).toBe(0);
    writeFileSync(join(d, 'b.js'), 'x="SYNTHETIC_TEST_ONLY_3node"');
    expect(run(d)).toBe(1);
  });
  it('current dist/ (if built) has no fixture marker', () => {
    if (existsSync(join(root, 'dist'))) expect(run(join(root, 'dist'))).toBe(0);
  });
});

describe('production vs e2e build', () => {
  it('the e2e fixture files are only produced by the e2e plugin and carry the marker', async () => {
    const { e2eFiles } = await import('../scripts/e2e-packs.mjs');
    const f = e2eFiles();
    expect(Object.keys(f).sort()).toEqual(['16.json', '18.json', '20.json', 'index.json']);
    expect(f['18.json']).toContain('SYNTHETIC_TEST_ONLY');
  });
  it('production dist (if built) has no packs, and dist-e2e (if built) is rejected by check:dist', () => {
    const run = (dir) => { try { execFileSync('node', ['scripts/check-dist.cjs', dir], { cwd: root, stdio: 'pipe' }); return 0; } catch (e) { return e.status; } };
    if (existsSync(join(root, 'dist'))) { expect(run(join(root, 'dist'))).toBe(0); expect(existsSync(join(root, 'dist/packs/preflop3'))).toBe(false); }
    if (existsSync(join(root, 'dist-e2e'))) { expect(run(join(root, 'dist-e2e'))).toBe(1); expect(existsSync(join(root, 'dist-e2e/packs/preflop3/index.json'))).toBe(true); }
  });
});
