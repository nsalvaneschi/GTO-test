export interface Progress {
  total: number; accuracy: number | null; meanChosenFreq: number | null; meanEvLoss: number | null; streak: number;
  last30Days: { date: string; total: number; accuracy: number | null; meanEvLoss: number | null }[];
  bySpotType: { spotType: string; total: number; accuracy: number; meanEvLoss: number }[];
}
export class ApiError extends Error { constructor(public status: number, public code: string) { super(code); } }

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(url, { method, credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  } catch { throw new ApiError(0, 'network'); }
  const j = await r.json().catch(() => ({}));
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
  hhDecisions: (decisions: unknown[]) => call<{ saved: number }>('POST', '/api/hh/decisions', { decisions }),
};
