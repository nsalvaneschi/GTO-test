// Aggregate-only checker for real hand-history files. Prints counts only: never hand text,
// names, ids, cards or input lines. Usage: npm run hh:check -- [dir]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHistory } from '../src/hh/parse.ts';

const ORDER = ['preflop', 'flop', 'turn', 'river'];

function listTxt(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listTxt(p));
    else if (e.isFile() && /\.txt$/i.test(e.name)) out.push(p);
  }
  return out.sort();
}

function posLabel(hand) {
  if (hand.hero == null) return 'none';
  const seats = hand.seats.map((s) => s.seat).sort((a, b) => a - b);
  const n = seats.length;
  const bi = seats.findIndex((s) => s >= hand.button);
  const start = bi < 0 ? 0 : bi;
  const k = (seats.indexOf(hand.hero) - start + n) % n; // 0 = button
  if (n === 2) return k === 0 ? 'BTN/SB' : 'BB';
  if (k === 0) return 'BTN';
  if (k === 1) return 'SB';
  if (k === 2) return 'BB';
  const d = n - k;
  return d === 1 ? 'CO' : d === 2 ? 'HJ' : d === 3 ? 'LJ' : 'EP';
}

function invariantFail(h) {
  const eps = 0.02;
  const sum = Object.values(h.contributions).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - h.final_pot) > eps) return true;
  return Object.values(h.final_stacks).some((v) => v < -eps);
}

/** hero has an action on `street` with exactly two players still in at its start. */
function huDecision(h, street) {
  if (h.hero == null || !h.pot_by_street.some((p) => p.street === street)) return false;
  const folded = new Set();
  for (const a of h.actions) {
    if (a.street === street) break;
    if (a.kind === 'fold') folded.add(a.seat);
  }
  const live = h.seats.filter((s) => !folded.has(s.seat));
  return live.length === 2 && live.some((s) => s.seat === h.hero)
    && h.actions.some((a) => a.street === street && a.seat === h.hero);
}

const bump = (o, k) => { o[k] = (o[k] ?? 0) + 1; };
const fmt = (o) => Object.keys(o).sort().map((k) => `  ${k}: ${o[k]}`).join('\n') || '  (none)';

/** Returns the report text (aggregates only). */
export function check(dir) {
  const files = listTxt(dir);
  const rej = {}, warn = {}, site = {}, pos = {}, street = {}, size = {};
  const lines = [];
  let hands = 0, ok = 0, huRiver = 0, huTurn = 0, inv = 0, unreadable = 0;
  files.forEach((f, fi) => {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { unreadable++; return; }
    for (const r of parseHistory(text).results) {
      hands++;
      if (!r.ok) {
        bump(rej, r.reason);
        if (r.reason === 'pot_mismatch' || r.reason === 'stack_overflow') inv++;
        lines.push(`reject ${r.reason} file#${fi} hand#${r.index} line ${r.line ?? '?'}`);
        continue;
      }
      ok++;
      const h = r.hand;
      r.warnings.forEach((w) => bump(warn, w));
      bump(site, h.site);
      bump(pos, posLabel(h));
      bump(street, h.pot_by_street.reduce((m, p) => (ORDER.indexOf(p.street) > ORDER.indexOf(m) ? p.street : m), 'preflop'));
      bump(size, h.seats.length === 2 ? 'heads_up' : 'multiway');
      if (huDecision(h, 'river')) huRiver++;
      if (huDecision(h, 'turn')) huTurn++;
      if (invariantFail(h)) inv++;
    }
  });
  return [
    `files: ${files.length}`, `unreadable files: ${unreadable}`,
    `hands total: ${hands}`, `parsed: ${ok}`, `rejected: ${hands - ok}`,
    'rejected by reason:', fmt(rej), 'warnings:', fmt(warn), 'site:', fmt(site),
    'hero position:', fmt(pos), 'street reached:', fmt(street), 'table size:', fmt(size),
    `heads-up river decisions: ${huRiver}`, `heads-up turn decisions: ${huTurn}`,
    `arithmetic invariant failures: ${inv}`,
    ...(lines.length ? ['reject locations:', ...lines.slice(0, 200).map((l) => '  ' + l)] : []),
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(process.argv[2] ?? '../private-data/handhistories');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error('directory not found');
    process.exit(1);
  }
  console.log(check(dir));
}
