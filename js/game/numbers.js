/**
 * @file js/game/numbers.js
 * Pure game logic for the Countdown Numbers Round.
 * Zero DOM access. Fully unit-testable.
 *
 * Rules:
 * - 6 tiles drawn from 4 large tiles [25, 50, 75, 100] and 20 small tiles (1..10 × 2).
 * - Picker selects 0..4 large tiles; remaining (6 - largeCount) are small.
 * - Target is a random integer in [101, 999].
 * - Allowed operations: +, -, ×, ÷
 * - Each tile may be used at most once; each step consumes two available tiles and
 *   produces one new tile with the result.
 * - Intermediate results must be strictly positive integers (> 0, no fractions).
 */

import { shuffle, randomInt } from '../core/rng.js';

export const LARGE_TILES = Object.freeze([25, 50, 75, 100]);
export const SMALL_TILES = Object.freeze([
  1, 1, 2, 2, 3, 3, 4, 4, 5, 5,
  6, 6, 7, 7, 8, 8, 9, 9, 10, 10
]);
export const NUMBERS_BOARD_SIZE = 6;
export const MIN_TARGET = 101;
export const MAX_TARGET = 999;

/**
 * Draws 6 number tiles according to `largeCount` (0..4).
 * @param {number} largeCount Integer 0..4
 * @param {() => number} [rng=Math.random]
 * @returns {number[]} Array of 6 number values
 */
export function drawNumbersTiles(largeCount, rng = Math.random) {
  const count = Math.max(0, Math.min(4, Math.floor(Number(largeCount) || 0)));
  const smallCount = NUMBERS_BOARD_SIZE - count;

  const shuffledLarge = shuffle(LARGE_TILES, rng);
  const shuffledSmall = shuffle(SMALL_TILES, rng);

  const chosenLarge = shuffledLarge.slice(0, count);
  const chosenSmall = shuffledSmall.slice(0, smallCount);

  return [...chosenLarge, ...chosenSmall];
}

/**
 * Generates a random 3-digit target in [101, 999].
 * @param {() => number} [rng=Math.random]
 * @returns {number}
 */
export function generateTarget(rng = Math.random) {
  return randomInt(MIN_TARGET, MAX_TARGET, rng);
}

/**
 * Validates and computes a single binary arithmetic step `a (op) b`.
 * Enforces Countdown rules:
 * - Result must be a positive integer (> 0).
 * - Division must be exact (`a % b === 0` and `b !== 0`).
 *
 * @param {number} a Left operand
 * @param {'+'|'-'|'*'|'/'|'×'|'÷'} op Operator
 * @param {number} b Right operand
 * @returns {{ valid: boolean, result?: number, error?: string, normalizedOp?: string, expression?: string }}
 */
export function evaluateStep(a, op, b) {
  if (!Number.isInteger(a) || !Number.isInteger(b) || a <= 0 || b <= 0) {
    return { valid: false, error: 'Operands must be positive integers.' };
  }

  switch (op) {
    case '+': {
      const res = a + b;
      return {
        valid: true,
        result: res,
        normalizedOp: '+',
        expression: `${a} + ${b} = ${res}`
      };
    }
    case '-': {
      const res = a - b;
      if (res <= 0) {
        return {
          valid: false,
          error: 'Subtraction result must be a positive integer (> 0).'
        };
      }
      return {
        valid: true,
        result: res,
        normalizedOp: '−',
        expression: `${a} − ${b} = ${res}`
      };
    }
    case '*':
    case '×': {
      const res = a * b;
      return {
        valid: true,
        result: res,
        normalizedOp: '×',
        expression: `${a} × ${b} = ${res}`
      };
    }
    case '/':
    case '÷': {
      if (b === 0 || a % b !== 0) {
        return {
          valid: false,
          error: 'Division must be exact with no remainder.'
        };
      }
      const res = a / b;
      return {
        valid: true,
        result: res,
        normalizedOp: '÷',
        expression: `${a} ÷ ${b} = ${res}`
      };
    }
    default:
      return { valid: false, error: `Unsupported operator: ${op}` };
  }
}

/**
 * Validates a sequence of arithmetic steps against the initial 6 number tiles,
 * ensuring no tile is reused and every intermediate result is legal.
 *
 * @param {number[]} initialTiles The 6 drawn tiles
 * @param {Array<{ a: number, op: string, b: number }>} steps Sequence of steps
 * @returns {{
 *   valid: boolean,
 *   finalValue: number|null,
 *   availableTiles: number[],
 *   error?: string,
 *   formattedSteps: string[]
 * }}
 */
export function validateCalculationSequence(initialTiles, steps) {
  const pool = [...initialTiles];
  const formattedSteps = [];
  let lastResult = null;

  for (let i = 0; i < steps.length; i++) {
    const { a, op, b } = steps[i];

    // Consume operand `a` from pool
    const idxA = pool.indexOf(a);
    if (idxA === -1) {
      return {
        valid: false,
        finalValue: null,
        availableTiles: pool,
        error: `Step ${i + 1}: Tile ${a} is not available in the pool.`,
        formattedSteps
      };
    }
    pool.splice(idxA, 1);

    // Consume operand `b` from pool
    const idxB = pool.indexOf(b);
    if (idxB === -1) {
      return {
        valid: false,
        finalValue: null,
        availableTiles: pool,
        error: `Step ${i + 1}: Tile ${b} is not available in the pool (cannot reuse a single tile twice).`,
        formattedSteps
      };
    }
    pool.splice(idxB, 1);

    const evaluation = evaluateStep(a, op, b);
    if (!evaluation.valid) {
      return {
        valid: false,
        finalValue: null,
        availableTiles: pool,
        error: `Step ${i + 1}: ${evaluation.error}`,
        formattedSteps
      };
    }

    pool.push(evaluation.result);
    lastResult = evaluation.result;
    formattedSteps.push(evaluation.expression);
  }

  return {
    valid: true,
    finalValue: lastResult,
    availableTiles: pool,
    formattedSteps
  };
}
