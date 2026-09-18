/**
 * APEX: Principal — seeded randomness.
 *
 * Every random draw in the game comes from here. A save file stores the seed
 * and the draw counter, so reloading a save and replaying a race gives the same
 * race — which is what stops the player save-scumming a safety car, and what
 * lets `tools/simseason.mjs` reproduce a balance run exactly.
 */

/** mulberry32 — small, fast, good enough, and identical to the one APEX F1 uses. */
export function makeRng(seed = 1) {
  let a = seed | 0;
  const r = () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.state = () => a;
  r.restore = (s) => { a = s | 0; };
  /** Uniform in [lo, hi). */
  r.range = (lo, hi) => lo + (hi - lo) * r();
  /** Integer in [lo, hi]. */
  r.int = (lo, hi) => Math.floor(lo + (hi - lo + 1) * r()) ;
  /** True with probability p. */
  r.chance = (p) => r() < p;
  /** Box–Muller normal; clamped to ±3σ so one draw cannot break a season. */
  r.normal = (mean = 0, sd = 1) => {
    const u = Math.max(1e-9, r()), v = r();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return mean + sd * Math.max(-3, Math.min(3, z));
  };
  r.pick = (arr) => arr[Math.floor(r() * arr.length) % arr.length];
  /** Fisher–Yates, in place. */
  r.shuffle = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  };
  /** Weighted pick. `weights` parallel to `items`. */
  r.weighted = (items, weights) => {
    let total = 0;
    for (const w of weights) total += Math.max(0, w);
    if (total <= 0) return items[0];
    let x = r() * total;
    for (let i = 0; i < items.length; i++) {
      x -= Math.max(0, weights[i]);
      if (x <= 0) return items[i];
    }
    return items[items.length - 1];
  };
  return r;
}

/** Derive a stable child seed, so a race's randomness does not depend on how
 *  many times the player opened the finance screen first. */
export function subSeed(seed, ...parts) {
  let h = seed | 0;
  for (const p of parts) {
    const s = String(p);
    for (let i = 0; i < s.length; i++) h = (Math.imul(h ^ s.charCodeAt(i), 0x01000193) | 0);
  }
  return h | 0;
}
