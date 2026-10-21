/**
 * @file js/app-solo.js
 * Controller for /solo.html (Solo Practice Mode).
 *
 * Implements:
 * - Drill selector: Full 15-Round Match, Letters Only, Numbers Only, Conundrums Only, Daily Challenge (date-seeded)
 * - Letters Round: Vowel/Consonant/Random buttons with live counters and 3V/4C rule enforcement,
 *   interactive tile tray, keyboard typing + Backspace + Enter, Shuffle tiles, Dictionary Corner solver
 * - Numbers Round: 0..4 Large tile picker + Random, 3-digit slot machine target roll,
 *   interactive step-by-step arithmetic calculation board (Tile -> Operator -> Tile -> New Tile),
 *   Undo/Reset/Submit, and Web Worker DFS solver with exact/closest step breakdown
 * - Conundrum Round: Drag-to-reorder 9-letter anagram tiles, hint button (-3 pts),
 *   optional Web Speech API voice answer recognition, tile-flip answer reveal
 * - Session Summary screen with persistent stats recording and shareable clipboard summary.
 */

import {
  loadSettings,
  applySettingsToDOM,
  recordSoloSession
} from './core/storage.js';
import { createRNG, getTodaySeed, shuffle, randomInt } from './core/rng.js';
import { audio } from './core/audio.js';
import { CountdownClock, renderClockWidget } from './core/clock.js';
import {
  createLetterStacks,
  getPickConstraints,
  pickLetterTile,
  pickRandomRemainingLetters,
  validateWordSubmission
} from './game/letters.js';
import {
  drawNumbersTiles,
  generateTarget,
  evaluateStep
} from './game/numbers.js';
import {
  pickConundrum,
  checkConundrumGuess
} from './game/conundrum.js';
import {
  scoreSingleWord,
  scoreSingleNumbers,
  scoreSoloConundrum
} from './game/scoring.js';
import { getScheduleRounds, getRoundTypeName } from './game/schedule.js';
import { loadDictionary, solveLettersRound } from './solver/wordSolver.js';
import { solveNumbersInWorker } from './solver/numbersSolver.js';
import {
  renderLetterTiles,
  renderNumberTiles,
  animateTargetSlotRoll
} from './ui/tiles.js';
import {
  renderWordTray,
  renderDictionaryCorner,
  renderNumbersSolution
} from './ui/board.js';
import { animateScoreTo, launchConfetti } from './ui/scoreboard.js';
import { initModalHandlers } from './ui/modal.js';
import { showToast } from './ui/toast.js';
import { announce, haptic, requestWakeLock } from './ui/a11y.js';
import { currentUser } from './auth.js';

let settings = loadSettings();
let dictData = null;
let rng = Math.random;

// Active Session State
let session = {
  drillMode: 'full', // 'full' | 'letters' | 'numbers' | 'conundrum' | 'daily'
  schedule: [],
  roundIndex: 0,
  totalScore: 0,
  maxPossibleScore: 0,
  stacks: null,
  phase: 'PICKING', // 'PICKING' | 'PLAYING' | 'REVEAL' | 'SUMMARY'

  // Current Letters Round
  letters: [],
  vowelCount: 0,
  consonantCount: 0,
  pickedSlots: [], // Array of { index: number, letter: string }

  // Current Numbers Round
  initialNumbers: [],
  numberPool: [], // Array of { id, value, consumed }
  selectedNumIndex: null,
  selectedOperator: null,
  calcSteps: [], // Array of { expr, snapshotPool }
  target: null,
  numbersSolution: null,

  // Current Conundrum Round
  conundrumAnswer: '',
  conundrumAnswers: [],
  conundrumTiles: [],
  revealedHintIndices: new Set(),
  hintsUsed: 0,

  // Stats accumulators for session summary
  stats: {
    bestWord: '',
    wordsSubmitted: 0,
    validWords: 0,
    totalWordLength: 0,
    numbersPlayed: 0,
    numbersExact: 0,
    conundrumsPlayed: 0,
    conundrumsSolved: 0,
    roundLog: []
  }
};

let clock = null;

function getRoundType() {
  return session.schedule[session.roundIndex] || 'L';
}

function updateHUD() {
  const roundLabel = document.getElementById('solo-round-indicator');
  const type = getRoundType();
  if (roundLabel) {
    roundLabel.textContent = `Round ${session.roundIndex + 1} of ${
      session.schedule.length
    } · ${getRoundTypeName(type)}`;
  }
  const scoreEl = document.getElementById('solo-total-score');
  if (scoreEl) {
    animateScoreTo(scoreEl, session.totalScore);
  }

  const user = currentUser();
  const playerInd = document.getElementById('solo-player-indicator');
  const playerName = document.getElementById('solo-player-name');
  if (playerInd && playerName) {
    playerInd.hidden = false;
    playerName.textContent = user ? (user.displayName || user.username) : 'Guest Player';
  }
}

function startDrillSession(drillMode) {
  settings = loadSettings();
  session.drillMode = drillMode;

  if (drillMode === 'daily') {
    rng = createRNG(getTodaySeed());
    session.schedule = ['L', 'L', 'N', 'L', 'C'];
  } else {
    rng = createRNG();
    if (drillMode === 'letters') {
      session.schedule = ['L', 'L', 'L', 'L', 'L', 'L'];
    } else if (drillMode === 'numbers') {
      session.schedule = ['N', 'N', 'N', 'N', 'N', 'N'];
    } else if (drillMode === 'conundrum') {
      session.schedule = ['C', 'C', 'C', 'C', 'C'];
    } else {
      session.schedule = getScheduleRounds(settings.schedulePreset, settings.customSchedule);
    }
  }

  session.roundIndex = 0;
  session.totalScore = 0;
  session.maxPossibleScore = 0;
  session.stacks = createLetterStacks(rng);
  session.stats = {
    bestWord: '',
    wordsSubmitted: 0,
    validWords: 0,
    totalWordLength: 0,
    numbersPlayed: 0,
    numbersExact: 0,
    conundrumsPlayed: 0,
    conundrumsSolved: 0,
    roundLog: []
  };

  // Highlight active drill tab
  document.querySelectorAll('[data-drill]').forEach((btn) => {
    const active = btn.getAttribute('data-drill') === drillMode;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', String(active));
  });

  requestWakeLock();
  setupCurrentRound();
}

function setupCurrentRound() {
  if (clock) clock.reset();
  audio.resetClockTracker();

  const summarySec = document.getElementById('solo-summary-section');
  const playSec = document.getElementById('solo-play-section');
  const revealSec = document.getElementById('solo-reveal-section');
  if (summarySec) summarySec.hidden = true;
  if (playSec) playSec.hidden = false;
  if (revealSec) revealSec.hidden = true;

  const type = getRoundType();
  session.phase = 'PICKING';
  updateHUD();

  const lettersZone = document.getElementById('zone-letters');
  const numbersZone = document.getElementById('zone-numbers');
  const conundrumZone = document.getElementById('zone-conundrum');

  if (lettersZone) lettersZone.hidden = type !== 'L';
  if (numbersZone) numbersZone.hidden = type !== 'N';
  if (conundrumZone) conundrumZone.hidden = type !== 'C';

  const clockContainer = document.getElementById('solo-clock-container');
  if (clockContainer) {
    renderClockWidget(clockContainer, settings.clockDuration * 1000, settings.clockDuration * 1000);
  }

  if (type === 'L') {
    initLettersRound();
  } else if (type === 'N') {
    initNumbersRound();
  } else {
    initConundrumRound();
  }
}

/* ============================================================================
 * LETTERS ROUND LOGIC
 * ========================================================================== */
function initLettersRound() {
  session.letters = [];
  session.vowelCount = 0;
  session.consonantCount = 0;
  session.pickedSlots = [];

  const pickingControls = document.getElementById('letters-picking-controls');
  const playControls = document.getElementById('letters-play-controls');
  if (pickingControls) pickingControls.hidden = false;
  if (playControls) playControls.hidden = true;

  updateLettersPickingUI();
}

function updateLettersPickingUI() {
  const boardEl = document.getElementById('letters-board');
  renderLetterTiles(boardEl, session.letters, {
    usedIndices: session.pickedSlots.map((s) => s.index),
    interactive: session.phase === 'PLAYING',
    onTileClick: (idx, ch) => {
      if (session.phase !== 'PLAYING') return;
      session.pickedSlots.push({ index: idx, letter: ch });
      audio.playTileFlip();
      haptic(10);
      syncWordBuilderUI();
    }
  });

  const counterEl = document.getElementById('letters-counter');
  if (counterEl) {
    counterEl.textContent = `Vowels ${session.vowelCount}/9 · Consonants ${session.consonantCount}/9`;
  }

  const constraints = getPickConstraints(session.vowelCount, session.consonantCount);
  const vowelBtn = document.getElementById('btn-pick-vowel');
  const consBtn = document.getElementById('btn-pick-consonant');
  const randBtn = document.getElementById('btn-pick-random');

  if (vowelBtn) vowelBtn.disabled = !constraints.canPickVowel;
  if (consBtn) consBtn.disabled = !constraints.canPickConsonant;
  if (randBtn) randBtn.disabled = constraints.isComplete;

  if (constraints.isComplete && session.phase === 'PICKING') {
    beginLettersClock();
  }
}

function beginLettersClock() {
  session.phase = 'PLAYING';
  const pickingControls = document.getElementById('letters-picking-controls');
  const playControls = document.getElementById('letters-play-controls');
  if (pickingControls) pickingControls.hidden = true;
  if (playControls) playControls.hidden = false;

  updateLettersPickingUI();
  syncWordBuilderUI();
  announce(`9 letters drawn: ${session.letters.join(', ')}. Clock running.`);
  startRoundClock(() => submitLettersRound());
}

function syncWordBuilderUI() {
  const boardEl = document.getElementById('letters-board');
  renderLetterTiles(boardEl, session.letters, {
    usedIndices: session.pickedSlots.map((s) => s.index),
    interactive: session.phase === 'PLAYING',
    onTileClick: (idx, ch) => {
      if (session.phase !== 'PLAYING') return;
      session.pickedSlots.push({ index: idx, letter: ch });
      audio.playTileFlip();
      syncWordBuilderUI();
    }
  });

  const trayEl = document.getElementById('letters-word-tray');
  renderWordTray(trayEl, session.pickedSlots, (slotPos) => {
    if (session.phase !== 'PLAYING') return;
    session.pickedSlots.splice(slotPos, 1);
    syncWordBuilderUI();
  });
}

function handleLetterTyping(char) {
  const up = char.toUpperCase();
  const usedSet = new Set(session.pickedSlots.map((s) => s.index));
  const matchIdx = session.letters.findIndex((ch, idx) => ch === up && !usedSet.has(idx));

  if (matchIdx === -1) {
    const trayEl = document.getElementById('letters-word-tray');
    if (trayEl) {
      trayEl.classList.remove('anim-shake');
      void trayEl.offsetWidth;
      trayEl.classList.add('anim-shake');
    }
    audio.playInvalidBuzz();
    return;
  }

  session.pickedSlots.push({ index: matchIdx, letter: up });
  audio.playTileFlip();
  syncWordBuilderUI();
}

function submitLettersRound() {
  if (session.phase === 'REVEAL') return;
  audio.stopClockMusic();
  session.phase = 'REVEAL';
  if (clock) clock.pause();

  const candidateWord = session.pickedSlots.map((s) => s.letter).join('');
  const validation = validateWordSubmission(
    candidateWord,
    session.letters,
    dictData ? dictData.wordSet : null
  );
  const points = scoreSingleWord(candidateWord, validation.valid);
  const solverResult = dictData
    ? solveLettersRound(session.letters, dictData.trie, 12)
    : { topWords: [], maxLength: 0, byLength: {}, totalFound: 0 };

  const maxRoundPts = solverResult.maxLength === 9 ? 18 : solverResult.maxLength;
  session.totalScore += points;
  session.maxPossibleScore += maxRoundPts;

  session.stats.wordsSubmitted += 1;
  if (validation.valid) {
    session.stats.validWords += 1;
    session.stats.totalWordLength += candidateWord.length;
    if (candidateWord.length > session.stats.bestWord.length) {
      session.stats.bestWord = candidateWord;
    }
    audio.playValidChime();
    if (candidateWord.length === 9) {
      audio.playFanfare();
      launchConfetti();
    }
  } else {
    audio.playInvalidBuzz();
  }

  session.stats.roundLog.push({
    round: session.roundIndex + 1,
    type: 'Letters',
    prompt: session.letters.join(' '),
    answer: candidateWord || '(none)',
    valid: validation.valid,
    points,
    best: solverResult.topWords[0] || '—'
  });

  updateHUD();
  showRevealPanel({
    title: validation.valid
      ? `✓ "${candidateWord}" is valid — +${points} points!`
      : `✗ "${candidateWord || 'No word'}" — 0 points (${formatReason(validation.reason)})`,
    isValid: validation.valid,
    mode: 'L',
    solverResult,
    playerWord: candidateWord
  });
}

function formatReason(reason) {
  switch (reason) {
    case 'empty':
      return 'no word entered';
    case 'too_short':
      return 'minimum 2 letters required';
    case 'missing_letters':
      return 'uses letters not on the board';
    case 'not_in_dictionary':
      return 'not in Countdown dictionary';
    default:
      return 'invalid submission';
  }
}

/* ============================================================================
 * NUMBERS ROUND LOGIC
 * ========================================================================== */
function initNumbersRound() {
  session.initialNumbers = [];
  session.numberPool = [];
  session.selectedNumIndex = null;
  session.selectedOperator = null;
  session.calcSteps = [];
  session.target = null;
  session.numbersSolution = null;

  const pickControls = document.getElementById('numbers-picking-controls');
  const calcControls = document.getElementById('numbers-calc-controls');
  if (pickControls) pickControls.hidden = false;
  if (calcControls) calcControls.hidden = true;

  const targetEl = document.getElementById('numbers-target-value');
  if (targetEl) targetEl.textContent = '000';

  const boardEl = document.getElementById('numbers-board');
  renderNumberTiles(boardEl, [], { interactive: false });
}

function selectLargeTileCount(largeCount) {
  if (session.phase !== 'PICKING') return;
  const drawn = drawNumbersTiles(largeCount, rng);
  const target = generateTarget(rng);

  session.initialNumbers = drawn;
  session.numberPool = drawn.map((val, idx) => ({ id: idx, value: val, consumed: false }));
  session.target = target;
  session.phase = 'PLAYING';

  const pickControls = document.getElementById('numbers-picking-controls');
  const calcControls = document.getElementById('numbers-calc-controls');
  if (pickControls) pickControls.hidden = true;
  if (calcControls) calcControls.hidden = false;

  audio.playTileFlip();
  syncNumbersCalcUI();

  const targetEl = document.getElementById('numbers-target-value');
  animateTargetSlotRoll(targetEl, target, () => {
    announce(`Target is ${target}. Tiles are ${drawn.join(', ')}.`);
    startRoundClock(() => submitNumbersRound());
  });

  // Pre-compute solver solution in Web Worker so it's ready instantly on reveal
  solveNumbersInWorker(drawn, target).then((sol) => {
    session.numbersSolution = sol;
  });
}

function syncNumbersCalcUI() {
  const boardEl = document.getElementById('numbers-board');
  const values = session.numberPool.map((item) => item.value);
  const consumedIndices = session.numberPool
    .map((item, idx) => (item.consumed ? idx : -1))
    .filter((idx) => idx !== -1);

  renderNumberTiles(boardEl, values, {
    selectedIndex: session.selectedNumIndex,
    consumedIndices,
    interactive: session.phase === 'PLAYING',
    onTileClick: (idx) => handleNumberTileClick(idx)
  });

  // Highlight active operator button
  document.querySelectorAll('[data-calc-op]').forEach((btn) => {
    const op = btn.getAttribute('data-calc-op');
    const active = session.selectedOperator === op;
    btn.classList.toggle('is-selected', active);
    btn.setAttribute('aria-pressed', String(active));
  });

  // Render steps list
  const stepsEl = document.getElementById('numbers-steps-list');
  if (stepsEl) {
    stepsEl.innerHTML = '';
    if (session.calcSteps.length === 0) {
      const hint = document.createElement('div');
      hint.style.color = 'var(--text-muted)';
      hint.textContent = 'Click a number tile → choose an operator (+ − × ÷) → click a second number tile.';
      stepsEl.appendChild(hint);
    } else {
      session.calcSteps.forEach((step, idx) => {
        const line = document.createElement('div');
        line.textContent = `${idx + 1}. ${step.expr}`;
        stepsEl.appendChild(line);
      });
    }
  }

  // Update best current value indicator
  const bestInput = document.getElementById('numbers-declared-input');
  if (bestInput && session.target) {
    const activeVals = session.numberPool.filter((t) => !t.consumed).map((t) => t.value);
    if (activeVals.length > 0) {
      let closest = activeVals[0];
      for (const v of activeVals) {
        if (Math.abs(v - session.target) < Math.abs(closest - session.target)) {
          closest = v;
        }
      }
      bestInput.value = String(closest);
    }
  }
}

function handleNumberTileClick(idx) {
  if (session.phase !== 'PLAYING') return;
  const clicked = session.numberPool[idx];
  if (!clicked || clicked.consumed) return;

  if (session.selectedNumIndex === null) {
    session.selectedNumIndex = idx;
    audio.playTileFlip();
    syncNumbersCalcUI();
    return;
  }

  if (session.selectedNumIndex === idx) {
    session.selectedNumIndex = null;
    session.selectedOperator = null;
    syncNumbersCalcUI();
    return;
  }

  if (!session.selectedOperator) {
    // Switch selection to the newly clicked tile
    session.selectedNumIndex = idx;
    audio.playTileFlip();
    syncNumbersCalcUI();
    return;
  }

  // Perform calculation: firstTile (op) secondTile
  const firstTile = session.numberPool[session.selectedNumIndex];
  const res = evaluateStep(firstTile.value, session.selectedOperator, clicked.value);

  const errEl = document.getElementById('numbers-calc-error');
  if (!res.valid) {
    if (errEl) {
      errEl.textContent = res.error;
      errEl.hidden = false;
    }
    audio.playInvalidBuzz();
    return;
  }
  if (errEl) errEl.hidden = true;

  // Save snapshot for Undo
  const snapshotPool = structuredClone(session.numberPool);
  firstTile.consumed = true;
  clicked.consumed = true;
  session.numberPool.push({
    id: session.numberPool.length,
    value: res.result,
    consumed: false
  });

  session.calcSteps.push({
    expr: res.expression,
    snapshotPool,
    resultValue: res.result
  });

  session.selectedNumIndex = session.numberPool.length - 1; // Auto-select newly created tile for chaining!
  session.selectedOperator = null;
  audio.playTileFlip();
  syncNumbersCalcUI();

  if (res.result === session.target) {
    showToast(`Exact target ${session.target} reached!`, 'success');
  }
}

async function submitNumbersRound() {
  if (session.phase === 'REVEAL') return;
  audio.stopClockMusic();
  session.phase = 'REVEAL';
  if (clock) clock.pause();

  const declaredInput = document.getElementById('numbers-declared-input');
  const declaredVal =
    declaredInput && declaredInput.value.trim() !== ''
      ? Number(declaredInput.value)
      : null;

  // Verify declaredVal is actually present in the player's available or initial tiles
  const reachableByPlayer = new Set([
    ...session.initialNumbers,
    ...session.calcSteps.map((s) => s.resultValue)
  ]);
  const isReachable = declaredVal !== null && reachableByPlayer.has(declaredVal);

  const scoreRes = scoreSingleNumbers(declaredVal, session.target, isReachable, {
    exact: settings.numbersExactPoints,
    within5: settings.numbersClose5Points,
    within10: settings.numbersClose10Points
  });

  if (!session.numbersSolution) {
    session.numbersSolution = await solveNumbersInWorker(session.initialNumbers, session.target);
  }

  session.totalScore += scoreRes.points;
  session.maxPossibleScore += 10;
  session.stats.numbersPlayed += 1;
  if (scoreRes.distance === 0) {
    session.stats.numbersExact += 1;
    audio.playFanfare();
  } else if (scoreRes.points > 0) {
    audio.playValidChime();
  } else {
    audio.playInvalidBuzz();
  }

  session.stats.roundLog.push({
    round: session.roundIndex + 1,
    type: 'Numbers',
    prompt: `${session.initialNumbers.join(', ')} → ${session.target}`,
    answer: isReachable ? String(declaredVal) : 'Not reached',
    valid: scoreRes.points > 0,
    points: scoreRes.points,
    best: String(session.numbersSolution.bestValue)
  });

  updateHUD();
  showRevealPanel({
    title: isReachable
      ? `Result: ${declaredVal} (${
          scoreRes.distance === 0 ? 'Exact hit!' : `${scoreRes.distance} away`
        }) — +${scoreRes.points} points`
      : `Result not constructed on board — 0 points`,
    isValid: scoreRes.points > 0,
    mode: 'N',
    numbersSolution: session.numbersSolution,
    target: session.target
  });
}

/* ============================================================================
 * CONUNDRUM ROUND LOGIC
 * ========================================================================== */
function initConundrumRound() {
  const { answer, answers, scrambled } = pickConundrum(
    dictData ? dictData.conundrums : [], rng, dictData?.wordSet
  );
  session.conundrumAnswer = answer;
  session.conundrumAnswers = answers;
  session.conundrumTiles = scrambled.split('');
  session.revealedHintIndices = new Set();
  session.hintsUsed = 0;
  session.phase = 'PLAYING';

  const input = document.getElementById('conundrum-guess-input');
  if (input) {
    input.value = '';
    input.focus();
  }

  const hintRow = document.getElementById('conundrum-hint-slots');
  if (hintRow) {
    hintRow.textContent = 'Answer pattern: _ _ _ _ _ _ _ _ _';
  }
  const prompt = document.getElementById('solo-conundrum-prompt');
  if (prompt) prompt.hidden = true;

  renderConundrumBoard();
  announce(`Countdown Conundrum: ${scrambled.split('').join(' ')}`);
  startRoundClock(() => submitConundrumRound());
}

function renderConundrumBoard() {
  const boardEl = document.getElementById('conundrum-board');
  renderLetterTiles(boardEl, session.conundrumTiles, {
    isConundrum: true,
    interactive: false,
    onReorder: (newOrder) => {
      session.conundrumTiles = newOrder;
      audio.playTileFlip();
      renderConundrumBoard();
    }
  });
}

function revealConundrumHint() {
  if (session.phase !== 'PLAYING') return;
  const unrevealed = [];
  for (let i = 0; i < 9; i++) {
    if (!session.revealedHintIndices.has(i)) unrevealed.push(i);
  }
  if (unrevealed.length <= 1) {
    showToast('Maximum hints revealed.', 'info');
    return;
  }

  const idx = unrevealed[randomInt(0, unrevealed.length - 1, rng)];
  session.revealedHintIndices.add(idx);
  session.hintsUsed += 1;

  const pattern = session.conundrumAnswer
    .split('')
    .map((ch, i) => (session.revealedHintIndices.has(i) ? ch : '_'))
    .join(' ');

  const hintRow = document.getElementById('conundrum-hint-slots');
  if (hintRow) {
    hintRow.textContent = `Hint (-${session.hintsUsed * 3} pts): ${pattern}`;
  }
  audio.playTileFlip();
}

function submitConundrumRound() {
  if (session.phase === 'REVEAL') return;
  audio.stopClockMusic();
  session.phase = 'REVEAL';
  if (clock) clock.pause();

  const input = document.getElementById('conundrum-guess-input');
  const guess = input ? input.value.trim().toUpperCase() : '';
  const solved = checkConundrumGuess(guess, session.conundrumAnswers);
  const points = scoreSoloConundrum(solved, session.hintsUsed);

  // Flip tiles to reveal the real 9-letter solution
  session.conundrumTiles = session.conundrumAnswer.split('');
  renderConundrumBoard();

  session.totalScore += points;
  session.maxPossibleScore += 10;
  session.stats.conundrumsPlayed += 1;
  if (solved) {
    session.stats.conundrumsSolved += 1;
    audio.playFanfare();
    launchConfetti();
  } else {
    audio.playInvalidBuzz();
  }

  session.stats.roundLog.push({
    round: session.roundIndex + 1,
    type: 'Conundrum',
    prompt: session.conundrumAnswer,
    answer: guess || '(no guess)',
    valid: solved,
    points,
    best: session.conundrumAnswer
  });

  updateHUD();
  showRevealPanel({
    title: solved
      ? `✓ Solved! "${session.conundrumAnswer}" — +${points} points`
      : `✗ Time up! The Conundrum was "${session.conundrumAnswer}"`,
    isValid: solved,
    mode: 'C',
    conundrumWord: session.conundrumAnswer
  });
}

/* ============================================================================
 * CLOCK & REVEAL PANEL HELPERS
 * ========================================================================== */
function startRoundClock(onComplete) {
  const durationSec = settings.clockDuration;
  const clockContainer = document.getElementById('solo-clock-container');

  if (!clock) {
    clock = new CountdownClock({
      durationSeconds: durationSec,
      onTick: (remMs, elapsedSec) => {
        renderClockWidget(clockContainer, remMs, durationSec * 1000);
        if (durationSec > 0 && clock.running) {
          audio.playClockSecond(elapsedSec, durationSec);
          const remSec = Math.ceil(remMs / 1000);
          if ((remSec === 20 || remSec === 10 || remSec <= 5) && remSec !== clock.lastAnnouncedSecond) {
            clock.lastAnnouncedSecond = remSec;
            announce(`${remSec} seconds remaining`);
          }
        }
      },
      onComplete: () => {
        announce('Time is up!', 'assertive');
        onComplete();
      }
    });
  } else {
    clock.onComplete = () => {
      announce('Time is up!', 'assertive');
      onComplete();
    };
    clock.setDuration(durationSec);
  }

  if (durationSec > 0) {
    clock.start();
  }
}

function showRevealPanel({ title, isValid, mode, solverResult, playerWord, numbersSolution, target, conundrumWord }) {
  const revealSec = document.getElementById('solo-reveal-section');
  const titleEl = document.getElementById('reveal-status-title');
  const bodyEl = document.getElementById('reveal-solver-body');
  const nextBtn = document.getElementById('btn-next-round');

  if (!revealSec || !titleEl || !bodyEl) return;
  revealSec.hidden = false;
  titleEl.textContent = title;
  titleEl.style.color = isValid ? 'var(--status-valid)' : 'var(--status-invalid)';

  if (mode === 'L') {
    renderDictionaryCorner(bodyEl, solverResult, playerWord);
  } else if (mode === 'N') {
    renderNumbersSolution(bodyEl, numbersSolution, target);
  } else {
    renderDictionaryCorner(
      bodyEl,
      {
        topWords: [conundrumWord],
        maxLength: 9,
        byLength: { 9: [conundrumWord] },
        totalFound: 1
      },
      conundrumWord
    );
  }

  if (nextBtn) {
    const isLast = session.roundIndex + 1 >= session.schedule.length;
    nextBtn.textContent = isLast ? 'Finish Match & View Summary →' : 'Next Round (Enter) →';
    nextBtn.focus();
  }
}

function advanceToNextRound() {
  if (session.roundIndex + 1 < session.schedule.length) {
    session.roundIndex += 1;
    setupCurrentRound();
  } else {
    finishSession();
  }
}

async function finishSession() {
  session.phase = 'SUMMARY';
  if (clock) clock.pause();

  const playSec = document.getElementById('solo-play-section');
  const revealSec = document.getElementById('solo-reveal-section');
  const summarySec = document.getElementById('solo-summary-section');
  if (playSec) playSec.hidden = true;
  if (revealSec) revealSec.hidden = true;
  if (summarySec) summarySec.hidden = false;

  await recordSoloSession({
    mode: session.drillMode.toUpperCase(),
    score: session.totalScore,
    maxPossible: session.maxPossibleScore,
    roundsCount: session.schedule.length,
    bestWord: session.stats.bestWord,
    wordsSubmitted: session.stats.wordsSubmitted,
    validWords: session.stats.validWords,
    totalWordLength: session.stats.totalWordLength,
    numbersPlayed: session.stats.numbersPlayed,
    numbersExact: session.stats.numbersExact,
    conundrumsPlayed: session.stats.conundrumsPlayed,
    conundrumsSolved: session.stats.conundrumsSolved
  });

  const scoreEl = document.getElementById('summary-final-score');
  if (scoreEl) {
    scoreEl.textContent = `${session.totalScore} / ${session.maxPossibleScore} pts`;
  }

  const tbody = document.getElementById('summary-rounds-tbody');
  if (tbody) {
    tbody.innerHTML = '';
    session.stats.roundLog.forEach((row) => {
      const tr = document.createElement('tr');
      tr.style.borderBottom = '1px solid var(--border-subtle)';
      const cells = [
        `R${row.round}`,
        row.type,
        row.prompt,
        row.answer,
        `+${row.points}`,
        row.best
      ];
      cells.forEach((txt) => {
        const td = document.createElement('td');
        td.style.padding = '0.55rem 0.5rem';
        td.textContent = String(txt);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
  }

  audio.playFanfare();
  launchConfetti();
}

/* ============================================================================
 * EVENT WIRING & KEYBOARD SHORTCUTS
 * ========================================================================== */
document.addEventListener('DOMContentLoaded', async () => {
  applySettingsToDOM(settings);
  audio.setMuted(!settings.soundEnabled);
  audio.setVolume(settings.volume);
  initModalHandlers();

  const loadingBanner = document.getElementById('dict-loading-state');
  dictData = await loadDictionary(settings.dictionaryMode);
  if (loadingBanner) loadingBanner.hidden = true;

  // Check URL query param for drill mode (e.g. ?drill=daily)
  const params = new URLSearchParams(window.location.search);
  const initialDrill = params.get('drill') || 'full';
  startDrillSession(initialDrill);

  // Drill selector buttons
  document.querySelectorAll('[data-drill]').forEach((btn) => {
    btn.addEventListener('click', () => {
      audio.unlock();
      startDrillSession(btn.getAttribute('data-drill'));
    });
  });

  // Letters picking buttons
  document.getElementById('btn-pick-vowel')?.addEventListener('click', () => {
    audio.unlock();
    try {
      const res = pickLetterTile('V', session.stacks, session.letters, rng);
      session.letters = res.nextBoard;
      session.vowelCount = res.vowelCount;
      session.consonantCount = res.consonantCount;
      audio.playTileFlip();
      updateLettersPickingUI();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('btn-pick-consonant')?.addEventListener('click', () => {
    audio.unlock();
    try {
      const res = pickLetterTile('C', session.stacks, session.letters, rng);
      session.letters = res.nextBoard;
      session.vowelCount = res.vowelCount;
      session.consonantCount = res.consonantCount;
      audio.playTileFlip();
      updateLettersPickingUI();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('btn-pick-random')?.addEventListener('click', () => {
    audio.unlock();
    const res = pickRandomRemainingLetters(session.stacks, session.letters, rng);
    session.letters = res.board;
    session.vowelCount = res.vowelCount;
    session.consonantCount = res.consonantCount;
    audio.playTileFlip();
    updateLettersPickingUI();
  });

  // Letters play controls
  document.getElementById('btn-letters-shuffle')?.addEventListener('click', () => {
    const currentWordIndices = session.pickedSlots.map((s) => s.index);
    const indexed = session.letters.map((ch, idx) => ({ ch, wasUsed: currentWordIndices.includes(idx) }));
    const shuffled = shuffle(indexed, Math.random);
    session.letters = shuffled.map((x) => x.ch);
    // Re-map pickedSlots to new indices
    const nextSlots = [];
    const claimed = new Set();
    for (const slot of session.pickedSlots) {
      const newIdx = session.letters.findIndex((c, idx) => c === slot.letter && !claimed.has(idx));
      if (newIdx !== -1) {
        claimed.add(newIdx);
        nextSlots.push({ index: newIdx, letter: slot.letter });
      }
    }
    session.pickedSlots = nextSlots;
    audio.playTileFlip();
    syncWordBuilderUI();
  });

  document.getElementById('btn-letters-clear')?.addEventListener('click', () => {
    session.pickedSlots = [];
    syncWordBuilderUI();
  });

  document.getElementById('btn-letters-submit')?.addEventListener('click', () => {
    submitLettersRound();
  });

  // Numbers picking buttons (0..4 large + random)
  document.querySelectorAll('[data-large-pick]').forEach((btn) => {
    btn.addEventListener('click', () => {
      audio.unlock();
      const raw = btn.getAttribute('data-large-pick');
      const count = raw === 'random' ? randomInt(0, 4, rng) : Number(raw);
      selectLargeTileCount(count);
    });
  });

  // Numbers operator buttons
  document.querySelectorAll('[data-calc-op]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (session.phase !== 'PLAYING') return;
      if (session.selectedNumIndex === null) {
        showToast('Select a number tile first.', 'info');
        return;
      }
      session.selectedOperator = btn.getAttribute('data-calc-op');
      syncNumbersCalcUI();
    });
  });

  document.getElementById('btn-numbers-undo')?.addEventListener('click', () => {
    if (session.calcSteps.length === 0) return;
    const last = session.calcSteps.pop();
    session.numberPool = last.snapshotPool;
    session.selectedNumIndex = null;
    session.selectedOperator = null;
    syncNumbersCalcUI();
  });

  document.getElementById('btn-numbers-reset')?.addEventListener('click', () => {
    if (session.calcSteps.length === 0) return;
    session.numberPool = session.initialNumbers.map((val, idx) => ({
      id: idx,
      value: val,
      consumed: false
    }));
    session.calcSteps = [];
    session.selectedNumIndex = null;
    session.selectedOperator = null;
    syncNumbersCalcUI();
  });

  document.getElementById('btn-numbers-submit')?.addEventListener('click', () => {
    submitNumbersRound();
  });

  // Conundrum controls
  document.getElementById('btn-conundrum-hint')?.addEventListener('click', () => {
    revealConundrumHint();
  });

  document.getElementById('btn-conundrum-shuffle')?.addEventListener('click', () => {
    session.conundrumTiles = shuffle(session.conundrumTiles, Math.random);
    audio.playTileFlip();
    renderConundrumBoard();
  });

  document.getElementById('btn-conundrum-submit')?.addEventListener('click', () => {
    submitConundrumRound();
  });

  // Optional Web Speech API microphone button for Conundrum
  const micBtn = document.getElementById('btn-conundrum-speech');
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (micBtn) {
    if (!SpeechRec) {
      micBtn.hidden = true;
    } else {
      micBtn.addEventListener('click', () => {
        try {
          const rec = new SpeechRec();
          rec.lang = 'en-GB';
          rec.interimResults = false;
          rec.maxAlternatives = 1;
          showToast('Listening for your 9-letter Conundrum answer…', 'info');
          rec.onresult = (e) => {
            const transcript = e.results[0][0].transcript.replace(/[^a-zA-Z]/g, '').toUpperCase();
            const input = document.getElementById('conundrum-guess-input');
            if (input) input.value = transcript;
          };
          rec.start();
        } catch {
          showToast('Speech recognition unavailable.', 'error');
        }
      });
    }
  }

  // Next Round & Summary buttons
  document.getElementById('btn-next-round')?.addEventListener('click', () => {
    advanceToNextRound();
  });

  document.getElementById('btn-summary-play-again')?.addEventListener('click', () => {
    startDrillSession(session.drillMode);
  });

  document.getElementById('btn-summary-share')?.addEventListener('click', async () => {
    const text = `Countdown Studio (${session.drillMode.toUpperCase()}): ${session.totalScore}/${
      session.maxPossibleScore
    } pts | Best word: ${session.stats.bestWord || '—'}`;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      showToast('Result copied to clipboard!', 'success');
    }
  });

  // Global Keyboard Shortcuts for Solo Mode
  document.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
      if (e.key === 'Enter' && session.phase === 'PLAYING' && getRoundType() === 'C') {
        e.preventDefault();
        submitConundrumRound();
      }
      return;
    }

    const type = getRoundType();
    if (session.phase === 'PICKING' && type === 'L') {
      if (e.key.toLowerCase() === 'v') {
        document.getElementById('btn-pick-vowel')?.click();
      } else if (e.key.toLowerCase() === 'c') {
        document.getElementById('btn-pick-consonant')?.click();
      } else if (e.key.toLowerCase() === 'r') {
        document.getElementById('btn-pick-random')?.click();
      }
      return;
    }

    if (session.phase === 'PLAYING' && type === 'L') {
      if (/^[a-zA-Z]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        handleLetterTyping(e.key);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        session.pickedSlots.pop();
        syncWordBuilderUI();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        submitLettersRound();
      }
      return;
    }

    if (session.phase === 'REVEAL' && e.key === 'Enter') {
      e.preventDefault();
      advanceToNextRound();
    }
  });
});
