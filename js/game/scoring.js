/**
 * @file js/game/scoring.js
 * Pure scoring engine for Letters, Numbers, and Conundrum rounds in both Solo and Versus modes.
 * Zero DOM access. Fully unit-testable.
 */

/**
 * Calculates the raw point value of a single valid word in a Letters round.
 * Rule: 1 point per letter, except a 9-letter word scores 18 points (double).
 * Invalid words or words shorter than 2 letters score 0.
 *
 * @param {string} word
 * @param {boolean} isValid
 * @returns {number}
 */
export function scoreSingleWord(word, isValid) {
  if (!isValid || typeof word !== 'string') return 0;
  const len = word.trim().length;
  if (len < 2 || len > 9) return 0;
  return len === 9 ? 18 : len;
}

/**
 * Scores a Head-to-Head Versus Letters round between Player 1 and Player 2.
 * Standard TV rule (`onlyLongerScores = true`):
 *   - Only the contestant with the longer valid word scores points.
 *   - If both contestants have valid words of equal length, BOTH score.
 * Relaxed rule (`onlyLongerScores = false`):
 *   - Both contestants score for their respective valid words regardless of opponent length.
 *
 * @param {{ word: string, valid: boolean }} p1
 * @param {{ word: string, valid: boolean }} p2
 * @param {{ onlyLongerScores?: boolean }} [options]
 * @returns {{ p1Points: number, p2Points: number, winner: 0|1|2|'tie' }}
 */
export function scoreVersusLettersRound(p1, p2, { onlyLongerScores = true } = {}) {
  const raw1 = scoreSingleWord(p1?.word || '', Boolean(p1?.valid));
  const raw2 = scoreSingleWord(p2?.word || '', Boolean(p2?.valid));
  const len1 = p1?.valid ? (p1.word || '').trim().length : 0;
  const len2 = p2?.valid ? (p2.word || '').trim().length : 0;

  if (!onlyLongerScores) {
    return {
      p1Points: raw1,
      p2Points: raw2,
      winner: len1 > len2 ? 1 : len2 > len1 ? 2 : len1 > 0 ? 'tie' : 0
    };
  }

  if (len1 > len2) {
    return { p1Points: raw1, p2Points: 0, winner: 1 };
  }
  if (len2 > len1) {
    return { p1Points: 0, p2Points: raw2, winner: 2 };
  }
  if (len1 > 0 && len1 === len2) {
    return { p1Points: raw1, p2Points: raw2, winner: 'tie' };
  }
  return { p1Points: 0, p2Points: 0, winner: 0 };
}

/**
 * Calculates the raw point value of a single Numbers round submission.
 * Default thresholds:
 *   - Distance 0 (exact): 10 points
 *   - Distance 1..5:       7 points
 *   - Distance 6..10:      5 points
 *   - Distance > 10:       0 points
 *
 * @param {number|null|undefined} declaredValue
 * @param {number} target
 * @param {boolean} [isValidSteps=true]
 * @param {{ exact?: number, within5?: number, within10?: number }} [thresholds]
 * @returns {{ points: number, distance: number|null }}
 */
export function scoreSingleNumbers(
  declaredValue,
  target,
  isValidSteps = true,
  thresholds = { exact: 10, within5: 7, within10: 5 }
) {
  if (
    !isValidSteps ||
    declaredValue === null ||
    declaredValue === undefined ||
    Number.isNaN(Number(declaredValue))
  ) {
    return { points: 0, distance: null };
  }
  const dist = Math.abs(Number(declaredValue) - Number(target));
  if (dist === 0) return { points: thresholds.exact ?? 10, distance: 0 };
  if (dist <= 5) return { points: thresholds.within5 ?? 7, distance: dist };
  if (dist <= 10) return { points: thresholds.within10 ?? 5, distance: dist };
  return { points: 0, distance: dist };
}

/**
 * Scores a Head-to-Head Versus Numbers round.
 * Standard TV rule:
 *   - Only the contestant closer to the target (within 10) scores.
 *   - If both contestants are equally close (within 10), BOTH score.
 *
 * @param {{ value: number|null, valid?: boolean }} p1
 * @param {{ value: number|null, valid?: boolean }} p2
 * @param {number} target
 * @param {{ onlyCloserScores?: boolean, exact?: number, within5?: number, within10?: number }} [options]
 * @returns {{ p1Points: number, p2Points: number, p1Distance: number|null, p2Distance: number|null }}
 */
export function scoreVersusNumbersRound(p1, p2, target, options = {}) {
  const { onlyCloserScores = true, exact = 10, within5 = 7, within10 = 5 } = options;
  const s1 = scoreSingleNumbers(p1?.value, target, p1?.valid !== false, { exact, within5, within10 });
  const s2 = scoreSingleNumbers(p2?.value, target, p2?.valid !== false, { exact, within5, within10 });

  if (!onlyCloserScores) {
    return {
      p1Points: s1.points,
      p2Points: s2.points,
      p1Distance: s1.distance,
      p2Distance: s2.distance
    };
  }

  const d1 = s1.distance === null ? Infinity : s1.distance;
  const d2 = s2.distance === null ? Infinity : s2.distance;

  if (d1 < d2) {
    return { p1Points: s1.points, p2Points: 0, p1Distance: s1.distance, p2Distance: s2.distance };
  }
  if (d2 < d1) {
    return { p1Points: 0, p2Points: s2.points, p1Distance: s1.distance, p2Distance: s2.distance };
  }
  return {
    p1Points: s1.points,
    p2Points: s2.points,
    p1Distance: s1.distance,
    p2Distance: s2.distance
  };
}

/**
 * Calculates Solo Conundrum score (10 points minus 3 points per letter hint used, min 1 if solved).
 * @param {boolean} solved
 * @param {number} [hintsUsed=0]
 * @returns {number}
 */
export function scoreSoloConundrum(solved, hintsUsed = 0) {
  if (!solved) return 0;
  return Math.max(1, 10 - Math.max(0, hintsUsed) * 3);
}
