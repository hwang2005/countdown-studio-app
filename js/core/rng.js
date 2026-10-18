/**
 * @file js/core/rng.js
 * Seeded and unseeded pseudo-random number generator (Mulberry32).
 * Enables deterministic Daily Challenges seeded by YYYY-MM-DD date string.
 */

/**
 * Hashes a string seed into a 32-bit unsigned integer (cyrb128-style).
 * @param {string} str
 * @returns {number}
 */
export function hashSeed(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

/**
 * Creates a Mulberry32 PRNG function returning floats in [0, 1).
 * @param {string|number} [seed]
 * @returns {() => number}
 */
export function createRNG(seed) {
  let a =
    seed === undefined || seed === null
      ? (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0
      : typeof seed === 'string'
        ? hashSeed(seed)
        : seed >>> 0;

  return function nextFloat() {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Returns a random integer in [min, max] inclusive using the provided rng.
 * @param {number} min
 * @param {number} max
 * @param {() => number} [rng=Math.random]
 * @returns {number}
 */
export function randomInt(min, max, rng = Math.random) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

/**
 * Returns a Fisher-Yates shuffled shallow copy of an array.
 * @template T
 * @param {T[]} array
 * @param {() => number} [rng=Math.random]
 * @returns {T[]}
 */
export function shuffle(array, rng = Math.random) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = copy[i];
    copy[i] = copy[j];
    copy[j] = tmp;
  }
  return copy;
}

/**
 * Returns today's ISO date string (YYYY-MM-DD) for Daily Challenge seeding.
 * @returns {string}
 */
export function getTodaySeed() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `daily-${y}-${m}-${d}`;
}
