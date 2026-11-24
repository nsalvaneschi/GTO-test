// Adapter from the parsed Hand to the H2 API schema (server/src/app.js normalizeHand) and the upload flow.
import { api } from '../api';
import { positions } from './ranges';
import type { DecisionResult } from './analyze';
import type { Hand } from './types';

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Per-user random salt kept in this browser only; villain (and hero) names never leave the page in plaintext. */
export function saltFor(user: string): string {
  const k = `hh_salt:${user}`;
  let v = localStorage.getItem(k);
  if (!v) { v = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''); localStorage.setItem(k, v); }
  return v;
}

export async function toServerHand(h: Hand, salt: string) {
  const pos = positions(h);
  const t = h.played_at ? Date.parse(h.played_at + 'Z') / 1000 : NaN;
  return {
    site: h.site, hand_id: h.hand_id, played_at: Number.isFinite(t) && t > 0 ? Math.floor(t) : 1, stakes: h.stakes,
    seats: await Promise.all(h.seats.map(async (s) => ({ seat: s.seat, name_hash: await sha256Hex(`${salt}:${s.name}`), stack: s.stack, is_hero: s.is_hero }))),
    hero_cards: h.hero_cards, board: h.board,
    actions: h.actions.map((a) => ({ street: a.street, seat: a.seat, kind: a.kind, amount_to: a.amount_to })),
    pot_by_street: h.pot_by_street.map((p) => p.pot),
    hero_pos: h.hero !== null ? pos[h.hero] : undefined,
  };
}

export const toServerDecision = (handRow: number, d: DecisionResult) => ({
  handRow, street: d.street, nodePath: d.nodePath, actionIdx: d.actionIdx, status: d.status, reason: d.reason ?? undefined,
  ...(d.solverFreqs ? { solverFreqs: d.solverFreqs, evLoss: d.evLoss } : {}), rangePreset: d.rangePreset, engineVer: d.engineVer,
});

/** Import hands, look up their row ids, then save decisions. Hands without a hero cannot be stored (server needs one). */
export async function uploadAll(user: string, hands: Hand[], results: Map<string, DecisionResult[]>): Promise<{ added: number; duplicates: number; saved: number }> {
  const salt = saltFor(user);
  const withHero = hands.filter((h) => h.hero !== null);
  let added = 0, duplicates = 0;
  for (let i = 0; i < withHero.length; i += 100) {
    const r = await api.hhImport(await Promise.all(withHero.slice(i, i + 100).map((h) => toServerHand(h, salt))));
    added += r.added; duplicates += r.duplicates;
  }
  const ids = new Map<string, number>();
  for (let off = 0; ; off += 200) {
    const page = await api.hhList(200, off);
    page.hands.forEach((h) => ids.set(`${h.site}:${h.handId}`, h.id));
    if (off + 200 >= page.total || !page.hands.length) break;
  }
  const rows = withHero.flatMap((h) => (results.get(`${h.site}:${h.hand_id}`) ?? []).flatMap((d) => {
    const id = ids.get(`${h.site}:${h.hand_id}`);
    return id ? [toServerDecision(id, d)] : [];
  }));
  for (let i = 0; i < rows.length; i += 400) await api.hhDecisions(rows.slice(i, i + 400));
  return { added, duplicates, saved: rows.length };
}
