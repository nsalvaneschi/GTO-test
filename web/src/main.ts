import './styles.css';
import { cardTile, esc, icon } from './ui';
import { t, fmt, locales, type Lang, type Key } from './i18n';
import { parseRange, presets, R } from './ranges';
import { api, ApiError, type HhProgress, type Progress } from './api';
import { renderHh } from './hh/screen';
import { engineErrKey, normalizeBoard, validChips } from './validate';
import { H, combos, comboName, stepOf, cardName, randomBoard, freqsFor, evLossPct, isCorrect, verdictOf, spotId, samplePath, type Street, nodeType, isFacing, type Step, type NodeType, SUITS, RANKS } from './drill';

// Bet sizes sent to the engine; labels derive from these (NodeView has no size info, so this assumes none are merged/dropped, e.g. at all-in).
const sizes = [0.5, 1];
// Colours are design tokens (styles.css) so both themes and the legend share one source.
const colors = { fold: 'var(--fold)', check: 'var(--call)', call: 'var(--call)', bet: ['var(--b1)', 'var(--b2)', 'var(--b3)'] };

interface View { kind: string; player: number; n: number; strategy: number[]; range: number[]; action_ev?: number[]; opp_mass?: number[] }
type Screen = 'solver' | 'drill' | 'progress' | 'hh' | 'auth';
const DRILL = { pot: 10, stack: 50 };
let screen: Screen = 'solver';
let owner: 'solver' | 'drill' = 'solver';
let user: string | null = null;
let authErr = '';
let progress: Progress | 'loading' | null = null;
let progTab: 'drills' | 'hh' = 'drills';
let hhProg: HhProgress | 'loading' | null = null;
const drill = { phase: 'idle' as 'idle' | 'solving' | 'ask' | 'reveal', board: '', oop: '', ip: '', view: null as View | null, h: 0,
  path: [] as number[], steps: [] as Step[], freqs: [] as number[], chosen: -1, evLoss: 0, street: 'river' as Street, solveT0: 0, solveMs: 0, solveExpl: 0, t0: 0, correct: 0, total: 0, saveErr: '' };

let lang: Lang = (new URLSearchParams(location.search).get('lang') as Lang) in locales
  ? (new URLSearchParams(location.search).get('lang') as Lang) : 'en';
let path: number[] = [];
let facing: boolean[] = [false]; // facing a bet at each depth of path
let seq: Step[] = []; // actions taken along `path` (solver action strip)
let view: View | null = null;
let expl: number | null = null;
let iters = 0;
let solving = false;
let err = '';
const form = { board: 'As Kd 7c 4h 2s', pot: 10, stack: 50, oop: 'mixed', ip: 'mixed' };

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'progress') { expl = m.expl; iters = m.iters; if (owner === 'drill') renderDrillStatus(); if (owner === 'solver') { if (!view) query([]); renderStatus(); } }
  else if (m.type === 'done') {
    if (owner === 'drill') { drill.solveMs = Date.now() - drill.solveT0; drill.solveExpl = m.expl; console.log('drill solve ms', drill.solveMs, drill.street, 'expl', m.expl, 'iters', m.iters); dealNode(); return; }
    solving = false; expl = m.expl; iters = m.iters; query(path); render();
  }
  else if (m.type === 'node') {
    if (owner === 'drill') { pend.get(JSON.stringify(m.path))?.(m.view); return; }
    view = m.view; renderGrid();
  }
  else if (m.type === 'error') { solving = false; if (owner === 'drill') drill.phase = 'idle'; err = engineErrKey(String(m.message)); render(); }
};
const pend = new Map<string, (v: View) => void>();
const queryAsync = (p: number[]) => new Promise<View>((res) => { pend.set(JSON.stringify(p), res); worker.postMessage({ type: 'query', path: p }); });
const query = (p: number[]) => worker.postMessage({ type: 'query', path: p });

function actions(v: View, fac: boolean): { key: Key; vars?: Record<string, string | number>; color: string }[] {
  const out: ReturnType<typeof actions> = [];
  let bi = 0;
  for (let i = 0; i < v.n; i++) {
    if (fac && i === 0) out.push({ key: 'action.fold', color: colors.fold });
    else if (fac && i === 1) out.push({ key: 'action.call', color: colors.call });
    else if (!fac && i === 0) out.push({ key: 'action.check', color: colors.check });
    else {
      const sz = fmt(sizes[bi] ?? 0, lang, { style: 'percent' });
      out.push({ key: fac ? 'action.raise' : 'action.bet', vars: { size: sz }, color: colors.bet[Math.min(bi, 2)] });
      bi++;
    }
  }
  return out;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const tr = (k: Key, v?: Record<string, string | number>) => t(lang, k, v);
const pctF = (x: number, d = 0) => fmt(x, lang, { style: 'percent', minimumFractionDigits: d, maximumFractionDigits: d });
const errMsg = () => (/^(solver|engine)\.err\./.test(err) ? tr(err as Key) : tr('error', { message: err }));
const ofPot = (pctPot: number) => tr('unit.ofPot', { value: pctF(pctPot / 100, 2) });

// Theme: stored choice, else the OS preference, else dark. Storage may be blocked, hence the try/catch.
const THEME_KEY = 'gto-theme';
let theme: 'dark' | 'light' = (() => {
  try { const s = localStorage.getItem(THEME_KEY); if (s === 'dark' || s === 'light') return s; } catch { /* storage unavailable */ }
  return 'dark'; // dark is the default look; a saved choice (above) wins and the header toggle switches it
})();
const applyTheme = () => { document.documentElement.dataset.theme = theme; };

function render() {
  const nav = (['solver', 'drill', 'progress', 'hh'] as const).map((s) => `<button data-nav="${s}" ${screen === s ? 'aria-current="page"' : ''}>${icon[s]}<span>${tr(('nav.' + s) as Key)}</span></button>`).join('');
  const who = user
    ? `<span class="who" id="whoami" data-user="${esc(user)}"><b class="avatar">${esc(user[0] ?? '?')}</b><span class="who-text">${esc(tr('auth.loggedAs', { name: user }))}</span></span><button id="logout" class="ghost" aria-label="${tr('auth.logout')}" title="${tr('auth.logout')}">${icon.logout}<span class="lbl">${tr('auth.logout')}</span></button>`
    : `<button data-nav="auth" id="to-auth" class="primary">${tr('auth.login')}</button>`;
  const pageName = tr(screen === 'auth' ? 'auth.login' : (('nav.' + screen) as Key));
  const pageTitle = `${tr('app.name')} - ${pageName}`;
  document.title = pageTitle;
  $('app').innerHTML = `<div class="shell">
  <header class="topbar"><div class="brand">${icon.logo}<h1 id="title" title="${esc(pageTitle)}"><span class="app">${tr('app.name')}<span class="sep"> - </span></span><span class="pg">${pageName}</span></h1></div>
  <div class="top-actions"><select id="lang" aria-label="${tr('language')}" title="${tr('language')}">${(Object.keys(locales) as Lang[]).map((l) => `<option value="${l}" ${l === lang ? 'selected' : ''}>${l}</option>`).join('')}</select>
  <button id="theme" class="ghost icon" aria-label="${tr('theme.toggle')}" title="${tr('theme.toggle')}">${icon.theme}</button>${who}</div></header>
  <nav class="side" aria-label="${tr('nav.main')}">${nav}</nav><main id="screen"></main></div>`;
  $<HTMLSelectElement>('lang').onchange = (e) => { readForm(); lang = (e.target as HTMLSelectElement).value as Lang; document.documentElement.lang = lang; render(); };
  $('theme').onclick = () => { theme = theme === 'dark' ? 'light' : 'dark'; applyTheme(); try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ } };
  document.querySelectorAll<HTMLButtonElement>('[data-nav]').forEach((b) => b.onclick = () => go(b.dataset.nav as Screen));
  const lo = document.getElementById('logout');
  if (lo) lo.onclick = async () => { try { await api.logout(); } catch { /* ignore */ } user = null; progress = null; hhProg = null; progTab = 'drills'; drill.phase = 'idle'; drill.correct = drill.total = 0; go('auth'); };
  if (screen === 'solver') renderSolver();
  else if (screen === 'drill') renderDrill();
  else if (screen === 'progress') renderProgress();
  else if (screen === 'hh') renderHh($('screen'), { tr, lang, user, errText, codeOf });
  else renderAuth();
}

function go(s: Screen) {
  readForm();
  if (s !== 'drill' && drill.phase === 'solving') { worker.postMessage({ type: 'cancel' }); drill.phase = 'idle'; } // leaving mid-solve: stop the work
  screen = s; authErr = ''; if (s === 'progress') progTab = 'drills';
  if (s === 'progress' && user) { progress = 'loading'; api.progress().then((p) => { progress = p; if (screen === 'progress') render(); }, (e) => { progress = null; handleApiErr(e); }); }
  render();
}

function errText(code: string): string {
  const k = ('err.' + code) as Key;
  return tr(k in locales.en ? k : 'err.generic');
}
const codeOf = (e: unknown) => (e instanceof ApiError ? e.code : 'generic');
function handleApiErr(e: unknown) {
  if (e instanceof ApiError && e.status === 401) { user = null; screen = 'auth'; }
  authErr = codeOf(e);
  render();
}

function renderAuth() {
  $('screen').innerHTML = `<div class="panel auth">
    <p class="muted">${tr('auth.hint')}</p>
    <label>${tr('auth.username')}<input id="u" autocomplete="username" maxlength="64"></label>
    <label>${tr('auth.password')}<input id="pw" type="password" autocomplete="current-password" maxlength="128"></label>
    <div class="row"><button id="do-login" class="primary">${tr('auth.login')}</button><button id="do-register">${tr('auth.register')}</button></div>
    <div id="auth-err" class="err" data-code="${authErr}">${authErr ? errText(authErr) : ''}</div></div>`;
  const submit = (fn: typeof api.login, btn: string) => async () => {
    const b = $<HTMLButtonElement>(btn);
    $<HTMLButtonElement>('do-login').disabled = $<HTMLButtonElement>('do-register').disabled = true; b.classList.add('loading');
    try {
      user = (await fn($<HTMLInputElement>('u').value, $<HTMLInputElement>('pw').value)).username;
      progress = null; screen = 'drill'; authErr = ''; render();
    } catch (e) {
      authErr = codeOf(e); const el = $('auth-err'); el.dataset.code = authErr; el.textContent = errText(authErr);
      $<HTMLButtonElement>('do-login').disabled = $<HTMLButtonElement>('do-register').disabled = false; b.classList.remove('loading');
    }
  };
  $('do-login').onclick = submit(api.login, 'do-login');
  $('do-register').onclick = submit(api.register, 'do-register');
}

const needLogin = () => {
  $('screen').innerHTML = `<div class="empty">${icon.inbox}<p id="need-login">${tr('auth.needLogin')}</p><button id="to-auth2" class="primary">${tr('auth.login')}</button></div>`;
  $('to-auth2').onclick = () => go('auth');
};

const cardHtml = (c: number, size: '' | 'sm' | 'lg' = '') => cardTile(cardName(c), size);
const parseBoard = (b: string) => b.split(' ').map((x) => (RANKS.indexOf(x[0]) * 4) + SUITS.indexOf(x[1]));
const boardTiles = (b: string) => b.split(/\s+/).filter((x) => /^[2-9TJQKA][cdhs]$/.test(x)).map((x) => cardTile(x, 'lg')).join('');

/** Action-history strip: one chip per action (colour dot + player + action name), then the player to act. */
const stepColor = (s: Step) => s.kind === 'fold' ? 'var(--fold)' : s.kind === 'bet' || s.kind === 'raise' ? `var(--b${Math.min(Math.max(s.size, 0), 2) + 1})` : 'var(--call)';
function seqHtml(steps: Step[], now: number | null, emptyChip: boolean): string {
  const chips = steps.map((s) => `<span class="chip" style="--c:${stepColor(s)}"><i class="dot"></i><small>${tr(('player.' + s.player) as Key)}</small>${tr(('action.' + s.kind) as Key, s.size >= 0 ? { size: fmt(sizes[s.size] ?? 0, lang, { style: 'percent' }) } : undefined)}</span>`);
  if (!steps.length && emptyChip) chips.push(`<span class="chip">${tr('drill.noHistory')}</span>`);
  if (now !== null) chips.push(`<span class="chip now"><small>${tr(('player.' + now) as Key)}</small>${tr('seq.toAct')}</span>`);
  return chips.join('<span class="arrow" aria-hidden="true">›</span>');
}

function startDrill() {
  const ids = Object.keys(presets);
  const pick = () => ids[Math.floor(Math.random() * ids.length)];
  const turn = drill.street === 'turn';
  Object.assign(drill, { phase: 'solving', board: randomBoard(Math.random, undefined, turn ? 4 : 5), oop: pick(), ip: pick(), view: null, saveErr: '', solveT0: Date.now() });
  owner = 'drill'; solving = false; err = ''; expl = null; iters = 0; sel = -1;
  // Turn: small menu (turn 50%/100% with no re-raise, river 50%) so the solve stays a few seconds; river drills unchanged.
  const streets = turn ? [{ pot: DRILL.pot, stack: DRILL.stack, sizes, raise_cap: 1 }, { pot: DRILL.pot, stack: DRILL.stack, sizes: [0.5], raise_cap: 1 }]
    : [{ pot: DRILL.pot, stack: DRILL.stack, sizes, raise_cap: 2 }];
  worker.postMessage({ type: 'solve', config: JSON.stringify({
    board: drill.board,
    ranges: [parseRange(presets[drill.oop]), parseRange(presets[drill.ip])],
    streets,
    budget_mb: 1024,
  }), chunk: turn ? 10 : 20, target: 0.3, maxIters: turn ? 300 : 2000 });
  render();
}

const statusHtml = (id: string) => `<b>${tr('exploitability')}:</b> <span id="${id}" data-value="${expl}">${pctF(expl! / 100, 2)} ${tr('pot')}</span> · ${tr('iterations', { count: iters })}`;
function renderDrillStatus() {
  const el = document.getElementById('drill-status');
  if (el && expl !== null) el.innerHTML = statusHtml('drill-expl');
}

async function dealNode() {
  const s = await samplePath(queryAsync, parseBoard(drill.board)); // stops at chance nodes: turn drills never leave the turn street
  Object.assign(drill, { view: s.view, h: s.h, path: s.path, steps: s.steps, phase: 'ask', t0: Date.now() });
  if (screen === 'drill') render();
}

function answer(i: number) {
  const v = drill.view!;
  drill.freqs = freqsFor(v.strategy, v.n, drill.h);
  drill.chosen = i;
  drill.evLoss = evLossPct(v.action_ev!, v.opp_mass!, v.n, drill.h, i, DRILL.pot);
  const ms = Math.min(Date.now() - drill.t0, 3600000);
  drill.total++; if (isCorrect(drill.freqs, i)) drill.correct++;
  drill.phase = 'reveal'; drill.saveErr = '';
  render();
  api.postResult({ spotId: spotId(drill.board, drill.oop, drill.ip, nodeType(drill.steps), drill.path, drill.street), hero: v.player, handCombo: comboName(drill.h), action: i,
    solverFreqs: drill.freqs, evLoss: drill.evLoss, ms, lang }).catch((e) => {
    if (e instanceof ApiError && e.status === 401) { user = null; screen = 'auth'; authErr = 'session'; render(); return; }
    drill.saveErr = errText(codeOf(e)); const el = document.getElementById('save-err'); if (el) el.textContent = drill.saveErr;
  });
}

const actBtn = (a: ReturnType<typeof actions>[number], attr: string) => `<button class="act" ${attr} style="--c:${a.color}">${tr(a.key, a.vars)}</button>`;

function renderDrill() {
  if (!user) return needLogin();
  const el = $('screen');
  const sessionPanel = () => drill.total
    ? `<div class="panel" id="session" data-correct="${drill.correct}" data-total="${drill.total}"><div class="big">${pctF(drill.correct / drill.total)}</div><div class="small muted">${tr('drill.session', { correct: drill.correct, total: drill.total, pct: pctF(drill.correct / drill.total) })}</div></div>` : '';
  if (drill.phase === 'idle') {
    el.innerHTML = `<div class="panel"><div class="toolbar"><label>${tr('drill.street')}<select id="street">${(['river', 'turn'] as const).map((s) => `<option value="${s}" ${s === drill.street ? 'selected' : ''}>${tr(('street.' + s) as Key)}</option>`).join('')}</select></label>
      <button id="start" class="primary">${tr('drill.start')}</button></div><div class="err">${err ? esc(errMsg()) : ''}</div></div>${sessionPanel() ? `<div class="stack" style="margin-top:var(--s-4);max-width:340px">${sessionPanel()}</div>` : ''}`;
    $('start').onclick = startDrill;
    $<HTMLSelectElement>('street').onchange = (e) => { drill.street = (e.target as HTMLSelectElement).value as Street; };
    return;
  }
  if (drill.phase === 'solving') {
    el.innerHTML = `<div class="panel"><p id="drill-solving" class="loading-line"><span class="spinner" role="status"></span>${tr('drill.solving')}</p><div id="drill-status" class="status"></div>
      <div class="gridwrap"><div id="grid" class="skeleton" aria-hidden="true"></div></div><div class="row" style="margin-top:var(--s-3)"><button id="cancel">${tr('drill.cancel')}</button></div></div>${sessionPanel() ? `<div class="stack" style="margin-top:var(--s-4);max-width:340px">${sessionPanel()}</div>` : ''}`;
    $('cancel').onclick = () => { worker.postMessage({ type: 'cancel' }); drill.phase = 'idle'; render(); };
    renderDrillStatus();
    return;
  }
  const v = drill.view!;
  const [c1, c2] = combos[drill.h];
  const as = actions(v, isFacing(drill.steps));
  const nt = nodeType(drill.steps);
  const head = `<div class="panel"><div class="board-row"><div><div class="panel-title">${tr('board')}</div><span id="board-cards" class="cards">${parseBoard(drill.board).map((c) => cardHtml(c, 'lg')).join('')}</span></div>
    <div class="meta"><span>${tr('pot')}: <b>${fmt(DRILL.pot, lang)}</b></span><span>${tr('stack')}: <b>${fmt(DRILL.stack, lang)}</b></span><span>${tr('oop')}: <b>${tr(('preset.' + drill.oop) as Key)}</b></span><span>${tr('ip')}: <b>${tr(('preset.' + drill.ip) as Key)}</b></span></div></div>
    <div id="history" data-street="${drill.street}" data-solve-ms="${drill.solveMs}" data-node="${nt}" data-depth="${drill.steps.length}"><div class="panel-title">${tr(('progress.spot.' + drill.street + ':' + nt) as Key)} · ${tr('drill.history')}</div><div class="seq">${seqHtml(drill.steps, v.player, true)}</div></div>
    <div id="solved-to" data-value="${drill.solveExpl}" class="small muted">${tr('drill.solvedTo', { value: tr('unit.ofPot', { value: pctF(drill.solveExpl / 100, 2) }) })}</div></div>`;
  const hand = `<div class="panel"><div class="panel-title">${tr('drill.hero')}</div><span id="hand" class="cards" data-combo="${comboName(drill.h)}">${[c2, c1].sort((a, b) => (b >> 2) - (a >> 2)).map((c) => cardHtml(c, 'lg')).join('')}</span>`;
  if (drill.phase === 'ask') {
    el.innerHTML = `<div class="workspace"><div class="stack">${head}<div class="panel"><div class="panel-title">${tr('drill.choose')}</div><div id="acts" class="acts">${as.map((a, i) => actBtn(a, `data-a="${i}"`)).join('')}</div></div></div>
      <aside class="side-panel">${hand}</div>${sessionPanel()}</aside></div>`;
    el.querySelectorAll<HTMLButtonElement>('button[data-a]').forEach((b) => b.onclick = () => answer(+b.dataset.a!));
    return;
  }
  const vd = verdictOf(drill.freqs, drill.chosen, drill.evLoss);
  const chosen = tr(as[drill.chosen].key, as[drill.chosen].vars);
  el.innerHTML = `<div class="workspace"><div class="stack">${head}<div class="panel"><div class="panel-title">${tr('drill.grid')}</div>${matrixShell()}</div></div>
    <aside class="side-panel">${hand}
      <div id="result" class="verdict ${vd === 'correct' ? 'right' : vd === 'close' ? 'close' : 'wrong'}" data-verdict="${vd}" data-correct="${vd === 'correct'}" data-evloss="${drill.evLoss}" data-chosen="${drill.chosen}" style="margin-top:var(--s-3)"><span class="${vd === 'correct' ? 'ok' : 'bad'}">${vd === 'mistake' ? icon.cross : icon.check}</span><div><b class="${vd === 'correct' ? 'ok' : 'bad'}">${tr(('drill.' + (vd === 'mistake' ? 'mistake' : vd)) as Key)}</b><div class="small muted">${tr('drill.youChose', { action: chosen })}</div></div></div>
      <div class="kv"><span>${tr('drill.evLoss')}</span><span>${ofPot(drill.evLoss)}</span></div>
      <div id="save-err" class="err">${esc(drill.saveErr)}</div>
      <div class="row" style="margin-top:var(--s-3)"><button id="next" class="primary">${tr('drill.next')}</button></div></div>
      <div class="panel"><div class="panel-title">${tr('drill.solverFreqs')}</div><div id="freqs" class="freqs">${as.map((a, i) => `<div class="fq ${i === drill.chosen ? 'chosen' : ''}" data-a="${i}" style="--c:${a.color}"><span>${tr(a.key, a.vars)}${i === drill.chosen ? ' ◀' : ''}</span><span class="bar"><i style="width:${drill.freqs[i] * 100}%"></i></span><span class="v">${pctF(drill.freqs[i])}</span></div>`).join('')}</div></div>
      <div class="panel" id="hand-info"></div>${sessionPanel()}</aside></div>`;
  $('next').onclick = startDrill;
  fillMatrix(v, as, drill.h);
}

function handClass(h: number): string {
  const [a, b] = combos[h];
  const hi = Math.max(a >> 2, b >> 2), lo = Math.min(a >> 2, b >> 2);
  return R[hi] + R[lo] + (hi === lo ? '' : (a & 3) === (b & 3) ? 's' : 'o');
}

const emptyBox = (id: string, text: string) => `<div class="empty">${icon.inbox}<p id="${id}">${text}</p></div>`;
const loadingBox = () => `<div class="loading-line"><span class="spinner" role="status"></span>${tr('progress.loading')}</div><div class="err">${authErr ? errText(authErr) : ''}</div>`;
const tile = (label: string, id: string, value: number | null, html: string) => `<div class="tile"><div class="l">${label}</div><div class="v" id="${id}" data-value="${value}">${html}</div></div>`;

/** Change password / delete account, shown under the progress tabs. */
function accountHtml() {
  return `<details id="acct" class="panel" style="margin-top:var(--s-4)"><summary>${tr('acct.title')}</summary>
    <label>${tr('acct.current')}<input id="acct-cur" type="password" autocomplete="current-password" maxlength="128"></label>
    <label>${tr('acct.new')}<input id="acct-new" type="password" autocomplete="new-password" maxlength="128"></label>
    <div class="row" style="margin-top:var(--s-3)"><button id="acct-change">${tr('acct.change')}</button><button id="acct-delete" class="danger">${tr('acct.delete')}</button></div>
    <div id="acct-msg" class="ok"></div><div id="acct-err" class="err"></div></details>`;
}
function bindAccount() {
  const val = (id: string) => $<HTMLInputElement>(id).value;
  const show = (ok: string, bad: string) => { $('acct-msg').textContent = ok; $('acct-err').textContent = bad; };
  $('acct-change').onclick = async () => {
    try { await api.changePassword(val('acct-cur'), val('acct-new')); show(tr('acct.changed'), ''); $<HTMLInputElement>('acct-cur').value = $<HTMLInputElement>('acct-new').value = ''; }
    catch (e) { show('', errText(codeOf(e))); }
  };
  $('acct-delete').onclick = async () => {
    if (!confirm(tr('acct.deleteConfirm'))) return;
    try { await api.deleteAccount(val('acct-cur')); user = null; progress = null; hhProg = null; drill.phase = 'idle'; drill.correct = drill.total = 0; go('auth'); authErr = ''; }
    catch (e) { show('', errText(codeOf(e))); }
  };
}

function renderProgress() {
  if (!user) return needLogin();
  $('screen').innerHTML = `<nav id="prog-tabs" class="tabs">${(['drills', 'hh'] as const).map((t) => `<button data-ptab="${t}" class="${progTab === t ? 'on' : ''}" aria-pressed="${progTab === t}">${tr(('hh.prog.tab.' + t) as Key)}</button>`).join('')}</nav><div id="prog-body"></div>`;
  document.querySelectorAll<HTMLButtonElement>('[data-ptab]').forEach((b) => b.onclick = () => {
    progTab = b.dataset.ptab as typeof progTab;
    if (progTab === 'hh') { hhProg = 'loading'; api.hhProgress().then((p) => { hhProg = p; if (screen === 'progress') render(); }, (e) => { hhProg = null; handleApiErr(e); }); }
    render();
  });
  const el = $('prog-body');
  el.insertAdjacentHTML('afterend', accountHtml()); bindAccount();
  if (progTab === 'hh') return renderHhProgress(el);
  if (progress === 'loading' || !progress) { el.innerHTML = loadingBox(); return; }
  const p = progress;
  if (!p.total) { el.innerHTML = `<h4>${tr('progress.title')}</h4>${emptyBox('p-empty', tr('progress.empty'))}`; return; }
  const pc = (x: number | null, d = 0) => x === null ? '-' : pctF(x, d);
  const evs = (x: number | null) => x === null ? '-' : ofPot(x);
  const dt = new Intl.DateTimeFormat(lang, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const day = (d: string) => dt.format(new Date(d + 'T00:00:00Z'));
  // Trend chart: 30 daily accuracy bars (one <rect> each), y axis 0-100 %, x axis first / middle / last day.
  const W = 640, Hh = 190, L = 40, T = 8, B = 24, pw = W - L - 6, ph = Hh - T - B, bw = pw / p.last30Days.length;
  const yy = (v: number) => T + ph * (1 - v);
  const grid = [0, 0.5, 1].map((v) => `<line class="${v === 0 ? 'ax' : 'gl'}" x1="${L}" x2="${W - 6}" y1="${yy(v)}" y2="${yy(v)}"/><text x="${L - 6}" y="${yy(v) + 4}" text-anchor="end">${pc(v)}</text>`).join('');
  const bars = p.last30Days.map((d, i) => {
    const t = `${day(d.date)}: ${d.accuracy === null ? '-' : pc(d.accuracy)} (${tr('progress.answers', { count: d.total })})`;
    const h = d.accuracy === null ? 2 : Math.max(2, d.accuracy * ph);
    return `<rect class="${d.accuracy === null ? 'none' : ''}" data-date="${d.date}" data-total="${d.total}" x="${L + i * bw + 1.5}" y="${T + ph - h}" width="${bw - 3}" height="${h}" rx="2"><title>${t}</title></rect>`;
  }).join('');
  const mid = p.last30Days[Math.floor(p.last30Days.length / 2)].date;
  const xl = (d: string, x: number, a: string) => `<text x="${x}" y="${Hh - 6}" text-anchor="${a}">${day(d)}</text>`;
  el.innerHTML = `<h4>${tr('progress.title')}</h4>
    <div class="tiles">${tile(tr('nav.drill'), 'p-total', p.total, tr('progress.answers', { count: p.total }))}${tile(tr('progress.accuracy'), 'p-acc', p.accuracy, pc(p.accuracy))}${tile(tr('progress.meanEvLoss'), 'p-ev', p.meanEvLoss, evs(p.meanEvLoss))}${tile(tr('progress.streak'), 'p-streak', p.streak, tr('progress.days', { count: p.streak }))}</div>
    <div class="panel"><div class="panel-title">${tr('progress.last30')}</div><div class="chart-wrap">
    <svg id="chart" role="img" aria-label="${tr('progress.last30')}" viewBox="0 0 ${W} ${Hh}">${grid}${bars}${xl(p.last30Days[0].date, L, 'start')}${xl(mid, L + pw / 2, 'middle')}${xl(p.last30Days[p.last30Days.length - 1].date, W - 6, 'end')}</svg></div></div>
    <h4>${tr('progress.bySpot')}</h4>
    <div class="tbl-wrap"><table id="by-spot">${p.bySpotType.map((s) => `<tr data-type="${s.spotType}"><td>${('progress.spot.' + s.spotType) in locales.en ? tr(('progress.spot.' + s.spotType) as Key) : esc(s.spotType)}</td><td>${tr('progress.answers', { count: s.total })}</td><td>${tr('progress.accuracy')}: ${pc(s.accuracy)}<span class="meter"><i style="width:${(s.accuracy ?? 0) * 100}%"></i></span></td><td>${tr('progress.meanEvLoss')}: ${evs(s.meanEvLoss)}</td></tr>`).join('')}</table></div>`;
}

function renderHhProgress(el: HTMLElement) {
  if (hhProg === 'loading' || !hhProg) { el.innerHTML = loadingBox(); return; }
  const p = hhProg;
  const note = `<div id="hh-prog-note" class="note">${tr('hh.disclaimer')} ${tr('hh.prog.note')}</div>`;
  if (!p.total) { el.innerHTML = `<h4>${tr('hh.prog.tab.hh')}</h4>${note}${emptyBox('hh-p-empty', tr('hh.prog.empty'))}`; return; }
  const pc = (x: number | null) => x === null ? '-' : pctF(x);
  const ev = (x: number | null) => x === null ? '-' : ofPot(x);
  el.innerHTML = `<h4>${tr('hh.prog.tab.hh')}</h4>${note}
    <div id="hh-p" class="tiles">${tile(tr('hh.results'), 'hh-p-total', p.total, `${tr('hh.prog.decisions', { count: p.total })}`)}${tile(tr('progress.accuracy'), 'hh-p-acc', p.accuracy, pc(p.accuracy))}${tile(tr('progress.meanEvLoss'), 'hh-p-ev', p.meanEvLoss, ev(p.meanEvLoss))}</div>
    <div class="row"><span class="badge-approx">${tr('hh.badge.approx')}</span></div>
    <h4>${tr('progress.bySpot')}</h4>
    <div class="tbl-wrap"><table id="hh-by-street">${p.bySpotType.map((s) => `<tr data-type="${s.spotType}"><td>${('street.' + s.spotType) in locales.en ? tr(('street.' + s.spotType) as Key) : esc(s.spotType)}</td><td>${tr('hh.prog.decisions', { count: s.total })}</td><td>${tr('progress.meanEvLoss')}: ${ev(s.meanEvLoss)}</td></tr>`).join('')}</table></div>
    <h4>${tr('hh.prog.byStatus')}</h4>
    <div class="tbl-wrap"><table id="hh-by-status">${Object.entries(p.byStatus).map(([k, n]) => `<tr data-status="${k}"><td>${('hh.status.' + k) in locales.en ? tr(('hh.status.' + k) as Key) : esc(k)}</td><td>${fmt(n, lang)}</td></tr>`).join('')}</table></div>`;
}

function renderSolver() {
  const opt = (sel: string) => Object.keys(presets).map((k) => `<option value="${k}" ${sel === k ? 'selected' : ''}>${tr(('preset.' + k) as Key)}</option>`).join('');
  $('screen').innerHTML = `
  <section class="panel"><div class="toolbar">
    <label>${tr('board')}<input id="board" size="14" value="${esc(form.board)}"></label>
    <label>${tr('pot')}<input id="pot" type="number" value="${form.pot}"></label>
    <label>${tr('stack')}<input id="stack" type="number" value="${form.stack}"></label>
    <label>${tr('oop')}<select id="oop">${opt(form.oop)}</select></label>
    <label>${tr('ip')}<select id="ip">${opt(form.ip)}</select></label>
    <button id="solve" class="primary ${solving ? 'loading' : ''}" ${solving ? 'disabled' : ''}>${solving ? tr('solving') : tr('solve')}</button>
  </div><div id="status" class="status"></div><div id="err" class="err">${err ? esc(errMsg()) : ''}</div></section>
  <div class="workspace"><div class="stack">
    <div class="panel"><div class="board-row"><div><div class="panel-title">${tr('board')}</div><span class="cards">${boardTiles(form.board)}</span></div>
      <div><div class="panel-title">${tr('seq.title')}</div><div id="seq" class="seq"></div></div></div>
      <div id="info" class="meta"></div><div id="acts" class="acts" style="margin-top:var(--s-3)"></div></div>
    <div class="panel">${matrixShell()}</div></div>
    <aside class="side-panel"><div class="panel" id="hand-info"></div></aside></div>`;
  $('solve').onclick = solve;
  renderStatus(); renderGrid(); renderHandInfo();
}

function readForm() {
  if (!document.getElementById('board')) return;
  form.board = $<HTMLInputElement>('board').value;
  form.pot = +$<HTMLInputElement>('pot').value;
  form.stack = +$<HTMLInputElement>('stack').value;
  form.oop = $<HTMLSelectElement>('oop').value;
  form.ip = $<HTMLSelectElement>('ip').value;
}

function solve() {
  if (solving) return;
  readForm();
  const b = normalizeBoard(form.board);
  const bad = !b.ok ? 'solver.err.' + b.err : !validChips(form.pot) || !validChips(form.stack) ? 'solver.err.chips' : '';
  if (bad) { err = bad; render(); return; }
  form.board = b.ok ? b.board : form.board;
  err = ''; view = null; path = []; facing = [false]; seq = []; sel = -1; expl = null; iters = 0; solving = true; owner = 'solver'; drill.phase = 'idle';
  const config = JSON.stringify({
    board: form.board,
    ranges: [parseRange(presets[form.oop]), parseRange(presets[form.ip])],
    streets: [{ pot: form.pot, stack: form.stack, sizes, raise_cap: 2 }],
    budget_mb: 1024,
  });
  worker.postMessage({ type: 'solve', config, chunk: 20, target: 0.3, maxIters: 2000 });
  render();
}

// Status ticks only touch this one element (no re-render of the view while solving).
function renderStatus() {
  const el = document.getElementById('status');
  if (!el || expl === null) return;
  el.innerHTML = (solving ? '<span class="spinner" aria-hidden="true"></span>' : '') + statusHtml('expl');
}

const matrixShell = () => `<div id="legend" class="legend"></div><div id="totbar" class="totbar" aria-hidden="true"></div><div class="gridwrap"><div id="grid" tabindex="0" role="group" aria-label="${tr('a11y.matrix')}"></div></div><div class="grid-hint">${tr('strategy.hint')}</div>`;

function renderGrid() {
  const grid = document.getElementById('grid');
  if (!grid) return;
  const info = $('info'), acts = $('acts'), legend = $('legend'), seqEl = $('seq');
  grid.className = !view && solving ? 'skeleton' : '';
  if (!view) { grid.innerHTML = ''; legend.innerHTML = ''; $('totbar').innerHTML = ''; return; }
  const v = view;
  const reset = () => { path = []; facing = [false]; seq = []; query(path); };
  if (v.kind !== 'action') {
    info.textContent = tr('terminal'); acts.innerHTML = `<button class="act sec" id="back">${tr('back')}</button>`;
    seqEl.innerHTML = seqHtml(seq, null, false);
    $('back').onclick = reset;
    legend.innerHTML = ''; $('totbar').innerHTML = ''; grid.innerHTML = ''; return;
  }
  const fac = facing[facing.length - 1];
  const as = actions(v, fac);
  info.innerHTML = `<b>${tr('toAct', { player: tr(('player.' + v.player) as Key) })}</b>`;
  seqEl.innerHTML = seqHtml(seq, v.player, false);
  acts.innerHTML = as.map((a, i) => actBtn(a, `data-i="${i}"`)).join('')
    + (path.length ? `<button class="act sec" id="back">${tr('back')}</button>` : '');
  acts.querySelectorAll<HTMLButtonElement>('button[data-i]').forEach((b) => b.onclick = () => {
    const i = +b.dataset.i!;
    // folds/calls end the action here (call at a bet = showdown); bets go on
    const isBet = fac ? i >= 2 : i >= 1;
    seq = [...seq, stepOf(v.player, i, fac)];
    path = [...path, i]; facing = [...facing, isBet]; query(path);
  });
  const back = document.getElementById('back');
  if (back) back.onclick = reset;
  fillMatrix(v, as);
}

/** Fill legend (with range-wide action totals), totals bar and the 13x13 matrix, then wire hover/select. */
function fillMatrix(v: View, as: ReturnType<typeof actions>, mark = -1) {
  const tot = new Float64Array(v.n); let sum = 0;
  for (let h = 0; h < H; h++) { const r = v.range[h]; if (!(r > 0)) continue; sum += r; for (let k = 0; k < v.n; k++) tot[k] += r * v.strategy[k * H + h]; }
  $('legend').innerHTML = as.map((a, k) => `<span class="lg" style="--c:${a.color}"><i></i>${tr(a.key, a.vars)} <b>${pctF(sum > 0 ? tot[k] / sum : 0, 1)}</b></span>`).join('');
  $('totbar').innerHTML = as.map((a, k) => `<i style="width:${sum > 0 ? (tot[k] / sum) * 100 : 0}%;background:${a.color}"></i>`).join('');
  const grid = $('grid');
  grid.innerHTML = gridHtml(v, as, mark);
  bindMatrix(grid);
  renderHandInfo();
}

// Matrix selection + hover panel. cellData is rebuilt by gridHtml; `sel` is the pinned cell (-1 = none).
let sel = -1;
let cellData: { as: ReturnType<typeof actions>; n: number; w: Float64Array; f: Float64Array; ev: Float64Array | null; names: string[] } | null = null;
function bindMatrix(grid: HTMLElement) {
  const cellOf = (e: Event) => (e.target as HTMLElement).closest<HTMLElement>('.c');
  let cur = sel;
  const pin = (ix: number) => { sel = cur = ix; grid.querySelector('.sel')?.classList.remove('sel'); grid.children[ix]?.classList.add('sel'); renderHandInfo(); };
  grid.onmouseover = (e) => { const c = cellOf(e); if (c) renderHandInfo(+c.dataset.ix!); };
  grid.onmouseleave = () => renderHandInfo();
  grid.onclick = (e) => { const c = cellOf(e); if (c) pin(+c.dataset.ix!); };
  // Keyboard: arrows move a visible cursor (hand info previews), Enter/Space pins the cursor cell like a click.
  const focusCell = (ix: number) => { cur = ix; grid.querySelector('.foc')?.classList.remove('foc'); grid.children[ix]?.classList.add('foc'); grid.setAttribute('aria-activedescendant', 'cell-' + ix); renderHandInfo(ix); };
  grid.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pin(cur < 0 ? 0 : cur); return; }
    const d = ({ ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] } as Record<string, number[]>)[e.key];
    if (!d) return;
    e.preventDefault();
    const base = cur < 0 ? 0 : cur, r = Math.min(12, Math.max(0, Math.floor(base / 13) + d[0])), c = Math.min(12, Math.max(0, (base % 13) + d[1]));
    focusCell(cur < 0 ? 0 : r * 13 + c);
  };
  if (sel >= 0) grid.children[sel]?.classList.add('sel');
}

function renderHandInfo(ix = sel) {
  const el = document.getElementById('hand-info'), d = cellData;
  if (!el) return;
  if (!d || ix < 0 || !grid169()) { el.innerHTML = `<div class="panel-title">${tr('strategy.hand')}</div><p class="muted small">${tr('strategy.hint')}</p>`; return; }
  const w = d.w[ix], n = d.n;
  const bars = w > 1e-6 ? d.as.map((a, k) => {
    const p = d.f[ix * n + k] / w;
    return `<div class="fq" style="--c:${a.color}"><span>${tr(a.key, a.vars)}</span><span class="bar"><i style="width:${p * 100}%"></i></span><span class="v">${pctF(p)}</span>${d.ev ? `<span class="ev">${tr('strategy.ev')}: ${fmt(d.ev[ix * n + k] / w, lang, { maximumFractionDigits: 2 })}</span>` : ''}</div>`;
  }).join('') : '';
  el.innerHTML = `<div class="panel-title">${tr('strategy.hand')}</div><div class="row between"><span class="big">${d.names[ix]}</span><span class="muted small">${tr('strategy.combos')}: ${fmt(w, lang, { maximumFractionDigits: 1 })}</span></div><div class="freqs" style="margin-top:var(--s-3)">${bars}</div>`;
}
const grid169 = () => !!document.getElementById('grid')?.children.length;

function gridHtml(v: View, as: ReturnType<typeof actions>, mark = -1): string {
  // aggregate to 13x13: weight = reach
  const w = new Float64Array(169), f = new Float64Array(169 * v.n);
  const hasEv = !!(v.action_ev && v.opp_mass);
  const ev = hasEv ? new Float64Array(169 * v.n) : null;
  for (let h = 0; h < H; h++) {
    const r = v.range[h];
    if (!(r > 0)) continue;
    const [a, b] = combos[h];
    let hi = a >> 2, lo = b >> 2; // a<b so hi rank <= lo rank
    [hi, lo] = [Math.max(hi, lo), Math.min(hi, lo)];
    const suited = (a & 3) === (b & 3);
    const row = 12 - hi, col = 12 - lo;
    const idx = suited ? row * 13 + col : col * 13 + row;
    w[idx] += r;
    const m = hasEv ? v.opp_mass![h] : 0;
    for (let k = 0; k < v.n; k++) {
      f[idx * v.n + k] += r * v.strategy[k * H + h];
      if (ev && m > 0) ev[idx * v.n + k] += r * (v.action_ev![k * H + h] / m); // per-combo EV in chips, weighted by reach
    }
  }
  const markName = mark >= 0 ? handClass(mark) : '';
  const names: string[] = [];
  let html = '';
  for (let i = 0; i < 13; i++) for (let j = 0; j < 13; j++) {
    const idx = i * 13 + j;
    const hi = i <= j ? i : j, lo = i <= j ? j : i;
    const name = R[12 - hi] + R[12 - lo] + (i === j ? '' : i < j ? 's' : 'o');
    names.push(name);
    let style = '';
    if (w[idx] > 1e-6) {
      let acc = 0; const stops: string[] = [];
      for (let k = 0; k < v.n; k++) {
        const p = f[idx * v.n + k] / w[idx];
        stops.push(`${as[k].color} ${acc * 100}% ${(acc + p) * 100}%`); acc += p;
      }
      style = ` style="background:linear-gradient(to right, ${stops.join(',')})"`;
    }
    html += `<div class="c${w[idx] > 1e-6 ? '' : ' nr'}${name === markName ? ' me' : ''}" id="cell-${idx}" data-hand="${name}" data-ix="${idx}" title="${name}"${style}>${name}</div>`;
  }
  cellData = { as, n: v.n, w, f, ev, names };
  return html;
}

applyTheme();
document.documentElement.lang = lang;
render();
// Restore the session after a reload (httpOnly cookie): only touch the UI if nothing else has happened meanwhile.
api.me().then((m) => { if (!user && screen !== 'auth') { readForm(); user = m.username; render(); } }, () => { /* not logged in or offline: stay logged out */ });
