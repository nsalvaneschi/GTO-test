const R = '23456789TJQKA';

/** Expand "AA,AKs,QJo,TT" into {combo: 1} (sparse engine format). Only pair/suited/offsuit exact classes. */
export function parseRange(spec: string): Record<string, number> {
  const out: Record<string, number> = {};
  const S = 'cdhs';
  for (const tok of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [a, b, k] = [tok[0], tok[1], tok[2]];
    for (const s1 of S) for (const s2 of S) {
      if (a === b ? s1 >= s2 : false) continue;
      if (a === b && k) continue;
      if (a !== b && k === 's' && s1 !== s2) continue;
      if (a !== b && k === 'o' && s1 === s2) continue;
      out[`${a}${s1}${b}${s2}`] = 1;
    }
  }
  return out;
}

export const presets: Record<string, string> = {
  tight: 'AA,KK,QQ,JJ,TT,AKs,AQs,AKo,KQs',
  mixed: 'AA,KK,QQ,JJ,TT,99,88,AKs,AQs,AJs,ATs,AKo,AQo,KQs,KJs,QJs,JTs,T9s,98s',
  wide: 'AA,KK,QQ,JJ,TT,99,88,77,66,55,AKs,AQs,AJs,ATs,A9s,A5s,A4s,AKo,AQo,AJo,KQs,KJs,KTs,KQo,QJs,QTs,JTs,T9s,98s,87s,76s,65s',
};

export { R };
