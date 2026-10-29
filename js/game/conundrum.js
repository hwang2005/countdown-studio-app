/**
 * @file js/game/conundrum.js
 * Pure game logic for the Countdown Conundrum (9-letter final round anagram).
 * Zero DOM access. Fully unit-testable.
 *
 * Rules:
 * - Selects a 9-letter answer from the curated conundrum list.
 * - Builds the question from two or three dictionary words whose combined letters
 *   are exactly the answer's nine letters.
 * - Handles dual-contestant buzzer lockouts and high-resolution timestamp adjudication.
 */

import { shuffle } from '../core/rng.js';

export const CONUNDRUM_POINTS = 10;
export const HINT_PENALTY_POINTS = 3;

function letterSignature(value) {
  return String(value).toUpperCase().split('').sort().join('');
}

/**
 * Supports both the legacy string format ("LAUNCHING") and the explicit
 * question format used by Countdown: { source: "CHINALUNG", answers: [...] }.
 */
function normalizeConundrumEntry(entry) {
  if (typeof entry === 'string') {
    const answer = entry.trim().toUpperCase();
    return { answer, answers: [answer], sourceWords: null };
  }
  if (!entry || typeof entry !== 'object') return null;

  const answers = Array.isArray(entry.answers)
    ? entry.answers
    : entry.answer
      ? [entry.answer]
      : [];
  const cleanAnswers = [...new Set(answers
    .map((value) => String(value).trim().toUpperCase())
    .filter((value) => /^[A-Z]{9}$/.test(value)))];
  if (!cleanAnswers.length) return null;

  const rawSource = entry.sourceWords || entry.source || entry.scrambled;
  const sourceWords = Array.isArray(rawSource)
    ? rawSource.map((value) => String(value).trim().toUpperCase()).filter(Boolean)
    : rawSource
      ? [String(rawSource).replace(/[^a-z]/gi, '').toUpperCase()]
      : null;
  const source = sourceWords?.join('');
  return {
    answer: cleanAnswers[0],
    answers: cleanAnswers,
    sourceWords: source && source.length === 9 && letterSignature(source) === letterSignature(cleanAnswers[0])
      ? sourceWords
      : null
  };
}

function subtractSignature(total, part) {
  const counts = new Map();
  for (const ch of total) counts.set(ch, (counts.get(ch) || 0) + 1);
  for (const ch of part) {
    const left = (counts.get(ch) || 0) - 1;
    if (left < 0) return null;
    counts.set(ch, left);
  }
  return [...counts.entries()].flatMap(([ch, count]) => Array(count).fill(ch)).join('');
}

const sourceWordIndexCache = new WeakMap();

function getSourceWordIndex(words) {
  if (words && (typeof words === 'object' || typeof words === 'function')) {
    const cached = sourceWordIndexCache.get(words);
    if (cached) return cached;
  }
  const candidates = [...new Set([...words]
    .map((word) => String(word).trim().toUpperCase())
    .filter((word) => /^[A-Z]{2,7}$/.test(word) && word.length < 9))];
  const bySignature = new Map();
  for (const word of candidates) {
    const sig = letterSignature(word);
    if (!bySignature.has(sig)) bySignature.set(sig, word);
  }
  const index = { candidates, bySignature };
  if (words && (typeof words === 'object' || typeof words === 'function')) {
    sourceWordIndexCache.set(words, index);
  }
  return index;
}

/**
 * Finds a valid Countdown-style source phrase: two or three words totalling
 * nine letters and anagramming exactly to the answer.
 * @param {string} answer
 * @param {Iterable<string>|null} words
 * @param {() => number} rng
 * @returns {string[]|null}
 */
export function findConundrumSourceWords(answer, words, rng = Math.random) {
  if (!words) return null;
  const target = letterSignature(answer);
  const index = getSourceWordIndex(words);
  const candidates = index.candidates
    // Only words that can actually be made from the answer can participate;
    // this also keeps the three-word search bounded for a large dictionary.
    .filter((word) => subtractSignature(target, letterSignature(word)) !== null);
  const bySignature = index.bySignature;
  const shuffled = shuffle(candidates, rng);

  for (const first of shuffled) {
    const remainder = subtractSignature(target, letterSignature(first));
    if (!remainder) continue;
    const second = bySignature.get(remainder);
    if (second) return [first, second];
  }

  for (const first of shuffled) {
    const afterFirst = subtractSignature(target, letterSignature(first));
    if (!afterFirst) continue;
    for (const second of shuffled) {
      if (second === first) continue;
      const remainder = subtractSignature(afterFirst, letterSignature(second));
      if (!remainder || remainder.length < 2) continue;
      const third = bySignature.get(letterSignature(remainder));
      if (third && third !== first && third !== second) return [first, second, third];
    }
  }
  return null;
}

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
 * Guarantees that the chosen answer is not already in `usedAnswers` (if provided),
 * so consecutive Conundrum rounds within a single match/session never repeat.
 *
 * @param {(string|object)[]} conundrumList
 * @param {() => number} [rng=Math.random]
 * @param {Iterable<string>|null} [wordList=null] Dictionary used to build the source phrase
 * @param {Set<string>|null} [usedAnswers=null] Set of answer strings already used this match/session
 * @returns {{ answer: string, answers: string[], scrambled: string, sourceWords: string[]|null }}
 */
export function pickConundrum(conundrumList, rng = Math.random, wordList = null, usedAnswers = null) {
  const pool =
    Array.isArray(conundrumList) && conundrumList.length > 0
      ? conundrumList
      : ['COUNTDOWN', 'BROADCAST', 'CHALLENGE', 'ARCHITECT', 'EDUCATION'];

  // Build a shuffled index order so we can walk through candidates without
  // repeating a previously-used answer. Fall back to any entry if all are used.
  const indices = Array.from({ length: pool.length }, (_, i) => i);
  // Fisher-Yates shuffle via rng for a fair pick order
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }

  let chosenEntry = null;
  for (const idx of indices) {
    const candidate = normalizeConundrumEntry(pool[idx]);
    if (!candidate) continue;
    // Accept this candidate if no used-set is supplied, or if none of its
    // accepted answers have been played already this match/session.
    if (!usedAnswers || !candidate.answers.some((a) => usedAnswers.has(a))) {
      chosenEntry = candidate;
      break;
    }
  }

  // Fallback: all pool entries have been used – just pick the first valid one.
  if (!chosenEntry) {
    for (const idx of indices) {
      const candidate = normalizeConundrumEntry(pool[idx]);
      if (candidate) { chosenEntry = candidate; break; }
    }
  }

  const entry = chosenEntry || normalizeConundrumEntry('COUNTDOWN');
  const answer = entry.answer;
  // Mark this answer (and all its aliases) as used for the current match/session.
  if (usedAnswers) {
    for (const a of entry.answers) usedAnswers.add(a);
  }

  const sourceWords = entry.sourceWords || findConundrumSourceWords(answer, wordList, rng);
  const scrambled = sourceWords ? sourceWords.join('') : scrambleConundrum(answer, rng);
  return { answer, answers: entry.answers, scrambled, sourceWords };
}

/**
 * Validates a player's conundrum guess against the target answer.
 * @param {string} guess
 * @param {string|string[]} targetAnswer
 * @returns {boolean}
 */
export function checkConundrumGuess(guess, targetAnswer) {
  if (typeof guess !== 'string') return false;
  const accepted = Array.isArray(targetAnswer) ? targetAnswer : [targetAnswer];
  const normalizedGuess = guess.trim().toUpperCase();
  return accepted.some((answer) => typeof answer === 'string' && normalizedGuess === answer.trim().toUpperCase());
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
