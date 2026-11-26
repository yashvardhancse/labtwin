/**
 * Seeded pseudo-random numbers for reproducible simulation noise.
 *
 * mulberry32 uses only 32-bit integer arithmetic, and the Gaussian below is an
 * Irwin–Hall sum (additions only — no log/sin/cos, whose last bits can differ
 * between JS engines). Same seed ⇒ bit-identical runs on every platform.
 */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Approximately standard normal (mean 0, σ 1), bounded to ±6. */
  gaussian(): number;
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gaussian = (): number => {
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += next();
    return sum - 6;
  };
  return { next, gaussian };
}

/**
 * Independent stream per simulated node, so adding noise to one node never
 * shifts the random sequence of another.
 */
export function deriveSeed(seed: number, stream: number): number {
  let h = (seed ^ Math.imul(stream + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}
