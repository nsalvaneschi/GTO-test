// Accuracy definition (mixed-frequency aware): an answer is "correct" when the
// solver plays the chosen action with frequency >= ACCURACY_MIN_FREQ (0.1).
// We also report meanChosenFreq (avg solver freq of chosen action) as a softer metric.
export const ACCURACY_MIN_FREQ = 0.1;
const DAY = 86400000;
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

// rows: {spot_type, action, solver_freqs(JSON string), ev_loss, created_at}
export function summarize(rows, now = Date.now()) {
  const total = rows.length;
  let correct = 0, evSum = 0, freqSum = 0;
  const byType = new Map();
  const days = new Map();
  for (const r of rows) {
    const f = JSON.parse(r.solver_freqs)[r.action] ?? 0;
    const ok = f >= ACCURACY_MIN_FREQ;
    correct += ok; evSum += r.ev_loss; freqSum += f;
    const t = byType.get(r.spot_type) ?? { spotType: r.spot_type, total: 0, correct: 0, evSum: 0 };
    t.total++; t.correct += ok; t.evSum += r.ev_loss;
    byType.set(r.spot_type, t);
    const k = dayKey(r.created_at);
    const d = days.get(k) ?? { date: k, total: 0, correct: 0, evSum: 0 };
    d.total++; d.correct += ok; d.evSum += r.ev_loss;
    days.set(k, d);
  }
  // Streak: consecutive UTC days with >=1 answer, ending today (or yesterday if none today yet).
  let streak = 0;
  let cur = now;
  if (!days.has(dayKey(cur))) cur -= DAY;
  while (days.has(dayKey(cur))) { streak++; cur -= DAY; }
  const series = [];
  for (let i = 29; i >= 0; i--) {
    const k = dayKey(now - i * DAY);
    const d = days.get(k);
    series.push({
      date: k, total: d?.total ?? 0,
      accuracy: d ? d.correct / d.total : null,
      meanEvLoss: d ? d.evSum / d.total : null,
    });
  }
  return {
    total,
    accuracy: total ? correct / total : null,
    meanChosenFreq: total ? freqSum / total : null,
    meanEvLoss: total ? evSum / total : null,
    streak,
    last30Days: series,
    bySpotType: [...byType.values()].map((t) => ({
      spotType: t.spotType, total: t.total,
      accuracy: t.correct / t.total, meanEvLoss: t.evSum / t.total,
    })).sort((a, b) => a.spotType.localeCompare(b.spotType)),
  };
}
