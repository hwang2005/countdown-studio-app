/**
 * @file js/core/state.js
 * Central store and authoritative Finite State Machine (FSM) for game flow.
 *
 * STATE DIAGRAM:
 * ============================================================================
 *   IDLE ──► PICKING ──► CLOCK_RUNNING ──► REVEAL ──► SCORING ──► NEXT_ROUND
 *    ▲          ▲              │             ▲          │             │
 *    │          │              └─────────────┘          ▼             │
 *    │          └───────────────────────────────────────┴─────────────┤
 *    └─────────────────────────── MATCH_END ◄─────────────────────────┘
 * ============================================================================
 *
 * Allowed Transitions:
 * - IDLE          -> ['PICKING', 'IDLE']
 * - PICKING       -> ['PICKING', 'CLOCK_RUNNING', 'REVEAL', 'IDLE']
 * - CLOCK_RUNNING -> ['CLOCK_RUNNING', 'REVEAL', 'PICKING', 'IDLE']
 * - REVEAL        -> ['REVEAL', 'SCORING', 'CLOCK_RUNNING', 'NEXT_ROUND', 'MATCH_END', 'IDLE']
 * - SCORING       -> ['SCORING', 'NEXT_ROUND', 'MATCH_END', 'REVEAL', 'IDLE']
 * - NEXT_ROUND    -> ['PICKING', 'MATCH_END', 'IDLE']
 * - MATCH_END     -> ['IDLE', 'PICKING']
 */

export const PHASES = Object.freeze({
  IDLE: 'IDLE',
  PICKING: 'PICKING',
  CLOCK_RUNNING: 'CLOCK_RUNNING',
  REVEAL: 'REVEAL',
  SCORING: 'SCORING',
  NEXT_ROUND: 'NEXT_ROUND',
  MATCH_END: 'MATCH_END'
});

const ALLOWED_TRANSITIONS = Object.freeze({
  [PHASES.IDLE]: new Set([PHASES.IDLE, PHASES.PICKING]),
  [PHASES.PICKING]: new Set([PHASES.PICKING, PHASES.CLOCK_RUNNING, PHASES.REVEAL, PHASES.IDLE]),
  [PHASES.CLOCK_RUNNING]: new Set([PHASES.CLOCK_RUNNING, PHASES.REVEAL, PHASES.PICKING, PHASES.IDLE]),
  [PHASES.REVEAL]: new Set([
    PHASES.REVEAL,
    PHASES.SCORING,
    PHASES.CLOCK_RUNNING,
    PHASES.NEXT_ROUND,
    PHASES.MATCH_END,
    PHASES.IDLE
  ]),
  [PHASES.SCORING]: new Set([
    PHASES.SCORING,
    PHASES.NEXT_ROUND,
    PHASES.MATCH_END,
    PHASES.REVEAL,
    PHASES.PICKING,
    PHASES.IDLE
  ]),
  [PHASES.NEXT_ROUND]: new Set([PHASES.NEXT_ROUND, PHASES.PICKING, PHASES.MATCH_END, PHASES.IDLE]),
  [PHASES.MATCH_END]: new Set([PHASES.MATCH_END, PHASES.IDLE, PHASES.PICKING])
});

/**
 * Checks whether a state machine transition from `fromPhase` to `toPhase` is legal.
 * @param {string} fromPhase
 * @param {string} toPhase
 * @returns {boolean}
 */
export function canTransition(fromPhase, toPhase) {
  const allowed = ALLOWED_TRANSITIONS[fromPhase];
  return Boolean(allowed && allowed.has(toPhase));
}

/**
 * Creates a fresh initial state for Solo or Versus matches.
 * @param {Partial<object>} [overrides]
 * @returns {object}
 */
export function createInitialMatchState(overrides = {}) {
  return {
    matchId: `match-${Date.now()}`,
    mode: 'versus', // 'solo' | 'versus'
    phase: PHASES.IDLE,
    theme: 'classic-blue',
    panicBlank: false,
    testPattern: false,
    roundIndex: 0, // 0-based index into schedule
    schedule: ['L','L','N','L','L','N','L','L','N','L','L','N','L','L','C'],
    roundType: 'L', // 'L' | 'N' | 'C'
    pickerPlayer: 1, // 1 or 2
    clockDuration: 30,
    clockRemainingMs: 30000,
    clockRunning: false,
    clockStartedAtEpoch: null, // Epoch timestamp for cross-window drift-free sync

    // Contestants
    players: [
      {
        id: 1,
        name: 'Contestant 1',
        color: '#38BDF8',
        score: 0,
        submission: '',
        valid: null,
        roundPoints: 0,
        lockedOut: false
      },
      {
        id: 2,
        name: 'Contestant 2',
        color: '#F59E0B',
        score: 0,
        submission: '',
        valid: null,
        roundPoints: 0,
        lockedOut: false
      }
    ],

    // Letters Round State
    letters: [],
    vowelCount: 0,
    consonantCount: 0,
    bestWords: [],

    // Numbers Round State
    numbers: [],
    largeCount: null,
    target: null,
    targetRolling: false,
    numbersSolution: null,
    showNumbersSolutionOnDisplay: false,

    // Conundrum Round State
    conundrumScrambled: '',
    conundrumAnswer: '',
    conundrumSourceWords: null,
    conundrumRevealed: false,
    activeBuzzerPlayer: null, // 1 | 2 | null
    buzzerTimestamp: null,
    buzzerRemainingMs: 5000,

    // Dictionary Challenge Banner
    challengeResult: null, // { word, valid, definition }

    // Round History & Operator Log
    roundHistory: [],
    actionLog: [],

    ...overrides
  };
}

/**
 * Central state store with FSM validation, subscriber notifications, and undo history.
 */
export class GameStore {
  /**
   * @param {object} [initialState]
   */
  constructor(initialState = createInitialMatchState()) {
    this.state = structuredClone(initialState);
    /** @type {Set<(state: object, action: object) => void>} */
    this.subscribers = new Set();
    /** @type {object[]} */
    this.undoStack = [];
  }

  /**
   * Returns current state snapshot.
   * @returns {object}
   */
  getState() {
    return this.state;
  }

  /**
   * Subscribe to store updates.
   * @param {(state: object, action: object) => void} listener
   * @returns {() => void}
   */
  subscribe(listener) {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  /**
   * Transition phase with strict FSM validation.
   * Throws an Error if the transition is illegal.
   * @param {string} nextPhase
   * @param {Partial<object>} [patch]
   * @param {string} [logMessage]
   */
  transition(nextPhase, patch = {}, logMessage = '') {
    const currentPhase = this.state.phase;
    if (!canTransition(currentPhase, nextPhase)) {
      throw new Error(`Illegal state transition: ${currentPhase} -> ${nextPhase}`);
    }
    this.pushUndo();
    const nextLog = logMessage
      ? [
          {
            time: new Date().toLocaleTimeString(),
            message: logMessage
          },
          ...(this.state.actionLog || []).slice(0, 99)
        ]
      : this.state.actionLog;

    this.state = {
      ...this.state,
      ...patch,
      phase: nextPhase,
      actionLog: nextLog
    };
    this.notify({ type: 'TRANSITION', phase: nextPhase, logMessage });
  }

  /**
   * Updates state within the current phase (or replaces state from sync).
   * @param {Partial<object>} patch
   * @param {object} [options]
   * @param {boolean} [options.recordUndo=false]
   * @param {string} [options.logMessage='']
   */
  update(patch, { recordUndo = false, logMessage = '' } = {}) {
    if (patch.phase && patch.phase !== this.state.phase) {
      if (!canTransition(this.state.phase, patch.phase)) {
        throw new Error(`Illegal state transition: ${this.state.phase} -> ${patch.phase}`);
      }
    }
    if (recordUndo) {
      this.pushUndo();
    }
    const nextLog = logMessage
      ? [
          {
            time: new Date().toLocaleTimeString(),
            message: logMessage
          },
          ...(this.state.actionLog || []).slice(0, 99)
        ]
      : patch.actionLog || this.state.actionLog;

    this.state = {
      ...this.state,
      ...patch,
      actionLog: nextLog
    };
    this.notify({ type: 'UPDATE', logMessage });
  }

  /**
   * Replaces entire state (used by Stage Display when syncing from Host).
   * @param {object} fullState
   */
  replaceState(fullState) {
    this.state = structuredClone(fullState);
    this.notify({ type: 'SYNC_REPLACE' });
  }

  /**
   * Pushes current state onto the undo stack (max 25 snapshots).
   */
  pushUndo() {
    this.undoStack.push(structuredClone(this.state));
    if (this.undoStack.length > 25) {
      this.undoStack.shift();
    }
  }

  /**
   * Restores previous state from the undo stack.
   * @returns {boolean} True if undo succeeded
   */
  undo() {
    if (this.undoStack.length === 0) return false;
    const prev = this.undoStack.pop();
    this.state = prev;
    this.notify({ type: 'UNDO' });
    return true;
  }

  /**
   * Notifies all subscribers.
   * @param {object} action
   */
  notify(action) {
    for (const listener of this.subscribers) {
      try {
        listener(this.state, action);
      } catch (err) {
        console.error('[GameStore] Subscriber error:', err);
      }
    }
  }
}
