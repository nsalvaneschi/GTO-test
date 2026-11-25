// Preflop 3-max trainer screen (T3). Strategies come ONLY from loaded solution packs; the answer is chosen before the solution is shown.
import { api } from '../api';
import { fmt, locales, type Key } from '../i18n';
import { cardTile, esc, icon } from '../ui';
import { loadAll, importFile, type Loaded, type UiError } from './store';
import {
  buildSpots, dealHand, describeSituation, emptyStats, explain, mulberry32, sampleSpot, scoreAnswer, sessionReducer, accuracyPct,
  type Deal, type ExplainParams, type Rng, type ScoreResult, type SessionStats, type Spot,
} from './trainer';
import type { Pack, PackNode, Position } from './types';
import {
  BUTTON_COLOR, BUTTON_KEY, SESSION_KEY, actionForKey, actionViews, badgeKind, cellBackground, fromServer, matrixCells, modeStates, parseSession,
  pickPack, resultBody, seatViews, situationOf, verdictOf, MODES, STACKS, type ActionView, type Mode, type Verdict,
} from './view';

export interface Ctx {
  tr: (k: Key, v?: Record<string, string | number>) => string;
  lang: 'en' | 'es' | 'it';
  user: string | null;
  errText: (code: string) => string;
  codeOf: (e: unknown) => string;
}
interface Hand { stack: number; pack: Pack; node: PackNode; spot: Spot; deal: Deal; views: ActionView[]; t0: number }
interface Result { actionId: string; score: ScoreResult; verdict: Verdict; expl: ExplainParams }

const seedParam = Number(new URLSearchParams(location.search).get('seed'));
const S = {
  loaded: null as Loaded | null, loading: false, mode: 'mix' as Mode, rng: mulberry32(Number.isFinite(seedParam) && seedParam > 0 ? seedParam : (Date.now() ^ (Math.random() * 2 ** 31)) >>> 0),
  hand: null as Hand | null, result: null as Result | null,
  session: (() => { try { return parseSession(sessionStorage.getItem(SESSION_KEY)); } catch { return emptyStats; } })() as SessionStats,
  scope: 'session' as 'session' | 'all', allTime: null as SessionStats | null, allUser: null as string | null,
  importOk: '', importErrors: [] as UiError[], confirm: false, saveErr: '',
};
const spotCache = new Map<Pack, Spot[]>();
let cur: { el: HTMLElement; c: Ctx } | null = null;

const saveSession = () => { try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(S.session)); } catch { /* storage unavailable */ } };

function deal(): void {
  const packs = S.loaded?.packs;
  S.hand = null; S.result = null; S.saveErr = '';
  const p = packs && pickPack(S.mode, packs, S.rng);
  if (!p) return;
  let spots = spotCache.get(p.pack);
  if (!spots) { spots = buildSpots(p.pack); spotCache.set(p.pack, spots); }
  const spot = sampleSpot(spots, S.rng);
  const node = p.pack.nodes.find((n) => n.id === spot.nodeId)!;
  S.hand = { stack: p.stack, pack: p.pack, node, spot, deal: dealHand(spot, S.rng), views: actionViews(node, p.pack), t0: Date.now() };
}

function answer(actionId: string): void {
  const h = S.hand;
  if (!h || S.result || !cur) return;
  const score = scoreAnswer(h.node, h.deal.classIdx, actionId);
  S.result = { actionId, score, verdict: verdictOf(score), expl: explain(h.node, h.pack, h.spot, h.deal.classIdx, actionId) };
  S.session = sessionReducer(S.session, score); saveSession();
  const { c } = cur;
  if (c.user) {
    const body = resultBody({ stack: h.stack, pack: h.pack, node: h.node, classIdx: h.deal.classIdx, combo: h.deal.hand, actionIdx: h.node.actions.findIndex((a) => a.id === actionId), score, ms: Date.now() - h.t0, lang: c.lang });
    api.postResult(body).then(() => { if (S.allTime) S.allTime = sessionReducer(S.allTime, score); draw(); }, (e) => { S.saveErr = c.errText(c.codeOf(e)); draw(); });
  }
  draw();
}
const next = () => { deal(); draw(); };

export function renderPreflop3(el: HTMLElement, c: Ctx): void {
  cur = { el, c };
  if (!S.loaded && !S.loading) {
    S.loading = true;
    loadAll().then((l) => { S.loaded = l; S.loading = false; if (!S.hand) deal(); draw(); }, () => { S.loaded = { packs: new Map(), errors: [] }; S.loading = false; draw(); });
  }
  if (c.user !== S.allUser) {
    S.allUser = c.user; S.allTime = null;
    if (c.user) {
      const u = c.user;
      api.preflop3Progress().then((p) => { if (S.allUser === u) { S.allTime = fromServer(p); draw(); } }, () => { /* all-time stays unavailable */ });
    }
  }
  draw();
}

function draw(): void {
  if (!cur || !cur.el.isConnected) return;
  const { el, c } = cur;
  const { tr, lang } = c;
  const pct = (x: number, d = 1) => fmt(x, lang, { style: 'percent', maximumFractionDigits: d });
  const n2 = (x: number) => fmt(x, lang, { maximumFractionDigits: 2 });
  const bb = (x: number) => tr('preflop3.unit.bb', { value: n2(x) });
  const pos = (p: Position) => tr(('preflop3.pos.' + p) as Key);
  const btnLabel = (v: ActionView) => v.check ? tr('preflop3.btn.CHECK') : tr(('preflop3.btn.' + v.button) as Key);
  const actLabel = (v: ActionView) => btnLabel(v) + (v.sizeBb !== null ? ' ' + n2(v.sizeBb) : '');
  const loaded = S.loaded;
  const h = S.hand;
  const errList = (errs: UiError[]) => {
    const shown = errs.slice(0, 20);
    return `<ul class="p3-errs">${shown.map((e) => `<li data-code="${esc(e.code)}"><code>${esc(e.path || '/')}</code> ${esc(('preflop3.err.' + e.code) in locales.en ? tr(('preflop3.err.' + e.code) as Key) : e.detail)} <small>${esc(e.code)}</small></li>`).join('')}</ul>${errs.length > shown.length ? `<p class="small">${tr('preflop3.import.more', { count: errs.length - shown.length })}</p>` : ''}`;
  };

  // --- mode bar
  const ms = loaded ? modeStates(loaded.packs) : { modes: MODES.map((m) => ({ mode: m, enabled: false })), missing: [...STACKS] };
  const modes = `<div class="p3-modes" role="group" aria-label="${tr('preflop3.mode.label')}">${ms.modes.map((m) => `<button data-mode="${m.mode}" aria-pressed="${S.mode === m.mode}" ${m.enabled ? '' : 'disabled'} class="${S.mode === m.mode ? 'on' : ''}">${tr(('preflop3.mode.' + m.mode) as Key)}</button>`).join('')}</div>`;
  const missing = loaded && ms.missing.length ? `<p id="p3-missing" class="note" data-missing="${ms.missing.join(',')}">${tr('preflop3.mode.missing', { stacks: ms.missing.map((s) => fmt(s, lang)).join(', ') })}</p>` : '';

  // --- badge + details
  let badge = '';
  if (h) {
    const m = h.pack.meta, kind = badgeKind(m.verification);
    const text = kind === 'verified' ? tr('preflop3.badge.verified', { solver: m.source.solver }) : tr(kind === 'unverified' ? 'preflop3.badge.unverified' : 'preflop3.badge.test');
    const row = (k: Key, v: string) => `<dt>${tr(k)}</dt><dd>${esc(v)}</dd>`;
    badge = `<div class="p3-badgebar"><div id="p3-badge" class="p3-badge ${kind}" data-kind="${kind}" role="status">${text}</div>
      <details class="p3-details" id="p3-details"><summary>${tr('preflop3.details')}</summary><dl>${row('preflop3.details.packId', m.packId)}${row('preflop3.details.source', `${m.source.kind}: ${m.source.solver} ${m.source.version}`)}${row('preflop3.details.verification', m.verification)}${row('preflop3.details.convergence', `${m.convergence.metric} ${m.convergence.value ?? '-'}`)}${row('preflop3.details.date', m.date)}${row('preflop3.details.notes', m.notes)}</dl></details></div>`;
  }

  // --- import messages
  const importMsg = `${S.importOk ? `<p id="p3-import-ok" class="ok">${esc(S.importOk)}</p>` : ''}${S.importErrors.length ? `<div id="p3-import-errors" class="err" data-count="${S.importErrors.length}"><b>${tr('preflop3.import.failed', { count: S.importErrors.length })}</b>${errList(S.importErrors)}</div>` : ''}`;
  const staticErrs = (loaded?.errors ?? []).map((f) => `<div class="err p3-static-err" data-file="${esc(f.file)}"><b>${tr('preflop3.import.staticRejected', { file: f.file })}</b>${errList(f.errors)}</div>`).join('');
  const importBtn = `<button id="p3-import">${tr('preflop3.import')}</button><input id="p3-file" type="file" accept=".json,application/json" hidden>`;

  // --- main body
  let body = '';
  if (!loaded) body = `<div class="loading-line"><span class="spinner" role="status"></span>${tr('preflop3.loading')}</div>`;
  else if (!h) body = `<div class="empty" id="p3-empty">${icon.inbox}<h3>${tr('preflop3.empty.title')}</h3><p>${tr('preflop3.empty.body')}</p><p class="small"><code>${tr('preflop3.empty.docs')}</code></p></div>${staticErrs}`;
  else body = handHtml(h);

  function handHtml(h: Hand): string {
    const seats = seatViews(h.node, h.pack);
    const hi = seats.findIndex((s) => s.hero);
    const order = [seats[(hi + 1) % 3], seats[(hi + 2) % 3], seats[hi]]; // clockwise from hero: left, right, hero at the bottom
    const chipText = (s: (typeof seats)[number]) => {
      const k = s.chip.kind, sz = s.chip.bb;
      if (k === 'none') return '';
      const key = k === 'allin' && sz === null ? 'preflop3.chip.allinNoSize' : (`preflop3.chip.${k}` as Key);
      return tr(key as Key, { size: sz === null ? '' : n2(sz) });
    };
    const seat = (s: (typeof seats)[number], area: string) => `<div class="p3-seat ${area}${s.hero ? ' hero' : ''}${s.folded ? ' folded' : ''}" data-pos="${s.pos}" data-hero="${s.hero ? 1 : 0}">
      <div class="p3-seat-top"><b class="p3-pos">${pos(s.pos)}</b>${s.dealer ? `<span class="p3-dealer" role="img" aria-label="${tr('preflop3.seat.dealer')}" title="${tr('preflop3.seat.dealer')}">D</span>` : ''}${s.hero ? `<span class="pill ok">${tr('preflop3.seat.you')}</span>` : ''}</div>
      <div class="p3-stack">${bb(s.stackBb)}</div>${s.chip.kind === 'none' ? '' : `<div class="p3-chip ${s.chip.kind}" data-chip="${s.chip.kind}">${chipText(s)}</div>`}</div>`;
    const sit = situationOf(h.node);
    const foldedTxt = sit.folded.length ? ', ' + tr(sit.folded.length > 1 ? 'preflop3.sit.foldedMany' : 'preflop3.sit.foldedOne', { positions: sit.folded.map(pos).join(', ') }) : '';
    const sitTxt = tr(('preflop3.sit.' + sit.key) as Key, { hero: pos(h.node.actor), villain: sit.villain ? pos(sit.villain) : '', size: sit.sizeBb === null ? '' : n2(sit.sizeBb) }) + foldedTxt;
    const table = `<div class="p3-table" role="group" aria-label="${tr('preflop3.table.aria')}" data-stack="${h.stack}" data-node="${esc(h.node.id)}" data-hero="${h.node.actor}">
      <div class="p3-felt">${seat(order[0], 'l')}${seat(order[1], 'r')}<div class="p3-pot" id="p3-pot" data-pot="${h.node.potBb}"><i class="p3-potchip" aria-hidden="true"></i>${tr('preflop3.pot', { value: n2(h.node.potBb) })}</div>${seat(order[2], 'b')}</div></div>`;
    const cards = `<div class="p3-hero-cards" id="p3-cards" data-hand="${h.deal.hand}" data-class="${h.pack.classes[h.deal.classIdx]}" role="group" aria-label="${tr('preflop3.hand.aria', { cards: h.deal.cards.join(' ') })}">${h.deal.cards.map((x) => cardTile(x, 'lg')).join('')}</div>`;
    let action: string;
    if (!S.result) {
      action = `<p class="muted small p3-prompt">${tr('preflop3.prompt')}</p><div class="p3-dock"><div class="p3-acts" id="p3-acts" data-n="${h.views.length}">${h.views.map((v) => {
        const k = BUTTON_KEY[v.button], label = btnLabel(v);
        return `<button class="p3-act" data-action="${esc(v.actionId)}" data-btn="${v.button}" style="--c:${BUTTON_COLOR[v.button]}" aria-label="${esc(tr('preflop3.btn.aria', { label: actLabel(v), key: k }))}"><span class="lbl">${label}</span>${v.sizeBb !== null ? `<span class="sz">${n2(v.sizeBb)}</span>` : ''}<kbd aria-hidden="true">${k}</kbd></button>`;
      }).join('')}</div></div>`;
    } else action = resultHtml(h, S.result);
    return `${badge}${table}<div class="p3-situation"><p id="p3-situation" class="p3-sit">${esc(sitTxt)}</p>${cards}</div>${action}`;
  }

  function resultHtml(h: Hand, r: Result): string {
    const byId = new Map(h.views.map((v) => [v.actionId, v]));
    const label = (id: string) => actLabel(byId.get(id)!);
    const x = r.expl;
    const cls = r.verdict === 'correct' ? 'right' : r.verdict === 'close' ? 'close' : 'wrong';
    const detail = tr('preflop3.verdict.detail', { action: label(r.actionId), freq: pct(x.chosenFreq), hand: x.handClass })
      + (r.verdict === 'close' && x.evLoss !== null ? ' ' + tr('preflop3.verdict.closeNote', { ev: n2(x.evLoss) }) : '');
    const banner = `<div id="p3-verdict" class="verdict ${cls}" data-verdict="${r.verdict}" data-freq="${x.chosenFreq}" data-action="${esc(r.actionId)}" role="status">${r.verdict === 'correct' ? icon.check : icon.cross}<div class="grow"><b>${tr(('preflop3.verdict.' + r.verdict) as Key)}</b><div class="small">${esc(detail)}</div></div></div>${S.saveErr ? `<div class="err" id="p3-save-err">${tr('preflop3.saveErr')} ${esc(S.saveErr)}</div>` : ''}`;
    const colorOf = (id: string) => BUTTON_COLOR[byId.get(id)!.button];
    const bars = `<div class="panel"><div class="panel-title">${tr('preflop3.bars.title', { hand: x.handClass })}</div><div class="freqs" id="p3-bars" role="list" aria-label="${tr('preflop3.bars.aria')}">${x.freqs.map((f) => `<div class="fq${f.actionId === r.actionId ? ' chosen' : ''}" role="listitem" data-action="${esc(f.actionId)}" data-freq="${f.freq}" style="--c:${colorOf(f.actionId)}"><span>${esc(label(f.actionId))}</span><span class="bar"><i style="width:${f.freq * 100}%"></i></span><span class="v">${pct(f.freq)}</span></div>`).join('')}</div></div>`;
    const best = byId.get(x.bestActionId)!;
    const lines = [
      tr('preflop3.expl.chosen', { hand: x.handClass, hero: pos(x.hero), action: label(r.actionId), freq: pct(x.chosenFreq) }),
      tr('preflop3.expl.best', { action: actLabel(best), freq: pct(x.bestFreq) }),
      ...(x.evLoss !== null ? [tr('preflop3.expl.ev', { ev: n2(x.evLoss) })] : []),
      x.toCallBb > 0 ? tr('preflop3.expl.pot', { pot: n2(x.potBb), call: n2(x.toCallBb), odds: pct(x.potOdds), spr: fmt(x.spr, lang, { maximumFractionDigits: 1 }) })
        : tr('preflop3.expl.potFree', { pot: n2(x.potBb), spr: fmt(x.spr, lang, { maximumFractionDigits: 1 }) }),
      tr('preflop3.expl.rank', { share: pct(x.chosenRangeRank, 0), action: label(r.actionId), hand: x.handClass }),
    ];
    const expl = `<div class="panel"><div class="panel-title">${tr('preflop3.expl.title')}</div><ul id="p3-expl" class="p3-expl">${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></div>`;
    const colors = h.node.actions.map((a) => colorOf(a.id));
    const cells = matrixCells(h.node, x.handClass);
    const legend = h.node.actions.map((a) => `<span class="lg" style="--c:${colorOf(a.id)}"><i></i>${esc(label(a.id))}</span>`).join('');
    const grid = cells.map((cl) => `<div class="c${cl.mix ? '' : ' nr'}${cl.me ? ' me' : ''}" data-hand="${cl.name}"${cl.me ? ' aria-current="true"' : ''}${cl.mix ? ` style="background:${cellBackground(cl.mix, colors)}"` : ''}>${cl.name}</div>`).join('');
    const matrix = `<div class="panel"><div class="panel-title">${tr('preflop3.matrix.title')}</div><div class="legend">${legend}</div><div class="gridwrap"><div id="p3-grid" class="mgrid" role="group" aria-label="${tr('preflop3.matrix.aria')}">${grid}</div></div><div class="grid-hint">${tr('preflop3.matrix.hint')}</div></div>`;
    const dock = `<div class="p3-dock"><button id="p3-next" class="primary">${tr('preflop3.next')} <kbd aria-hidden="true">&#x23CE;</kbd></button></div>`;
    return `${banner}${dock}<div class="p3-after">${bars}${expl}${matrix}</div>`;
  }

  // --- scoreboard (fixed bar)
  const scope = S.scope === 'all' && c.user && S.allTime ? 'all' : 'session';
  const st = scope === 'all' ? S.allTime! : S.session;
  const acc = fmt(accuracyPct(st) / 100, lang, { style: 'percent', maximumFractionDigits: 0 });
  const stat = (id: string, k: Key, v: string, raw: number) => `<div class="p3-stat"><span class="l">${tr(k)}</span><b id="${id}" data-v="${raw}">${v}</b></div>`;
  const score = `<div class="p3-score" id="p3-score" role="region" aria-label="${tr('preflop3.score.aria')}" data-scope="${scope}">
    <div class="p3-stats">${stat('p3-correct', 'preflop3.score.correct', fmt(st.correct, lang), st.correct)}${stat('p3-incorrect', 'preflop3.score.incorrect', fmt(st.incorrect, lang), st.incorrect)}${stat('p3-total', 'preflop3.score.total', fmt(st.total, lang), st.total)}${stat('p3-acc', 'preflop3.score.accuracy', acc, Math.round(accuracyPct(st) * 10) / 10)}</div>
    <div class="p3-scope" role="group" aria-label="${tr('preflop3.score.scope')}"><button data-scope="session" aria-pressed="${scope === 'session'}">${tr('preflop3.score.session')}</button><button data-scope="all" aria-pressed="${scope === 'all'}" ${c.user && S.allTime ? '' : 'disabled'} ${c.user ? '' : `title="${tr('preflop3.score.loginForAllTime')}"`}>${tr('preflop3.score.allTime')}</button><button id="p3-reset" class="ghost">${tr('preflop3.score.reset')}</button></div>${c.user ? '' : `<span class="p3-login small muted">${tr('preflop3.score.loginForAllTime')}</span>`}</div>`;
  const confirm = S.confirm ? `<div class="modal-back" id="p3-confirm-back" tabindex="-1"><div class="modal" id="p3-confirm" role="alertdialog" aria-modal="true" aria-labelledby="p3-confirm-text"><p id="p3-confirm-text">${tr('preflop3.score.resetConfirm')}</p><div class="row"><button id="p3-confirm-no">${tr('preflop3.score.cancel')}</button><button id="p3-confirm-yes" class="danger">${tr('preflop3.score.resetYes')}</button></div></div></div>` : '';

  el.innerHTML = `<div class="p3" id="p3-root"><div class="p3-top">${modes}${importBtn}</div>${missing}${importMsg}${body}</div>${score}${confirm}`;

  // On phones the nav is a fixed bottom bar whose height depends on label wrapping: keep the score bar right above it.
  const navEl = document.querySelector<HTMLElement>('.side'), bar = document.getElementById('p3-score')!;
  const navH = navEl && getComputedStyle(navEl).position === 'fixed' ? navEl.getBoundingClientRect().height : 0;
  bar.style.bottom = navH ? `${navH}px` : '';
  // Phones: the action row is docked right above the score bar; reserve room so nothing hides behind the fixed bars.
  const dockEl = el.querySelector<HTMLElement>('.p3-dock'), root = document.getElementById('p3-root')!;
  const docked = !!dockEl && getComputedStyle(dockEl).position === 'fixed';
  if (dockEl) dockEl.style.bottom = docked ? `${navH + bar.getBoundingClientRect().height}px` : '';
  root.style.paddingBottom = navH ? `${navH + bar.getBoundingClientRect().height + (docked ? dockEl!.getBoundingClientRect().height : 0) + 12}px` : '';

  // --- wiring
  el.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => b.onclick = () => { S.mode = b.dataset.mode as Mode; next(); });
  el.querySelectorAll<HTMLButtonElement>('.p3-act').forEach((b) => b.onclick = () => answer(b.dataset.action!));
  const nx = document.getElementById('p3-next'); if (nx) { nx.onclick = next; if (!document.activeElement || document.activeElement === document.body) nx.focus({ preventScroll: true }); }
  el.querySelectorAll<HTMLButtonElement>('.p3-scope button[data-scope]').forEach((b) => b.onclick = () => { S.scope = b.dataset.scope as 'session' | 'all'; draw(); });
  document.getElementById('p3-reset')!.onclick = () => { S.confirm = true; draw(); document.getElementById('p3-confirm-no')?.focus(); };
  const closeConfirm = () => { S.confirm = false; draw(); };
  if (S.confirm) {
    document.getElementById('p3-confirm-no')!.onclick = closeConfirm;
    document.getElementById('p3-confirm-yes')!.onclick = () => { S.session = emptyStats; saveSession(); closeConfirm(); };
  }
  const file = document.getElementById('p3-file') as HTMLInputElement;
  document.getElementById('p3-import')!.onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files?.[0]; if (!f) return;
    const r = await importFile(f);
    S.importOk = ''; S.importErrors = [];
    if (r.ok) {
      S.loaded ??= { packs: new Map(), errors: [] };
      S.loaded.packs.set(r.stack, r.pack); S.importOk = tr('preflop3.import.ok', { packId: r.pack.meta.packId, stack: r.stack });
      if (!S.hand) deal();
    } else S.importErrors = r.errors;
    draw();
  };
}

// One document-level handler (shortcuts F C R 3 A, Enter = next hand); inert unless the trainer is on screen.
document.addEventListener('keydown', (e) => {
  if (!document.getElementById('p3-root') || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target as HTMLElement;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
  if (S.confirm) { if (e.key === 'Escape') { S.confirm = false; draw(); } return; }
  if (e.key === 'Enter') {
    if (S.result && (t.tagName !== 'BUTTON' || t.id === 'p3-next')) { e.preventDefault(); next(); }
    return;
  }
  if (S.hand && !S.result && e.key.length === 1) {
    const v = actionForKey(S.hand.views, e.key);
    if (v) { e.preventDefault(); answer(v.actionId); }
  }
});

window.addEventListener('resize', () => { if (document.getElementById('p3-root')) draw(); });
