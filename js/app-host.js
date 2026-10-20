/**
 * @file js/app-host.js
 * Controller for /versus-host.html (Live Versus Stage Operator Console).
 *
 * Implements:
 * - Pre-Match Setup (Contestant names, colours, schedule preset, clock duration, starting player, theme)
 * - Test Display Pattern & Sound Check
 * - Authoritative GameStore FSM (IDLE -> PICKING -> CLOCK_RUNNING -> REVEAL -> SCORING -> NEXT_ROUND -> MATCH_END)
 * - Real-time BroadcastChannel + localStorage sync to /versus-display.html
 * - Full Operator Hotkeys:
 *     C = Consonant, V = Vowel, R = Random 9
 *     SPACE = Start / Pause / Resume 30s Clock
 *     D = Open Reveal / Adjudication Panel
 *     N = Advance to Next Round
 *     Q / Left Shift = Player 1 Conundrum Buzzer
 *     P / Right Shift = Player 2 Conundrum Buzzer
 *     H = Toggle Full Stage View Overlay
 * - Gamepad API polling for physical USB/Bluetooth quiz buzzers
 * - Live Dictionary Challenge lookup with Free Dictionary API enrichment
 * - Operator Tools: Undo, Manual Score +/-, Skip Round, Replay Round, Reshuffle, Panic Blank Screen,
 *   Sudden-Death Tie-Break Conundrum, Copyable Action Log, and PNG/Text Export.
 */

import {
  loadSettings,
  saveSettings,
  applySettingsToDOM,
  loadStageLayout,
  saveStageLayout,
  loadCustomStageBackground,
  saveCustomStageBackground,
  loadStageControlsHidden,
  saveStageControlsHidden
} from './core/storage.js';
import {
  PHASES,
  createInitialMatchState,
  GameStore
} from './core/state.js';
import { createRNG, randomInt } from './core/rng.js';
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
  generateTarget
} from './game/numbers.js';
import {
  pickConundrum,
  adjudicateBuzz
} from './game/conundrum.js';
import {
  scoreVersusLettersRound,
  scoreVersusNumbersRound
} from './game/scoring.js';
import {
  SCHEDULE_PRESETS,
  getScheduleRounds,
  getPickerForRound,
  getRoundTypeName
} from './game/schedule.js';
import { loadDictionary, solveLettersRound } from './solver/wordSolver.js';
import { solveNumbersInWorker } from './solver/numbersSolver.js';
import { StageSyncChannel } from './net/sync.js';
import { fetchWordDefinition } from './net/dictionaryApi.js';
import { renderLetterTiles, renderNumberTiles } from './ui/tiles.js';
import { renderDictionaryCorner, renderNumbersSolution } from './ui/board.js';
import { exportMatchSummaryPNG, launchConfetti } from './ui/scoreboard.js';
import { initModalHandlers } from './ui/modal.js';
import { showToast } from './ui/toast.js';
import { requestWakeLock } from './ui/a11y.js';

let settings = loadSettings();
let dictData = null;
const rng = createRNG();
let letterStacks = createLetterStacks(rng);

const store = new GameStore(createInitialMatchState({ theme: settings.theme }));
let syncChannel = null;
let clock = null;
let buzzerAnswerTimer = null;
let hostCustomSchedule = [];
let lastRenderedPreviewBoardKey = null;

/**
 * Gets a URL relative to the page currently being served.  Using the page URL
 * (rather than `location.origin`) is important for static hosts such as GitHub
 * Pages, where the app can live under a repository subdirectory.
 */
function getStageDisplayUrl(roomId = '') {
  const url = new URL('./versus-display.html', window.location.href);
  if (roomId) url.searchParams.set('room', roomId);

  // Preserve an explicitly configured remote WebSocket backend in copied
  // links and QR codes when the frontend is hosted separately from the Node
  // WebSocket server (for example, GitHub Pages + a small API host).
  const wsEndpoint = new URLSearchParams(window.location.search).get('ws')
    || window.__COUNTDOWN_STAGE_WS_URL__;
  if (wsEndpoint) url.searchParams.set('ws', wsEndpoint);
  return url.toString();
}

/**
 * The QR code is a convenience for the remote-display feature.  Do not make
 * the entire Host console depend on an npm-only import: browsers serving the
 * source files directly cannot resolve bare module specifiers such as
 * `qrcode`.  A deploy may optionally provide a global QRCode library; without
 * it the copyable room link remains fully usable.
 */
function renderQrCode(canvas, value) {
  const qrCode = window.QRCode;
  if (qrCode?.toCanvas) {
    qrCode.toCanvas(canvas, value, {
      width: 200,
      margin: 1,
      color: { dark: '#030712', light: '#FFFFFF' },
    }, (error) => {
      if (error) console.error('Failed to generate QR Code:', error);
    });
    return;
  }

  const context = canvas?.getContext?.('2d');
  if (!context) return;
  canvas.width = 200;
  canvas.height = 200;
  context.fillStyle = '#FFFFFF';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#030712';
  context.font = '600 14px sans-serif';
  context.textAlign = 'center';
  context.fillText('Copy the display link', 100, 92);
  context.fillText('to open it on another device.', 100, 114);
}

function broadcastState(state) {
  if (syncChannel) {
    syncChannel.send('STATE_SYNC', state);
  }
}

function initClock() {
  clock = new CountdownClock({
    durationSeconds: store.getState().clockDuration || 30,
    onTick: (remMs, elapsedSec) => {
      const st = store.getState();
      if (clock.running) {
        audio.playClockSecond(elapsedSec, st.clockDuration || 30);
      }
      store.update({
        clockRemainingMs: Math.round(remMs),
        clockRunning: clock.running
      });
    },
    onComplete: () => {
      const st = store.getState();
      store.transition(
        PHASES.REVEAL,
        {
          clockRemainingMs: 0,
          clockRunning: false,
          clockStartedAtEpoch: null,
          activeBuzzerPlayer: null
        },
        `Round ${st.roundIndex + 1} clock expired (Time!).`
      );
      showToast('Time is up! Enter contestant declarations.', 'info');
    }
  });
}

function initHostScheduleEditor() {
  const presetSelect = document.getElementById('setup-schedule');
  const editor = document.getElementById('host-custom-schedule-editor');
  const list = document.getElementById('host-custom-schedule-list');
  const addSelect = document.getElementById('host-add-round-type');
  const addButton = document.getElementById('host-add-round-btn');
  if (!presetSelect || !editor || !list || !addSelect || !addButton) return;

  const initialPreset = settings.schedulePreset || 'tv-15';
  presetSelect.value = SCHEDULE_PRESETS[initialPreset] || initialPreset === 'custom'
    ? initialPreset
    : 'tv-15';
  hostCustomSchedule = getScheduleRounds('custom', settings.customSchedule);
  if (hostCustomSchedule.length === 0) hostCustomSchedule = [...SCHEDULE_PRESETS['tv-15'].rounds];

  const render = () => {
    const isCustom = presetSelect.value === 'custom';
    editor.hidden = !isCustom;
    if (!isCustom) return;

    list.replaceChildren();
    hostCustomSchedule.forEach((code, index) => {
      const item = document.createElement('div');
      item.draggable = true;
      item.className = 'btn btn--sm btn--secondary';
      item.style.cursor = 'grab';
      item.setAttribute('aria-label', `Round ${index + 1}: ${getRoundTypeName(code)}. Drag to reorder.`);

      const label = document.createElement('span');
      label.textContent = `R${index + 1}: ${getRoundTypeName(code)}`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn--sm';
      remove.style.marginLeft = '0.35rem';
      remove.style.padding = '0 0.25rem';
      remove.textContent = '×';
      remove.title = `Remove round ${index + 1}`;
      remove.addEventListener('click', (event) => {
        event.stopPropagation();
        if (hostCustomSchedule.length <= 1) {
          showToast('A match must contain at least 1 round.', 'error');
          return;
        }
        hostCustomSchedule.splice(index, 1);
        render();
      });
      item.append(label, remove);

      let dragIndex = null;
      item.addEventListener('dragstart', () => { dragIndex = index; });
      item.addEventListener('dragover', (event) => event.preventDefault());
      item.addEventListener('drop', (event) => {
        event.preventDefault();
        if (dragIndex === null || dragIndex === index) return;
        const [moved] = hostCustomSchedule.splice(dragIndex, 1);
        hostCustomSchedule.splice(index, 0, moved);
        render();
      });
      list.appendChild(item);
    });
  };

  presetSelect.addEventListener('change', () => {
    if (presetSelect.value !== 'custom') {
      hostCustomSchedule = [...SCHEDULE_PRESETS[presetSelect.value].rounds];
    }
    render();
  });
  addButton.addEventListener('click', () => {
    if (hostCustomSchedule.length >= 25) {
      showToast('Maximum 25 rounds per match.', 'error');
      return;
    }
    hostCustomSchedule.push(addSelect.value);
    presetSelect.value = 'custom';
    render();
  });
  render();
}

function startNewMatchFromSetup() {
  const p1Name = document.getElementById('setup-p1-name')?.value.trim() || 'Contestant 1';
  const p2Name = document.getElementById('setup-p2-name')?.value.trim() || 'Contestant 2';
  const preset = document.getElementById('setup-schedule')?.value || 'tv-15';
  const clockSec = Number(document.getElementById('setup-clock')?.value || 30);
  const starter = Number(document.getElementById('setup-starter')?.value || 1);
  const theme = document.getElementById('setup-theme')?.value || 'classic-blue';
  const soundOn = document.getElementById('setup-sound')?.checked ?? true;

  settings = saveSettings({
    theme,
    clockDuration: clockSec,
    startingPlayer: starter,
    soundEnabled: soundOn
  });
  audio.setMuted(!soundOn);
  audio.unlock();
  requestWakeLock();

  letterStacks = createLetterStacks(rng);
  const selectedSchedule = preset === 'custom' ? hostCustomSchedule : SCHEDULE_PRESETS[preset]?.rounds;
  const schedule = getScheduleRounds(preset, selectedSchedule);
  if (schedule.length < 1 || schedule.length > 25) {
    showToast('Custom schedule must contain between 1 and 25 rounds.', 'error');
    return;
  }
  settings = saveSettings({ schedulePreset: preset, customSchedule: [...schedule] });
  const firstType = schedule[0] || 'L';

  const fresh = createInitialMatchState({
    matchId: `match-${Date.now()}`,
    mode: 'versus',
    phase: PHASES.PICKING,
    theme,
    schedule,
    roundIndex: 0,
    roundType: firstType,
    pickerPlayer: getPickerForRound(0, starter),
    clockDuration: clockSec,
    clockRemainingMs: clockSec * 1000,
    players: [
      { id: 1, name: p1Name, color: '#38BDF8', score: 0, submission: '', valid: null, roundPoints: 0, lockedOut: false },
      { id: 2, name: p2Name, color: '#F59E0B', score: 0, submission: '', valid: null, roundPoints: 0, lockedOut: false }
    ],
    actionLog: [{ time: new Date().toLocaleTimeString(), message: `Match started: ${p1Name} vs ${p2Name} (${schedule.length} rounds).` }]
  });

  if (firstType === 'C') {
    const con = pickConundrum(dictData ? dictData.conundrums : [], rng, dictData?.wordSet);
    fresh.conundrumAnswer = con.answer;
    fresh.conundrumScrambled = con.scrambled;
    fresh.conundrumSourceWords = con.sourceWords;
  }

  store.replaceState(fresh);
  if (clock) clock.setDuration(clockSec);
  showToast('Match initialised and broadcast to Stage Display!', 'success');
}

function configureRoundAtIndex(roundIdx, logText) {
  if (clock) clock.reset();
  clearBuzzerTimer();
  audio.resetClockTracker();

  const st = store.getState();
  const schedule = st.schedule;
  if (roundIdx >= schedule.length) {
    store.transition(
      PHASES.MATCH_END,
      { clockRunning: false, clockStartedAtEpoch: null },
      'Match completed!'
    );
    audio.playFanfare();
    launchConfetti();
    return;
  }

  const rType = schedule[roundIdx];
  const picker = getPickerForRound(roundIdx, settings.startingPlayer || 1);
  const nextPlayers = st.players.map((p) => ({
    ...p,
    submission: '',
    valid: null,
    roundPoints: 0,
    lockedOut: false
  }));

  const patch = {
    roundIndex: roundIdx,
    roundType: rType,
    pickerPlayer: picker,
    clockRemainingMs: st.clockDuration * 1000,
    clockRunning: false,
    clockStartedAtEpoch: null,
    players: nextPlayers,
    letters: [],
    vowelCount: 0,
    consonantCount: 0,
    bestWords: [],
    numbers: [],
    largeCount: null,
    target: null,
    numbersSolution: null,
    showNumbersSolutionOnDisplay: false,
    conundrumScrambled: '',
    conundrumAnswer: '',
    conundrumSourceWords: null,
    conundrumRevealed: false,
    activeBuzzerPlayer: null
  };

  if (rType === 'C') {
    const con = pickConundrum(dictData ? dictData.conundrums : [], rng, dictData?.wordSet);
    patch.conundrumAnswer = con.answer;
    patch.conundrumScrambled = con.scrambled;
    patch.conundrumSourceWords = con.sourceWords;
  }

  // clear host input fields
  const p1In = document.getElementById('host-p1-submission');
  const p2In = document.getElementById('host-p2-submission');
  if (p1In) p1In.value = '';
  if (p2In) p2In.value = '';

  store.transition(PHASES.PICKING, patch, logText || `Started Round ${roundIdx + 1} (${getRoundTypeName(rType)}).`);
}

/* ============================================================================
 * HOST ROUND ACTIONS
 * ========================================================================== */
function hostPickLetter(kind) {
  const st = store.getState();
  if (st.phase !== PHASES.PICKING || st.roundType !== 'L') return;

  try {
    const res = pickLetterTile(kind, letterStacks, st.letters, rng);
    audio.playTileFlip();

    let bestWords = st.bestWords;
    if (res.nextBoard.length === 9 && dictData) {
      const solved = solveLettersRound(res.nextBoard, dictData.trie, 10);
      bestWords = solved.topWords;
    }

    store.update(
      {
        letters: res.nextBoard,
        vowelCount: res.vowelCount,
        consonantCount: res.consonantCount,
        bestWords
      },
      {
        recordUndo: true,
        logMessage: `Picked ${kind === 'V' ? 'Vowel' : 'Consonant'}: ${res.tile} (${res.nextBoard.length}/9)`
      }
    );
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function hostPickRandomLetters() {
  const st = store.getState();
  if (st.phase !== PHASES.PICKING || st.roundType !== 'L') return;
  if (st.letters.length >= 9) return;

  const res = pickRandomRemainingLetters(letterStacks, st.letters, rng);
  audio.playTileFlip();
  const solved = dictData ? solveLettersRound(res.board, dictData.trie, 10) : { topWords: [] };

  store.update(
    {
      letters: res.board,
      vowelCount: res.vowelCount,
      consonantCount: res.consonantCount,
      bestWords: solved.topWords
    },
    {
      recordUndo: true,
      logMessage: `Randomly completed 9-letter board: ${res.board.join('')}`
    }
  );
}

function hostPickNumbers(largeCount) {
  const st = store.getState();
  if (st.phase !== PHASES.PICKING || st.roundType !== 'N') return;

  const tiles = drawNumbersTiles(largeCount, rng);
  const target = generateTarget(rng);
  audio.playTileFlip();

  store.update(
    {
      numbers: tiles,
      largeCount,
      target,
      showNumbersSolutionOnDisplay: false
    },
    {
      recordUndo: true,
      logMessage: `Numbers drawn (${largeCount} large): ${tiles.join(', ')} → Target ${target}`
    }
  );

  solveNumbersInWorker(tiles, target).then((sol) => {
    store.update({ numbersSolution: sol });
  });
}

function toggleClockRunPause() {
  const st = store.getState();
  audio.unlock();

  // Ensure round is ready to start clock
  if (st.roundType === 'L' && st.letters.length < 9) {
    showToast('Pick all 9 letters before starting the 30s clock.', 'error');
    return;
  }
  if (st.roundType === 'N' && (!st.numbers || st.numbers.length < 6 || !st.target)) {
    showToast('Draw 6 number tiles and target before starting the clock.', 'error');
    return;
  }

  if (clock.running) {
    clock.pause();
    audio.pauseClockMusic();
    store.update(
      {
        clockRunning: false,
        clockRemainingMs: Math.round(clock.remainingMs),
        clockStartedAtEpoch: null
      },
      { logMessage: `Paused clock at ${(clock.remainingMs / 1000).toFixed(1)}s.` }
    );
  } else {
    if (st.phase === PHASES.PICKING || st.phase === PHASES.REVEAL) {
      store.transition(
        PHASES.CLOCK_RUNNING,
        {
          clockRunning: true,
          clockStartedAtEpoch: Date.now()
        },
        `Started 30s clock for Round ${st.roundIndex + 1}.`
      );
    } else {
      store.update(
        {
          clockRunning: true,
          clockStartedAtEpoch: Date.now()
        },
        { logMessage: 'Resumed clock.' }
      );
    }
    clock.start(st.clockRemainingMs > 0 ? st.clockRemainingMs : st.clockDuration * 1000);
    audio.resumeClockMusic();
  }
}

/* ============================================================================
 * CONUNDRUM BUZZER ADJUDICATION
 * ========================================================================== */
function clearBuzzerTimer() {
  if (buzzerAnswerTimer) {
    clearInterval(buzzerAnswerTimer);
    buzzerAnswerTimer = null;
  }
}

function handleContestantBuzz(playerNum, timestamp = performance.now()) {
  const st = store.getState();
  if (st.roundType !== 'C' || st.phase !== PHASES.CLOCK_RUNNING) return;
  if (st.activeBuzzerPlayer !== null) return;

  const pObj = st.players[playerNum - 1];
  if (!pObj || pObj.lockedOut) {
    showToast(`${pObj ? pObj.name : 'Player'} is already locked out this conundrum.`, 'error');
    return;
  }

  const adj = adjudicateBuzz(
    { player: playerNum, timestamp },
    null,
    { p1LockedOut: st.players[0].lockedOut, p2LockedOut: st.players[1].lockedOut }
  );
  if (!adj.winner) return;

  if (clock && clock.running) {
    clock.pause();
  }
  // A buzzer freezes the complete studio clock: pause the soundtrack at the
  // same moment as the analogue hand. It will be resumed only after an
  // incorrect answer when the opponent gets the next attempt.
  audio.pauseClockMusic();
  audio.playContestantBuzz(adj.winner);

  store.update(
    {
      clockRunning: false,
      clockRemainingMs: Math.round(clock.remainingMs),
      clockStartedAtEpoch: null,
      activeBuzzerPlayer: adj.winner,
      buzzerTimestamp: timestamp,
      buzzerRemainingMs: 5000
    },
    {
      recordUndo: true,
      logMessage: `${st.players[adj.winner - 1].name} buzzed in at ${(
        clock.remainingMs / 1000
      ).toFixed(1)}s!`
    }
  );

  clearBuzzerTimer();
  let rem = 5000;
  buzzerAnswerTimer = setInterval(() => {
    rem = Math.max(0, rem - 250);
    store.update({ buzzerRemainingMs: rem });
    if (rem <= 0) {
      clearBuzzerTimer();
    }
  }, 250);
}

function adjudicateConundrumBuzz(isCorrect) {
  clearBuzzerTimer();
  const st = store.getState();
  const activeP = st.activeBuzzerPlayer;
  if (!activeP) return;

  const nextPlayers = structuredClone(st.players);
  const idx = activeP - 1;

  if (isCorrect) {
    nextPlayers[idx].roundPoints = 10;
    nextPlayers[idx].score += 10;
    nextPlayers[idx].valid = true;
    nextPlayers[idx].submission = st.conundrumAnswer;
    audio.playFanfare();

    const nextHistory = [
      ...st.roundHistory,
      {
        round: st.roundIndex + 1,
        type: 'C',
        p1Sub: nextPlayers[0].submission || '—',
        p1Pts: nextPlayers[0].roundPoints,
        p2Sub: nextPlayers[1].submission || '—',
        p2Pts: nextPlayers[1].roundPoints
      }
    ];

    store.transition(
      PHASES.SCORING,
      {
        players: nextPlayers,
        activeBuzzerPlayer: null,
        conundrumRevealed: true,
        roundHistory: nextHistory
      },
      `CORRECT! ${nextPlayers[idx].name} solved "${st.conundrumAnswer}" (+10 pts).`
    );
  } else {
    nextPlayers[idx].lockedOut = true;
    nextPlayers[idx].valid = false;
    audio.playInvalidBuzz();

    const bothLocked = nextPlayers[0].lockedOut && nextPlayers[1].lockedOut;
    if (bothLocked || st.clockRemainingMs <= 0) {
      store.transition(
        PHASES.REVEAL,
        {
          players: nextPlayers,
          activeBuzzerPlayer: null,
          conundrumRevealed: true
        },
        `Both contestants locked out. Conundrum revealed: ${st.conundrumAnswer}.`
      );
    } else {
      store.update(
        {
          players: nextPlayers,
          activeBuzzerPlayer: null
        },
        {
          logMessage: `Incorrect from ${nextPlayers[idx].name} (locked out). Resuming clock for opponent.`
        }
      );
      toggleClockRunPause();
    }
  }
}

/* ============================================================================
 * REVEAL & ADJUDICATION SCORING (LETTERS & NUMBERS)
 * ========================================================================== */
function scoreCurrentRoundSubmissions() {
  const st = store.getState();
  audio.stopClockMusic();
  if (clock && clock.running) clock.pause();

  const p1Raw = document.getElementById('host-p1-submission')?.value.trim() || '';
  const p2Raw = document.getElementById('host-p2-submission')?.value.trim() || '';
  const nextPlayers = structuredClone(st.players);

  if (st.roundType === 'L') {
    const v1 = validateWordSubmission(p1Raw, st.letters, dictData ? dictData.wordSet : null);
    const v2 = validateWordSubmission(p2Raw, st.letters, dictData ? dictData.wordSet : null);
    const scored = scoreVersusLettersRound(
      { word: v1.normalizedWord, valid: v1.valid },
      { word: v2.normalizedWord, valid: v2.valid },
      { onlyLongerScores: settings.onlyLongerScores }
    );

    nextPlayers[0].submission = v1.normalizedWord || '—';
    nextPlayers[0].valid = p1Raw ? v1.valid : null;
    nextPlayers[0].roundPoints = scored.p1Points;
    nextPlayers[0].score += scored.p1Points;

    nextPlayers[1].submission = v2.normalizedWord || '—';
    nextPlayers[1].valid = p2Raw ? v2.valid : null;
    nextPlayers[1].roundPoints = scored.p2Points;
    nextPlayers[1].score += scored.p2Points;

    if (scored.p1Points > 0 || scored.p2Points > 0) {
      audio.playValidChime();
    } else {
      audio.playInvalidBuzz();
    }
  } else if (st.roundType === 'N') {
    const val1 = p1Raw !== '' ? Number(p1Raw) : null;
    const val2 = p2Raw !== '' ? Number(p2Raw) : null;
    const p1Verified = document.getElementById('host-p1-valid-toggle')?.checked ?? true;
    const p2Verified = document.getElementById('host-p2-valid-toggle')?.checked ?? true;

    const scored = scoreVersusNumbersRound(
      { value: val1, valid: p1Verified },
      { value: val2, valid: p2Verified },
      st.target,
      {
        onlyCloserScores: settings.onlyLongerScores,
        exact: settings.numbersExactPoints,
        within5: settings.numbersClose5Points,
        within10: settings.numbersClose10Points
      }
    );

    nextPlayers[0].submission = val1 !== null ? String(val1) : '—';
    nextPlayers[0].valid = val1 !== null ? p1Verified && scored.p1Points > 0 : null;
    nextPlayers[0].roundPoints = scored.p1Points;
    nextPlayers[0].score += scored.p1Points;

    nextPlayers[1].submission = val2 !== null ? String(val2) : '—';
    nextPlayers[1].valid = val2 !== null ? p2Verified && scored.p2Points > 0 : null;
    nextPlayers[1].roundPoints = scored.p2Points;
    nextPlayers[1].score += scored.p2Points;

    if (scored.p1Points > 0 || scored.p2Points > 0) {
      audio.playValidChime();
    } else {
      audio.playInvalidBuzz();
    }
  } else if (st.roundType === 'C') {
    // Reveal conundrum without a winner if nobody buzzed
    store.transition(
      PHASES.SCORING,
      {
        conundrumRevealed: true,
        clockRunning: false
      },
      `Revealed Conundrum answer: ${st.conundrumAnswer}`
    );
    return;
  }

  const nextHistory = [
    ...st.roundHistory,
    {
      round: st.roundIndex + 1,
      type: st.roundType,
      p1Sub: nextPlayers[0].submission,
      p1Pts: nextPlayers[0].roundPoints,
      p2Sub: nextPlayers[1].submission,
      p2Pts: nextPlayers[1].roundPoints
    }
  ];

  store.transition(
    PHASES.SCORING,
    {
      players: nextPlayers,
      clockRunning: false,
      clockStartedAtEpoch: null,
      roundHistory: nextHistory
    },
    `Scored Round ${st.roundIndex + 1}: ${nextPlayers[0].name} +${nextPlayers[0].roundPoints}, ${nextPlayers[1].name} +${nextPlayers[1].roundPoints}.`
  );
}

/* ============================================================================
 * UI RENDERER FOR HOST CONSOLE
 * ========================================================================== */
function renderHostConsole(state) {
  broadcastState(state);

  // Update header status
  const phaseBadge = document.getElementById('host-phase-label');
  if (phaseBadge) {
    phaseBadge.textContent = `Phase: ${state.phase} · Round ${state.roundIndex + 1}/${
      state.schedule.length
    } (${getRoundTypeName(state.roundType)})`;
  }

  // Update Live Preview Mini-Stage
  const prevRound = document.getElementById('preview-round-title');
  if (prevRound) {
    prevRound.textContent = `Round ${state.roundIndex + 1} of ${state.schedule.length} · ${getRoundTypeName(
      state.roundType
    )}`;
  }

  const prevPicker = document.getElementById('preview-picker-label');
  if (prevPicker) {
    const pickerObj = state.players[state.pickerPlayer - 1];
    prevPicker.textContent =
      state.roundType === 'C'
        ? 'Buzzer Round'
        : `Picker: ${pickerObj ? pickerObj.name : 'Contestant'}`;
  }

  const prevBoard = document.getElementById('preview-board-container');
  if (prevBoard) {
    const word = state.conundrumRevealed ? state.conundrumAnswer : state.conundrumScrambled;
    const prevBoardKey = state.roundType === 'L'
      ? `L:${(state.letters || []).join('')}`
      : state.roundType === 'N'
        ? `N:${(state.numbers || []).join(',')}`
        : `C:${word || ''}:${Boolean(state.conundrumRevealed)}`;
    if (prevBoardKey !== lastRenderedPreviewBoardKey) {
      if (state.roundType === 'L') {
        renderLetterTiles(prevBoard, state.letters, { noAnim: Boolean(state.clockRunning) });
      } else if (state.roundType === 'N') {
        renderNumberTiles(prevBoard, state.numbers, { noAnim: Boolean(state.clockRunning) });
      } else {
        renderLetterTiles(prevBoard, word ? word.split('') : [], { isConundrum: true, noAnim: Boolean(state.clockRunning) });
      }
      lastRenderedPreviewBoardKey = prevBoardKey;
    }
  }

  const prevTarget = document.getElementById('preview-target-label');
  if (prevTarget) {
    prevTarget.hidden = state.roundType !== 'N';
    prevTarget.textContent = `Target: ${state.target || '000'}`;
  }

  const prevP1Name = document.getElementById('preview-p1-name');
  const prevP2Name = document.getElementById('preview-p2-name');
  const prevP1 = document.getElementById('preview-p1-score');
  const prevP2 = document.getElementById('preview-p2-score');
  if (prevP1Name) prevP1Name.textContent = state.players[0].name;
  if (prevP2Name) prevP2Name.textContent = state.players[1].name;
  if (prevP1) prevP1.textContent = String(state.players[0].score);
  if (prevP2) prevP2.textContent = String(state.players[1].score);

  const previewEl = document.getElementById('host-stage-preview');
  const layout = loadStageLayout();
  const customBg = loadCustomStageBackground();
  if (previewEl) {
    previewEl.style.setProperty('--clock-x', `${layout.clockX}%`);
    previewEl.style.setProperty('--clock-y', `${layout.clockY}%`);
    previewEl.style.setProperty('--clock-size', `${layout.clockSize}%`);
    previewEl.style.setProperty('--p1-name-x', `${layout.p1NameX}%`);
    previewEl.style.setProperty('--p1-name-y', `${layout.p1NameY}%`);
    previewEl.style.setProperty('--p1-name-w', `${layout.p1NameW}%`);
    previewEl.style.setProperty('--p1-score-x', `${layout.p1ScoreX}%`);
    previewEl.style.setProperty('--p1-score-y', `${layout.p1ScoreY}%`);
    previewEl.style.setProperty('--p1-score-w', `${layout.p1ScoreW}%`);
    previewEl.style.setProperty('--p2-name-x', `${layout.p2NameX}%`);
    previewEl.style.setProperty('--p2-name-y', `${layout.p2NameY}%`);
    previewEl.style.setProperty('--p2-name-w', `${layout.p2NameW}%`);
    previewEl.style.setProperty('--p2-score-x', `${layout.p2ScoreX}%`);
    previewEl.style.setProperty('--p2-score-y', `${layout.p2ScoreY}%`);
    previewEl.style.setProperty('--p2-score-w', `${layout.p2ScoreW}%`);
    previewEl.style.setProperty('--board-x', `${layout.boardX}%`);
    previewEl.style.setProperty('--board-y', `${layout.boardY}%`);
    previewEl.style.setProperty('--board-w', `${layout.boardW}%`);
    if (customBg) {
      previewEl.style.setProperty('--stage-bg-image', `url("${customBg}")`);
    } else {
      previewEl.style.removeProperty('--stage-bg-image');
      const probe = new Image();
      probe.onload = () => {
        if (!loadCustomStageBackground()) {
          previewEl.style.setProperty('--stage-bg-image', `url("${probe.src}")`);
        }
      };
      probe.src = './assets/countdown-clock-placeholder.jpg';
    }
  }

  // Render Host Clock Widget inside the background clock dial
  const clockBox = document.getElementById('host-clock-widget');
  if (clockBox) {
    renderClockWidget(clockBox, state.clockRemainingMs, state.clockDuration * 1000, {
      handsOnly: Boolean(layout.clockHandsOnly),
      showDigital: Boolean(layout.showDigitalTimer)
    });
  }

  // Toggle Round Type Specific Controls
  const lPanel = document.getElementById('host-controls-letters');
  const nPanel = document.getElementById('host-controls-numbers');
  const cPanel = document.getElementById('host-controls-conundrum');
  if (lPanel) lPanel.hidden = state.roundType !== 'L';
  if (nPanel) nPanel.hidden = state.roundType !== 'N';
  if (cPanel) cPanel.hidden = state.roundType !== 'C';

  if (state.roundType === 'L') {
    const c = getPickConstraints(state.vowelCount, state.consonantCount);
    const vBtn = document.getElementById('host-btn-vowel');
    const cBtn = document.getElementById('host-btn-consonant');
    const rBtn = document.getElementById('host-btn-random-letters');
    if (vBtn) vBtn.disabled = state.phase !== PHASES.PICKING || !c.canPickVowel;
    if (cBtn) cBtn.disabled = state.phase !== PHASES.PICKING || !c.canPickConsonant;
    if (rBtn) rBtn.disabled = state.phase !== PHASES.PICKING || c.isComplete;

    const solverBox = document.getElementById('host-solver-output');
    if (solverBox) {
      if (state.letters.length === 9 && dictData) {
        const solved = solveLettersRound(state.letters, dictData.trie, 10);
        renderDictionaryCorner(solverBox, solved);
      } else {
        solverBox.innerHTML = '<p style="color:var(--text-muted);font-size:0.875rem;">Pick 9 letters to view Dictionary Corner solutions for the host.</p>';
      }
    }
  } else if (state.roundType === 'N') {
    const solverBox = document.getElementById('host-solver-output');
    if (solverBox) {
      if (state.numbersSolution) {
        renderNumbersSolution(solverBox, state.numbersSolution, state.target);
      } else {
        solverBox.innerHTML = '<p style="color:var(--text-muted);font-size:0.875rem;">Select large tiles count (0–4) to compute the Numbers solution.</p>';
      }
    }
  } else if (state.roundType === 'C') {
    const ansLabel = document.getElementById('host-conundrum-secret');
    if (ansLabel) {
      ansLabel.textContent = `Host Secret Answer: ${state.conundrumAnswer || '—'} (Scramble: ${
        state.conundrumScrambled || '—'
      })`;
    }
    const buzzZone = document.getElementById('host-buzzer-adjudication');
    const buzzName = document.getElementById('host-buzzed-player-name');
    if (buzzZone) {
      buzzZone.hidden = state.activeBuzzerPlayer === null;
      if (state.activeBuzzerPlayer && buzzName) {
        buzzName.textContent = `${state.players[state.activeBuzzerPlayer - 1].name} buzzed in! (${(
          state.buzzerRemainingMs / 1000
        ).toFixed(1)}s left)`;
      }
    }
  }

  // Update Contestant Names on Adjudication Inputs
  const l1 = document.getElementById('label-p1-sub');
  const l2 = document.getElementById('label-p2-sub');
  if (l1) l1.textContent = `${state.players[0].name} Declaration`;
  if (l2) l2.textContent = `${state.players[1].name} Declaration`;

  // Tie-break banner check at MATCH_END
  const tieBanner = document.getElementById('host-tiebreak-banner');
  if (tieBanner) {
    const isTiedEnd =
      state.phase === PHASES.MATCH_END &&
      state.players[0].score === state.players[1].score;
    tieBanner.hidden = !isTiedEnd;
  }

  // Update Panic Blank Button state and preview banner
  const panicBtn = document.getElementById('host-btn-panic');
  if (panicBtn) {
    if (state.panicBlank) {
      panicBtn.textContent = '🚨 CLEAR PANIC BLANK';
      panicBtn.classList.add('btn--danger', 'is-active');
      panicBtn.style.boxShadow = '0 0 16px rgba(239, 68, 68, 0.85)';
      panicBtn.setAttribute('aria-pressed', 'true');
    } else {
      panicBtn.textContent = 'Panic (Blank Screen)';
      panicBtn.classList.remove('is-active');
      panicBtn.style.removeProperty('box-shadow');
      panicBtn.setAttribute('aria-pressed', 'false');
    }
  }

  const prevPanic = document.getElementById('preview-panic-banner');
  if (prevPanic) {
    prevPanic.hidden = !state.panicBlank;
    prevPanic.style.display = state.panicBlank ? 'flex' : 'none';
  }

  // Render Operator Action Log
  const logEl = document.getElementById('host-action-log');
  if (logEl) {
    logEl.innerHTML = '';
    (state.actionLog || []).slice(0, 30).forEach((entry) => {
      const div = document.createElement('div');
      div.style.padding = '0.2rem 0';
      div.style.borderBottom = '1px solid rgba(148,163,184,0.1)';
      div.textContent = `[${entry.time}] ${entry.message}`;
      logEl.appendChild(div);
    });
  }
}

/* ============================================================================
 * GAMEPAD API POLLING FOR PHYSICAL BUZZERS
 * ========================================================================== */
function startGamepadPolling() {
  if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return;
  const poll = () => {
    const st = store.getState();
    if (st.roundType === 'C' && st.phase === PHASES.CLOCK_RUNNING && !st.activeBuzzerPlayer) {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      if (pads[0] && pads[0].buttons.some((b) => b.pressed)) {
        handleContestantBuzz(1, performance.now());
      } else if (pads[1] && pads[1].buttons.some((b) => b.pressed)) {
        handleContestantBuzz(2, performance.now());
      }
    }
    requestAnimationFrame(poll);
  };
  requestAnimationFrame(poll);
}

/* ============================================================================
 * INITIALISATION & EVENT LISTENERS
 * ========================================================================== */
document.addEventListener('DOMContentLoaded', async () => {
  applySettingsToDOM(settings);
  audio.setMuted(!settings.soundEnabled);
  audio.setVolume(settings.volume);
  initModalHandlers();
  initClock();

  syncChannel = new StageSyncChannel('host', (msg) => {
    if (msg.type === 'DISPLAY_BUZZ' && msg.payload) {
      handleContestantBuzz(msg.payload.player, msg.payload.timestamp || performance.now());
    } else if (msg.type === 'REQUEST_STATE') {
      broadcastState(store.getState());
    } else if (msg.type === 'CLEAR_PANIC') {
      store.update(
        { panicBlank: false },
        { logMessage: 'Panic blank screen CLEARED from Stage Display.' }
      );
      renderHostConsole(store.getState());
    } else if (msg.type === 'STAGE_LAYOUT_SYNC' && msg.payload) {
      saveStageLayout(msg.payload);
      renderHostConsole(store.getState());
    } else if (msg.type === 'STAGE_BG_SYNC' && msg.payload !== undefined) {
      saveCustomStageBackground(msg.payload.bg || null);
      renderHostConsole(store.getState());
    }
  });

  // Recover existing match if available, ensuring panicBlank is always false on fresh host load
  const recovered = syncChannel.recoverPersistedState();
  if (recovered && recovered.matchId) {
    recovered.panicBlank = false;
    recovered.testPattern = false;
    store.replaceState(recovered);
  }

  store.subscribe((state) => renderHostConsole(state));
  renderHostConsole(store.getState());

  dictData = await loadDictionary(settings.dictionaryMode);
  renderHostConsole(store.getState());
  startGamepadPolling();

  // Pre-match setup buttons
  initHostScheduleEditor();
  document.getElementById('btn-start-match')?.addEventListener('click', startNewMatchFromSetup);

  const hostBgInput = document.getElementById('host-bg-file-input');
  document.getElementById('host-btn-upload-bg')?.addEventListener('click', () => {
    hostBgInput?.click();
  });
  hostBgInput?.addEventListener('change', () => {
    const file = hostBgInput.files?.[0];
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      saveCustomStageBackground(dataUrl);
      syncChannel?.send('STAGE_BG_SYNC', { bg: dataUrl });
      renderHostConsole(store.getState());
      showToast('Stage background image updated and broadcast to 16:9 Display!', 'success');
    };
    reader.readAsDataURL(file);
    hostBgInput.value = '';
  });

  // Remote Display Controls Toggle
  let hostDisplayControlsHidden = loadStageControlsHidden();
  const updateHostControlsBtnText = () => {
    const btn = document.getElementById('host-btn-toggle-display-controls');
    if (btn) {
      btn.textContent = hostDisplayControlsHidden ? '👁 Show Display Controls' : '👁 Hide Display Controls';
    }
  };
  updateHostControlsBtnText();

  document.getElementById('host-btn-toggle-display-controls')?.addEventListener('click', () => {
    hostDisplayControlsHidden = !hostDisplayControlsHidden;
    saveStageControlsHidden(hostDisplayControlsHidden);
    syncChannel?.send('STAGE_CONTROLS_SYNC', { hidden: hostDisplayControlsHidden });
    updateHostControlsBtnText();
    showToast(
      hostDisplayControlsHidden
        ? 'Display controls hidden remotely (Clean TV Stage Mode).'
        : 'Display controls restored on 16:9 Stage Screen.',
      'info'
    );
  });

  // Stage Display Modal Viewer Handlers
  const stageModal = document.getElementById('modal-host-stage-display');
  const hostStageIframe = document.getElementById('host-stage-iframe');
  const hostStagePreviewIframe = document.getElementById('host-stage-preview-iframe');

  const syncStageIframe = (iframe) => {
    try {
      iframe?.contentWindow?.postMessage({
        type: 'STATE_SYNC',
        sender: 'host',
        timestamp: Date.now(),
        payload: store.getState()
      }, '*');
    } catch {}
  };

  hostStagePreviewIframe?.addEventListener('load', () => {
    syncStageIframe(hostStagePreviewIframe);
  });

  const openStageModal = () => {
    if (!stageModal) return;
    stageModal.hidden = false;
    stageModal.style.display = 'flex';
    const currentState = store.getState();
    if (hostStageIframe) {
      if (!hostStageIframe.src || hostStageIframe.src.endsWith('about:blank')) {
        hostStageIframe.src = './versus-display.html';
      }
      try {
        hostStageIframe.contentWindow?.postMessage({
          type: 'STATE_SYNC',
          sender: 'host',
          timestamp: Date.now(),
          payload: currentState
        }, '*');
      } catch {}
    }
    broadcastState(currentState);
  };

  const closeStageModal = () => {
    if (!stageModal) return;
    stageModal.hidden = true;
    stageModal.style.display = 'none';
  };

  hostStageIframe?.addEventListener('load', () => {
    syncStageIframe(hostStageIframe);
    broadcastState(store.getState());
  });

  document.getElementById('host-btn-embedded-display')?.addEventListener('click', openStageModal);
  document.getElementById('host-btn-modal-stage')?.addEventListener('click', openStageModal);
  document.getElementById('btn-close-stage-modal')?.addEventListener('click', closeStageModal);
  stageModal?.addEventListener('click', (e) => {
    if (e.target === stageModal) closeStageModal();
  });

  // --- REMOTE MULTI-DEVICE BROADCAST CONTROLLER ---
  const remoteModal = document.getElementById('modal-host-remote-room');
  const inputRoomCode = document.getElementById('host-input-room-code');
  const inputPin = document.getElementById('host-input-pin');
  const qrCanvas = document.getElementById('host-qr-canvas');
  const qrRoomText = document.getElementById('host-qr-room-text');
  const displayUrlPreview = document.getElementById('host-display-url-preview');
  const hostRemoteDot = document.getElementById('host-remote-dot');
  const hostRemoteBtnText = document.getElementById('host-remote-btn-text');
  const hostModalDot = document.getElementById('host-modal-dot');
  const hostModalStatusText = document.getElementById('host-modal-status-text');
  const hostDisplayCountBadge = document.getElementById('host-display-count-badge');
  const btnStartBroadcast = document.getElementById('host-btn-start-broadcast');
  const btnDisconnectRemote = document.getElementById('host-btn-disconnect-remote');
  const btnCloseRemote = document.getElementById('host-btn-close-remote-room');
  const closeRoomPanel = document.getElementById('host-close-room-panel');

  function generateRandomRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let res = 'CD-';
    for (let i = 0; i < 4; i++) {
      res += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return res;
  }

  let currentRoomId = localStorage.getItem('countdown_studio_host_room_v1') || generateRandomRoomCode();
  let currentPin = localStorage.getItem('countdown_studio_host_pin_v1') || '1234';

  if (inputRoomCode) inputRoomCode.value = currentRoomId;
  if (inputPin) inputPin.value = currentPin;

  function renderRemoteQR(roomId) {
    const cleanRoom = (roomId || currentRoomId).toUpperCase().trim();
    if (qrRoomText) qrRoomText.textContent = cleanRoom;
    const displayUrl = getStageDisplayUrl(cleanRoom);
    if (displayUrlPreview) displayUrlPreview.textContent = displayUrl;

    if (qrCanvas) {
      renderQrCode(qrCanvas, displayUrl);
    }
    return displayUrl;
  }

  renderRemoteQR(currentRoomId);

  // Status handler from StageSyncChannel
  syncChannel?.onStatusChange((status) => {
    const isOnline = Boolean(status.connected);
    const count = status.displayCount || 0;

    // Top Bar updates
    if (hostRemoteDot) {
      hostRemoteDot.className = `status-dot ${isOnline ? 'status-dot--online' : 'status-dot--offline'}`;
    }
    if (hostRemoteBtnText) {
      hostRemoteBtnText.textContent = isOnline
        ? `Broadcasting: ${status.roomId} (${count} views)`
        : 'Online Room';
    }

    // Modal updates
    if (hostModalDot) {
      hostModalDot.className = `status-dot ${isOnline ? 'status-dot--online' : 'status-dot--offline'}`;
    }
    if (hostModalStatusText) {
      if (status.error) {
        hostModalStatusText.textContent = `Error: ${status.error}`;
        hostModalStatusText.style.color = 'var(--status-invalid)';
      } else if (isOnline) {
        hostModalStatusText.textContent = `Broadcasting live (Room ${status.roomId})`;
        hostModalStatusText.style.color = '#10B981';
      } else {
        hostModalStatusText.textContent = 'Not broadcasting';
        hostModalStatusText.style.color = 'var(--text-secondary)';
      }
    }
    if (hostDisplayCountBadge) {
      hostDisplayCountBadge.textContent = `${count} Connected Display(s)`;
    }
    if (btnStartBroadcast) {
      btnStartBroadcast.textContent = isOnline ? '🔄 Update Room' : '🚀 Start Broadcast';
    }
    if (btnDisconnectRemote) {
      btnDisconnectRemote.hidden = !isOnline;
    }
    if (btnCloseRemote) {
      btnCloseRemote.hidden = !isOnline;
    }
    if (closeRoomPanel) {
      closeRoomPanel.hidden = !isOnline;
    }
  });

  const openRemoteModal = () => {
    if (!remoteModal) return;
    remoteModal.hidden = false;
    remoteModal.style.display = 'flex';
    renderRemoteQR(inputRoomCode ? inputRoomCode.value : currentRoomId);
  };

  const closeRemoteModal = () => {
    if (!remoteModal) return;
    remoteModal.hidden = true;
    remoteModal.style.display = 'none';
  };

  document.getElementById('host-btn-remote-room')?.addEventListener('click', openRemoteModal);
  document.getElementById('host-btn-close-remote-modal')?.addEventListener('click', closeRemoteModal);
  remoteModal?.addEventListener('click', (e) => {
    if (e.target === remoteModal) closeRemoteModal();
  });

  document.getElementById('host-btn-gen-room')?.addEventListener('click', () => {
    const newRoom = generateRandomRoomCode();
    if (inputRoomCode) inputRoomCode.value = newRoom;
    renderRemoteQR(newRoom);
  });

  inputRoomCode?.addEventListener('input', () => {
    renderRemoteQR(inputRoomCode.value);
  });

  document.getElementById('host-btn-copy-room-link')?.addEventListener('click', async () => {
    const url = renderRemoteQR(inputRoomCode?.value || currentRoomId);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(url);
      showToast('Display link copied to clipboard!', 'success');
    }
  });

  btnStartBroadcast?.addEventListener('click', () => {
    const room = (inputRoomCode?.value || '').toUpperCase().trim();
    const pin = (inputPin?.value || '').trim();
    if (!room) {
      showToast('Please enter a Room Code.', 'error');
      return;
    }
    currentRoomId = room;
    currentPin = pin;
    localStorage.setItem('countdown_studio_host_room_v1', room);
    localStorage.setItem('countdown_studio_host_pin_v1', pin);

    syncChannel.connectRemote(room, 'host', pin);
    broadcastState(store.getState());
    showToast(`Connected to broadcast server for room ${room}!`, 'success');
  });

  btnDisconnectRemote?.addEventListener('click', () => {
    syncChannel.disconnectRemote();
    showToast('Disconnected from online broadcast.', 'info');
  });

  btnCloseRemote?.addEventListener('click', () => {
    if (!syncChannel?.isRemoteConnected || !syncChannel.ws || syncChannel.ws.readyState !== WebSocket.OPEN) {
      showToast('Room is not currently open.', 'info');
      return;
    }
    if (!window.confirm('Close this room? All connected displays will be disconnected and this room code will no longer be accessible.')) return;
    if (syncChannel.closeRemoteRoom()) {
      showToast('Closing room and disconnecting all connected displays...', 'info');
    }
  });

  document.getElementById('btn-test-display')?.addEventListener('click', () => {
    audio.unlock();
    audio.playValidChime();
    const cur = store.getState();
    store.update(
      { testPattern: !cur.testPattern },
      { logMessage: `Toggled Display Test Pattern (${!cur.testPattern ? 'ON' : 'OFF'}).` }
    );
    showToast('Sent Test Pattern & Sound Check to Stage Display.', 'info');
  });

  // Letters Host Controls
  document.getElementById('host-btn-vowel')?.addEventListener('click', () => hostPickLetter('V'));
  document.getElementById('host-btn-consonant')?.addEventListener('click', () => hostPickLetter('C'));
  document.getElementById('host-btn-random-letters')?.addEventListener('click', hostPickRandomLetters);
  document.getElementById('host-btn-reshuffle-letters')?.addEventListener('click', () => {
    letterStacks = createLetterStacks(rng);
    const st = store.getState();
    if (st.roundType === 'L') {
      store.update(
        { letters: [], vowelCount: 0, consonantCount: 0, bestWords: [] },
        { recordUndo: true, logMessage: 'Reshuffled letter stacks and cleared board.' }
      );
    }
    showToast('Vowel & Consonant stacks reshuffled.', 'info');
  });

  // Numbers Host Controls
  document.querySelectorAll('[data-host-large]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const raw = btn.getAttribute('data-host-large');
      const count = raw === 'random' ? randomInt(0, 4, rng) : Number(raw);
      hostPickNumbers(count);
    });
  });

  document.getElementById('host-btn-show-num-solution')?.addEventListener('click', () => {
    const st = store.getState();
    store.update(
      { showNumbersSolutionOnDisplay: !st.showNumbersSolutionOnDisplay },
      { logMessage: 'Toggled Numbers Solver solution on Stage Display.' }
    );
  });

  // Conundrum Host Controls
  document.getElementById('host-btn-buzz-p1')?.addEventListener('click', () =>
    handleContestantBuzz(1, performance.now())
  );
  document.getElementById('host-btn-buzz-p2')?.addEventListener('click', () =>
    handleContestantBuzz(2, performance.now())
  );
  document.getElementById('host-btn-buzz-correct')?.addEventListener('click', () =>
    adjudicateConundrumBuzz(true)
  );
  document.getElementById('host-btn-buzz-wrong')?.addEventListener('click', () =>
    adjudicateConundrumBuzz(false)
  );
  document.getElementById('host-btn-reveal-conundrum')?.addEventListener('click', () => {
    const st = store.getState();
    store.transition(
      PHASES.SCORING,
      { conundrumRevealed: true, clockRunning: false, activeBuzzerPlayer: null },
      `Revealed Conundrum answer on Stage Display: ${st.conundrumAnswer}`
    );
  });

  // Clock Controls
  document.getElementById('host-btn-clock-toggle')?.addEventListener('click', toggleClockRunPause);
  document.getElementById('host-btn-clock-reset')?.addEventListener('click', () => {
    if (clock) clock.reset();
    audio.resetClockTracker();
    const st = store.getState();
    store.update(
      {
        clockRemainingMs: st.clockDuration * 1000,
        clockRunning: false,
        clockStartedAtEpoch: null
      },
      { logMessage: 'Reset clock to full duration.' }
    );
  });

  // Adjudication & Round Progression
  document.getElementById('host-btn-score-round')?.addEventListener('click', scoreCurrentRoundSubmissions);
  document.getElementById('host-btn-next-round')?.addEventListener('click', () => {
    const st = store.getState();
    configureRoundAtIndex(st.roundIndex + 1);
  });

  // Operator Tools (Undo, Skip, Replay, Manual Score, Panic, Tie-Break, Dictionary Challenge)
  document.getElementById('host-btn-undo')?.addEventListener('click', () => {
    if (store.undo()) {
      showToast('Undid last operator action.', 'info');
    } else {
      showToast('Nothing to undo.', 'error');
    }
  });

  document.getElementById('host-btn-replay-round')?.addEventListener('click', () => {
    const st = store.getState();
    configureRoundAtIndex(st.roundIndex, `Replaying Round ${st.roundIndex + 1}.`);
  });

  document.getElementById('host-btn-skip-round')?.addEventListener('click', () => {
    const st = store.getState();
    configureRoundAtIndex(st.roundIndex + 1, `Skipped Round ${st.roundIndex + 1}.`);
  });

  document.getElementById('host-btn-panic')?.addEventListener('click', () => {
    const st = store.getState();
    const nextBlank = !st.panicBlank;
    store.update(
      { panicBlank: nextBlank },
      { logMessage: `Panic blank screen ${nextBlank ? 'ACTIVATED' : 'CLEARED'}.` }
    );
    renderHostConsole(store.getState());
  });

  // Manual Score +/- Adjustments
  document.querySelectorAll('[data-score-adj]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const playerIdx = Number(btn.getAttribute('data-player')) - 1;
      const delta = Number(btn.getAttribute('data-score-adj'));
      const st = store.getState();
      const nextPlayers = structuredClone(st.players);
      nextPlayers[playerIdx].score = Math.max(0, nextPlayers[playerIdx].score + delta);
      store.update(
        { players: nextPlayers },
        {
          recordUndo: true,
          logMessage: `Manual score adjustment for ${nextPlayers[playerIdx].name}: ${
            delta > 0 ? `+${delta}` : delta
          } (now ${nextPlayers[playerIdx].score}).`
        }
      );
    });
  });

  // Sudden-Death Tie-Break Conundrum
  document.getElementById('host-btn-tiebreak')?.addEventListener('click', () => {
    const st = store.getState();
    const nextSchedule = [...st.schedule, 'C'];
    store.update({ schedule: nextSchedule });
    configureRoundAtIndex(
      nextSchedule.length - 1,
      'Launched Sudden-Death Tie-Break Conundrum!'
    );
  });

  // Dictionary Challenge Checker
  document.getElementById('host-btn-challenge-word')?.addEventListener('click', async () => {
    const input = document.getElementById('host-challenge-input');
    const resultEl = document.getElementById('host-challenge-result');
    const raw = input ? input.value.trim().toUpperCase() : '';
    if (!raw) return;

    const inDict = dictData && dictData.wordSet.has(raw.toLowerCase());
    let defText = '';
    if (inDict) {
      audio.playValidChime();
      const apiDef = await fetchWordDefinition(raw);
      defText = apiDef ? `${apiDef.partOfSpeech}: ${apiDef.definition}` : 'Verified in Countdown lexicon.';
    } else {
      audio.playInvalidBuzz();
      defText = 'Rejected — Not present in official Countdown lexicon.';
    }

    const challengeResult = { word: raw, valid: Boolean(inDict), definition: defText };
    if (resultEl) {
      resultEl.textContent = `${inDict ? '✓ VALID' : '✗ INVALID'} — ${raw}: ${defText}`;
      resultEl.style.color = inDict ? 'var(--status-valid)' : 'var(--status-invalid)';
    }
    store.update(
      { challengeResult },
      { logMessage: `Dictionary challenge "${raw}": ${inDict ? 'VALID' : 'INVALID'}.` }
    );
  });

  // Copy Action Log & Export Match Summary
  document.getElementById('host-btn-copy-log')?.addEventListener('click', async () => {
    const st = store.getState();
    const text = (st.actionLog || []).map((l) => `[${l.time}] ${l.message}`).join('\n');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      showToast('Operator log copied to clipboard.', 'success');
    }
  });

  document.getElementById('host-btn-export-png')?.addEventListener('click', () => {
    exportMatchSummaryPNG(store.getState());
  });

  // Global Host Keyboard Hotkeys
  document.addEventListener('keydown', (e) => {
    if (
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement ||
      e.target instanceof HTMLSelectElement
    ) {
      return;
    }

    const key = e.key.toLowerCase();
    const st = store.getState();

    // Conundrum buzzers: Left Shift / Q for Player 1, Right Shift / P for Player 2
    if (st.roundType === 'C' && st.phase === PHASES.CLOCK_RUNNING) {
      if (e.code === 'ShiftLeft' || key === (settings.p1BuzzerKey || 'q')) {
        e.preventDefault();
        handleContestantBuzz(1, performance.now());
        return;
      }
      if (e.code === 'ShiftRight' || key === (settings.p2BuzzerKey || 'p')) {
        e.preventDefault();
        handleContestantBuzz(2, performance.now());
        return;
      }
    }

    if (key === 'c' && st.roundType === 'L' && st.phase === PHASES.PICKING) {
      e.preventDefault();
      hostPickLetter('C');
    } else if (key === 'v' && st.roundType === 'L' && st.phase === PHASES.PICKING) {
      e.preventDefault();
      hostPickLetter('V');
    } else if (key === 'r' && st.roundType === 'L' && st.phase === PHASES.PICKING) {
      e.preventDefault();
      hostPickRandomLetters();
    } else if (e.code === 'Space') {
      e.preventDefault();
      toggleClockRunPause();
    } else if (key === 'd') {
      e.preventDefault();
      document.getElementById('host-p1-submission')?.focus();
    } else if (key === 'n') {
      e.preventDefault();
      configureRoundAtIndex(st.roundIndex + 1);
    }
  });
});
