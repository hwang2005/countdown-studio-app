/**
 * @file js/game/conundrum.js
 * Pure game logic for the Countdown Conundrum (9-letter final round anagram).
 * Zero DOM access. Fully unit-testable.
 *
 * Rules:
 * - Selects a 9-letter word from the curated conundrum list.
 * - Scrambles the letters such that the scramble is NEVER equal to the original word
 *   and avoids trivial prefix/suffix preservation where possible.
 * - Handles dual-contestant buzzer lockouts and high-resolution timestamp adjudication.
 */

import { shuffle, randomInt } from '../core/rng.js';

export const CONUNDRUM_POINTS = 10;
export const HINT_PENALTY_POINTS = 3;

/**
 * Scrambles a 9-letter word so the scrambled string is guaranteed not to equal
 * the original word (nor share the exact first 3 letters in order if avoidable).
 *
 * @param {string} word 9-letter uppercase word
 * @param {() => number} [rng=Math.random]
 * @returns {string} Scrambled 9-letter uppercase string
 */
export function scrambleConundrum(word, rng = Math.random) {
  const clean = String(word).trim().toUpperCase();
  if (clean.length < 2) return clean;

  // Check if all characters are identical (impossible in real English 9-letter words, but safe guard)
  const chars = clean.split('');
  if (new Set(chars).size === 1) return clean;

  for (let attempt = 0; attempt < 40; attempt++) {
    const candidate = shuffle(chars, rng).join('');
    if (candidate !== clean) {
      // Prefer scrambles that also break the initial 3-letter prefix
      if (attempt < 25 && candidate.slice(0, 3) === clean.slice(0, 3)) {
        continue;
      }
      return candidate;
    }
  }

  // Deterministic rotation fallback if RNG repeatedly produced the original
  return clean.slice(1) + clean[0];
}

/**
 * Picks a random conundrum from the curated array and returns the answer + scramble.
 * @param {string[]} conundrumList
 * @param {() => number} [rng=Math.random]
 * @returns {{ answer: string, scrambled: string }}
 */
export function pickConundrum(conundrumList, rng = Math.random) {
  const pool =
    Array.isArray(conundrumList) && conundrumList.length > 0
      ? conundrumList
      : ['COUNTDOWN', 'BROADCAST', 'CHALLENGE', 'ARCHITECT', 'EDUCATION'];
  const idx = randomInt(0, pool.length - 1, rng);
  const answer = pool[idx].trim().toUpperCase();
  const scrambled = scrambleConundrum(answer, rng);
  return { answer, scrambled };
}

/**
 * Validates a player's conundrum guess against the target answer.
 * @param {string} guess
 * @param {string} targetAnswer
 * @returns {boolean}
 */
export function checkConundrumGuess(guess, targetAnswer) {
  if (typeof guess !== 'string' || typeof targetAnswer !== 'string') return false;
  return guess.trim().toUpperCase() === targetAnswer.trim().toUpperCase();
}

/**
 * Resolves two near-simultaneous contestant buzz events using high-resolution timestamps.
 * If two buzzes arrive within 15ms of each other, flags `tooClose: true` while still
 * awarding priority to the earliest timestamp.
 *
 * @param {{ player: 1|2, timestamp: number }} buzzA
 * @param {{ player: 1|2, timestamp: number }|null} [buzzB=null]
 * @param {{ p1LockedOut?: boolean, p2LockedOut?: boolean }} [lockouts={}]
 * @returns {{ winner: 1|2|null, deltaMs: number|null, tooClose: boolean }}
 */
export function adjudicateBuzz(buzzA, buzzB = null, lockouts = {}) {
  const isAllowed = (p) => (p === 1 ? !lockouts.p1LockedOut : !lockouts.p2LockedOut);

  const validA = buzzA && isAllowed(buzzA.player) ? buzzA : null;
  const validB = buzzB && isAllowed(buzzB.player) ? buzzB : null;

  if (!validA && !validB) {
    return { winner: null, deltaMs: null, tooClose: false };
  }
  if (validA && !validB) {
    return { winner: validA.player, deltaMs: null, tooClose: false };
  }
  if (!validA && validB) {
    return { winner: validB.player, deltaMs: null, tooClose: false };
  }

  const deltaMs = Math.abs(validA.timestamp - validB.timestamp);
  const winner = validA.timestamp <= validB.timestamp ? validA.player : validB.player;
  return {
    winner,
    deltaMs,
    tooClose: deltaMs < 15
  };
}
