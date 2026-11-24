export interface Progress {
  total: number; accuracy: number | null; meanChosenFreq: number | null; meanEvLoss: number | null; streak: number;
  last30Days: { date: string; total: number; accuracy: number | null; meanEvLoss: number | null }[];
  bySpotType: { spotType: string; total: number; accuracy: number; meanEvLoss: number }[];
}
export interface HhProgress extends Progress { source: 'hh'; byStatus: Record<string, number> }
export interface HhFilters { site?: string; from?: string; to?: string; status?: string; street?: string; minEvLoss?: string }
export interface HhHandRow { id: number; site: string; handId: string; playedAt: number; heroPos: string | null; players: number }
export interface HhDecisionRow { id: number; handRow: number; street: string; nodePath: string; actionIdx: number; status: string; reason: string | null;
  solverFreqs: number[] | null; evLoss: number | null; rangePreset: string; engineVer: string }
export interface HhHandFull extends HhHandRow {
  hand: { site: string; hand_id: string; stakes: { sb: number; bb: number }; seats: { seat: number; stack: number; is_hero: boolean }[]; hero_cards: string[] | null; board: string[];
    actions: { street: string; seat: number; kind: string; amount_to: number | null }[]; pot_by_street: number[] };
  decisions: HhDecisionRow[];
}

/** Query string for GET /api/hh from the list filters (dates are YYYY-MM-DD, read as UTC like played_at). */
export function hhQuery(f: HhFilters, limit: number, offset: number): string {
  const q = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (f.site) q.set('site', f.site);
  const day = (d: string, end: boolean) => { const t = Date.parse(d + 'T00:00:00Z') / 1000; return Number.isFinite(t) ? String(end ? t + 86399 : t) : null; };
  const from = f.from ? day(f.from, false) : null, to = f.to ? day(f.to, true) : null;
  if (from) q.set('from', from);
  if (to) q.set('to', to);
  if (f.status) q.set('status', f.status);
  if (f.street) q.set('street', f.street);
  if (f.minEvLoss && Number(f.minEvLoss) > 0) q.set('minEvLoss', String(Number(f.minEvLoss)));
  return q.toString();
}

export class ApiError extends Error { constructor(public status: number, public code: string) { super(code); } }

/** One central place for expired sessions: any API call answering 401 'unauthorized' notifies this handler (login failures are 'invalid_credentials' and are not affected). */
let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (f: () => void) => { onUnauthorized = f; };

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(url, { method, credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  } catch { throw new ApiError(0, 'network'); }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && j.error === 'unauthorized') onUnauthorized();
  if (!r.ok) throw new ApiError(r.status, j.error ?? 'generic');
  return j as T;
}
export const api = {
  me: () => call<{ username: string }>('GET', '/api/me'),
  login: (username: string, password: string) => call<{ username: string }>('POST', '/api/login', { username, password }),
  register: (username: string, password: string) => call<{ username: string }>('POST', '/api/register', { username, password }),
  logout: () => call<{ ok: true }>('POST', '/api/logout', {}),
  postResult: (r: unknown) => call<{ ok: true }>('POST', '/api/drills/results', r),
  progress: () => call<Progress>('GET', '/api/progress'),
  hhImport: (hands: unknown[]) => call<{ added: number; duplicates: number }>('POST', '/api/hh', { hands }),
  hhList: (limit: number, offset: number) => call<{ total: number; hands: { id: number; site: string; handId: string }[] }>('GET', `/api/hh?limit=${limit}&offset=${offset}`),
  hhFiltered: (f: HhFilters, limit: number, offset: number) => call<{ total: number; hands: HhHandRow[] }>('GET', `/api/hh?${hhQuery(f, limit, offset)}`),
  hhGet: (id: number) => call<HhHandFull>('GET', `/api/hh/${id}`),
  hhDeleteAll: () => call<{ hands: number; decisions: number }>('DELETE', '/api/hh'),
  deleteMyData: () => call<{ hands: number; decisions: number; drillResults: number }>('DELETE', '/api/me/data'),
  changePassword: (currentPassword: string, newPassword: string) => call<{ ok: true }>('POST', '/api/me/password', { currentPassword, newPassword }),
  deleteAccount: (password: string) => call<{ ok: true }>('DELETE', '/api/me', { password }),
  hhProgress: () => call<HhProgress>('GET', '/api/progress?source=hh'),
  hhDecisions: (decisions: unknown[]) => call<{ saved: number }>('POST', '/api/hh/decisions', { decisions }),
};
