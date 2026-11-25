// Small shared view helpers: own inline-SVG icons, playing-card tiles and HTML escaping. No text lives here (i18n stays in the callers).
export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

const svg = (body: string, vb = 24) => `<svg viewBox="0 0 ${vb} ${vb}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
export const icon = {
  logo: `<svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true" focusable="false"><rect width="28" height="28" rx="7" fill="var(--surface-3)"/><rect x="5" y="5" width="8" height="8" rx="2" fill="var(--fold)"/><rect x="15" y="5" width="8" height="8" rx="2" fill="var(--call)"/><rect x="5" y="15" width="8" height="8" rx="2" fill="var(--b1)"/><rect x="15" y="15" width="8" height="8" rx="2" fill="var(--b3)"/></svg>`,
  solver: svg('<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><path d="M13.5 17h7M17 13.5v7"/>'),
  drill: svg('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/>'),
  preflop3: svg('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="6" r="1.6" fill="currentColor"/><circle cx="6.8" cy="15" r="1.6" fill="currentColor"/><circle cx="17.2" cy="15" r="1.6" fill="currentColor"/>'),
  progress: svg('<path d="M4 20V4M4 20h16"/><path d="M8 15l3.5-4 3 2.5L19 7"/>'),
  hh: svg('<rect x="4" y="3.5" width="12" height="16" rx="2"/><path d="M8 8h4M8 12h4M18.5 8.5v10a2 2 0 0 1-2 2H8"/>'),
  logout: svg('<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 8l-4 4 4 4M6 12h9"/>'),
  theme: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor"/>'),
  check: svg('<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 9.5"/>'),
  cross: svg('<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>'),
  inbox: svg('<path d="M4 13l2.5-8h11L20 13v6H4z"/><path d="M4 13h5l1 2h4l1-2h5"/>'),
};

const SYM: Record<string, string> = { c: '♣\uFE0E', d: '♦\uFE0E', h: '♥\uFE0E', s: '♠\uFE0E' };
const SUITCLS: Record<string, string> = { c: 'ss2', d: 'sd', h: 'sh', s: 'sc' }; // colour-blind-safe (Okabe-Ito) hues; the symbol is always shown too
/** Playing-card tile for a card name like "As". */
export const cardTile = (name: string, size: '' | 'sm' | 'lg' = '') =>
  `<span class="card ${SUITCLS[name[1]]}${size ? ' ' + size : ''}" data-card="${name}"><b>${name[0]}</b><i>${SYM[name[1]]}</i></span>`;
