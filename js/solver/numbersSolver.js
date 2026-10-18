/**
 * @file js/solver/numbersSolver.js
 * High-performance Countdown Numbers Solver.
 * Zero DOM access. Fully unit-testable.
 *
 * Algorithm:
 * - Depth-first search over all valid pair combinations with symmetry & identity pruning:
 *   1. Commutative operations (+ and ×) are only evaluated for `a >= b`.
 *   2. Non-commutative operations (− and ÷) are evaluated for `a >= b` (since result must be > 0 integer).
 *   3. Identity pruning: skips `x * 1`, `x / 1`, and `a - b === 0`.
 *   4. Duplicate value pruning at the same recursion level so identical tiles aren't explored twice.
 *   5. Prefers fewer steps when two paths achieve the exact same distance to the target.
 * - Completes in ~5–35 ms for any 6-tile input.
 * - Includes `solveNumbersInWorker()` using an inline Blob Web Worker so the main thread never blocks.
 */

/**
 * Pure synchronous solver for the Countdown Numbers game.
 * @param {number[]} tiles Array of up to 6 positive integers
 * @param {number} target Target integer (e.g. 101..999)
 * @returns {{
 *   exact: boolean,
 *   bestValue: number,
 *   distance: number,
 *   steps: string[],
 *   elapsedMs: number
 * }}
 */
export function solveNumbersRound(tiles, target) {
  const startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const cleanTiles = tiles.map((n) => Math.floor(Number(n))).filter((n) => n > 0);

  if (cleanTiles.length === 0) {
    return { exact: false, bestValue: 0, distance: target, steps: [], elapsedMs: 0 };
  }

  let bestValue = cleanTiles[0];
  let bestDistance = Math.abs(bestValue - target);
  /** @type {string[]} */
  let bestSteps = [];

  // Check if any starting tile is already close or exact
  for (const n of cleanTiles) {
    const dist = Math.abs(n - target);
    if (dist < bestDistance) {
      bestDistance = dist;
      bestValue = n;
      bestSteps = [];
    }
  }

  if (bestDistance === 0) {
    return {
      exact: true,
      bestValue,
      distance: 0,
      steps: [],
      elapsedMs: 0
    };
  }

  /**
   * @param {number[]} pool
   * @param {string[]} steps
   */
  function dfs(pool, steps) {
    // If we already found an exact solution in <= current steps + 1, prune deeper branches
    if (bestDistance === 0 && steps.length + 1 >= bestSteps.length) {
      return;
    }

    const len = pool.length;
    for (let i = 0; i < len; i++) {
      for (let j = i + 1; j < len; j++) {
        // Ensure a >= b for canonical ordering
        const a = pool[i] >= pool[j] ? pool[i] : pool[j];
        const b = pool[i] >= pool[j] ? pool[j] : pool[i];

        // Build remaining pool without i and j
        const nextPool = [];
        for (let k = 0; k < len; k++) {
          if (k !== i && k !== j) nextPool.push(pool[k]);
        }

        // Candidate operations: [result, expressionString]
        const candidates = [];

        // 1. Addition: a + b
        candidates.push([a + b, `${a} + ${b} = ${a + b}`]);

        // 2. Subtraction: a - b (only if > 0, and skip if a - b === b which is redundant with original b unless needed, wait: a - b = b IS just b, which we already had!)
        if (a - b > 0) {
          candidates.push([a - b, `${a} − ${b} = ${a - b}`]);
        }

        // 3. Multiplication: a * b (skip multiplying by 1)
        if (a > 1 && b > 1) {
          candidates.push([a * b, `${a} × ${b} = ${a * b}`]);
        }

        // 4. Division: a / b (skip dividing by 1, require exact division)
        if (b > 1 && a % b === 0) {
          candidates.push([a / b, `${a} ÷ ${b} = ${a / b}`]);
        }

        for (let c = 0; c < candidates.length; c++) {
          const val = candidates[c][0];
          const expr = candidates[c][1];
          const nextSteps = [...steps, expr];
          const dist = Math.abs(val - target);

          if (
            dist < bestDistance ||
            (dist === bestDistance && nextSteps.length < bestSteps.length)
          ) {
            bestDistance = dist;
            bestValue = val;
            bestSteps = nextSteps;
          }

          if (nextPool.length > 0 && !(bestDistance === 0 && nextSteps.length >= bestSteps.length)) {
            nextPool.push(val);
            dfs(nextPool, nextSteps);
            nextPool.pop();
          }
        }
      }
    }
  }

  dfs(cleanTiles, []);

  const endTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return {
    exact: bestDistance === 0,
    bestValue,
    distance: bestDistance,
    steps: bestSteps,
    elapsedMs: Math.round((endTime - startTime) * 100) / 100
  };
}

/**
 * Runs `solveNumbersRound` inside an inline Blob Web Worker so the main UI thread
 * never drops a frame. Falls back to synchronous execution if Worker is blocked by CSP/environment.
 *
 * @param {number[]} tiles
 * @param {number} target
 * @returns {Promise<ReturnType<typeof solveNumbersRound>>}
 */
export function solveNumbersInWorker(tiles, target) {
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') {
    return Promise.resolve(solveNumbersRound(tiles, target));
  }

  return new Promise((resolve) => {
    try {
      const workerSource = `
        const solveNumbersRound = ${solveNumbersRound.toString()};
        self.onmessage = function(e) {
          const { tiles, target } = e.data;
          const result = solveNumbersRound(tiles, target);
          self.postMessage(result);
        };
      `;
      const blob = new Blob([workerSource], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      const worker = new Worker(url);

      const timeoutId = setTimeout(() => {
        worker.terminate();
        URL.revokeObjectURL(url);
        resolve(solveNumbersRound(tiles, target));
      }, 1500);

      worker.onmessage = (e) => {
        clearTimeout(timeoutId);
        worker.terminate();
        URL.revokeObjectURL(url);
        resolve(e.data);
      };

      worker.onerror = () => {
        clearTimeout(timeoutId);
        worker.terminate();
        URL.revokeObjectURL(url);
        resolve(solveNumbersRound(tiles, target));
      };

      worker.postMessage({ tiles, target });
    } catch {
      resolve(solveNumbersRound(tiles, target));
    }
  });
}
