/**
 * Mulberry32 — fast, seedable 32-bit PRNG.
 * Produces deterministic pseudo-random numbers from a 32-bit integer seed.
 */
function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let z = Math.imul(s ^ (s >>> 15), 1 | s);
    z ^= z + Math.imul(z ^ (z >>> 7), 61 | z);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Hash a string to a uint32 so it can be used as a mulberry32 seed.
 */
function hashStrToUint32(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

/**
 * PRNG factory compatible with the AG Grid Studio generator API.
 * The factory receives a seed string and returns a `() => number` function.
 * Using this factory makes `getMainDemoDataGenerated` produce deterministic output.
 */
export function agStudioSeededFactory(seedStr: string): () => number {
  return mulberry32(hashStrToUint32(seedStr));
}
