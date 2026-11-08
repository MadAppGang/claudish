/**
 * Deterministic randomness (architecture §1.1): a seeded generator, the FNV-1a
 * hash every key and seed is built from, and the samplers the forecast draws.
 * Nothing here reads a clock or `Math.random`, so the same seed gives the same
 * paths on every run and every machine.
 */

/** A generator of uniform numbers in [0, 1). */
export type Rng = () => number;

/** mulberry32: a 32-bit state, full period, good enough for Monte Carlo paths. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * FNV-1a, 32 bit, over the string's UTF-8 bytes (so `fnv1a32("a")` is the
 * reference 0xe40c292c). Unsigned.
 */
export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  const byte = (b: number) => {
    hash ^= b;
    hash = Math.imul(hash, 0x01000193);
  };
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp < 0x80) byte(cp);
    else if (cp < 0x800) {
      byte(0xc0 | (cp >> 6));
      byte(0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      byte(0xe0 | (cp >> 12));
      byte(0x80 | ((cp >> 6) & 0x3f));
      byte(0x80 | (cp & 0x3f));
    } else {
      byte(0xf0 | (cp >> 18));
      byte(0x80 | ((cp >> 12) & 0x3f));
      byte(0x80 | ((cp >> 6) & 0x3f));
      byte(0x80 | (cp & 0x3f));
    }
  }
  return hash >>> 0;
}

/** A hash as 8 lower-case hex digits, the form every key string takes. */
export function fnvHex(text: string): string {
  return fnv1a32(text).toString(16).padStart(8, "0");
}

/** Normal(mean, sd) by Box–Muller. */
export function sampleNormal(rng: Rng, mean = 0, sd = 1): number {
  const u1 = 1 - rng(); // (0, 1]: log(0) is never taken
  const u2 = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Gamma(shape, scale) by Marsaglia–Tsang. Below shape 1 it samples shape + 1
 * and applies the boost `U^(1/shape)`, because the squeeze needs shape ≥ 1.
 */
export function sampleGamma(rng: Rng, shape: number, scale = 1): number {
  if (!(shape > 0) || !(scale > 0)) return 0;
  if (shape < 1) {
    const boost = (1 - rng()) ** (1 / shape);
    return sampleGamma(rng, shape + 1, scale) * boost;
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = sampleNormal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = 1 - rng();
    if (u < 1 - 0.0331 * x ** 4) return d * v * scale;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
  }
}

/** LogNormal: exp(Normal(mu, sigma)). */
export function sampleLognormal(rng: Rng, mu: number, sigma: number): number {
  return Math.exp(sampleNormal(rng, mu, sigma));
}

export function sampleBernoulli(rng: Rng, p: number): boolean {
  return rng() < p;
}
