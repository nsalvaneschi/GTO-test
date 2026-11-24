// Minimal hand-history screen (H3): paste, parse, analyse river decisions, optional upload after login. The full
// import/list/replay UI is milestone H4.
import { fmt, locales, type Key } from '../i18n';
import { icon } from '../ui';
import { analyzeHand, classify, type DecisionResult } from './analyze';
import { parseHistory } from './parse';
import type { ParseSummary } from './types';
import { parseNodePath, labelKey } from './replay';
import { bindTabs, currentTab, invalidate, renderHands, tabsHtml } from './pages';
import { engineErrKey } from '../validate';
import { uploadAll } from './upload';
import { WorkerBackend } from './workerBackend';

export interface Ctx {
  tr: (k: Key, v?: Record<string, string | number>) => string;
  lang: 'en' | 'es' | 'it';
  user: string | null;
  errText: (code: string) => string;
  codeOf: (e: unknown) => string;
  nav: () => void; // push the current #/hands/... route after a tab / replay change
}

const MAX_TEXT = 2_000_000; // chars; larger pastes are refused instead of freezing the tab
const S = {
  text: '', width: '', heroRange: '', villRange: '', parsed: null as ParseSummary | null,
  results: new Map<string, DecisionResult[]>(), phase: 'idle' as 'idle' | 'solving' | 'done', n: 0, total: 0, cancelled: false,
  msg: '', err: '', upMsg: '', upErr: '', expl: null as number | null, iters: 0, uploading: false,
};
let backend: WorkerBackend | null = null;
let signal = { aborted: false };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const key = (site: string, id: string) => `${site}:${id}`;

export function renderHh(el: HTMLElement, c: Ctx) {
  if (!el.isConnected) return; // an async tail (upload, analysis) finishing after the screen was rebuilt (e.g. 401 -> login view) must not draw into a stale node
  if (currentTab() === 'hands') { renderHands(el, c, () => renderHh(el, c)); return; }
  const { tr, lang } = c;
  const pct = (x: number, d = 0) => fmt(x, lang, { style: 'percent', minimumFractionDigits: d, maximumFractionDigits: d });
  const ofPot = (x: number) => tr('unit.ofPot', { value: pct(x / 100, 2) });
  const k = (s: string) => s as Key;
  const reasonText = (r: string) => (('hh.reason.' + r) in locales.en ? tr(k('hh.reason.' + r)) : r);

  const summary = S.parsed
    ? `<p id="hh-summary" class="muted" data-ok="${S.parsed.counts.ok ?? 0}">${tr('hh.summary', { ok: S.parsed.counts.ok ?? 0, rejected: S.parsed.results.length - (S.parsed.counts.ok ?? 0) })}</p>` : '';
  const handsHtml = S.parsed ? (S.parsed.results.length ? `<div class="tbl-wrap"><table id="hh-hands"><tr><th>${tr('hh.col.hand')}</th><th>${tr('hh.col.site')}</th><th>${tr('hh.col.status')}</th></tr>${S.parsed.results.map((r) => {
    if (!r.ok) return `<tr data-status="rejected" data-reason="${r.reason}"><td>${r.hand_id ? esc(r.hand_id) : '-'}</td><td>${r.site ? tr(k('hh.site.' + r.site)) : '-'}</td><td><span class="pill bad">${reasonText(r.reason)}</span></td></tr>`;
    const cs = classify(r.hand), cand = cs.find((x) => x.reason === null);
    const why = cand ? tr('hh.analysable') : reasonText(cs[0].reason!);
    const warn = r.warnings.map((w) => tr(k('hh.warn.' + w))).join(', ');
    return `<tr data-hand="${esc(r.hand.hand_id)}" data-status="${cand ? 'analysable' : 'skipped'}" data-reason="${cand ? '' : cs[0].reason}"><td>${esc(r.hand.hand_id)}</td><td>${tr(k('hh.site.' + r.hand.site))}</td><td><span class="pill ${cand ? 'ok' : 'warn'}">${why}</span>${warn ? ` <span class="muted small">(${warn})</span>` : ''}</td></tr>`;
  }).join('')}</table></div>` : `<div class="empty">${icon.inbox}<p>${tr('hh.empty')}</p></div>`) : `<div class="empty">${icon.inbox}<p id="hh-empty">${tr('hh.empty')}</p></div>`;

  const all = [...S.results.values()].flat();
  const label = (d: DecisionResult) => {
    const m = d.meta;
    if (!m) return '-';
    if (m.kind === 'allin') return tr('action.allin');
    return tr(k('action.' + m.kind), m.frac !== null ? { size: pct(m.frac) } : undefined);
  };
  const pillCls = (st: string) => (st === 'ok' ? 'ok' : st === 'unsupported' ? '' : 'warn');
  const resHtml = all.length ? `<div class="tbl-wrap"><table id="hh-results"><tr><th>${tr('hh.col.hand')}</th><th>${tr('hh.col.street')}</th><th>${tr('hh.col.action')}</th><th>${tr('hh.col.status')}</th><th>${tr('hh.col.evLoss')}</th><th>${tr('hh.col.freqs')}</th></tr>${
    [...S.results.entries()].flatMap(([id, ds]) => ds.map((d) => {
      const m = d.meta, hasEv = d.evLoss !== null && m;
      const tip = m ? tr('hh.tooltip', { preset: d.rangePreset, top: pct(m.top), bluff: pct(m.bluff), delta: pct(m.maxDelta, 1), expl: pct(m.expl / 100, 2), iters: tr('iterations', { count: m.iters }) }) : '';
      const stat = tr(k('hh.status.' + d.status)) + (d.reason ? `: ${reasonText(d.reason)}` : '');
      return `<tr data-hand="${esc(id.split(':')[1])}" data-street="${d.street}" data-status="${d.status}" data-reason="${d.reason ?? ''}" data-evloss="${hasEv ? d.evLoss : ''}" data-preset="${esc(d.rangePreset)}" data-solve="${m?.solve ?? ''}" data-tier="${m?.tier ?? ''}" data-cached="${m?.cached ?? ''}" data-solvems="${m?.solveMs ?? ''}">
        <td>${esc(id.split(':')[1])}</td><td>${tr(k('street.' + d.street))}</td><td>${label(d)}</td><td><span class="pill ${pillCls(d.status)}">${stat}</span></td>
        <td>${hasEv ? `${ofPot(d.evLoss!)} <span class="badge-approx" title="${esc(tip)}">${tr('hh.badge.approx')}</span>` : '-'}</td>
        <td>${d.solverFreqs ? d.solverFreqs.map((f, i) => { const t = parseNodePath(d.nodePath)?.labels[i], lk = t ? labelKey(t) : null; return `${lk ? tr(lk.key, lk.pct !== null ? { size: pct(lk.pct) } : undefined) + ' ' : ''}${pct(f)}`; }).join(' / ') : '-'}</td></tr>`;
    })).join('')}</table></div>` : `<div class="empty">${icon.inbox}<p id="hh-noresults">${tr('hh.noResults')}</p></div>`;

  const solving = S.phase === 'solving';
  const canUp = !!c.user && all.length > 0 && !S.uploading && !solving;
  el.innerHTML = `<h4>${tr('hh.title')}</h4>
    <div id="hh-disclaimer" class="note">${tr('hh.disclaimer')}</div>
    ${tabsHtml(c)}
    <div class="panel"><div class="panel-title">${tr('hh.paste')}</div>
    <textarea id="hh-text" rows="8" ${solving ? 'disabled' : ''}>${esc(S.text)}</textarea>
    <details style="margin:var(--s-2) 0"><summary>${tr('hh.override.title')}</summary>
      <label>${tr('hh.override.width')}<input id="hh-width" type="number" min="5" max="100" value="${esc(S.width)}"></label>
      <label>${tr('hh.override.hero')}<input id="hh-hero-range" size="22" value="${esc(S.heroRange)}"></label>
      <label>${tr('hh.override.villain')}<input id="hh-vill-range" size="22" value="${esc(S.villRange)}"></label></details>
    <div class="row"><button id="hh-parse" ${solving ? 'disabled' : ''}>${tr('hh.parse')}</button>
    <button id="hh-analyse" class="primary ${solving ? 'loading' : ''}" ${solving || !S.parsed?.counts.ok ? 'disabled' : ''}>${tr('hh.analyse')}</button>
    ${solving ? `<button id="hh-cancel">${tr('hh.cancel')}</button>` : ''}</div>
    <div class="status">${solving ? '<span class="spinner" aria-hidden="true"></span>' : ''}<span id="hh-progress" data-phase="${S.phase}">${solving ? progressText(c) : S.cancelled ? tr('hh.cancelled') : ''}</span></div>
    ${solving ? `<div class="small muted">${tr('hh.solvingStage')}</div>` : ''}</div>
    <div class="err" id="hh-err">${esc(S.err)}</div>
    ${summary}${handsHtml}
    <h4>${tr('hh.results')}</h4>${resHtml}
    <div style="margin:var(--s-3) 0"><button id="hh-upload" class="primary ${S.uploading ? 'loading' : ''}" ${canUp ? '' : 'disabled'}>${tr('hh.upload')}</button>
      <div id="hh-upload-hint" class="small muted">${c.user ? '' : tr('hh.uploadHint')}</div>
      <div id="hh-upload-msg" class="ok" data-saved="${S.upMsg ? 1 : 0}">${esc(S.upMsg)}</div><div id="hh-upload-err" class="err">${esc(S.upErr)}</div></div>`;

  bindTabs(el, () => renderHh(el, c), c);
  const val = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
  const readInputs = () => { S.text = val('hh-text'); S.width = val('hh-width'); S.heroRange = val('hh-hero-range'); S.villRange = val('hh-vill-range'); };
  ['hh-text', 'hh-width', 'hh-hero-range', 'hh-vill-range'].forEach((id) => { document.getElementById(id)!.oninput = readInputs; });
  document.getElementById('hh-parse')!.onclick = () => {
    readInputs(); S.results = new Map(); S.cancelled = false; S.err = ''; S.upMsg = S.upErr = '';
    if (S.text.length > MAX_TEXT) { S.parsed = null; S.err = tr('hh.tooLarge'); } else S.parsed = parseHistory(S.text);
    renderHh(el, c);
  };
  document.getElementById('hh-analyse')!.onclick = async () => {
    readInputs();
    const hands = S.parsed!.results.flatMap((r) => (r.ok ? [r.hand] : []));
    const w = Number(S.width);
    const overrides = { width: S.width && w > 0 ? Math.min(1, w / 100) : undefined, heroRange: S.heroRange || undefined, villainRange: S.villRange || undefined };
    backend ??= new WorkerBackend();
    signal = { aborted: false };
    Object.assign(S, { phase: 'solving', n: 0, total: hands.length, cancelled: false, err: '', results: new Map(), expl: null, iters: 0 });
    renderHh(el, c);
    try {
      for (const h of hands) {
        S.n++; S.expl = null; progressUpdate(c);
        S.results.set(key(h.site, h.hand_id), await analyzeHand(h, { backend, overrides, signal, onProgress: (expl, iters) => { S.expl = expl; S.iters = iters; progressUpdate(c); } }));
      }
    } catch (e) {
      if (e instanceof Error && e.message === 'cancelled') S.cancelled = true; else S.err = c.tr(engineErrKey(String(e instanceof Error ? e.message : e)));
    }
    S.phase = 'done';
    renderHh(el, c);
  };
  const cancel = document.getElementById('hh-cancel');
  if (cancel) cancel.onclick = () => { signal.aborted = true; backend?.cancel(); };
  document.getElementById('hh-upload')!.onclick = async () => {
    if (!c.user) return;
    S.uploading = true; S.upErr = ''; S.upMsg = '';
    try {
      const hands = S.parsed!.results.flatMap((r) => (r.ok ? [r.hand] : []));
      S.upMsg = tr('hh.uploaded', await uploadAll(c.user, hands, S.results)); invalidate();
    } catch (e) { S.upErr = c.codeOf(e) === 'unauthorized' ? '' : c.errText(c.codeOf(e)); } // expired session: the login view says so, keep this view clean for the retry
    S.uploading = false;
    renderHh(el, c);
  };
}

function progressText(c: Ctx) {
  const e = S.expl !== null ? ` · ${c.tr('exploitability')}: ${fmt(S.expl / 100, c.lang, { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 })} · ${c.tr('iterations', { count: S.iters })}` : '';
  return c.tr('hh.solving', { n: S.n, total: S.total }) + e;
}
function progressUpdate(c: Ctx) {
  const el = document.getElementById('hh-progress');
  if (el) el.textContent = progressText(c);
}
