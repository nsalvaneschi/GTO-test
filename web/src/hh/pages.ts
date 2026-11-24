// Hands list (filters, paging, delete controls) and per-hand replay for hand-history analysis (milestone H4).
import { api, type HhFilters, type HhHandFull, type HhHandRow } from '../api';
import { fmt, locales, type Key } from '../i18n';
import { lineOf } from './analyze';
import { NARROW } from './ranges';
import { decisionAt, labelKey, replayAt, STREETS } from './replay';
import type { Ctx } from './screen';
import type { Hand } from './types';

type Tab = 'import' | 'hands';
const P = {
  tab: 'import' as Tab, filters: { site: '', from: '', to: '', status: '', street: '', minEvLoss: '' } as HhFilters, offset: 0,
  list: null as { total: number; hands: HhHandRow[] } | null, loading: false, err: '',
  replay: null as { hand: HhHandFull; step: number } | null, confirm: '' as '' | 'hands' | 'all', msg: '',
};
const PAGE = 20;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const SUIT = { c: '♣', d: '♦', h: '♥', s: '♠' } as Record<string, string>;
const cardSpan = (c: string) => `<span class="card ${({ c: 'ss2', d: 'sd', h: 'sh', s: 'sc' } as Record<string, string>)[c[1]]}" data-card="${c}" style="font-size:16px;padding:2px 4px">${c[0]}${SUIT[c[1]]}</span>`;

export const currentTab = () => P.tab;
export function tabsHtml(c: Ctx) {
  return `<nav id="hh-tabs">${(['import', 'hands'] as const).map((t) => `<button data-hhtab="${t}" class="${P.tab === t ? 'on' : ''}">${c.tr(('hh.tab.' + t) as Key)}</button>`).join('')}</nav>`;
}
export function bindTabs(el: HTMLElement, rerender: () => void) {
  el.querySelectorAll<HTMLButtonElement>('[data-hhtab]').forEach((b) => { b.onclick = () => { P.tab = b.dataset.hhtab as Tab; if (P.tab === 'hands') { P.list = null; P.replay = null; } rerender(); }; });
}
/** Drop cached list data (after an upload) so the next visit reloads. */
export const invalidate = () => { P.list = null; P.replay = null; };

export function renderHands(el: HTMLElement, c: Ctx, toImport: () => void) {
  const { tr, lang } = c;
  const rerender = () => renderHands(el, c, toImport);
  const head = `<h4>${tr('hh.title')}</h4><div id="hh-disclaimer" style="border:1px solid #f0ad4e;padding:6px 10px;margin:6px 0;max-width:640px">${tr('hh.disclaimer')}</div>${tabsHtml(c)}`;
  const done = () => bindTabs(el, () => { if (P.tab === 'import') toImport(); else rerender(); });
  if (!c.user) { el.innerHTML = `${head}<p id="hh-list-login">${tr('hh.list.needLogin')}</p>`; done(); return; }
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
  const rows = (L?.hands ?? []).map((h) => `<tr data-id="${h.id}" data-hand="${esc(h.handId)}"><td>${esc(h.handId)}</td><td>${tr(('hh.site.' + h.site) as Key)}</td><td>${dt.format(new Date(h.playedAt * 1000))}</td><td>${h.heroPos ? esc(h.heroPos) : '-'}</td><td><button class="a" data-open="${h.id}">${tr('hh.list.open')}</button></td></tr>`).join('');
  const total = L?.total ?? 0;
  const conf = P.confirm ? `<div id="hh-confirm" data-kind="${P.confirm}" style="border:1px solid #f66;padding:6px 10px;margin:6px 0;max-width:520px">${tr(P.confirm === 'hands' ? 'hh.data.confirmHands' : 'hh.data.confirmAll')}<br>
    <button id="hh-confirm-yes" class="a">${tr('hh.data.confirm')}</button><button id="hh-confirm-no" class="a">${tr('hh.cancel')}</button></div>` : '';
  el.innerHTML = `${head}
    <div id="hh-filters" style="margin:8px 0">
      ${sel('site', [any, ['pokerstars', tr('hh.site.pokerstars')], ['ggpoker', tr('hh.site.ggpoker')]])}
      <label>${tr('hh.filter.from')}<input id="f-from" type="date" value="${esc(f.from ?? '')}"></label>
      <label>${tr('hh.filter.to')}<input id="f-to" type="date" value="${esc(f.to ?? '')}"></label>
      ${sel('status', [any, ['ok', tr('hh.status.ok')], ['unsupported', tr('hh.status.unsupported')], ['off_tree', tr('hh.status.off_tree')], ['approx_only', tr('hh.status.approx_only')]])}
      ${sel('street', [any, ...(['turn', 'river', 'flop', 'preflop'] as const).map((s) => [s, tr(('street.' + s) as Key)] as [string, string])])}
      <label>${tr('hh.filter.minEv')}<input id="f-minEvLoss" type="number" min="0" step="1" style="width:60px" value="${esc(f.minEvLoss ?? '')}"></label>
      <button id="f-apply" class="a">${tr('hh.filter.apply')}</button></div>
    <div id="hh-list-count" data-total="${total}">${tr('hh.list.count', { count: total })}${total > PAGE ? ` · ${fmt(P.offset + 1, lang)}-${fmt(Math.min(total, P.offset + PAGE), lang)}` : ''}</div>
    <div class="err" id="hh-list-err">${esc(P.err)}</div>
    ${rows ? `<table id="hh-list"><tr><th>${tr('hh.col.hand')}</th><th>${tr('hh.col.site')}</th><th>${tr('hh.col.date')}</th><th>${tr('hh.col.pos')}</th><th></th></tr>${rows}</table>` : L ? `<p id="hh-list-empty">${tr('hh.list.empty')}</p>` : ''}
    <div style="margin:6px 0"><button id="hh-prev" class="a" ${P.offset > 0 ? '' : 'disabled'}>${tr('hh.list.prev')}</button><button id="hh-next" class="a" ${P.offset + PAGE < total ? '' : 'disabled'}>${tr('hh.list.next')}</button></div>
    <h4>${tr('hh.data.title')}</h4>
    <button id="hh-del-hands" class="a">${tr('hh.data.delHands')}</button><button id="hh-del-all" class="a">${tr('hh.data.delAll')}</button>${conf}
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
  document.getElementById('hh-del-hands')!.onclick = () => { P.confirm = 'hands'; P.msg = ''; rerender(); };
  document.getElementById('hh-del-all')!.onclick = () => { P.confirm = 'all'; P.msg = ''; rerender(); };
  const no = document.getElementById('hh-confirm-no');
  if (no) no.onclick = () => { P.confirm = ''; rerender(); };
  const yes = document.getElementById('hh-confirm-yes');
  if (yes) yes.onclick = async () => {
    try {
      const r = P.confirm === 'all' ? await api.deleteMyData() : await api.hhDeleteAll();
      P.msg = tr('hh.data.done', { hands: r.hands, decisions: r.decisions }); P.err = '';
    } catch (e) { P.err = c.errText(c.codeOf(e)); }
    P.confirm = ''; P.list = null; rerender();
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
    shown.map((a, i) => ({ a, i })).filter((x) => x.a.street === s).map(({ a, i }) => `<li data-i="${i}" data-seat="${a.seat}" data-kind="${a.kind}" ${a.seat === heroSeat ? 'style="font-weight:bold"' : ''}>${who(a.seat)} ${actText(a)}</li>`).join('')}</ul></li>`).join('');
  const stacks = Object.entries(st.stacks).map(([s, v]) => `<tr data-seat="${s}"><td>${who(+s)}</td><td>${bb(v)}</td><td>${st.inStreet[+s] ? bb(st.inStreet[+s]) : '-'}</td></tr>`).join('');
  const lastIdx = R.step - 1;
  const dec = lastIdx >= 0 && h.actions[lastIdx].seat === heroSeat ? decisionAt(full.decisions, lastIdx) : null;
  let panel = '';
  if (lastIdx >= 0 && h.actions[lastIdx].seat === heroSeat) {
    if (!dec) panel = `<div id="hh-decision" data-status="none">${tr('hh.replay.noDecision')}</div>`;
    else {
      const d = dec.row, hasEv = d.evLoss !== null && d.solverFreqs;
      const reason = d.reason ? ` (${('hh.reason.' + d.reason) in locales.en ? tr(('hh.reason.' + d.reason) as Key) : d.reason})` : '';
      const hand = h as unknown as Hand;
      const villain = h.seats.find((s) => s.seat !== heroSeat && h.actions.some((a) => a.seat === s.seat && a.street === h.actions[lastIdx].street))?.seat ?? -1;
      const earlier = h.actions[lastIdx].street === 'turn' ? (['flop'] as const) : (['flop', 'turn'] as const);
      const hn = NARROW[lineOf(hand, heroSeat, [...earlier])], vn = NARROW[lineOf(hand, villain, [...earlier])];
      const assume = tr('hh.replay.assume', { preset: d.rangePreset, heroTop: pct(hn.top), heroBluff: pct(hn.bluff), vilTop: pct(vn.top), vilBluff: pct(vn.bluff) });
      const rows = hasEv ? dec.labels.map((tok, i) => { const k = labelKey(tok); return `<tr data-label="${tok}" data-chosen="${i === d.actionIdx}" ${i === d.actionIdx ? 'style="font-weight:bold"' : ''}><td>${tr(k.key, k.pct !== null ? { size: pct(k.pct) } : undefined)}${i === d.actionIdx ? ' ◀' : ''}</td><td>${pct(d.solverFreqs![i])}</td></tr>`; }).join('') : '';
      panel = `<div id="hh-decision" data-status="${d.status}" data-reason="${d.reason ?? ''}" data-evloss="${hasEv ? d.evLoss : ''}" data-preset="${esc(d.rangePreset)}" style="border:1px solid #888;padding:6px 10px;margin:8px 0;max-width:640px">
        <b>${tr('hh.replay.decision')}</b> · ${tr(('hh.status.' + d.status) as Key)}${reason}<br>
        ${tr('hh.replay.yourAction')}: ${actText(h.actions[lastIdx])}<br>
        ${hasEv ? `${tr('hh.col.evLoss')}: <span id="hh-ev">${tr('unit.ofPot', { value: pct(d.evLoss! / 100, 2) })}</span> <span class="badge-approx" style="border:1px solid #f0ad4e;border-radius:3px;padding:0 4px;font-size:11px;color:#f0ad4e">${tr('hh.badge.approx')}</span>
        <div style="margin-top:6px"><b>${tr('hh.replay.freqs')}</b></div><table id="hh-freqs">${rows}</table>` : ''}
        <div id="hh-assume" style="font-size:12px;opacity:.8;margin-top:6px">${assume}</div></div>`;
    }
  }
  const hist = `${esc(h.hand_id)} · ${tr(('hh.site.' + h.site) as Key)}`;
  el.innerHTML = `${head}
    <h4>${tr('hh.replay.title')}: <span id="hh-replay-id">${hist}</span></h4>
    <button id="rp-back" class="a">${tr('hh.replay.back')}</button>
    <div style="margin:6px 0"><button id="rp-prev" class="a" ${R.step > 0 ? '' : 'disabled'}>${tr('hh.replay.prev')}</button><button id="rp-next" class="a" ${R.step < N ? '' : 'disabled'}>${tr('hh.replay.next')}</button><button id="rp-nextdec" class="a">${tr('hh.replay.nextDecision')}</button>
      <span id="rp-step" data-step="${R.step}" data-total="${N}">${R.step === 0 ? tr('hh.replay.start') : `${R.step}/${N}`}</span></div>
    <div>${tr('hh.replay.cards')}: <span id="rp-cards">${(h.hero_cards ?? []).map(cardSpan).join('') || '-'}</span></div>
    <div style="margin:4px 0">${tr('street.' + st.street as Key)} · ${tr('hh.replay.board')}: <span id="rp-board" data-n="${st.board.length}">${st.board.map(cardSpan).join('') || '-'}</span> · ${tr('hh.replay.pot')}: <span id="rp-pot" data-value="${st.potStart}">${bb(st.potStart)}</span></div>
    <table id="rp-stacks"><tr><th></th><th>${tr('hh.replay.stacks')}</th><th>${tr('hh.replay.inStreet')}</th></tr>${stacks}</table>
    <ul id="rp-actions">${lines}</ul>${panel}`;
  done();
  document.getElementById('rp-back')!.onclick = () => { P.replay = null; rerender(); };
  document.getElementById('rp-prev')!.onclick = () => { R.step = Math.max(0, R.step - 1); rerender(); };
  document.getElementById('rp-next')!.onclick = () => { R.step = Math.min(N, R.step + 1); rerender(); };
  document.getElementById('rp-nextdec')!.onclick = () => {
    const i = h.actions.findIndex((a, k) => k >= R.step && a.seat === heroSeat);
    R.step = i < 0 ? N : i + 1; rerender();
  };
}
