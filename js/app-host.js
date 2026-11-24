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
  saveStageControlsHidden,
  saveGameLog
} from './core/storage.js';
import {
  PHASES,
  createInitialMatchState,
  GameStore
} from './core/state.js';
import { createRNG, randomInt } from './core/rng.js';
import { audio } from './core/audio.js';
import { CountdownClock } from './core/clock.js';
import {
  createLetterStacks,
  getPickConstraints,
  pickLetterTile,
  pickRandomRemainingLetters,
  validateWordSubmission,
  isDictionaryWordOrInflection
} from './game/letters.js';
import {
  drawNumbersTiles,
  generateTarget
} from './game/numbers.js';
import {
  pickConundrum,
  adjudicateBuzz,
  checkConundrumGuess
} from './game/conundrum.js';
import {
  scoreVersusLettersRound,
  scoreVersusNumbersRound,
  scoreSingleWord,
  scoreSingleNumbers
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
import { apiFetch, readApiJson } from './net/api.js';
import { authHeaders } from './auth.js';
import { fetchWordDefinition } from './net/dictionaryApi.js';
import { renderDictionaryCorner, renderNumbersSolution } from './ui/board.js';
import { exportMatchSummaryPNG, launchConfetti } from './ui/scoreboard.js';
import { initModalHandlers } from './ui/modal.js';
import { showToast } from './ui/toast.js';
import { requestWakeLock } from './ui/a11y.js';
import { drawQrCodeToCanvas } from './ui/qrcode.js';
import { compressStageBackgroundFile } from './ui/stageImage.js';

let settings = loadSettings();
let dictData = null;
const rng = createRNG();
let letterStacks = createLetterStacks(rng);

/** Tracks conundrum answers already used in the current match to avoid repeats. */
let usedConundrumAnswers = new Set();

const store = new GameStore(createInitialMatchState({ theme: settings.theme }));
let syncChannel = null;
let clock = null;
let buzzerAnswerTimer = null;
let hostCustomSchedule = [];
let selectedArchiveSnapshot = null;
let lastBroadcastAt = 0;
let lastNonTickBroadcastKey = '';
let lastSolverRenderKey = '';
let lastActionLogRenderKey = '';
let lastScheduleStripKey = '';
let lastRoundHistoryKey = '';
let lastLoggedMatchId = null;

const HISTORY_PAGE_SIZE = 25;
const historyFilterState = { offset: 0, total: 0 };

function readHistoryFilterQuery(offset) {
  const roomInput = document.getElementById('host-history-filter-room');
  const fromInput = document.getElementById('host-history-filter-from');
  const toInput = document.getElementById('host-history-filter-to');
  const query = new URLSearchParams();
  query.set('limit', String(HISTORY_PAGE_SIZE));
  query.set('offset', String(Math.max(0, offset || 0)));
  const room = (roomInput?.value || '').toUpperCase().trim();
  if (room) query.set('room', room);
  const from = (fromInput?.value || '').trim();
  if (from) query.set('from', from);
  const to = (toInput?.value || '').trim();
  if (to) query.set('to', to);
  return query.toString();
}

function renderHistoryRow(item, list) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'host-history-row';
  row.dataset.archiveId = String(item.id);
  const scores = Array.isArray(item.final_scores)
    ? item.final_scores.map((score) => `${score.name}: ${score.score}`).join(' · ')
    : 'No final score';
  const roomEl = document.createElement('strong');
  roomEl.textContent = item.room_code;
  const dateEl = document.createElement('span');
  dateEl.textContent = new Date(item.closed_at).toLocaleString();
  const scoreEl = document.createElement('span');
  scoreEl.textContent = scores;
  row.append(roomEl, dateEl, scoreEl);
  row.addEventListener('click', () => showMatchArchive(item.id));
  list.appendChild(row);
}

async function loadMatchHistory({ append = false } = {}) {
  const list = document.getElementById('host-history-list');
  const status = document.getElementById('host-history-status');
  const moreButton = document.getElementById('host-btn-more-history');
  if (!list) return;
  if (!append) list.replaceChildren();
  if (status && !append) status.textContent = 'Loading archived matches…';
  const offset = append ? historyFilterState.offset : 0;
  try {
    const response = await apiFetch(`/api/versus/history?${readHistoryFilterQuery(offset)}`, { headers: authHeaders() });
    const data = await readApiJson(response);
    if (!response.ok) throw new Error(data.message || data.error || 'Unable to load match history.');
    if (!data.items?.length && !append) {
      list.textContent = 'No archived matches match the current filters.';
    } else {
      for (const item of data.items) renderHistoryRow(item, list);
    }
    historyFilterState.offset = offset + (data.items?.length || 0);
    historyFilterState.total = Number(data.total || 0);
    const totalLabel = historyFilterState.total > 0
      ? `${historyFilterState.total} archived match(es)`
      : '0 archived matches';
    if (status) {
      status.textContent = append
        ? `${totalLabel} · showing ${historyFilterState.offset}`
        : totalLabel;
    }
    if (moreButton) moreButton.hidden = historyFilterState.offset >= historyFilterState.total;
  } catch (error) {
    if (status && !append) status.textContent = error instanceof Error ? error.message : 'History unavailable.';
    else if (status) status.textContent = error instanceof Error ? error.message : 'History unavailable.';
  }
}

async function showMatchArchive(archiveId) {
  const detail = document.getElementById('host-history-detail');
  if (!detail) return;
  try {
    const response = await apiFetch(`/api/versus/history/${encodeURIComponent(archiveId)}`, { headers: authHeaders() });
    const data = await readApiJson(response);
    if (!response.ok) throw new Error(data.message || data.error || 'Archive unavailable.');
    selectedArchiveSnapshot = data.item;
    detail.textContent = JSON.stringify(data.item, null, 2);
    const downloadButton = document.getElementById('host-btn-download-history');
    if (downloadButton) downloadButton.disabled = false;
  } catch (error) {
    selectedArchiveSnapshot = null;
    const downloadButton = document.getElementById('host-btn-download-history');
    if (downloadButton) downloadButton.disabled = true;
    detail.textContent = error instanceof Error ? error.message : 'Archive unavailable.';
  }
}

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
  const pageParams = new URLSearchParams(window.location.search);
  const wsEndpoint = pageParams.get('ws')
    || window.__COUNTDOWN_STAGE_WS_URL__
    || (typeof import.meta !== 'undefined' && import.meta.env?.VITE_STAGE_WS_URL);
  if (wsEndpoint) url.searchParams.set('ws', wsEndpoint);
  const apiEndpoint = pageParams.get('api')
    || window.__COUNTDOWN_API_URL__
    || (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_URL);
  if (apiEndpoint) url.searchParams.set('api', apiEndpoint);
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
  drawQrCodeToCanvas(canvas, value, {
    width: 200,
    margin: 2,
    dark: '#030712',
    light: '#FFFFFF'
  });
}

function broadcastState(state, { force = false } = {}) {
  if (!syncChannel) return;
  const nonTickKey = JSON.stringify({ ...state, clockRemainingMs: undefined });
  const now = Date.now();
  if (force || nonTickKey !== lastNonTickBroadcastKey || now - lastBroadcastAt >= 1000) {
    lastNonTickBroadcastKey = nonTickKey;
    lastBroadcastAt = now;
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
      audio.stopClockMusic();
      store.transition(
        PHASES.REVEAL,
        {
          clockRemainingMs: 0,
          clockBaseRemainingMs: 0,
          clockRunning: false,
          clockStartedAtEpoch: null,
          activeBuzzerPlayer: null
        },
        `Round ${st.roundIndex + 1} clock expired (Time!).`
      );
      broadcastState(store.getState(), { force: true });
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
  presetSelect.value = (SCHEDULE_PRESETS[initialPreset] || initialPreset === 'custom')
    ? initialPreset
    : 'tv-15';
  hostCustomSchedule = getScheduleRounds('custom', settings.customSchedule);
  if (hostCustomSchedule.length === 0) hostCustomSchedule = [...SCHEDULE_PRESETS['tv-15'].rounds];

  let dragIndex = null;

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
      item.style.gap = '0.25rem';
      item.setAttribute('aria-label', `Round ${index + 1}: ${getRoundTypeName(code)}. Drag or use arrows to reorder.`);

      const moveLeft = document.createElement('button');
      moveLeft.type = 'button';
      moveLeft.className = 'btn btn--sm';
      moveLeft.style.padding = '0 0.2rem';
      moveLeft.textContent = '‹';
      moveLeft.title = `Move round ${index + 1} earlier`;
      moveLeft.disabled = index === 0;
      moveLeft.addEventListener('click', (event) => {
        event.stopPropagation();
        if (index === 0) return;
        [hostCustomSchedule[index - 1], hostCustomSchedule[index]] = [hostCustomSchedule[index], hostCustomSchedule[index - 1]];
        render();
      });

      const label = document.createElement('span');
      label.textContent = `R${index + 1}: ${getRoundTypeName(code)}`;

      const moveRight = document.createElement('button');
      moveRight.type = 'button';
      moveRight.className = 'btn btn--sm';
      moveRight.style.padding = '0 0.2rem';
      moveRight.textContent = '›';
      moveRight.title = `Move round ${index + 1} later`;
      moveRight.disabled = index === hostCustomSchedule.length - 1;
      moveRight.addEventListener('click', (event) => {
        event.stopPropagation();
        if (index >= hostCustomSchedule.length - 1) return;
        [hostCustomSchedule[index + 1], hostCustomSchedule[index]] = [hostCustomSchedule[index], hostCustomSchedule[index + 1]];
        render();
      });

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn--sm';
      remove.style.marginLeft = '0.15rem';
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
      item.append(moveLeft, label, moveRight, remove);

      item.addEventListener('dragstart', () => { dragIndex = index; });
      item.addEventListener('dragover', (event) => event.preventDefault());
      item.addEventListener('drop', (event) => {
        event.preventDefault();
        if (dragIndex === null || dragIndex === index) return;
        const [moved] = hostCustomSchedule.splice(dragIndex, 1);
        hostCustomSchedule.splice(index, 0, moved);
        dragIndex = null;
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

function populatePreMatchSetupModal() {
  const st = store.getState();
  const p1Name = document.getElementById('setup-p1-name');
  const p2Name = document.getElementById('setup-p2-name');
  const p1Color = document.getElementById('setup-p1-color');
  const p2Color = document.getElementById('setup-p2-color');
  const clockSel = document.getElementById('setup-clock');
  const starterSel = document.getElementById('setup-starter');
  const themeSel = document.getElementById('setup-theme');
  const onlyLongerChk = document.getElementById('setup-only-longer');
  const soundChk = document.getElementById('setup-sound');

  if (p1Name) p1Name.value = st.players?.[0]?.name || 'Contestant 1';
  if (p2Name) p2Name.value = st.players?.[1]?.name || 'Contestant 2';
  if (p1Color) p1Color.value = st.players?.[0]?.color || '#38BDF8';
  if (p2Color) p2Color.value = st.players?.[1]?.color || '#F59E0B';
  if (clockSel) clockSel.value = String(st.clockDuration ?? settings.clockDuration ?? 30);
  if (starterSel) starterSel.value = String(settings.startingPlayer || 1);
  if (themeSel) themeSel.value = st.theme || settings.theme || 'classic-blue';
  if (onlyLongerChk) onlyLongerChk.checked = settings.onlyLongerScores !== false;
  if (soundChk) soundChk.checked = settings.soundEnabled !== false;
}

function updateActiveMatchMeta() {
  const st = store.getState();
  const p1Name = document.getElementById('setup-p1-name')?.value.trim() || 'Contestant 1';
  const p2Name = document.getElementById('setup-p2-name')?.value.trim() || 'Contestant 2';
  const p1Color = document.getElementById('setup-p1-color')?.value || '#38BDF8';
  const p2Color = document.getElementById('setup-p2-color')?.value || '#F59E0B';
  const theme = document.getElementById('setup-theme')?.value || 'classic-blue';
  const onlyLonger = document.getElementById('setup-only-longer')?.checked ?? true;
  const soundOn = document.getElementById('setup-sound')?.checked ?? true;

  settings = saveSettings({
    theme,
    onlyLongerScores: onlyLonger,
    soundEnabled: soundOn
  });
  audio.setMuted(!soundOn);

  const nextPlayers = st.players.map((p, idx) => ({
    ...p,
    name: idx === 0 ? p1Name : p2Name,
    color: idx === 0 ? p1Color : p2Color
  }));

  store.update(
    { theme, players: nextPlayers },
    {
      recordUndo: true,
      logMessage: `Updated match details: ${p1Name} vs ${p2Name} (${theme}).`
    }
  );
  broadcastState(store.getState(), { force: true });
  showToast('Updated active match details without resetting scores.', 'success');
}

function startNewMatchFromSetup() {
  const p1Name = document.getElementById('setup-p1-name')?.value.trim() || 'Contestant 1';
  const p2Name = document.getElementById('setup-p2-name')?.value.trim() || 'Contestant 2';
  const p1Color = document.getElementById('setup-p1-color')?.value || '#38BDF8';
  const p2Color = document.getElementById('setup-p2-color')?.value || '#F59E0B';
  const preset = document.getElementById('setup-schedule')?.value || 'tv-15';
  const clockSec = Number(document.getElementById('setup-clock')?.value || 30);
  const starter = Number(document.getElementById('setup-starter')?.value || 1);
  const theme = document.getElementById('setup-theme')?.value || 'classic-blue';
  const onlyLonger = document.getElementById('setup-only-longer')?.checked ?? true;
  const soundOn = document.getElementById('setup-sound')?.checked ?? true;

  settings = saveSettings({
    theme,
    clockDuration: clockSec,
    startingPlayer: starter,
    onlyLongerScores: onlyLonger,
    soundEnabled: soundOn
  });
  audio.setMuted(!soundOn);
  audio.unlock();
  requestWakeLock();

  letterStacks = createLetterStacks(rng);
  usedConundrumAnswers = new Set();
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
    clockBaseRemainingMs: clockSec * 1000,
    players: [
      { id: 1, name: p1Name, color: p1Color, score: 0, submission: '', valid: null, roundPoints: 0, lockedOut: false },
      { id: 2, name: p2Name, color: p2Color, score: 0, submission: '', valid: null, roundPoints: 0, lockedOut: false }
    ],
    actionLog: [{ time: new Date().toLocaleTimeString(), message: `Match started: ${p1Name} vs ${p2Name} (${schedule.length} rounds).` }]
  });

  if (firstType === 'C') {
    const con = pickConundrum(dictData ? dictData.conundrums : [], rng, dictData?.wordSet, usedConundrumAnswers);
    fresh.conundrumAnswer = con.answer;
    fresh.conundrumAnswers = con.answers;
    fresh.conundrumScrambled = con.scrambled;
    fresh.conundrumSourceWords = con.sourceWords;
  }

  store.replaceState(fresh);
  if (clock) clock.setDuration(clockSec);
  const p1In = document.getElementById('host-p1-submission');
  const p2In = document.getElementById('host-p2-submission');
  if (p1In) p1In.value = '';
  if (p2In) p2In.value = '';
  broadcastState(store.getState(), { force: true });
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
      {
        clockRunning: false,
        clockStartedAtEpoch: null,
        clockBaseRemainingMs: st.clockRemainingMs
      },
      'Match completed!'
    );
    broadcastState(store.getState(), { force: true });
    audio.playFanfare();
    launchConfetti();

    const finalState = store.getState();
    if (lastLoggedMatchId !== finalState.matchId) {
      lastLoggedMatchId = finalState.matchId;
      const topScore = Math.max(finalState.players[0]?.score || 0, finalState.players[1]?.score || 0);
      void saveGameLog(
        { score: topScore, maxPossible: 0, roundsCount: (finalState.roundHistory || []).length },
        {
          mode: 'versus-host',
          matchId: finalState.matchId,
          roomCode: syncChannel?.roomId || null,
          roundsCount: (finalState.roundHistory || []).length,
          sessionData: {
            players: finalState.players,
            roundHistory: finalState.roundHistory
          }
        }
      );
    }
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
    clockBaseRemainingMs: st.clockDuration * 1000,
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
    conundrumAnswers: [],
    conundrumSourceWords: null,
    conundrumRevealed: false,
    activeBuzzerPlayer: null
  };

  if (rType === 'C') {
    const con = pickConundrum(dictData ? dictData.conundrums : [], rng, dictData?.wordSet, usedConundrumAnswers);
    patch.conundrumAnswer = con.answer;
    patch.conundrumAnswers = con.answers;
    patch.conundrumScrambled = con.scrambled;
    patch.conundrumSourceWords = con.sourceWords;
  }

  // clear host input fields
  const p1In = document.getElementById('host-p1-submission');
  const p2In = document.getElementById('host-p2-submission');
  if (p1In) p1In.value = '';
  if (p2In) p2In.value = '';
  const conCheckIn = document.getElementById('host-conundrum-check-input');
  const conCheckStatus = document.getElementById('host-conundrum-check-status');
  if (conCheckIn) conCheckIn.value = '';
  if (conCheckStatus) {
    conCheckStatus.textContent = 'Type spoken answer to verify';
    conCheckStatus.style.color = 'var(--text-muted)';
  }

  store.transition(PHASES.PICKING, patch, logText || `Started Round ${roundIdx + 1} (${getRoundTypeName(rType)}).`);
}

/* ============================================================================
 * HOST ROUND ACTIONS
 * ========================================================================== */
function ensureMatchActiveForPicking() {
  const st = store.getState();
  if (st.phase === PHASES.IDLE) {
    store.transition(PHASES.PICKING, {}, `Started Round ${st.roundIndex + 1} (${getRoundTypeName(st.roundType)}).`);
  }
}

function hostPickLetter(kind) {
  ensureMatchActiveForPicking();
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
  ensureMatchActiveForPicking();
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
  ensureMatchActiveForPicking();
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
    const pausedRem = Math.round(clock.remainingMs);
    store.update(
      {
        clockRunning: false,
        clockRemainingMs: pausedRem,
        clockBaseRemainingMs: pausedRem,
        clockStartedAtEpoch: null
      },
      { logMessage: `Paused clock at ${(pausedRem / 1000).toFixed(1)}s.` }
    );
    broadcastState(store.getState(), { force: true });
  } else {
    const startRemMs = st.clockRemainingMs > 0 ? st.clockRemainingMs : st.clockDuration * 1000;
    const startEpoch = Date.now();
    if (st.phase === PHASES.IDLE || st.phase === PHASES.PICKING || st.phase === PHASES.REVEAL) {
      store.transition(
        PHASES.CLOCK_RUNNING,
        {
          clockRunning: true,
          clockStartedAtEpoch: startEpoch,
          clockBaseRemainingMs: startRemMs
        },
        `Started ${st.clockDuration || 30}s clock for Round ${st.roundIndex + 1}.`
      );
    } else {
      store.update(
        {
          clockRunning: true,
          clockStartedAtEpoch: startEpoch,
          clockBaseRemainingMs: startRemMs
        },
        { logMessage: 'Resumed clock.' }
      );
    }
    broadcastState(store.getState(), { force: true });
    clock.start(startRemMs);
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

  const pausedRem = Math.round(clock ? clock.remainingMs : st.clockRemainingMs);
  store.update(
    {
      clockRunning: false,
      clockRemainingMs: pausedRem,
      clockBaseRemainingMs: pausedRem,
      clockStartedAtEpoch: null,
      activeBuzzerPlayer: adj.winner,
      buzzerTimestamp: timestamp,
      buzzerRemainingMs: 5000
    },
    {
      recordUndo: true,
      logMessage: `${st.players[adj.winner - 1].name} buzzed in at ${(
        pausedRem / 1000
      ).toFixed(1)}s!`
    }
  );
  broadcastState(store.getState(), { force: true });

  clearBuzzerTimer();
  let rem = 5000;
  buzzerAnswerTimer = setInterval(() => {
    rem = Math.max(0, rem - 250);
    store.update({ buzzerRemainingMs: rem });
    if (rem <= 0) {
      clearBuzzerTimer();
      showToast(`5s answer window expired for ${st.players[adj.winner - 1].name} — mark Correct or Wrong.`, 'info');
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
    if (clock && clock.running) clock.pause();
    audio.stopClockMusic();
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
        clockRunning: false,
        clockStartedAtEpoch: null,
        activeBuzzerPlayer: null,
        conundrumRevealed: true,
        roundHistory: nextHistory
      },
      `CORRECT! ${nextPlayers[idx].name} solved "${st.conundrumAnswer}" (+10 pts).`
    );
    broadcastState(store.getState(), { force: true });
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
function updateLiveDeclarationHints(state = store.getState()) {
  const hint1 = document.getElementById('host-p1-validation');
  const hint2 = document.getElementById('host-p2-validation');
  const p1Raw = document.getElementById('host-p1-submission')?.value.trim() || '';
  const p2Raw = document.getElementById('host-p2-submission')?.value.trim() || '';
  const p1Verified = document.getElementById('host-p1-valid-toggle')?.checked ?? true;
  const p2Verified = document.getElementById('host-p2-valid-toggle')?.checked ?? true;

  const applyHint = (el, raw, verified) => {
    if (!el) return;
    el.classList.remove('is-valid', 'is-invalid');
    if (!raw) {
      el.textContent = '';
      return;
    }
    if (state.roundType === 'L') {
      if (!state.letters || state.letters.length < 9) {
        el.textContent = 'Pick all 9 letters to validate.';
        return;
      }
      const res = validateWordSubmission(raw, state.letters, dictData ? dictData.wordSet : null);
      if (res.valid) {
        const pts = scoreSingleWord(res.normalizedWord, true);
        el.classList.add('is-valid');
        el.textContent = `✓ Valid (${res.normalizedWord.length}L · ${pts} pts)`;
      } else {
        el.classList.add('is-invalid');
        const reasonMap = {
          too_short: 'Too short (min 2 letters)',
          too_long: 'Exceeds 9 letters',
          non_alpha: 'Letters A–Z only',
          missing_letters: `Missing tile "${res.missingLetter || '?'}"`,
          not_in_dictionary: 'Not in dictionary'
        };
        el.textContent = `✗ ${reasonMap[res.reason] || 'Invalid word'}`;
      }
    } else if (state.roundType === 'N') {
      const val = Number(raw);
      if (!Number.isFinite(val) || !Number.isInteger(val) || val <= 0) {
        el.classList.add('is-invalid');
        el.textContent = '✗ Enter a positive integer';
        return;
      }
      if (!state.target) {
        el.textContent = 'Draw target numbers first.';
        return;
      }
      if (!verified) {
        el.classList.add('is-invalid');
        el.textContent = '✗ Working unchecked (0 pts)';
        return;
      }
      const res = scoreSingleNumbers(val, state.target, true, {
        exact: settings.numbersExactPoints,
        within5: settings.numbersClose5Points,
        within10: settings.numbersClose10Points
      });
      if (res.points > 0) {
        el.classList.add('is-valid');
        el.textContent = res.distance === 0
          ? `✓ Exact! (${res.points} pts)`
          : `✓ ${res.distance} away (${res.points} pts)`;
      } else {
        el.classList.add('is-invalid');
        el.textContent = `✗ ${res.distance} away (> 10 · 0 pts)`;
      }
    } else {
      const ok = checkConundrumGuess(raw, state.conundrumAnswers?.length ? state.conundrumAnswers : state.conundrumAnswer);
      el.classList.toggle('is-valid', ok);
      el.classList.toggle('is-invalid', !ok);
      el.textContent = ok ? '✓ Matches conundrum answer' : '✗ Does not match conundrum';
    }
  };

  applyHint(hint1, p1Raw, p1Verified);
  applyHint(hint2, p2Raw, p2Verified);
}

function previewDeclarationsOnStage() {
  const st = store.getState();
  const p1Raw = document.getElementById('host-p1-submission')?.value.trim().toUpperCase() || '';
  const p2Raw = document.getElementById('host-p2-submission')?.value.trim().toUpperCase() || '';
  const nextPlayers = st.players.map((p, idx) => ({
    ...p,
    submission: (idx === 0 ? p1Raw : p2Raw) || '',
    valid: null,
    roundPoints: 0
  }));
  store.update(
    { players: nextPlayers },
    { logMessage: `Displayed declarations on Stage: ${p1Raw || '—'} vs ${p2Raw || '—'}.` }
  );
  broadcastState(store.getState(), { force: true });
  showToast('Contestant declarations shown on Stage Display.', 'info');
}

function scoreCurrentRoundSubmissions() {
  const st = store.getState();
  if (st.phase === PHASES.IDLE) {
    showToast('Start a round or pick tiles before scoring.', 'error');
    return;
  }
  if (st.phase === PHASES.SCORING) {
    showToast('Current round is already scored. Use Undo to revise or advance to Next Round.', 'info');
    return;
  }

  audio.stopClockMusic();
  if (clock && clock.running) clock.pause();
  clearBuzzerTimer();

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
        clockRunning: false,
        clockStartedAtEpoch: null,
        activeBuzzerPlayer: null
      },
      `Revealed Conundrum answer: ${st.conundrumAnswer}`
    );
    broadcastState(store.getState(), { force: true });
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

  // Live Clock Readout & Progress Bar
  const durationMs = Math.max(0, Number(state.clockDuration || 30) * 1000);
  const remMs = Math.max(0, Number(state.clockRemainingMs ?? durationMs));
  const clockReadout = document.getElementById('host-clock-readout');
  const clockStateLabel = document.getElementById('host-clock-state-label');
  const clockProgressFill = document.getElementById('host-clock-progress-fill');
  if (clockReadout) {
    clockReadout.textContent = durationMs === 0
      ? 'Untimed'
      : `${(remMs / 1000).toFixed(1)}s / ${Math.round(durationMs / 1000)}s`;
  }
  if (clockStateLabel) {
    clockStateLabel.textContent = state.clockRunning
      ? '⏱ Clock Running'
      : state.activeBuzzerPlayer
        ? `🔔 Buzzer Frozen (${state.players[state.activeBuzzerPlayer - 1]?.name || 'Player'})`
        : remMs <= 0 && durationMs > 0
          ? '⏹ Time Expired'
          : '⏸ Clock Ready';
  }
  if (clockProgressFill) {
    const pct = durationMs > 0 ? Math.max(0, Math.min(100, (remMs / durationMs) * 100)) : 100;
    clockProgressFill.style.width = `${pct.toFixed(1)}%`;
    clockProgressFill.parentElement?.setAttribute('aria-valuenow', String(Math.round(pct)));
  }

  // Schedule Strip (memoized)
  const scheduleStrip = document.getElementById('host-schedule-strip');
  const scheduleKey = `${state.schedule.join('')}:${state.roundIndex}:${state.phase}`;
  if (scheduleStrip && scheduleKey !== lastScheduleStripKey) {
    lastScheduleStripKey = scheduleKey;
    scheduleStrip.replaceChildren();
    state.schedule.forEach((code, idx) => {
      const pill = document.createElement('span');
      pill.className = 'host-schedule-pill';
      if (idx < state.roundIndex || (idx === state.roundIndex && (state.phase === PHASES.SCORING || state.phase === PHASES.MATCH_END))) {
        pill.classList.add('is-done');
      }
      if (idx === state.roundIndex && state.phase !== PHASES.MATCH_END) {
        pill.classList.add('is-current');
      }
      pill.textContent = `R${idx + 1}:${code}`;
      pill.title = `Round ${idx + 1}: ${getRoundTypeName(code)}`;
      scheduleStrip.appendChild(pill);
    });
  }

  // Toggle Round Type Specific Controls
  const lPanel = document.getElementById('host-controls-letters');
  const nPanel = document.getElementById('host-controls-numbers');
  const cPanel = document.getElementById('host-controls-conundrum');
  if (lPanel) lPanel.hidden = state.roundType !== 'L';
  if (nPanel) nPanel.hidden = state.roundType !== 'N';
  if (cPanel) cPanel.hidden = state.roundType !== 'C';

  // Hide Working Verified checkboxes unless in Numbers round
  document.querySelectorAll('.host-verified-label').forEach((el) => {
    el.hidden = state.roundType !== 'N';
  });

  // Update Scored Badge & Award Button
  const scoredBadge = document.getElementById('host-scored-badge');
  if (scoredBadge) scoredBadge.hidden = state.phase !== PHASES.SCORING;
  const scoreBtn = document.getElementById('host-btn-score-round');
  if (scoreBtn) {
    scoreBtn.disabled =
      state.phase === PHASES.SCORING ||
      state.phase === PHASES.IDLE ||
      state.phase === PHASES.MATCH_END;
    scoreBtn.textContent =
      state.roundType === 'C'
        ? 'Reveal Conundrum (No Score)'
        : 'Validate & Award Round Points';
  }

  const solverBox = document.getElementById('host-solver-output');
  if (state.roundType === 'L') {
    const c = getPickConstraints(state.vowelCount, state.consonantCount);
    const vBtn = document.getElementById('host-btn-vowel');
    const cBtn = document.getElementById('host-btn-consonant');
    const rBtn = document.getElementById('host-btn-random-letters');
    const lockPicking = state.phase !== PHASES.PICKING && state.phase !== PHASES.IDLE;
    if (vBtn) vBtn.disabled = lockPicking || !c.canPickVowel;
    if (cBtn) cBtn.disabled = lockPicking || !c.canPickConsonant;
    if (rBtn) rBtn.disabled = lockPicking || c.isComplete;

    const solverKey = `L:${(state.letters || []).join('')}:${Boolean(dictData)}`;
    if (solverBox && solverKey !== lastSolverRenderKey) {
      lastSolverRenderKey = solverKey;
      if (state.letters.length === 9 && dictData) {
        const solved = solveLettersRound(state.letters, dictData.trie, 10);
        renderDictionaryCorner(solverBox, solved);
      } else {
        solverBox.innerHTML = '<p style="color:var(--text-muted);font-size:0.875rem;">Pick 9 letters to view Dictionary Corner solutions for the host.</p>';
      }
    }
  } else if (state.roundType === 'N') {
    const solverKey = `N:${JSON.stringify(state.numbersSolution || null)}:${state.target || ''}`;
    if (solverBox && solverKey !== lastSolverRenderKey) {
      lastSolverRenderKey = solverKey;
      if (state.numbersSolution) {
        renderNumbersSolution(solverBox, state.numbersSolution, state.target);
      } else {
        solverBox.innerHTML = '<p style="color:var(--text-muted);font-size:0.875rem;">Select large tiles count (0–4) to compute the Numbers solution.</p>';
      }
    }
  } else if (state.roundType === 'C') {
    const solverKey = `C:${state.conundrumScrambled || ''}`;
    if (solverBox && solverKey !== lastSolverRenderKey) {
      lastSolverRenderKey = solverKey;
      solverBox.innerHTML = '<p style="color:var(--text-muted);font-size:0.875rem;">Conundrum Round active — monitor contestant buzzers (Q/L-Shift &amp; P/R-Shift) or use the quick answer checker above.</p>';
    }
    const ansLabel = document.getElementById('host-conundrum-secret');
    if (ansLabel) {
      const accepted = state.conundrumAnswers?.length ? state.conundrumAnswers.join(' / ') : state.conundrumAnswer;
      const sourceText = Array.isArray(state.conundrumSourceWords) && state.conundrumSourceWords.length
        ? state.conundrumSourceWords.join(' + ')
        : state.conundrumScrambled || '—';
      ansLabel.textContent = `Host Accepted Answer(s): ${accepted || '—'} (Source: ${sourceText})`;
    }
    const newConBtn = document.getElementById('host-btn-new-conundrum');
    if (newConBtn) {
      newConBtn.disabled = state.phase === PHASES.CLOCK_RUNNING || Boolean(state.conundrumRevealed);
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

  // Update Contestant Names & Live Validation Hints
  const l1 = document.getElementById('label-p1-sub');
  const l2 = document.getElementById('label-p2-sub');
  if (l1) l1.textContent = `${state.players[0].name} Declaration`;
  if (l2) l2.textContent = `${state.players[1].name} Declaration`;
  updateLiveDeclarationHints(state);

  // Live Scoreboard Summary & Round History Table (memoized)
  const sbP1Name = document.getElementById('host-sb-p1-name');
  const sbP2Name = document.getElementById('host-sb-p2-name');
  const sbP1Score = document.getElementById('host-sb-p1-score');
  const sbP2Score = document.getElementById('host-sb-p2-score');
  if (sbP1Name) sbP1Name.textContent = state.players[0].name;
  if (sbP2Name) sbP2Name.textContent = state.players[1].name;
  if (sbP1Score) sbP1Score.textContent = String(state.players[0].score);
  if (sbP2Score) sbP2Score.textContent = String(state.players[1].score);

  const historyBody = document.getElementById('host-round-history-body');
  const historyKey = JSON.stringify(state.roundHistory || []);
  if (historyBody && historyKey !== lastRoundHistoryKey) {
    lastRoundHistoryKey = historyKey;
    historyBody.replaceChildren();
    const rows = state.roundHistory || [];
    if (rows.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 4;
      td.style.color = 'var(--text-muted)';
      td.style.textAlign = 'center';
      td.textContent = 'No scored rounds yet.';
      tr.appendChild(td);
      historyBody.appendChild(tr);
    } else {
      rows.forEach((r) => {
        const tr = document.createElement('tr');
        const c1 = document.createElement('td');
        c1.textContent = `R${r.round}`;
        const c2 = document.createElement('td');
        c2.textContent = r.type;
        const c3 = document.createElement('td');
        c3.textContent = `${r.p1Sub || '—'} (+${r.p1Pts || 0})`;
        const c4 = document.createElement('td');
        c4.textContent = `${r.p2Sub || '—'} (+${r.p2Pts || 0})`;
        tr.append(c1, c2, c3, c4);
        historyBody.appendChild(tr);
      });
    }
  }

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

  // Render Operator Action Log (memoized)
  const logEl = document.getElementById('host-action-log');
  const recentLogs = (state.actionLog || []).slice(0, 30);
  const logKey = JSON.stringify(recentLogs);
  if (logEl && logKey !== lastActionLogRenderKey) {
    lastActionLogRenderKey = logKey;
    logEl.replaceChildren();
    recentLogs.forEach((entry) => {
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
      broadcastState(store.getState(), { force: true });
    } else if (msg.type === 'CLEAR_PANIC') {
      store.update(
        { panicBlank: false },
        { logMessage: 'Panic blank screen CLEARED from Stage Display.' }
      );
      // The Host owns the authoritative state: rebroadcast immediately so a
      // display that re-requested state will not render the blank overlay.
      broadcastState(store.getState(), { force: true });
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
  document.querySelectorAll('[data-modal-open="modal-prematch-setup"]').forEach((trigger) => {
    trigger.addEventListener('click', populatePreMatchSetupModal);
  });
  document.getElementById('btn-update-match-meta')?.addEventListener('click', updateActiveMatchMeta);
  document.getElementById('btn-start-match')?.addEventListener('click', startNewMatchFromSetup);

  const hostBgInput = document.getElementById('host-bg-file-input');
  document.getElementById('host-btn-upload-bg')?.addEventListener('click', () => {
    hostBgInput?.click();
  });
  hostBgInput?.addEventListener('change', async () => {
    const file = hostBgInput.files?.[0];
    hostBgInput.value = '';
    if (!file || !file.type.startsWith('image/')) return;
    try {
      const { dataUrl } = await compressStageBackgroundFile(file);
      saveCustomStageBackground(dataUrl);
      syncChannel?.send('STAGE_BG_SYNC', { bg: dataUrl });
      renderHostConsole(store.getState());
      showToast('Stage background image updated and broadcast to 16:9 Display!', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to process background image.', 'error');
    }
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
      if (!hostStageIframe.getAttribute('src') && hostStageIframe.dataset.src) {
        hostStageIframe.src = hostStageIframe.dataset.src;
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
    broadcastState(currentState, { force: true });
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
  // Never persist the plaintext PIN. A PIN is mandatory: a room cannot be
  // opened without one, so there is no default fallback PIN value.
  let currentPin = '';

  if (inputRoomCode) inputRoomCode.value = currentRoomId;
  if (inputPin) inputPin.value = '';

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
  let wasBroadcastOnline = false;
  syncChannel?.onStatusChange((status) => {
    const isOnline = Boolean(status.connected);
    const count = status.displayCount || 0;

    // Celebrate only after the server has actually accepted the Host
    // session (host:auth_success), not when the connect attempt starts.
    if (isOnline && !wasBroadcastOnline) {
      showToast(`Broadcast live for room ${status.roomId}! Connected displays: ${count}.`, 'success');
    }
    wasBroadcastOnline = isOnline;

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

    // A newly connected Display receives the authoritative stage setup from
    // the Host, including settings that were saved before the room opened.
    if (isOnline) {
      syncChannel.send('STAGE_LAYOUT_SYNC', loadStageLayout());
      syncChannel.send('STAGE_BG_SYNC', { bg: loadCustomStageBackground() });
      syncChannel.send('STAGE_CONTROLS_SYNC', { hidden: loadStageControlsHidden() });
      broadcastState(store.getState(), { force: true });
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

  document.getElementById('host-btn-open-remote-display')?.addEventListener('click', () => {
    const url = renderRemoteQR(inputRoomCode?.value || currentRoomId);
    window.open(url, '_blank', 'noopener');
  });

  const submitBroadcastOnEnter = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      btnStartBroadcast?.click();
    }
  };
  inputRoomCode?.addEventListener('keydown', submitBroadcastOnEnter);
  inputPin?.addEventListener('keydown', submitBroadcastOnEnter);

  btnStartBroadcast?.addEventListener('click', () => {
    const room = (inputRoomCode?.value || '').toUpperCase().trim();
    const pin = (inputPin?.value || '').trim();
    if (!room) {
      showToast('Please enter a Room Code.', 'error');
      return;
    }
    if (!pin) {
      showToast('Host PIN is required (4 to 8 digits).', 'error');
      inputPin?.focus();
      return;
    }
    if (!/^\d{4,8}$/.test(pin)) {
      showToast('Host PIN must contain 4 to 8 digits.', 'error');
      inputPin?.focus();
      return;
    }
    currentRoomId = room;
    currentPin = pin;
    localStorage.setItem('countdown_studio_host_room_v1', room);

    syncChannel.connectRemote(room, 'host', pin);
    broadcastState(store.getState(), { force: true });
    showToast(`Opening broadcast room ${room}...`, 'info');
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
  document.getElementById('host-btn-new-conundrum')?.addEventListener('click', () => {
    const st = store.getState();
    if (st.roundType !== 'C' || st.phase === PHASES.CLOCK_RUNNING || st.conundrumRevealed) return;
    const con = pickConundrum(dictData ? dictData.conundrums : [], rng, dictData?.wordSet, usedConundrumAnswers);
    store.update(
      {
        conundrumAnswer: con.answer,
        conundrumAnswers: con.answers,
        conundrumScrambled: con.scrambled,
        conundrumSourceWords: con.sourceWords,
        conundrumRevealed: false,
        activeBuzzerPlayer: null
      },
      { recordUndo: true, logMessage: 'Drew a fresh Conundrum puzzle.' }
    );
    const conCheckIn = document.getElementById('host-conundrum-check-input');
    const conCheckStatus = document.getElementById('host-conundrum-check-status');
    if (conCheckIn) conCheckIn.value = '';
    if (conCheckStatus) {
      conCheckStatus.textContent = 'Type spoken answer to verify';
      conCheckStatus.style.color = 'var(--text-muted)';
    }
    showToast('Drew a fresh Conundrum puzzle!', 'info');
  });

  document.getElementById('host-conundrum-check-input')?.addEventListener('input', (e) => {
    const st = store.getState();
    const statusEl = document.getElementById('host-conundrum-check-status');
    if (!statusEl) return;
    const val = (e.target?.value || '').trim();
    if (!val) {
      statusEl.textContent = 'Type spoken answer to verify';
      statusEl.style.color = 'var(--text-muted)';
      return;
    }
    const accepted = st.conundrumAnswers?.length ? st.conundrumAnswers : st.conundrumAnswer;
    const ok = checkConundrumGuess(val, accepted);
    statusEl.textContent = ok ? '✓ CORRECT MATCH' : '✗ Not accepted';
    statusEl.style.color = ok ? 'var(--status-valid)' : 'var(--status-invalid)';
  });

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
    if (clock && clock.running) clock.pause();
    audio.stopClockMusic();
    clearBuzzerTimer();
    store.transition(
      PHASES.SCORING,
      { conundrumRevealed: true, clockRunning: false, clockStartedAtEpoch: null, activeBuzzerPlayer: null },
      `Revealed Conundrum answer on Stage Display: ${st.conundrumAnswer}`
    );
    broadcastState(store.getState(), { force: true });
  });

  // Clock Controls
  document.getElementById('host-btn-clock-toggle')?.addEventListener('click', toggleClockRunPause);
  document.getElementById('host-btn-clock-reset')?.addEventListener('click', () => {
    if (clock) clock.reset();
    audio.resetClockTracker();
    const st = store.getState();
    const fullMs = st.clockDuration * 1000;
    store.update(
      {
        clockRemainingMs: fullMs,
        clockBaseRemainingMs: fullMs,
        clockRunning: false,
        clockStartedAtEpoch: null
      },
      { logMessage: 'Reset clock to full duration.' }
    );
    broadcastState(store.getState(), { force: true });
  });

  // Adjudication & Round Progression
  document.getElementById('host-p1-submission')?.addEventListener('input', () => updateLiveDeclarationHints());
  document.getElementById('host-p2-submission')?.addEventListener('input', () => updateLiveDeclarationHints());
  document.getElementById('host-p1-valid-toggle')?.addEventListener('change', () => updateLiveDeclarationHints());
  document.getElementById('host-p2-valid-toggle')?.addEventListener('change', () => updateLiveDeclarationHints());
  document.getElementById('host-btn-preview-declarations')?.addEventListener('click', previewDeclarationsOnStage);
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
  document.getElementById('host-challenge-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('host-btn-challenge-word')?.click();
    }
  });
  document.getElementById('host-btn-challenge-word')?.addEventListener('click', async () => {
    const input = document.getElementById('host-challenge-input');
    const resultEl = document.getElementById('host-challenge-result');
    const raw = input ? input.value.trim().toUpperCase() : '';
    if (!raw) return;

    const inDict = dictData ? isDictionaryWordOrInflection(raw.toLowerCase(), dictData.wordSet) : false;
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

  document.getElementById('host-btn-refresh-history')?.addEventListener('click', () => loadMatchHistory());
  document.getElementById('host-btn-more-history')?.addEventListener('click', () => loadMatchHistory({ append: true }));
  document.getElementById('host-btn-apply-history-filters')?.addEventListener('click', () => loadMatchHistory());
  document.getElementById('host-btn-clear-history-filters')?.addEventListener('click', () => {
    const roomInput = document.getElementById('host-history-filter-room');
    const fromInput = document.getElementById('host-history-filter-from');
    const toInput = document.getElementById('host-history-filter-to');
    if (roomInput) roomInput.value = '';
    if (fromInput) fromInput.value = '';
    if (toInput) toInput.value = '';
    loadMatchHistory();
  });
  document.getElementById('host-btn-download-history')?.addEventListener('click', () => {
    if (!selectedArchiveSnapshot) return;
    const blob = new Blob([JSON.stringify(selectedArchiveSnapshot, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `countdown-match-${selectedArchiveSnapshot.room_code || 'archive'}-${selectedArchiveSnapshot.id}.json`;
    link.click();
    URL.revokeObjectURL(url);
  });
  loadMatchHistory();

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

    if (key === 'c' && st.roundType === 'L' && (st.phase === PHASES.PICKING || st.phase === PHASES.IDLE)) {
      e.preventDefault();
      hostPickLetter('C');
    } else if (key === 'v' && st.roundType === 'L' && (st.phase === PHASES.PICKING || st.phase === PHASES.IDLE)) {
      e.preventDefault();
      hostPickLetter('V');
    } else if (key === 'r' && st.roundType === 'L' && (st.phase === PHASES.PICKING || st.phase === PHASES.IDLE)) {
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
    } else if (key === 'h') {
      e.preventDefault();
      if (stageModal && !stageModal.hidden) {
        closeStageModal();
      } else {
        openStageModal();
      }
    }
  });
});
