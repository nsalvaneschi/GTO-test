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
