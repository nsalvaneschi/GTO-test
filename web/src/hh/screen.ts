// Minimal hand-history screen (H3): paste, parse, analyse river decisions, optional upload after login. The full
// import/list/replay UI is milestone H4.
import { fmt, locales, type Key } from '../i18n';
import { analyzeHand, classify, type DecisionResult } from './analyze';
import { parseHistory } from './parse';
import type { ParseSummary } from './types';
import { parseNodePath, labelKey } from './replay';
import { bindTabs, currentTab, invalidate, renderHands, tabsHtml } from './pages';
import { uploadAll } from './upload';
import { WorkerBackend } from './workerBackend';

export interface Ctx {
  tr: (k: Key, v?: Record<string, string | number>) => string;
  lang: 'en' | 'es' | 'it';
  user: string | null;
  errText: (code: string) => string;
  codeOf: (e: unknown) => string;
}

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
  if (currentTab() === 'hands') { renderHands(el, c, () => renderHh(el, c)); return; }
  const { tr, lang } = c;
  const pct = (x: number, d = 0) => fmt(x, lang, { style: 'percent', minimumFractionDigits: d, maximumFractionDigits: d });
  const ofPot = (x: number) => tr('unit.ofPot', { value: pct(x / 100, 2) });
  const k = (s: string) => s as Key;
  const reasonText = (r: string) => (('hh.reason.' + r) in locales.en ? tr(k('hh.reason.' + r)) : r);

  const summary = S.parsed
    ? `<p id="hh-summary" data-ok="${S.parsed.counts.ok ?? 0}">${tr('hh.summary', { ok: S.parsed.counts.ok ?? 0, rejected: S.parsed.results.length - (S.parsed.counts.ok ?? 0) })}</p>` : '';
  const handsHtml = S.parsed ? (S.parsed.results.length ? `<table id="hh-hands"><tr><th>${tr('hh.col.hand')}</th><th>${tr('hh.col.site')}</th><th>${tr('hh.col.status')}</th></tr>${S.parsed.results.map((r) => {
    if (!r.ok) return `<tr data-status="rejected" data-reason="${r.reason}"><td>${r.hand_id ? esc(r.hand_id) : '-'}</td><td>${r.site ? tr(k('hh.site.' + r.site)) : '-'}</td><td class="bad">${reasonText(r.reason)}</td></tr>`;
    const cs = classify(r.hand), cand = cs.find((x) => x.reason === null);
    const why = cand ? tr('hh.analysable') : reasonText(cs[0].reason!);
    const warn = r.warnings.map((w) => tr(k('hh.warn.' + w))).join(', ');
    return `<tr data-hand="${esc(r.hand.hand_id)}" data-status="${cand ? 'analysable' : 'skipped'}" data-reason="${cand ? '' : cs[0].reason}"><td>${esc(r.hand.hand_id)}</td><td>${tr(k('hh.site.' + r.hand.site))}</td><td class="${cand ? 'ok' : 'bad'}">${why}${warn ? ` (${warn})` : ''}</td></tr>`;
  }).join('')}</table>` : `<p>${tr('hh.empty')}</p>`) : `<p id="hh-empty">${tr('hh.empty')}</p>`;

  const all = [...S.results.values()].flat();
  const label = (d: DecisionResult) => {
    const m = d.meta;
    if (!m) return '-';
    if (m.kind === 'allin') return tr('action.allin');
    return tr(k('action.' + m.kind), m.frac !== null ? { size: pct(m.frac) } : undefined);
  };
  const resHtml = all.length ? `<table id="hh-results"><tr><th>${tr('hh.col.hand')}</th><th>${tr('hh.col.street')}</th><th>${tr('hh.col.action')}</th><th>${tr('hh.col.status')}</th><th>${tr('hh.col.evLoss')}</th><th>${tr('hh.col.freqs')}</th></tr>${
    [...S.results.entries()].flatMap(([id, ds]) => ds.map((d) => {
      const m = d.meta, hasEv = d.evLoss !== null && m;
      const tip = m ? tr('hh.tooltip', { preset: d.rangePreset, top: pct(m.top), bluff: pct(m.bluff), delta: pct(m.maxDelta, 1), expl: pct(m.expl / 100, 2), iters: tr('iterations', { count: m.iters }) }) : '';
      const stat = tr(k('hh.status.' + d.status)) + (d.reason ? `: ${reasonText(d.reason)}` : '');
      return `<tr data-hand="${esc(id.split(':')[1])}" data-street="${d.street}" data-status="${d.status}" data-reason="${d.reason ?? ''}" data-evloss="${hasEv ? d.evLoss : ''}" data-preset="${esc(d.rangePreset)}" data-solve="${m?.solve ?? ''}" data-tier="${m?.tier ?? ''}" data-cached="${m?.cached ?? ''}" data-solvems="${m?.solveMs ?? ''}">
        <td>${esc(id.split(':')[1])}</td><td>${tr(k('street.' + d.street))}</td><td>${label(d)}</td><td>${stat}</td>
        <td>${hasEv ? `${ofPot(d.evLoss!)} <span class="badge-approx" title="${esc(tip)}" style="border:1px solid #f0ad4e;border-radius:3px;padding:0 4px;font-size:11px;color:#f0ad4e">${tr('hh.badge.approx')}</span>` : '-'}</td>
        <td>${d.solverFreqs ? d.solverFreqs.map((f, i) => { const t = parseNodePath(d.nodePath)?.labels[i], lk = t ? labelKey(t) : null; return `${lk ? tr(lk.key, lk.pct !== null ? { size: pct(lk.pct) } : undefined) + ' ' : ''}${pct(f)}`; }).join(' / ') : '-'}</td></tr>`;
    })).join('')}</table>` : `<p id="hh-noresults">${tr('hh.noResults')}</p>`;

  const solving = S.phase === 'solving';
  const canUp = !!c.user && all.length > 0 && !S.uploading && !solving;
  el.innerHTML = `<h4>${tr('hh.title')}</h4>
    <div id="hh-disclaimer" style="border:1px solid #f0ad4e;padding:6px 10px;margin:6px 0;max-width:640px">${tr('hh.disclaimer')}</div>
    ${tabsHtml(c)}
    <div>${tr('hh.paste')}</div>
    <textarea id="hh-text" rows="8" cols="80" ${solving ? 'disabled' : ''}>${esc(S.text)}</textarea><br>
    <details style="margin:6px 0"><summary>${tr('hh.override.title')}</summary>
      <label>${tr('hh.override.width')}<input id="hh-width" type="number" min="5" max="100" style="width:60px" value="${esc(S.width)}"></label>
      <label>${tr('hh.override.hero')}<input id="hh-hero-range" size="22" value="${esc(S.heroRange)}"></label>
      <label>${tr('hh.override.villain')}<input id="hh-vill-range" size="22" value="${esc(S.villRange)}"></label></details>
    <button id="hh-parse" class="a" ${solving ? 'disabled' : ''}>${tr('hh.parse')}</button>
    <button id="hh-analyse" class="a" ${solving || !S.parsed?.counts.ok ? 'disabled' : ''}>${tr('hh.analyse')}</button>
    ${solving ? `<button id="hh-cancel" class="a">${tr('hh.cancel')}</button>` : ''}
    <div id="hh-progress" data-phase="${S.phase}" style="margin:6px 0">${solving ? progressText(c) : S.cancelled ? tr('hh.cancelled') : ''}</div>
    ${solving ? `<div style="font-size:12px;opacity:.7">${tr('hh.solvingStage')}</div>` : ''}
    <div class="err" id="hh-err">${esc(S.err)}</div>
    ${summary}${handsHtml}
    <h4>${tr('hh.results')}</h4>${resHtml}
    <div style="margin:8px 0"><button id="hh-upload" class="a" ${canUp ? '' : 'disabled'}>${tr('hh.upload')}</button>
      <div id="hh-upload-hint">${c.user ? '' : tr('hh.uploadHint')}</div>
      <div id="hh-upload-msg" class="ok" data-saved="${S.upMsg ? 1 : 0}">${esc(S.upMsg)}</div><div id="hh-upload-err" class="err">${esc(S.upErr)}</div></div>`;

  bindTabs(el, () => renderHh(el, c));
  const val = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
  const readInputs = () => { S.text = val('hh-text'); S.width = val('hh-width'); S.heroRange = val('hh-hero-range'); S.villRange = val('hh-vill-range'); };
  ['hh-text', 'hh-width', 'hh-hero-range', 'hh-vill-range'].forEach((id) => { document.getElementById(id)!.oninput = readInputs; });
  document.getElementById('hh-parse')!.onclick = () => {
    readInputs(); S.parsed = parseHistory(S.text); S.results = new Map(); S.cancelled = false; S.err = ''; S.upMsg = S.upErr = '';
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
      if (e instanceof Error && e.message === 'cancelled') S.cancelled = true; else S.err = String(e);
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
    } catch (e) { S.upErr = c.errText(c.codeOf(e)); }
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
