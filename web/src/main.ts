import { t, fmt, locales, type Lang, type Key } from './i18n';
import { parseRange, presets, R } from './ranges';
import { api, ApiError, type Progress } from './api';
import { combos, comboName, cardName, randomBoard, sampleHand, freqsFor, evLossPct, isCorrect, spotId, SUITS, RANKS } from './drill';

// Bet sizes sent to the engine; labels derive from these (NodeView has no size info, so this assumes none are merged/dropped, e.g. at all-in).
const sizes = [0.5, 1];
const colors = { fold: '#4a90d9', check: '#5cb85c', call: '#5cb85c', bet: ['#f0ad4e', '#e8743b', '#c0392b'] };

interface View { kind: string; player: number; n: number; strategy: number[]; range: number[]; action_ev?: number[]; opp_mass?: number[] }
type Screen = 'solver' | 'drill' | 'progress' | 'auth';
const DRILL = { pot: 10, stack: 50 };
let screen: Screen = 'solver';
let owner: 'solver' | 'drill' = 'solver';
let user: string | null = null;
let authErr = '';
let progress: Progress | 'loading' | null = null;
const drill = { phase: 'idle' as 'idle' | 'solving' | 'ask' | 'reveal', board: '', oop: '', ip: '', view: null as View | null, h: 0,
  freqs: [] as number[], chosen: -1, evLoss: 0, t0: 0, correct: 0, total: 0, saveErr: '' };

let lang: Lang = (new URLSearchParams(location.search).get('lang') as Lang) in locales
  ? (new URLSearchParams(location.search).get('lang') as Lang) : 'en';
let path: number[] = [];
let facing: boolean[] = [false]; // facing a bet at each depth of path
let view: View | null = null;
let expl: number | null = null;
let iters = 0;
let solving = false;
let err = '';
const form = { board: 'As Kd 7c 4h 2s', pot: 10, stack: 50, oop: 'mixed', ip: 'mixed' };

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'progress') { expl = m.expl; iters = m.iters; if (owner === 'solver') { if (!view) query([]); renderStatus(); } }
  else if (m.type === 'done') {
    if (owner === 'drill') { query([]); return; }
    solving = false; expl = m.expl; iters = m.iters; query(path); render();
  }
  else if (m.type === 'node') {
    if (owner === 'drill') { if (drill.phase === 'solving') dealHand(m.view); return; }
    view = m.view; renderGrid();
  }
  else if (m.type === 'error') { solving = false; if (owner === 'drill') drill.phase = 'idle'; err = m.message; render(); }
};
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

const cssText = `
    body{font-family:system-ui,sans-serif;margin:12px;background:#1b1d22;color:#e8e8e8}
    label{margin-right:10px;font-size:13px} input,select,button{font-size:13px;margin-left:4px}
    #grid{display:grid;grid-template-columns:repeat(13,34px);gap:1px;margin:10px 0}
    .c{width:34px;height:34px;font-size:9px;color:#fff;display:flex;align-items:flex-start;text-shadow:0 0 2px #000;box-sizing:border-box;padding:1px}
    .c.me{outline:3px solid #fff;outline-offset:-3px;z-index:1}
    .legend span{display:inline-block;margin-right:12px;font-size:12px} .legend i{display:inline-block;width:10px;height:10px;margin-right:4px}
    button.a{margin:2px 6px 2px 0;padding:4px 10px}
    header{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px} header h3{margin:0 10px 0 0}
    nav button.on{font-weight:bold;border-bottom:3px solid #f0ad4e}
    .card{display:inline-block;background:#fff;border-radius:4px;padding:4px 6px;margin-right:4px;font-size:22px;font-weight:bold;border:1px solid #888}
    .sc{color:#111}.sh{color:#d55e00}.sd{color:#0072b2}.ss2{color:#009e73}
    table{border-collapse:collapse;font-size:13px} td,th{padding:3px 10px;text-align:left}
    .err{color:#f66}.ok{color:#5cb85c}.bad{color:#f0ad4e}
  `;

function render() {
  const nav = (['solver', 'drill', 'progress'] as const).map((s) => `<button data-nav="${s}" class="${screen === s ? 'on' : ''}">${tr(('nav.' + s) as Key)}</button>`).join('');
  const who = user
    ? `<span id="whoami" data-user="${user}">${tr('auth.loggedAs', { name: user })}</span><button id="logout">${tr('auth.logout')}</button>`
    : `<button data-nav="auth" id="to-auth">${tr('auth.login')}</button>`;
  $('app').innerHTML = `<style>${cssText}</style>
  <header><h3 id="title">${tr('title')}</h3><nav>${nav}</nav>
  <label>${tr('language')}<select id="lang">${(Object.keys(locales) as Lang[]).map((l) => `<option value="${l}" ${l === lang ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
  ${who}</header><div id="screen"></div>`;
  $<HTMLSelectElement>('lang').onchange = (e) => { readForm(); lang = (e.target as HTMLSelectElement).value as Lang; document.documentElement.lang = lang; render(); };
  document.querySelectorAll<HTMLButtonElement>('[data-nav]').forEach((b) => b.onclick = () => go(b.dataset.nav as Screen));
  const lo = document.getElementById('logout');
  if (lo) lo.onclick = async () => { try { await api.logout(); } catch { /* ignore */ } user = null; progress = null; drill.phase = 'idle'; drill.correct = drill.total = 0; go('auth'); };
  if (screen === 'solver') renderSolver();
  else if (screen === 'drill') renderDrill();
  else if (screen === 'progress') renderProgress();
  else renderAuth();
}

function go(s: Screen) {
  readForm(); screen = s; authErr = '';
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
  $('screen').innerHTML = `<div style="max-width:340px">
    <p>${tr('auth.hint')}</p>
    <div><label>${tr('auth.username')}<input id="u" autocomplete="username" maxlength="64"></label></div>
    <div style="margin-top:6px"><label>${tr('auth.password')}<input id="pw" type="password" autocomplete="current-password" maxlength="128"></label></div>
    <div style="margin-top:8px"><button id="do-login">${tr('auth.login')}</button><button id="do-register">${tr('auth.register')}</button></div>
    <div id="auth-err" class="err" data-code="${authErr}" style="margin-top:8px">${authErr ? errText(authErr) : ''}</div></div>`;
  const submit = (fn: typeof api.login) => async () => {
    try {
      user = (await fn($<HTMLInputElement>('u').value, $<HTMLInputElement>('pw').value)).username;
      progress = null; screen = 'drill'; authErr = ''; render();
    } catch (e) { authErr = codeOf(e); const el = $('auth-err'); el.dataset.code = authErr; el.textContent = errText(authErr); }
  };
  $('do-login').onclick = submit(api.login);
  $('do-register').onclick = submit(api.register);
}

const needLogin = () => {
  $('screen').innerHTML = `<p id="need-login">${tr('auth.needLogin')}</p><button id="to-auth2">${tr('auth.login')}</button>`;
  $('to-auth2').onclick = () => go('auth');
};

const cardHtml = (c: number) => {
  const suit = SUITS[c & 3] as 'c' | 'd' | 'h' | 's';
  const sym = { c: '♣', d: '♦', h: '♥', s: '♠' }[suit];
  const cls = { c: 'ss2', d: 'sd', h: 'sh', s: 'sc' }[suit];
  return `<span class="card ${cls}" data-card="${cardName(c)}">${RANKS[c >> 2]}${sym}</span>`;
};
const parseBoard = (b: string) => b.split(' ').map((x) => (RANKS.indexOf(x[0]) * 4) + SUITS.indexOf(x[1]));

function startDrill() {
  const ids = Object.keys(presets);
  const pick = () => ids[Math.floor(Math.random() * ids.length)];
  Object.assign(drill, { phase: 'solving', board: randomBoard(), oop: pick(), ip: pick(), view: null, saveErr: '' });
  owner = 'drill'; solving = false; err = '';
  worker.postMessage({ type: 'solve', config: JSON.stringify({
    board: drill.board,
    ranges: [parseRange(presets[drill.oop]), parseRange(presets[drill.ip])],
    streets: [{ pot: DRILL.pot, stack: DRILL.stack, sizes, raise_cap: 2 }],
    budget_mb: 1024,
  }), chunk: 20, target: 0.3, maxIters: 2000 });
  render();
}

function dealHand(v: View) {
  drill.view = v; drill.h = sampleHand(v.range); drill.phase = 'ask'; drill.t0 = Date.now();
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
  api.postResult({ spotId: spotId(drill.board, drill.oop, drill.ip), hero: v.player, handCombo: comboName(drill.h), action: i,
    solverFreqs: drill.freqs, evLoss: drill.evLoss, ms, lang }).catch((e) => {
    if (e instanceof ApiError && e.status === 401) { handleApiErr(e); return; }
    drill.saveErr = errText(codeOf(e)); const el = document.getElementById('save-err'); if (el) el.textContent = drill.saveErr;
  });
}

function renderDrill() {
  if (!user) return needLogin();
  const el = $('screen');
  const sessionLine = () => drill.total
    ? `<div id="session" data-correct="${drill.correct}" data-total="${drill.total}">${tr('drill.session', { correct: drill.correct, total: drill.total, pct: fmt(drill.correct / drill.total, lang, { style: 'percent' }) })}</div>` : '';
  if (drill.phase === 'idle') { el.innerHTML = `<button id="start" class="a">${tr('drill.start')}</button>${sessionLine()}<div class="err">${err ? tr('error', { message: err }) : ''}</div>`; $('start').onclick = startDrill; return; }
  if (drill.phase === 'solving') { el.innerHTML = `<p id="drill-solving">${tr('drill.solving')}</p>${sessionLine()}`; return; }
  const v = drill.view!;
  const [c1, c2] = combos[drill.h];
  const as = actions(v, false);
  const head = `<div>${tr('board')}: <span id="board-cards">${parseBoard(drill.board).map(cardHtml).join('')}</span></div>
    <div style="margin:6px 0">${tr('toAct', { player: tr(('player.' + v.player) as Key) })} · ${tr('pot')}: ${fmt(DRILL.pot, lang)} · ${tr('stack')}: ${fmt(DRILL.stack, lang)} · ${tr('oop')}: ${tr(('preset.' + drill.oop) as Key)} · ${tr('ip')}: ${tr(('preset.' + drill.ip) as Key)}</div>
    <div style="margin:6px 0">${tr('drill.yourHand')}: <span id="hand" data-combo="${comboName(drill.h)}">${[c2, c1].sort((a, b) => (b >> 2) - (a >> 2)).map(cardHtml).join('')}</span></div>`;
  if (drill.phase === 'ask') {
    el.innerHTML = `${head}<div>${tr('drill.choose')}</div><div id="acts">${as.map((a, i) => `<button class="a" data-a="${i}" style="border-left:6px solid ${a.color}">${tr(a.key, a.vars)}</button>`).join('')}</div>${sessionLine()}`;
    el.querySelectorAll<HTMLButtonElement>('button[data-a]').forEach((b) => b.onclick = () => answer(+b.dataset.a!));
    return;
  }
  const ok = isCorrect(drill.freqs, drill.chosen);
  const pct = (x: number) => fmt(x, lang, { style: 'percent', maximumFractionDigits: 0 });
  el.innerHTML = `${head}
    <div id="result" data-correct="${ok}" data-evloss="${drill.evLoss}" data-chosen="${drill.chosen}"><b class="${ok ? 'ok' : 'bad'}">${tr(ok ? 'drill.correct' : 'drill.mistake')}</b> · ${tr('drill.youChose', { action: tr(as[drill.chosen].key, as[drill.chosen].vars) })} · ${tr('drill.evLoss')}: ${tr('unit.ofPot', { value: fmt(drill.evLoss / 100, lang, { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 }) })}</div>
    <div style="margin:6px 0"><b>${tr('drill.solverFreqs')}</b><table id="freqs">${as.map((a, i) => `<tr data-a="${i}"><td><i style="display:inline-block;width:10px;height:10px;background:${a.color}"></i> ${tr(a.key, a.vars)}</td><td>${pct(drill.freqs[i])}</td></tr>`).join('')}</table></div>
    <div id="save-err" class="err">${drill.saveErr}</div>
    <button id="next" class="a">${tr('drill.next')}</button>${sessionLine()}
    <div style="margin-top:8px"><b>${tr('drill.grid')}</b></div><div id="grid">${gridHtml(v, as, drill.h)}</div>`;
  $('next').onclick = startDrill;
}

function handClass(h: number): string {
  const [a, b] = combos[h];
  const hi = Math.max(a >> 2, b >> 2), lo = Math.min(a >> 2, b >> 2);
  return R[hi] + R[lo] + (hi === lo ? '' : (a & 3) === (b & 3) ? 's' : 'o');
}

function renderProgress() {
  if (!user) return needLogin();
  const el = $('screen');
  if (progress === 'loading' || !progress) { el.innerHTML = `<p>${tr('progress.loading')}</p><div class="err">${authErr ? errText(authErr) : ''}</div>`; return; }
  const p = progress;
  if (!p.total) { el.innerHTML = `<h4>${tr('progress.title')}</h4><p id="p-empty">${tr('progress.empty')}</p>`; return; }
  const pc = (x: number | null, d = 0) => x === null ? '-' : fmt(x, lang, { style: 'percent', minimumFractionDigits: d, maximumFractionDigits: d });
  const evs = (x: number | null) => x === null ? '-' : tr('unit.ofPot', { value: fmt(x / 100, lang, { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 }) });
  const dt = new Intl.DateTimeFormat(lang, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const day = (d: string) => dt.format(new Date(d + 'T00:00:00Z'));
  const W = 300, Hh = 80, bw = W / p.last30Days.length;
  const bars = p.last30Days.map((d, i) => {
    const t = `${day(d.date)}: ${d.accuracy === null ? '-' : pc(d.accuracy)} (${tr('progress.answers', { count: d.total })})`;
    const h = d.accuracy === null ? 2 : Math.max(2, d.accuracy * Hh);
    return `<rect data-date="${d.date}" data-total="${d.total}" x="${i * bw + 1}" y="${Hh - h}" width="${bw - 2}" height="${h}" fill="${d.accuracy === null ? '#555' : '#5cb85c'}"><title>${t}</title></rect>`;
  }).join('');
  el.innerHTML = `<h4>${tr('progress.title')}</h4>
    <table><tr><th>${tr('nav.drill')}</th><td id="p-total" data-value="${p.total}">${tr('progress.answers', { count: p.total })}</td></tr>
    <tr><th>${tr('progress.accuracy')}</th><td id="p-acc" data-value="${p.accuracy}">${pc(p.accuracy)}</td></tr>
    <tr><th>${tr('progress.meanEvLoss')}</th><td id="p-ev" data-value="${p.meanEvLoss}">${evs(p.meanEvLoss)}</td></tr>
    <tr><th>${tr('progress.streak')}</th><td id="p-streak" data-value="${p.streak}">${tr('progress.days', { count: p.streak })}</td></tr></table>
    <p>${tr('progress.last30')}</p>
    <svg id="chart" role="img" aria-label="${tr('progress.last30')}" width="${W}" height="${Hh + 16}" viewBox="0 0 ${W} ${Hh + 16}">${bars}
      <text x="0" y="${Hh + 12}" font-size="10" fill="#aaa">${day(p.last30Days[0].date)}</text>
      <text x="${W}" y="${Hh + 12}" font-size="10" fill="#aaa" text-anchor="end">${day(p.last30Days[p.last30Days.length - 1].date)}</text></svg>
    <p><b>${tr('progress.bySpot')}</b></p>
    <table id="by-spot">${p.bySpotType.map((s) => `<tr data-type="${s.spotType}"><td>${('progress.spot.' + s.spotType) in locales.en ? tr(('progress.spot.' + s.spotType) as Key) : s.spotType}</td><td>${tr('progress.answers', { count: s.total })}</td><td>${tr('progress.accuracy')}: ${pc(s.accuracy)}</td><td>${tr('progress.meanEvLoss')}: ${evs(s.meanEvLoss)}</td></tr>`).join('')}</table>`;
}

function renderSolver() {
  const opt = (sel: string) => Object.keys(presets).map((k) => `<option value="${k}" ${sel === k ? 'selected' : ''}>${tr(('preset.' + k) as Key)}</option>`).join('');
  $('screen').innerHTML = `
  <div style="margin-top:8px">
    <label>${tr('board')}<input id="board" size="14" value="${form.board}"></label>
    <label>${tr('pot')}<input id="pot" type="number" size="4" style="width:55px" value="${form.pot}"></label>
    <label>${tr('stack')}<input id="stack" type="number" style="width:55px" value="${form.stack}"></label>
    <label>${tr('oop')}<select id="oop">${opt(form.oop)}</select></label>
    <label>${tr('ip')}<select id="ip">${opt(form.ip)}</select></label>
    <button id="solve" ${solving ? 'disabled' : ''}>${solving ? tr('solving') : tr('solve')}</button>
  </div>
  <div id="status" style="margin:8px 0"></div>
  <div id="err" style="color:#f66">${err ? tr('error', { message: err }) : ''}</div>
  <div id="info"></div><div id="acts"></div><div id="legend" class="legend"></div><div id="grid"></div>`;
  $('solve').onclick = solve;
  renderStatus(); renderGrid();
}

function readForm() {
  if (!$('board')) return;
  form.board = $<HTMLInputElement>('board').value;
  form.pot = +$<HTMLInputElement>('pot').value;
  form.stack = +$<HTMLInputElement>('stack').value;
  form.oop = $<HTMLSelectElement>('oop').value;
  form.ip = $<HTMLSelectElement>('ip').value;
}

function solve() {
  readForm();
  err = ''; view = null; path = []; facing = [false]; expl = null; iters = 0; solving = true; owner = 'solver'; drill.phase = 'idle';
  const config = JSON.stringify({
    board: form.board,
    ranges: [parseRange(presets[form.oop]), parseRange(presets[form.ip])],
    streets: [{ pot: form.pot, stack: form.stack, sizes, raise_cap: 2 }],
    budget_mb: 1024,
  });
  worker.postMessage({ type: 'solve', config, chunk: 20, target: 0.3, maxIters: 2000 });
  render();
}

function renderStatus() {
  const el = document.getElementById('status');
  if (!el || expl === null) return;
  el.innerHTML = `<b>${tr('exploitability')}:</b> <span id="expl" data-value="${expl}">${fmt(expl / 100, lang, { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${tr('pot')}</span> · ${tr('iterations', { count: iters })}`;
}

function renderGrid() {
  const grid = document.getElementById('grid');
  if (!grid) return;
  if (!view) { grid.innerHTML = ''; return; }
  const v = view;
  const info = $('info'), acts = $('acts'), legend = $('legend');
  if (v.kind !== 'action') {
    info.textContent = tr('terminal'); acts.innerHTML = `<button class="a" id="back">${tr('back')}</button>`;
    $('back').onclick = () => { path = []; facing = [false]; query(path); };
    legend.innerHTML = ''; grid.innerHTML = ''; return;
  }
  const fac = facing[facing.length - 1];
  const as = actions(v, fac);
  info.innerHTML = `<b>${tr('toAct', { player: tr(('player.' + v.player) as Key) })}</b>`;
  acts.innerHTML = as.map((a, i) => `<button class="a" data-i="${i}" style="border-left:6px solid ${a.color}">${tr(a.key, a.vars)}</button>`).join('')
    + (path.length ? `<button class="a" id="back">${tr('back')}</button>` : '');
  acts.querySelectorAll<HTMLButtonElement>('button[data-i]').forEach((b) => b.onclick = () => {
    const i = +b.dataset.i!;
    // folds/calls end the action here (call at a bet = showdown); bets go on
    const isBet = fac ? i >= 2 : i >= 1;
    path = [...path, i]; facing = [...facing, isBet]; query(path);
  });
  const back = document.getElementById('back');
  if (back) back.onclick = () => { path = []; facing = [false]; query(path); };
  legend.innerHTML = as.map((a) => `<span><i style="background:${a.color}"></i>${tr(a.key, a.vars)}</span>`).join('');

  grid.innerHTML = gridHtml(v, as);
}

function gridHtml(v: View, as: ReturnType<typeof actions>, mark = -1): string {
  // aggregate to 13x13: weight = reach
  const w = new Float64Array(169), f = new Float64Array(169 * v.n);
  const H = combos.length;
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
    for (let k = 0; k < v.n; k++) f[idx * v.n + k] += r * v.strategy[k * H + h];
  }
  const markName = mark >= 0 ? handClass(mark) : '';
  let html = '';
  for (let i = 0; i < 13; i++) for (let j = 0; j < 13; j++) {
    const idx = i * 13 + j;
    const hi = i <= j ? i : j, lo = i <= j ? j : i;
    const name = R[12 - hi] + R[12 - lo] + (i === j ? '' : i < j ? 's' : 'o');
    let bg = '#2c2f36';
    const title = name;
    if (w[idx] > 1e-6) {
      let acc = 0; const stops: string[] = [];
      for (let k = 0; k < v.n; k++) {
        const p = f[idx * v.n + k] / w[idx];
        stops.push(`${as[k].color} ${acc * 100}% ${(acc + p) * 100}%`); acc += p;
      }
      bg = `linear-gradient(to right, ${stops.join(',')})`;
    }
    html += `<div class="c${name === markName ? ' me' : ''}" data-hand="${name}" title="${title}" style="background:${bg}">${name}</div>`;
  }
  return html;
}


document.documentElement.lang = lang;
render();
