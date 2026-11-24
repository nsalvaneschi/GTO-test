// Hands list (filters, paging, delete controls) and per-hand replay for hand-history analysis (milestone H4).
import { api, type HhFilters, type HhHandFull, type HhHandRow } from '../api';
import { fmt, locales, type Key } from '../i18n';
import { cardTile, icon } from '../ui';
import { lineOf } from './analyze';
import { NARROW } from './ranges';
import { decisionAt, labelKey, replayAt, STREETS } from './replay';
import type { Ctx } from './screen';
import type { Hand } from './types';

type Tab = 'import' | 'hands';
const P = {
  tab: 'import' as Tab, filters: { site: '', from: '', to: '', status: '', street: '', minEvLoss: '' } as HhFilters, offset: 0,
  list: null as { total: number; hands: HhHandRow[] } | null, loading: false, err: '',
  replay: null as { hand: HhHandFull; step: number } | null, confirm: '' as '' | 'hands' | 'all', msg: '', opener: '',
};
const PAGE = 20;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const cardSpan = (c: string) => cardTile(c, 'sm');

export const currentTab = () => P.tab;
export function tabsHtml(c: Ctx) {
  return `<nav id="hh-tabs" class="tabs">${(['import', 'hands'] as const).map((t) => `<button data-hhtab="${t}" class="${P.tab === t ? 'on' : ''}" aria-pressed="${P.tab === t}">${c.tr(('hh.tab.' + t) as Key)}</button>`).join('')}</nav>`;
}
export function bindTabs(el: HTMLElement, rerender: () => void) {
  el.querySelectorAll<HTMLButtonElement>('[data-hhtab]').forEach((b) => { b.onclick = () => { P.tab = b.dataset.hhtab as Tab; if (P.tab === 'hands') { P.list = null; P.replay = null; } rerender(); }; });
}
/** Drop cached list data (after an upload) so the next visit reloads. */
export const invalidate = () => { P.list = null; P.replay = null; };

export function renderHands(el: HTMLElement, c: Ctx, toImport: () => void) {
  const { tr, lang } = c;
  const rerender = () => renderHands(el, c, toImport);
  const head = `<h4>${tr('hh.title')}</h4><div id="hh-disclaimer" class="note">${tr('hh.disclaimer')}</div>${tabsHtml(c)}`;
  const done = () => bindTabs(el, () => { if (P.tab === 'import') toImport(); else rerender(); });
  if (!c.user) { el.innerHTML = `${head}<div class="empty">${icon.inbox}<p id="hh-list-login">${tr('hh.list.needLogin')}</p></div>`; done(); return; }
  if (P.replay) { renderReplay(el, c, head, done, rerender); return; }
  if (!P.list && !P.loading) {
    P.loading = true;
    api.hhFiltered(P.filters, PAGE, P.offset).then((r) => { P.list = r; P.err = ''; }, (e) => { P.err = c.errText(c.codeOf(e)); P.list = { total: 0, hands: [] }; })
      .then(() => { P.loading = false; rerender(); });
  }
  const f = P.filters, L = P.list;
  const sel = (id: keyof HhFilters, opts: [string, string][]) => `<label>${tr(('hh.filter.' + (id === 'minEvLoss' ? 'minEv' : id)) as Key)}<select id="f-${id}">${opts.map(([v, t]) => `<option value="${v}" ${f[id] === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>`;
  const any: [string, string] = ['', tr('hh.filter.any')];
  const dt = new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
  const rows = (L?.hands ?? []).map((h) => `<article class="hand-card" data-id="${h.id}" data-hand="${esc(h.handId)}"><div class="top"><span class="id" title="${esc(h.handId)}">${esc(h.handId)}</span><span class="pill">${tr(('hh.site.' + h.site) as Key)}</span></div>
    <div class="row muted small"><span>${dt.format(new Date(h.playedAt * 1000))}</span>${h.heroPos ? `<span class="pill ok">${esc(h.heroPos)}</span>` : ''}</div><button data-open="${h.id}">${tr('hh.list.open')}</button></article>`).join('');
  const total = L?.total ?? 0;
  const conf = P.confirm ? `<div class="modal-back" id="hh-confirm-back" tabindex="-1"><div id="hh-confirm" class="modal" role="alertdialog" aria-modal="true" aria-labelledby="hh-confirm-text" data-kind="${P.confirm}"><p id="hh-confirm-text">${tr(P.confirm === 'hands' ? 'hh.data.confirmHands' : 'hh.data.confirmAll')}</p>
    <div class="row"><button id="hh-confirm-no">${tr('hh.cancel')}</button><button id="hh-confirm-yes" class="danger">${tr('hh.data.confirm')}</button></div></div></div>` : '';
  el.innerHTML = `${head}
    <div id="hh-filters" class="panel toolbar">
      ${sel('site', [any, ['pokerstars', tr('hh.site.pokerstars')], ['ggpoker', tr('hh.site.ggpoker')]])}
      <label>${tr('hh.filter.from')}<input id="f-from" type="date" value="${esc(f.from ?? '')}"></label>
      <label>${tr('hh.filter.to')}<input id="f-to" type="date" value="${esc(f.to ?? '')}"></label>
      ${sel('status', [any, ['ok', tr('hh.status.ok')], ['unsupported', tr('hh.status.unsupported')], ['off_tree', tr('hh.status.off_tree')], ['approx_only', tr('hh.status.approx_only')]])}
      ${sel('street', [any, ...(['turn', 'river', 'flop', 'preflop'] as const).map((s) => [s, tr(('street.' + s) as Key)] as [string, string])])}
      <label>${tr('hh.filter.minEv')}<input id="f-minEvLoss" type="number" min="0" step="1" value="${esc(f.minEvLoss ?? '')}"></label>
      <button id="f-apply" class="primary">${tr('hh.filter.apply')}</button></div>
    <div id="hh-list-count" class="muted small" style="margin-top:var(--s-3)" data-total="${total}">${tr('hh.list.count', { count: total })}${total > PAGE ? ` · ${fmt(P.offset + 1, lang)}-${fmt(Math.min(total, P.offset + PAGE), lang)}` : ''}</div>
    <div class="err" id="hh-list-err">${esc(P.err)}</div>
    ${rows ? `<div id="hh-list" class="hand-cards">${rows}</div>` : L ? `<div class="empty">${icon.inbox}<p id="hh-list-empty">${tr('hh.list.empty')}</p></div>` : `<div class="loading-line"><span class="spinner" role="status"></span></div>`}
    <div class="row"><button id="hh-prev" ${P.offset > 0 ? '' : 'disabled'}>${tr('hh.list.prev')}</button><button id="hh-next" ${P.offset + PAGE < total ? '' : 'disabled'}>${tr('hh.list.next')}</button></div>
    <h4>${tr('hh.data.title')}</h4>
    <div class="row"><button id="hh-del-hands" class="danger">${tr('hh.data.delHands')}</button><button id="hh-del-all" class="danger">${tr('hh.data.delAll')}</button></div>${conf}
    <div id="hh-data-msg" class="ok">${esc(P.msg)}</div>`;
  done();
  const get = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
  document.getElementById('f-apply')!.onclick = () => {
    P.filters = { site: get('f-site'), from: get('f-from'), to: get('f-to'), status: get('f-status'), street: get('f-street'), minEvLoss: get('f-minEvLoss') };
    P.offset = 0; P.list = null; P.msg = ''; rerender();
  };
  document.getElementById('hh-prev')!.onclick = () => { P.offset = Math.max(0, P.offset - PAGE); P.list = null; rerender(); };
  document.getElementById('hh-next')!.onclick = () => { P.offset += PAGE; P.list = null; rerender(); };
  el.querySelectorAll<HTMLButtonElement>('[data-open]').forEach((b) => { b.onclick = async () => {
    try { P.replay = { hand: await api.hhGet(+b.dataset.open!), step: 0 }; P.err = ''; } catch (e) { P.err = c.errText(c.codeOf(e)); }
    rerender();
  }; });
  document.getElementById('hh-del-hands')!.onclick = () => { P.confirm = 'hands'; P.opener = 'hh-del-hands'; P.msg = ''; rerender(); };
  document.getElementById('hh-del-all')!.onclick = () => { P.confirm = 'all'; P.opener = 'hh-del-all'; P.msg = ''; rerender(); };
  const no = document.getElementById('hh-confirm-no');
  const yes = document.getElementById('hh-confirm-yes');
  const restore = () => document.getElementById(P.opener)?.focus(); // return focus to the button that opened the dialog
  const close = () => { P.confirm = ''; rerender(); restore(); };
  no?.focus();
  if (no) no.onclick = close;
  // Escape closes; Tab / Shift+Tab cycle inside the dialog (focus trap).
  document.getElementById('hh-confirm-back')?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab' || !no || !yes) return;
    const first = no, last = yes;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    else if (!(document.activeElement === first || document.activeElement === last)) { e.preventDefault(); first.focus(); }
  });
  if (yes) yes.onclick = async () => {
    try {
      const r = P.confirm === 'all' ? await api.deleteMyData() : await api.hhDeleteAll();
      P.msg = tr('hh.data.done', { hands: r.hands, decisions: r.decisions }); P.err = '';
    } catch (e) { P.err = c.errText(c.codeOf(e)); }
    P.confirm = ''; P.list = null; rerender(); restore();
  };
}

function renderReplay(el: HTMLElement, c: Ctx, head: string, done: () => void, rerender: () => void) {
  const { tr, lang } = c;
  const R = P.replay!, full = R.hand, h = full.hand, N = h.actions.length;
  const st = replayAt(h, R.step);
  const bb = (x: number) => tr('hh.replay.bb', { value: fmt(x, lang, { maximumFractionDigits: 2 }) });
  const pct = (x: number, d = 0) => fmt(x, lang, { style: 'percent', minimumFractionDigits: d, maximumFractionDigits: d });
  const heroSeat = h.seats.find((s) => s.is_hero)?.seat ?? -1;
  const who = (seat: number) => (seat === heroSeat ? tr('hh.replay.hero', { pos: full.heroPos ?? '-' }) : tr('hh.replay.seat', { n: seat }));
  const actText = (a: { kind: string; amount_to: number | null }) => tr(('hh.act.' + a.kind) as Key, { amount: a.amount_to === null ? '' : bb(a.amount_to) }).trim();
  const shown = h.actions.slice(0, R.step);
  const lines = STREETS.filter((s) => shown.some((a) => a.street === s) || s === st.street).map((s) => `<li><b>${tr(('street.' + s) as Key)}</b><ul>${
    shown.map((a, i) => ({ a, i })).filter((x) => x.a.street === s).map(({ a, i }) => `<li data-i="${i}" data-seat="${a.seat}" data-kind="${a.kind}" ${a.seat === heroSeat ? 'style="font-weight:600"' : ''}>${who(a.seat)} ${actText(a)}</li>`).join('')}</ul></li>`).join('');
  const stacks = Object.entries(st.stacks).map(([s, v]) => `<tr data-seat="${s}"${+s === heroSeat ? ' class="hero-row"' : ''}><td>${who(+s)}</td><td>${bb(v)}</td><td>${st.inStreet[+s] ? bb(st.inStreet[+s]) : '-'}</td></tr>`).join('');
  const lastIdx = R.step - 1;
  const dec = lastIdx >= 0 && h.actions[lastIdx].seat === heroSeat ? decisionAt(full.decisions, lastIdx) : null;
  let panel = '';
  if (lastIdx >= 0 && h.actions[lastIdx].seat === heroSeat) {
    if (!dec) panel = `<div id="hh-decision" class="panel" data-status="none">${tr('hh.replay.noDecision')}</div>`;
    else {
      const d = dec.row, hasEv = d.evLoss !== null && d.solverFreqs;
      const reason = d.reason ? ` (${('hh.reason.' + d.reason) in locales.en ? tr(('hh.reason.' + d.reason) as Key) : d.reason})` : '';
      const hand = h as unknown as Hand;
      const villain = h.seats.find((s) => s.seat !== heroSeat && h.actions.some((a) => a.seat === s.seat && a.street === h.actions[lastIdx].street))?.seat ?? -1;
      const earlier = h.actions[lastIdx].street === 'turn' ? (['flop'] as const) : (['flop', 'turn'] as const);
      const hn = NARROW[lineOf(hand, heroSeat, [...earlier])], vn = NARROW[lineOf(hand, villain, [...earlier])];
      const assume = tr('hh.replay.assume', { preset: d.rangePreset, heroTop: pct(hn.top), heroBluff: pct(hn.bluff), vilTop: pct(vn.top), vilBluff: pct(vn.bluff) });
      const rows = hasEv ? dec.labels.map((tok, i) => { const k = labelKey(tok); return `<tr data-label="${tok}" data-chosen="${i === d.actionIdx}" ${i === d.actionIdx ? 'style="font-weight:600;color:var(--accent)"' : ''}><td>${tr(k.key, k.pct !== null ? { size: pct(k.pct) } : undefined)}${i === d.actionIdx ? ' ◀' : ''}</td><td class="bar" style="--c:var(--accent)"><span style="width:${d.solverFreqs![i] * 100}%"></span></td><td>${pct(d.solverFreqs![i])}</td></tr>`; }).join('') : '';
      panel = `<div id="hh-decision" class="panel" data-status="${d.status}" data-reason="${d.reason ?? ''}" data-evloss="${hasEv ? d.evLoss : ''}" data-preset="${esc(d.rangePreset)}">
        <div class="panel-title">${tr('hh.replay.decision')}</div>
        <div class="row between"><span class="pill ${d.status === 'ok' ? 'ok' : d.status === 'unsupported' ? '' : 'warn'}">${tr(('hh.status.' + d.status) as Key)}</span><span class="small muted">${reason}</span></div>
        <div class="kv"><span>${tr('hh.replay.yourAction')}</span><span>${actText(h.actions[lastIdx])}</span></div>
        ${hasEv ? `<div class="kv"><span>${tr('hh.col.evLoss')}</span><span><span id="hh-ev">${tr('unit.ofPot', { value: pct(d.evLoss! / 100, 2) })}</span> <span class="badge-approx">${tr('hh.badge.approx')}</span></span></div>
        <div class="panel-title" style="margin-top:var(--s-3)">${tr('hh.replay.freqs')}</div><table id="hh-freqs" class="freqtab">${rows}</table>` : ''}
        <div id="hh-assume" class="small muted" style="margin-top:var(--s-3)">${assume}</div></div>`;
    }
  }
  const hist = `${esc(h.hand_id)} · ${tr(('hh.site.' + h.site) as Key)}`;
  const curSi = STREETS.indexOf(st.street as (typeof STREETS)[number]);
  const timeline = STREETS.filter((s) => s === 'preflop' || h.actions.some((a) => a.street === s)).map((s) => {
    const si = STREETS.indexOf(s);
    const dots = h.actions.map((a, i) => ({ a, i })).filter((x) => x.a.street === s).map(({ a, i }) => { const lbl = esc(`${who(a.seat)} ${actText(a)}`); return `<button data-goto="${i + 1}" class="${a.seat === heroSeat ? 'hero' : ''} ${i < R.step ? 'shown' : ''}" title="${lbl}" aria-label="${lbl}"></button>`; }).join('');
    return `<li data-street="${s}" class="${si < curSi ? 'done' : si === curSi ? 'cur' : ''}" ${si === curSi ? 'aria-current="step"' : ''}>${tr(('street.' + s) as Key)}<div class="dots">${dots}</div></li>`;
  }).join('');
  el.innerHTML = `${head}
    <div class="row between"><h4 style="margin:0">${tr('hh.replay.title')}: <span id="hh-replay-id">${hist}</span></h4><button id="rp-back">${tr('hh.replay.back')}</button></div>
    <ol class="timeline">${timeline}</ol>
    <div class="workspace"><div class="stack">
    <div class="panel felt"><div class="board-row"><div><div class="panel-title">${tr('hh.replay.cards')}</div><span id="rp-cards" class="cards">${(h.hero_cards ?? []).map(cardSpan).join('') || '-'}</span></div>
      <div><div class="panel-title">${tr('street.' + st.street as Key)} · ${tr('hh.replay.board')}</div><span id="rp-board" class="cards" data-n="${st.board.length}">${st.board.map(cardSpan).join('') || '-'}</span></div>
      <div><div class="panel-title">${tr('hh.replay.pot')}</div><span class="big" id="rp-pot" data-value="${st.potStart}">${bb(st.potStart)}</span></div></div>
    <div class="tbl-wrap" style="margin-top:var(--s-3)"><table id="rp-stacks"><tr><th></th><th>${tr('hh.replay.stacks')}</th><th>${tr('hh.replay.inStreet')}</th></tr>${stacks}</table></div></div>
    <div class="panel"><div class="row" style="margin-bottom:var(--s-3)"><button id="rp-prev" ${R.step > 0 ? '' : 'disabled'}>${tr('hh.replay.prev')}</button><button id="rp-next" ${R.step < N ? '' : 'disabled'}>${tr('hh.replay.next')}</button><button id="rp-nextdec" class="primary">${tr('hh.replay.nextDecision')}</button>
      <span id="rp-step" class="pill" data-step="${R.step}" data-total="${N}">${R.step === 0 ? tr('hh.replay.start') : `${R.step}/${N}`}</span></div>
    <ul id="rp-actions" class="log">${lines}</ul></div></div>
    <aside class="side-panel">${panel}</aside></div>`;
  el.querySelectorAll<HTMLButtonElement>('[data-goto]').forEach((b) => { b.onclick = () => { R.step = +b.dataset.goto!; rerender(); }; });
  done();
  document.getElementById('rp-back')!.onclick = () => { P.replay = null; rerender(); };
  document.getElementById('rp-prev')!.onclick = () => { R.step = Math.max(0, R.step - 1); rerender(); };
  document.getElementById('rp-next')!.onclick = () => { R.step = Math.min(N, R.step + 1); rerender(); };
  document.getElementById('rp-nextdec')!.onclick = () => {
    const i = h.actions.findIndex((a, k) => k >= R.step && a.seat === heroSeat);
    R.step = i < 0 ? N : i + 1; rerender();
  };
}
