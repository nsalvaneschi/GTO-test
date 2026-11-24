// @ts-nocheck (node APIs; web tsconfig has no node types)
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore untyped script
import { check } from '../../scripts/hh-check.mjs';

const SRC = fs.readFileSync(path.join(__dirname, 'fixtures/ps_hu_srp_river.txt'), 'utf8'); // SYNTHETIC
const HAND = (id: string, name: string) => SRC.replace(/900000000001/g, id).replace(/V1/g, name);

describe('hh check (SYNTHETIC inputs)', () => {
  it('empty dir prints zeros', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hhc-'));
    const out: string = check(d);
    expect(out).toContain('files: 0');
    expect(out).toContain('hands total: 0');
    expect(out).toContain('parsed: 0');
    expect(out).toContain('arithmetic invariant failures: 0');
  });
  it('never echoes input strings', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hhc-'));
    fs.mkdirSync(path.join(d, 'sub'));
    fs.writeFileSync(path.join(d, 'a.txt'), HAND('900000000777', 'ZedVillain') + '\n\nSecretLine garbage Ah');
    fs.writeFileSync(path.join(d, 'sub', 'b.txt'), HAND('900000000888', 'QuxPlayer'));
    const out: string = check(d);
    expect(out).toContain('files: 2');
    expect(out).toContain('parsed: 2');
    for (const s of ['ZedVillain', 'QuxPlayer', 'SecretLine', '900000000777', '900000000888', 'Synth', 'Ac Kd', 'Hero', 'Ah 7d']) {
      expect(out).not.toContain(s);
    }
  });
});
