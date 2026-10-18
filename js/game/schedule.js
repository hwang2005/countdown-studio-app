/**
 * @file js/game/schedule.js
 * Match schedule presets, custom round builder, and alternating picker determination.
 * Zero DOM access. Fully unit-testable.
 *
 * Default 15-round TV schedule:
 * R1 L, R2 L, R3 N, R4 L, R5 L, R6 N, R7 L, R8 L, R9 N, R10 L, R11 L, R12 N, R13 L, R14 L, R15 C
 */

export const SCHEDULE_PRESETS = Object.freeze({
  'tv-15': {
    id: 'tv-15',
    name: 'TV Format (15 Rounds)',
    rounds: Object.freeze(['L', 'L', 'N', 'L', 'L', 'N', 'L', 'L', 'N', 'L', 'L', 'N', 'L', 'L', 'C'])
  },
  'quick-5': {
    id: 'quick-5',
    name: 'Quick Match (5 Rounds)',
    rounds: Object.freeze(['L', 'N', 'L', 'N', 'C'])
  },
  'letters-only': {
    id: 'letters-only',
    name: 'Letters Only (6 Rounds)',
    rounds: Object.freeze(['L', 'L', 'L', 'L', 'L', 'L'])
  },
  'numbers-only': {
    id: 'numbers-only',
    name: 'Numbers Only (6 Rounds)',
    rounds: Object.freeze(['N', 'N', 'N', 'N', 'N', 'N'])
  },
  'conundrum-only': {
    id: 'conundrum-only',
    name: 'Conundrum Sprint (5 Rounds)',
    rounds: Object.freeze(['C', 'C', 'C', 'C', 'C'])
  }
});

/**
 * Returns the array of round types ('L' | 'N' | 'C') for a preset ID or custom list.
 * @param {string} presetId
 * @param {string[]} [customRounds]
 * @returns {string[]}
 */
export function getScheduleRounds(presetId, customRounds = []) {
  if (presetId === 'custom' && Array.isArray(customRounds) && customRounds.length > 0) {
    return customRounds.filter((r) => r === 'L' || r === 'N' || r === 'C');
  }
  const preset = SCHEDULE_PRESETS[presetId] || SCHEDULE_PRESETS['tv-15'];
  return [...preset.rounds];
}

/**
 * Determines which contestant (1 or 2) picks the tiles in a given round index.
 * Player `startingPlayer` (default 1) picks in roundIndex 0 (Round 1), and players alternate each round.
 * @param {number} roundIndex 0-based round index
 * @param {1|2} [startingPlayer=1]
 * @returns {1|2}
 */
export function getPickerForRound(roundIndex, startingPlayer = 1) {
  const isEvenIndex = roundIndex % 2 === 0;
  if (startingPlayer === 1) {
    return isEvenIndex ? 1 : 2;
  }
  return isEvenIndex ? 2 : 1;
}

/**
 * Returns human-readable label for a round type code.
 * @param {'L'|'N'|'C'} roundType
 * @returns {string}
 */
export function getRoundTypeName(roundType) {
  switch (roundType) {
    case 'L':
      return 'Letters';
    case 'N':
      return 'Numbers';
    case 'C':
      return 'Conundrum';
    default:
      return 'Round';
  }
}
