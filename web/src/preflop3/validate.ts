import {
  ACTION_KINDS, CLASSES, CURRENT_SCHEMA_VERSION, POSITIONS, TERMINALS, VERIFICATIONS, replay,
  type ErrorCode, type PackError, type Position,
} from './types';

export const SUM_TOL = 1e-3;
const EPS = 1e-6;
const ACT_OF: Record<string, string> = { fold: 'F', call: 'C', check: 'C', raise: 'R', allin: 'A' };

export interface ValidationResult { ok: boolean; errors: PackError[] }
const isObj = (x: unknown): x is Record<string, any> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isStr = (x: unknown): x is string => typeof x === 'string' && x.length > 0;

/** Pure validator: returns ALL errors with codes and exact paths. */
export function validatePack(pack: unknown): ValidationResult {
  const errors: PackError[] = [];
  const err = (path: string, code: ErrorCode, detail: string) => errors.push({ path, code, detail });
  const done = (): ValidationResult => ({ ok: errors.length === 0, errors });

  if (!isObj(pack)) { err('', 'E_STRUCTURE', 'pack must be an object'); return done(); }
  const meta = pack.meta;
  if (!isObj(meta)) { err('meta', 'E_STRUCTURE', 'meta missing'); return done(); }
  if (meta.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    err('meta.schemaVersion', 'E_SCHEMA_VERSION', `unsupported schemaVersion ${String(meta.schemaVersion)}; run migratePack first`);
    return done();
  }

  // --- meta
  const mf = (k: string, ok: boolean, what: string) => { if (!ok) err(`meta.${k}`, 'E_META_FIELD', `${k} must be ${what}`); };
  mf('packId', isStr(meta.packId), 'a non-empty string');
  if (!VERIFICATIONS.includes(meta.verification)) err('meta.verification', 'E_VERIFICATION', `unknown verification ${String(meta.verification)}`);
  mf('source', isObj(meta.source) && ['external', 'self', 'synthetic'].includes(meta.source.kind) && isStr(meta.source.solver) && isStr(meta.source.version), '{kind: external|self|synthetic, solver, version}');
  mf('settings', isObj(meta.settings), 'an object');
  mf('players', meta.players === 3, '3');
  const st = meta.stacksBb;
  const stacksOk = isObj(st) && POSITIONS.every((p) => isNum(st[p]) && st[p] > 0);
  mf('stacksBb', stacksOk, '{BTN,SB,BB} positive numbers');
  mf('blinds', isObj(meta.blinds) && isNum(meta.blinds.sb) && isNum(meta.blinds.bb) && meta.blinds.sb >= 0 && meta.blinds.bb > 0, '{sb,bb} numbers');
  mf('anteBb', isNum(meta.anteBb) && meta.anteBb >= 0, 'a number >= 0');
  mf('rake', meta.rake === null || (isObj(meta.rake) && isNum(meta.rake.pct) && isNum(meta.rake.capBb)), 'null or {pct,capBb}');
  mf('payoff', meta.payoff === 'chipEV' || meta.payoff === 'ICM', "'chipEV' or 'ICM'");
  if (meta.payoff === 'ICM' && !(Array.isArray(meta.icmPayouts) && meta.icmPayouts.length > 0 && meta.icmPayouts.every(isNum))) {
    err('meta.icmPayouts', 'E_ICM_PAYOUTS', 'ICM payoff requires a non-empty icmPayouts number array');
  }
  mf('betMenu', Array.isArray(meta.betMenu) && meta.betMenu.every(isNum), 'an array of numbers');
  mf('convergence', isObj(meta.convergence) && ['max-player-br-gain-mbb', 'exploitability-mbb', 'unknown'].includes(meta.convergence.metric) && (meta.convergence.value === null || isNum(meta.convergence.value)), '{metric, value}');
  mf('date', isStr(meta.date), 'a non-empty string');
  mf('license', isStr(meta.license), 'a non-empty string');
  mf('notes', typeof meta.notes === 'string', 'a string');

  // --- classes
  const cls = pack.classes;
  if (!Array.isArray(cls) || cls.length !== 169 || cls.some((c, i) => c !== CLASSES[i])) {
    const bad = Array.isArray(cls) ? cls.findIndex((c, i) => c !== CLASSES[i]) : -1;
    err('classes', 'E_CLASSES', `classes must be the canonical 169 in order${bad >= 0 ? `; first mismatch at index ${bad}` : ''}`);
  }

  // --- nodes
  const nodes = pack.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) { err('nodes', 'E_STRUCTURE', 'nodes must be a non-empty array'); return done(); }
  const byId = new Map<string, Record<string, any>>();
  for (const n of nodes) {
    if (!isObj(n) || !isStr(n.id)) { err('nodes', 'E_STRUCTURE', 'every node needs a string id'); return done(); }
    if (byId.has(n.id)) err(`nodes[${n.id}]`, 'E_DUP_ID', `duplicate node id ${n.id}`);
    else byId.set(n.id, n);
  }

  for (const n of byId.values()) {
    const np = `nodes[${n.id}]`;
    const acts: any[] = Array.isArray(n.actions) ? n.actions : [];
    if (!Array.isArray(n.actions) || acts.length === 0) err(`${np}.actions`, 'E_STRUCTURE', 'actions must be a non-empty array');
    if (!POSITIONS.includes(n.actor)) err(`${np}.actor`, 'E_ACTOR', `unknown actor ${String(n.actor)}`);

    // history + stack consistency (only if meta stacks are usable)
    const hist: any[] = Array.isArray(n.history) ? n.history : [];
    const histOk = Array.isArray(n.history) && hist.every((h) => isObj(h) && POSITIONS.includes(h.pos) && ['F', 'C', 'R', 'A'].includes(h.act) && (h.act === 'R' || h.act === 'A' ? isNum(h.toBb) : true));
    if (!histOk) err(`${np}.history`, 'E_HISTORY', 'history entries need pos, act (F|C|R|A) and numeric toBb for R/A');
    let rp: ReturnType<typeof replay> | null = null;
    const metaOk = stacksOk && isObj(meta.blinds) && isNum(meta.blinds.sb) && isNum(meta.blinds.bb) && isNum(meta.anteBb);
    if (histOk && metaOk && POSITIONS.includes(n.actor)) {
      rp = replay(meta as any, hist);
      if (rp.folded[n.actor as Position]) err(`${np}.actor`, 'E_ACTOR', `${n.actor} already folded in history`);
      if (!isNum(n.potBb) || Math.abs(n.potBb - rp.potBb) > EPS) err(`${np}.potBb`, 'E_POT', `potBb ${String(n.potBb)} != ${rp.potBb} from history`);
      const toCall = rp.currentBet - rp.committed[n.actor as Position];
      if (!isNum(n.toCallBb) || Math.abs(n.toCallBb - toCall) > EPS) err(`${np}.toCallBb`, 'E_TOCALL', `toCallBb ${String(n.toCallBb)} != ${toCall} from history`);
      for (const p of POSITIONS) {
        const v = isObj(n.stacksBb) ? n.stacksBb[p] : undefined;
        if (!isNum(v) || v < -EPS || Math.abs(v - rp.remaining[p]) > EPS) err(`${np}.stacksBb.${p}`, 'E_STACK', `stack ${String(v)} != ${rp.remaining[p]} remaining after history`);
      }
    }

    // actions
    for (const a of acts) {
      const ap = `${np}.actions[${isObj(a) ? String(a.id) : '?'}]`;
      if (!isObj(a) || !isStr(a.id)) { err(`${np}.actions`, 'E_STRUCTURE', 'every action needs a string id'); continue; }
      if (!ACTION_KINDS.includes(a.kind)) { err(`${ap}.kind`, 'E_ACTION_KIND', `unknown kind ${String(a.kind)}`); continue; }
      if (rp && POSITIONS.includes(n.actor)) {
        const me = n.actor as Position, toCall = rp.currentBet - rp.committed[me];
        const maxTo = rp.committed[me] + rp.remaining[me];
        if (a.kind === 'check' && toCall > EPS) err(`${ap}.kind`, 'E_ACTION_KIND', 'check with a bet to call');
        if (a.kind === 'call' && toCall <= EPS) err(`${ap}.kind`, 'E_ACTION_KIND', 'call with nothing to call');
        if (a.kind === 'raise' && !(isNum(a.toBb) && a.toBb > rp.currentBet + EPS && a.toBb <= maxTo + EPS)) err(`${ap}.toBb`, 'E_TOBB', `raise toBb ${String(a.toBb)} must be in (${rp.currentBet}, ${maxTo}]`);
        if (a.kind === 'allin' && !(isNum(a.toBb) && Math.abs(a.toBb - maxTo) <= EPS)) err(`${ap}.toBb`, 'E_TOBB', `allin toBb ${String(a.toBb)} must equal ${maxTo}`);
        if (a.kind === 'call' && !(isNum(a.toBb) && Math.abs(a.toBb - rp.currentBet) <= EPS)) err(`${ap}.toBb`, 'E_TOBB', `call toBb ${String(a.toBb)} must equal ${rp.currentBet}`);
      }
      if (a.terminal !== undefined && !TERMINALS.includes(a.terminal)) err(`${ap}.terminal`, 'E_TERMINAL', `unknown terminal ${String(a.terminal)}`);
      else if (a.terminal !== undefined && a.child != null) err(`${ap}`, 'E_TERMINAL', 'terminal action must have child null');
      else if (a.terminal === undefined) {
        if (a.child == null) err(`${ap}.child`, 'E_CHILD_MISSING', 'non-terminal action needs a child node (or mark it terminal)');
        else if (!byId.has(a.child)) err(`${ap}.child`, 'E_CHILD_MISSING', `child ${String(a.child)} does not exist`);
        else {
          const c = byId.get(a.child)!;
          const ch: any[] = Array.isArray(c.history) ? c.history : [];
          const last = ch[ch.length - 1];
          if (ch.length !== hist.length + 1 || !last || last.pos !== n.actor || last.act !== ACT_OF[a.kind]) err(`${ap}.child`, 'E_HISTORY', `child ${a.child} history is not parent history + this action`);
        }
      }
    }

    // frequencies / EV
    const width = acts.length;
    const checkRows = (key: 'freq' | 'ev') => {
      const rows = n[key];
      if (key === 'ev' && rows === undefined) return;
      if (!Array.isArray(rows) || rows.length !== 169) { err(`${np}.${key}`, key === 'freq' ? 'E_CLASS_COVERAGE' : 'E_EV_SHAPE', `${key} must have 169 rows (one per class), got ${Array.isArray(rows) ? rows.length : typeof rows}`); return; }
      rows.forEach((row: unknown, i: number) => {
        const rpth = `${np}.${key}[${CLASSES[i]}]`;
        if (row === null) { if (key === 'ev' && n.freq?.[i] != null) err(rpth, 'E_EV_SHAPE', 'ev row is null but freq row is not'); return; }
        if (key === 'ev' && n.freq?.[i] === null) err(rpth, 'E_EV_SHAPE', 'ev row present but freq row is null');
        if (!Array.isArray(row) || row.length !== width) { err(rpth, key === 'freq' ? 'E_ROW_WIDTH' : 'E_EV_SHAPE', `row width ${Array.isArray(row) ? row.length : typeof row} != ${width} actions`); return; }
        let numsOk = true;
        row.forEach((v, j) => {
          const bad = key === 'freq' ? !isNum(v) || v < 0 || v > 1 : !isNum(v);
          if (bad) { numsOk = false; err(`${rpth}[${j}]`, 'E_NUMBER', `invalid value ${String(v)}`); }
        });
        if (key === 'freq' && numsOk) {
          const s = row.reduce((a: number, b: number) => a + b, 0);
          if (Math.abs(s - 1) > SUM_TOL) err(rpth, 'E_SUM', `probabilities sum to ${s}, expected 1 +- ${SUM_TOL}`);
        }
      });
    };
    checkRows('freq');
    checkRows('ev');
  }

  // reachability from root (nodes[0])
  const root = nodes[0].id;
  const seen = new Set<string>([root]);
  const stack = [root];
  while (stack.length) {
    const n = byId.get(stack.pop()!);
    for (const a of Array.isArray(n?.actions) ? n!.actions : []) {
      if (isObj(a) && typeof a.child === 'string' && byId.has(a.child) && !seen.has(a.child)) { seen.add(a.child); stack.push(a.child); }
    }
  }
  for (const id of byId.keys()) if (!seen.has(id)) err(`nodes[${id}]`, 'E_UNREACHABLE', `node ${id} is not reachable from root ${root}`);
  return done();
}
