import { t, fmt, locales, type Lang, type Key } from './i18n';
import { parseRange, presets, R } from './ranges';

// Bet sizes sent to the engine; labels derive from these (NodeView has no size info, so this assumes none are merged/dropped, e.g. at all-in).
const sizes = [0.5, 1];
const colors = { fold: '#4a90d9', check: '#5cb85c', call: '#5cb85c', bet: ['#f0ad4e', '#e8743b', '#c0392b'] };
const combos: [number, number][] = [];
for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) combos.push([a, b]);

interface View { kind: string; player: number; n: number; strategy: number[]; range: number[] }

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
  if (m.type === 'progress') { expl = m.expl; iters = m.iters; if (!view) query([]); renderStatus(); }
  else if (m.type === 'done') { solving = false; expl = m.expl; iters = m.iters; query(path); render(); }
  else if (m.type === 'node') { view = m.view; renderGrid(); }
  else if (m.type === 'error') { solving = false; err = m.message; render(); }
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

function render() {
  const opt = (sel: string) => Object.keys(presets).map((k) => `<option value="${k}" ${sel === k ? 'selected' : ''}>${tr(('preset.' + k) as Key)}</option>`).join('');
  $('app').innerHTML = `
  <style>
    body{font-family:system-ui,sans-serif;margin:12px;background:#1b1d22;color:#e8e8e8}
    label{margin-right:10px;font-size:13px} input,select,button{font-size:13px;margin-left:4px}
    #grid{display:grid;grid-template-columns:repeat(13,34px);gap:1px;margin:10px 0}
    .c{width:34px;height:34px;font-size:9px;color:#fff;display:flex;align-items:flex-start;text-shadow:0 0 2px #000;box-sizing:border-box;padding:1px}
    .legend span{display:inline-block;margin-right:12px;font-size:12px} .legend i{display:inline-block;width:10px;height:10px;margin-right:4px}
    button.a{margin:2px 6px 2px 0;padding:4px 10px}
  </style>
  <h3 id="title">${tr('title')}</h3>
  <div><label>${tr('language')}<select id="lang">${(Object.keys(locales) as Lang[]).map((l) => `<option value="${l}" ${l === lang ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
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
  $<HTMLSelectElement>('lang').onchange = (e) => { lang = (e.target as HTMLSelectElement).value as Lang; document.documentElement.lang = lang; readForm(); render(); };
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
  err = ''; view = null; path = []; facing = [false]; expl = null; iters = 0; solving = true;
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
    html += `<div class="c" data-hand="${name}" title="${title}" style="background:${bg}">${name}</div>`;
  }
  grid.innerHTML = html;
}

document.documentElement.lang = lang;
render();
