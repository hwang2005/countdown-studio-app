/**
 * @file js/game/letters.js
 * Pure game logic for the Countdown Letters Round.
 * Zero DOM access. Fully unit-testable.
 *
 * Implements:
 * - Authoritative TV vowel & consonant tile frequency distribution
 * - Stack shuffling at the start of a match (with automatic replenishment if exhausted)
 * - Vowel/Consonant selection constraints:
 *     At least 3 vowels and at least 4 consonants in the final 9 tiles.
 * - Word letter-multiset validation (checks whether a candidate word can be formed
 *   using each drawn tile at most once).
 */

import { shuffle, randomInt } from '../core/rng.js';

/**
 * Standard British TV Countdown tile distribution.
 * Vowels (67 tiles total): A×15, E×21, I×13, O×13, U×5
 * Consonants (74 tiles total): standard weighted distribution across the 21 consonants.
 * Tweak weights here to adjust tile probabilities.
 */
export const LETTER_DISTRIBUTION = Object.freeze({
  vowels: Object.freeze({
    A: 15,
    E: 21,
    I: 13,
    O: 13,
    U: 5
  }),
  consonants: Object.freeze({
    B: 2,
    C: 3,
    D: 6,
    F: 2,
    G: 3,
    H: 2,
    J: 1,
    K: 1,
    L: 5,
    M: 4,
    N: 8,
    P: 4,
    Q: 1,
    R: 9,
    S: 9,
    T: 9,
    V: 1,
    W: 1,
    X: 1,
    Y: 1,
    Z: 1
  })
});

export const MIN_VOWELS = 3;
export const MIN_CONSONANTS = 4;
export const BOARD_SIZE = 9;

/**
 * Expands a frequency map (e.g. { A: 15, E: 21 }) into a flat array of letter tiles.
 * @param {Record<string, number>} freqMap
 * @returns {string[]}
 */
export function expandFrequencyMap(freqMap) {
  const stack = [];
  for (const [letter, count] of Object.entries(freqMap)) {
    for (let i = 0; i < count; i++) {
      stack.push(letter.toUpperCase());
    }
  }
  return stack;
}

/**
 * Creates freshly shuffled vowel and consonant stacks for a match.
 * @param {() => number} [rng=Math.random]
 * @returns {{ vowels: string[], consonants: string[] }}
 */
export function createLetterStacks(rng = Math.random) {
  return {
    vowels: shuffle(expandFrequencyMap(LETTER_DISTRIBUTION.vowels), rng),
    consonants: shuffle(expandFrequencyMap(LETTER_DISTRIBUTION.consonants), rng)
  };
}

/**
 * Evaluates whether the picker is allowed to choose another Vowel or Consonant
 * given the current counts of vowels and consonants on the board.
 *
 * Rule: Final 9 letters must contain >= 3 vowels and >= 4 consonants.
 * Therefore:
 *   max vowels allowed = 9 - 4 = 5
 *   max consonants allowed = 9 - 3 = 6
 *
 * @param {number} vowelCount Current vowels picked
 * @param {number} consonantCount Current consonants picked
 * @returns {{ canPickVowel: boolean, canPickConsonant: boolean, isComplete: boolean }}
 */
export function getPickConstraints(vowelCount, consonantCount) {
  const total = vowelCount + consonantCount;
  if (total >= BOARD_SIZE) {
    return { canPickVowel: false, canPickConsonant: false, isComplete: true };
  }
  const maxVowels = BOARD_SIZE - MIN_CONSONANTS; // 5
  const maxConsonants = BOARD_SIZE - MIN_VOWELS; // 6

  return {
    canPickVowel: vowelCount < maxVowels,
    canPickConsonant: consonantCount < maxConsonants,
    isComplete: false
  };
}

/**
 * Draws a single tile ('V' for Vowel, 'C' for Consonant) from the stacks,
 * enforcing the 3-vowel / 4-consonant rule.
 * @param {'V'|'C'} kind
 * @param {{ vowels: string[], consonants: string[] }} stacks
 * @param {string[]} currentBoard
 * @param {() => number} [rng=Math.random]
 * @returns {{ tile: string, nextBoard: string[], vowelCount: number, consonantCount: number }}
 */
export function pickLetterTile(kind, stacks, currentBoard, rng = Math.random) {
  const vowelsSet = new Set(Object.keys(LETTER_DISTRIBUTION.vowels));
  const vowelCount = currentBoard.filter((ch) => vowelsSet.has(ch)).length;
  const consonantCount = currentBoard.length - vowelCount;
  const constraints = getPickConstraints(vowelCount, consonantCount);

  if (constraints.isComplete) {
    throw new Error('Board already has 9 letters.');
  }
  if (kind === 'V' && !constraints.canPickVowel) {
    throw new Error('Cannot pick another vowel: at least 4 consonants are required.');
  }
  if (kind === 'C' && !constraints.canPickConsonant) {
    throw new Error('Cannot pick another consonant: at least 3 vowels are required.');
  }

  let tile;
  if (kind === 'V') {
    if (stacks.vowels.length === 0) {
      stacks.vowels = shuffle(expandFrequencyMap(LETTER_DISTRIBUTION.vowels), rng);
    }
    tile = stacks.vowels.pop();
  } else {
    if (stacks.consonants.length === 0) {
      stacks.consonants = shuffle(expandFrequencyMap(LETTER_DISTRIBUTION.consonants), rng);
    }
    tile = stacks.consonants.pop();
  }

  const nextBoard = [...currentBoard, tile];
  const nextVowelCount = nextBoard.filter((ch) => vowelsSet.has(ch)).length;
  return {
    tile,
    nextBoard,
    vowelCount: nextVowelCount,
    consonantCount: nextBoard.length - nextVowelCount
  };
}

/**
 * Generates a complete valid 9-letter selection (3, 4, or 5 vowels; remaining consonants).
 * @param {{ vowels: string[], consonants: string[] }} stacks
 * @param {string[]} [existingBoard=[]]
 * @param {() => number} [rng=Math.random]
 * @returns {{ board: string[], vowelCount: number, consonantCount: number }}
 */
export function pickRandomRemainingLetters(stacks, existingBoard = [], rng = Math.random) {
  let board = [...existingBoard];
  const vowelsSet = new Set(Object.keys(LETTER_DISTRIBUTION.vowels));
  let vCount = board.filter((c) => vowelsSet.has(c)).length;
  let cCount = board.length - vCount;

  // Target 3, 4, or 5 vowels total
  const minTargetV = Math.max(MIN_VOWELS, vCount);
  const maxTargetV = BOARD_SIZE - Math.max(MIN_CONSONANTS, cCount);
  const targetVowels = randomInt(minTargetV, maxTargetV, rng);

  const remainingChoices = [];
  for (let i = vCount; i < targetVowels; i++) remainingChoices.push('V');
  while (board.length + remainingChoices.length < BOARD_SIZE) {
    remainingChoices.push('C');
  }

  const shuffledChoices = shuffle(remainingChoices, rng);
  for (const choice of shuffledChoices) {
    const res = pickLetterTile(choice, stacks, board, rng);
    board = res.nextBoard;
    vCount = res.vowelCount;
    cCount = res.consonantCount;
  }

  return { board, vowelCount: vCount, consonantCount: cCount };
}

/**
 * Validates whether `word` can be constructed from the 9-letter `board`
 * (using each tile at most once) and optionally checks membership in `dictionarySet`.
 *
 * Explicitly handles edge cases:
 * - Empty string or whitespace
 * - 1-letter words (Countdown requires at least 2 letters, and only words in dictionary)
 * - Non-alphabetic characters
 * - Using a letter more times than it appears on the board
 *
 * @param {string} word
 * @param {string[]} board
 * @param {Set<string>|null} [dictionarySet=null]
 * @returns {{
 *   valid: boolean,
 *   reason: 'ok'|'empty'|'too_short'|'too_long'|'non_alpha'|'missing_letters'|'not_in_dictionary',
 *   missingLetter?: string,
 *   normalizedWord: string
 * }}
 */
export function validateWordSubmission(word, board, dictionarySet = null) {
  if (typeof word !== 'string') {
    return { valid: false, reason: 'empty', normalizedWord: '' };
  }
  const clean = word.trim().toUpperCase();
  if (clean.length === 0) {
    return { valid: false, reason: 'empty', normalizedWord: '' };
  }
  if (!/^[A-Z]+$/.test(clean)) {
    return { valid: false, reason: 'non_alpha', normalizedWord: clean };
  }
  if (clean.length < 2) {
    return { valid: false, reason: 'too_short', normalizedWord: clean };
  }
  if (clean.length > BOARD_SIZE) {
    return { valid: false, reason: 'too_long', normalizedWord: clean };
  }

  // Check tile multiset availability
  const counts = new Map();
  for (const letter of board) {
    const up = String(letter).toUpperCase();
    counts.set(up, (counts.get(up) || 0) + 1);
  }

  for (const ch of clean) {
    const avail = counts.get(ch) || 0;
    if (avail <= 0) {
      return {
        valid: false,
        reason: 'missing_letters',
        missingLetter: ch,
        normalizedWord: clean
      };
    }
    counts.set(ch, avail - 1);
  }

  if (dictionarySet && !dictionarySet.has(clean.toLowerCase())) {
    return { valid: false, reason: 'not_in_dictionary', normalizedWord: clean };
  }

  return { valid: true, reason: 'ok', normalizedWord: clean };
}
