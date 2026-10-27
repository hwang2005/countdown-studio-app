/**
 * @file js/app-display.js
 * Controller for /versus-display.html (16:9 Projected Stage Screen).
 *
 * Pure renderer of the shared Versus state received via BroadcastChannel / localStorage.
 * Features:
 * - Authentic 16:9 Countdown TV Studio Set background (/assets/stage-bg.svg) or custom uploaded background
 * - 60fps studio clock running directly inside the background clock dial
 * - Contestant 1 & Contestant 2 names and scores positioned in the left & right studio podium slots
 * - Drag-and-drop custom background image & interactive drag/resize layout calibration (Hotkey 'B')
 * - Single-window quick host overlay toggle via hotkey 'H' & Fullscreen via hotkey 'F'
 * - Contestant buzzer hotkeys (Left Shift / Q for Player 1, Right Shift / P for Player 2)
 * - Two-machine operation support: technician sync HUD with RTT & broadcast age (Hotkey 'D'),
 *   STANDBY screen until the first host broadcast, auto-rejoin remembered room, and a
 *   copyable ?room= bookmark link for the projection machine.
 */

import {
  applySettingsToDOM,
  loadSettings,
  loadStageLayout,
  saveStageLayout,
  resetStageLayout,
  loadCustomStageBackground,
  saveCustomStageBackground,
  loadStageControlsHidden,
  saveStageControlsHidden
} from './core/storage.js';
import { createInitialMatchState } from './core/state.js';
import { renderClockWidget } from './core/clock.js';
import { getRoundTypeName } from './game/schedule.js';
import { StageSyncChannel } from './net/sync.js';
import { renderLetterTiles, renderNumberTiles } from './ui/tiles.js';
import { renderNumbersSolution } from './ui/board.js';
import { animateScoreTo, launchConfetti } from './ui/scoreboard.js';
import { audio } from './core/audio.js';
import { requestWakeLock } from './ui/a11y.js';
import { showToast } from './ui/toast.js';

let currentState = createInitialMatchState();
let stageLayout = loadStageLayout();
let syncChannel = null;
let rafId = null;
let lastCelebratedMatchId = null;
let stageControlsHidden = loadStageControlsHidden();
let stageAudioWasRunning = false;
let stageQuestionSnapshot = null;
let lastStageBuzzerPlayer = null;
let lastRenderedBoardKey = null;
// Two-machine operation telemetry (projection screen + operator console)
let hudPingMs = null;
let lastRemoteStateAt = Date.now();
let remoteFirstStateReceived = false;
let hudVisible = localStorage.getItem('countdown_studio_stage_hud_v1') !== 'hidden';

const DISPLAY_AUTOJOIN_KEY = 'countdown_studio_stage_autojoin_v1';

/**
 * Builds the direct link to this Stage Display for a room. Projection
 * machines can keep the returned URL as a bookmark so the next show starts
 * without retyping a room code.
 * @param {string} roomId
 * @returns {string}
 */
function buildDisplayRoomLink(roomId) {
  const url = new URL('./versus-display.html', window.location.href);
  if (roomId) url.searchParams.set('room', String(roomId).toUpperCase().trim());
  return url.toString();
}

/**
 * Shows or hides the STANDBY screen used between an authenticated
 * display:join and the Host's first stage broadcast.
 * @param {boolean} visible
 */
function setStandbyVisible(visible) {
  const standby = document.getElementById('stage-standby');
  if (!standby) return;
  standby.hidden = !visible;
  standby.style.display = visible ? 'flex' : 'none';
}

/**
 * Updates the technician sync telemetry HUD: room, measured server round
 * trip time (RTT heartbeat), and how stale the latest broadcast is.
 */
function refreshSyncHud() {
  const hud = document.getElementById('stage-sync-hud');
  const detail = document.getElementById('stage-sync-hud-detail');
  if (!hud || !detail) return;
  hud.style.display = hudVisible ? '' : 'none';
  const roomId = syncChannel?.roomId || '';
  if (!roomId) {
    // Local BroadcastChannel/localStorage mode (same-machine fallback).
    detail.textContent = 'Local Sync · same-machine transport';
  } else if (syncChannel.isRemoteConnected) {
    const ageSeconds = Math.max(0, Math.round((Date.now() - lastRemoteStateAt) / 1000));
    const rttLabel = hudPingMs !== null ? `${hudPingMs}ms` : 'measuring…';
    const stateLabel = remoteFirstStateReceived ? `last broadcast ${ageSeconds}s ago` : 'awaiting first broadcast';
    detail.textContent = `Room ${roomId} · ${rttLabel} · ${stateLabel}`;
  } else if (syncChannel.roomClosed) {
    detail.textContent = `Room ${roomId} · closed`;
  } else {
    detail.textContent = `Connecting: ${roomId}…`;
  }
}

function setRemoteDisplayGate(blocked, message = 'Authenticating display room...') {
  const canvas = document.getElementById('stage-canvas');
  if (!canvas) return;

  let gate = document.getElementById('stage-remote-gate');
  if (!gate) {
    gate = document.createElement('div');
    gate.id = 'stage-remote-gate';
    gate.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:9999', 'display:flex',
      'align-items:center', 'justify-content:center', 'padding:2rem',
      'background:#081229', 'color:#F8FAFC', 'text-align:center',
      'font-family:var(--font-body, sans-serif)'
    ].join(';');
    gate.innerHTML = `
      <div style="max-width:34rem;display:grid;gap:0.85rem;justify-items:center">
        <strong id="stage-remote-gate-title" style="font-size:clamp(1.3rem,3vw,2rem)"></strong>
        <span id="stage-remote-gate-message" style="color:#CBD5E1"></span>
        <button type="button" id="stage-remote-gate-join" class="btn btn--primary btn--sm">Enter another room code</button>
      </div>`;
    document.body.appendChild(gate);
    gate.querySelector('#stage-remote-gate-join')?.addEventListener('click', () => {
      document.getElementById('btn-join-remote-stage')?.click();
    });
  }

  const title = gate.querySelector('#stage-remote-gate-title');
  const detail = gate.querySelector('#stage-remote-gate-message');
  if (title) title.textContent = blocked ? 'Stage Display Not Connected' : '';
  if (detail) detail.textContent = message;
  gate.hidden = !blocked;
  gate.style.display = blocked ? 'flex' : 'none';
  canvas.style.visibility = blocked ? 'hidden' : '';
}

/**
 * Keep the Stage Display's audio limited to the clock soundtrack.  The Host
 * remains the source for tile, buzzer, answer and celebration sounds.
 * @param {object} state
 */
function syncStageClockAudio(state) {
  const duration = Number(state.clockDuration || 30);
  const remaining = Math.max(0, Number(state.clockRemainingMs || 0));

  if (state.clockRunning) {
    const elapsed = Math.min(duration, Math.floor((duration * 1000 - remaining) / 1000));
    audio.playClockSecond(elapsed, duration);
    stageAudioWasRunning = true;
    return;
  }

  // The final host tick can arrive together with clockRunning=false.  Give
  // the Stage Display the same final buzzer as the Host in that case.
  if (stageAudioWasRunning) {
    if (remaining <= 0) {
      audio.playClockSecond(duration, duration);
      stageAudioWasRunning = false;
    } else if (state.phase === 'CLOCK_RUNNING') {
      // A paused clock keeps the soundtrack position for resume.
      audio.pauseClockMusic();
    } else {
      // Scoring/reveal/reset ends the round, so the next round starts fresh.
      audio.stopClockMusic();
      audio.resetClockTracker();
      stageAudioWasRunning = false;
    }
  }
}

/**
 * Preserve the active round's question/tiles for the complete 30-second
 * thinking period, even if a sync update briefly contains an intermediate
 * state while the Host starts the clock.
 * @param {object} state
 * @returns {object}
 */
function getStageQuestionState(state) {
  const roundKey = `${state.matchId}:${state.roundIndex}:${state.roundType}`;
  const hasQuestion = state.roundType === 'L'
    ? Array.isArray(state.letters) && state.letters.some(Boolean)
    : state.roundType === 'N'
      ? (Array.isArray(state.numbers) && state.numbers.some((value) => value !== null && value !== undefined)) || Boolean(state.target)
      : Boolean(state.conundrumScrambled || state.conundrumAnswer);
  const snapshotIsCurrentRound = stageQuestionSnapshot?.key === roundKey;
  const snapshotHasQuestion = snapshotIsCurrentRound && (
    stageQuestionSnapshot.letters?.some(Boolean) ||
    stageQuestionSnapshot.numbers?.some((value) => value !== null && value !== undefined) ||
    stageQuestionSnapshot.target ||
    stageQuestionSnapshot.conundrumScrambled ||
    stageQuestionSnapshot.conundrumAnswer
  );

  // While the 30-second clock is running we MUST keep the question visible.
  // Rules:
  //  1. If clock is not running → always refresh snapshot from state (normal flow).
  //  2. If clock IS running:
  //     a. No snapshot yet, or snapshot is for a different round, and state has
  //        a question → capture this state as the new snapshot.
  //     b. Snapshot already has a question for this round → never overwrite it
  //        (protects against empty intermediate sync packets from the Host).
  //     c. Neither snapshot nor state has a question yet → wait; do not erase.
  if (!state.clockRunning) {
    // Clock is stopped: always update snapshot from current state
    stageQuestionSnapshot = {
      key: roundKey,
      letters: Array.isArray(state.letters) ? [...state.letters] : [],
      numbers: Array.isArray(state.numbers) ? [...state.numbers] : [],
      target: state.target,
      conundrumScrambled: state.conundrumScrambled,
      conundrumAnswer: state.conundrumAnswer,
      conundrumSourceWords: state.conundrumSourceWords,
      conundrumRevealed: state.conundrumRevealed
    };
    return state;
  }

  // Clock IS running from here on.
  // If the snapshot belongs to a different round and the incoming state has
  // a question, or we have no snapshot at all, capture the incoming state.
  if (!snapshotHasQuestion && hasQuestion) {
    stageQuestionSnapshot = {
      key: roundKey,
      letters: Array.isArray(state.letters) ? [...state.letters] : [],
      numbers: Array.isArray(state.numbers) ? [...state.numbers] : [],
      target: state.target,
      conundrumScrambled: state.conundrumScrambled,
      conundrumAnswer: state.conundrumAnswer,
      conundrumSourceWords: state.conundrumSourceWords,
      conundrumRevealed: state.conundrumRevealed
    };
    return state;
  }

  // If a valid snapshot exists, always serve it during the countdown,
  // ignoring any empty/partial packets the Host may send.
  if (snapshotHasQuestion) {
    if (state.conundrumRevealed) {
      stageQuestionSnapshot.conundrumRevealed = true;
    }
    if (state.conundrumAnswer) {
      stageQuestionSnapshot.conundrumAnswer = state.conundrumAnswer;
    }
    return {
      ...state,
      letters: stageQuestionSnapshot.letters,
      numbers: stageQuestionSnapshot.numbers,
      target: stageQuestionSnapshot.target,
      conundrumScrambled: stageQuestionSnapshot.conundrumScrambled,
      conundrumAnswer: stageQuestionSnapshot.conundrumAnswer,
      conundrumSourceWords: stageQuestionSnapshot.conundrumSourceWords,
      conundrumRevealed: stageQuestionSnapshot.conundrumRevealed
    };
  }

  // No snapshot and no question in current state — return raw state as fallback.
  return state;
}

/**
 * Toggles or sets visibility of stage control buttons on the 16:9 stage display.
 * @param {boolean} hidden
 * @param {boolean} [notify]
 */
function setStageControlsHidden(hidden, notify = true) {
  stageControlsHidden = Boolean(hidden);
  saveStageControlsHidden(stageControlsHidden);

  const canvas = document.getElementById('stage-canvas');
  if (canvas) {
    canvas.classList.toggle('is-controls-hidden', stageControlsHidden);
  }
  const showBtn = document.getElementById('btn-show-stage-controls');
  if (showBtn) {
    showBtn.hidden = !stageControlsHidden;
  }
  const hideBtn = document.getElementById('btn-hide-stage-controls');
  if (hideBtn) {
    hideBtn.textContent = stageControlsHidden ? '👁 Show Controls (C)' : '👁 Hide Controls (C)';
  }
  const calibHideBtn = document.getElementById('btn-calib-hide-controls');
  if (calibHideBtn) {
    calibHideBtn.textContent = stageControlsHidden ? '👁 Show Controls (C)' : '👁 Hide Controls (C)';
  }

  if (notify) {
    if (stageControlsHidden) {
      showToast('Controls hidden. Press "C" or hover near bottom of screen to restore.', 'info');
    } else {
      showToast('Controls restored on screen.', 'info');
    }
  }
}

/**
 * Applies the stage layout coordinates & custom background image to the 16:9 stage canvas.
 * @param {typeof stageLayout} layout
 * @param {string|null} [customBg]
 */
function applyStageLayoutToDOM(layout = stageLayout, customBg = loadCustomStageBackground()) {
  stageLayout = layout;
  const canvas = document.getElementById('stage-canvas');
  if (!canvas) return;

  canvas.style.setProperty('--clock-x', `${layout.clockX}%`);
  canvas.style.setProperty('--clock-y', `${layout.clockY}%`);
  canvas.style.setProperty('--clock-size', `${layout.clockSize}%`);

  canvas.style.setProperty('--p1-name-x', `${layout.p1NameX}%`);
  canvas.style.setProperty('--p1-name-y', `${layout.p1NameY}%`);
  canvas.style.setProperty('--p1-name-w', `${layout.p1NameW}%`);
  canvas.style.setProperty('--p1-score-x', `${layout.p1ScoreX}%`);
  canvas.style.setProperty('--p1-score-y', `${layout.p1ScoreY}%`);
  canvas.style.setProperty('--p1-score-w', `${layout.p1ScoreW}%`);

  canvas.style.setProperty('--p2-name-x', `${layout.p2NameX}%`);
  canvas.style.setProperty('--p2-name-y', `${layout.p2NameY}%`);
  canvas.style.setProperty('--p2-name-w', `${layout.p2NameW}%`);
  canvas.style.setProperty('--p2-score-x', `${layout.p2ScoreX}%`);
  canvas.style.setProperty('--p2-score-y', `${layout.p2ScoreY}%`);
  canvas.style.setProperty('--p2-score-w', `${layout.p2ScoreW}%`);

  canvas.style.setProperty('--board-x', `${layout.boardX}%`);
  canvas.style.setProperty('--board-y', `${layout.boardY}%`);
  canvas.style.setProperty('--board-w', `${layout.boardW}%`);

  if (customBg) {
    canvas.style.setProperty('--stage-bg-image', `url("${customBg}")`);
  } else {
    canvas.style.removeProperty('--stage-bg-image');
    const probe = new Image();
    probe.onload = () => {
      if (!loadCustomStageBackground()) {
        canvas.style.setProperty('--stage-bg-image', `url("${probe.src}")`);
      }
    };
    probe.src = './assets/stage-bg.svg';
  }

  const handsCheckbox = document.getElementById('calib-hands-only-toggle');
  if (handsCheckbox) handsCheckbox.checked = Boolean(layout.clockHandsOnly);
  const digCheckbox = document.getElementById('calib-digital-toggle');
  if (digCheckbox) digCheckbox.checked = Boolean(layout.showDigitalTimer);

  const clockEl = document.getElementById('stage-clock-container');
  if (clockEl && currentState) {
    renderClockWidget(
      clockEl,
      currentState.clockRemainingMs,
      (currentState.clockDuration || 30) * 1000,
      {
        handsOnly: Boolean(layout.clockHandsOnly),
        showDigital: Boolean(layout.showDigitalTimer)
      }
    );
  }
}

function renderStage(state) {
  currentState = state;
  syncStageClockAudio(state);
  const questionState = getStageQuestionState(state);

  // Mirror the Host's Conundrum buzzer sound on the Stage Display once per
  // buzzer event. Other Host-only sounds remain local to the Host console.
  const buzzerPlayer = state.roundType === 'C' ? state.activeBuzzerPlayer : null;
  if (buzzerPlayer && buzzerPlayer !== lastStageBuzzerPlayer) {
    audio.playContestantBuzz(buzzerPlayer);
  }
  lastStageBuzzerPlayer = buzzerPlayer || null;

  document.documentElement.setAttribute('data-theme', state.theme || 'classic-blue');

  // Panic blank screen check
  const panicEl = document.getElementById('stage-panic-screen');
  if (panicEl) {
    const isBlank = Boolean(state.panicBlank);
    panicEl.hidden = !isBlank;
    panicEl.classList.toggle('is-hidden', !isBlank);
    panicEl.classList.toggle('is-active', isBlank);
    panicEl.setAttribute('data-active', String(isBlank));
    panicEl.style.display = isBlank ? 'flex' : 'none';
  }

  // Test pattern overlay check
  const testEl = document.getElementById('stage-test-pattern');
  if (testEl) {
    const isTest = Boolean(state.testPattern);
    testEl.hidden = !isTest;
    testEl.classList.toggle('is-hidden', !isTest);
    testEl.classList.toggle('is-active', isTest);
    testEl.setAttribute('data-active', String(isTest));
    testEl.style.display = isTest ? 'flex' : 'none';
  }

  // Round & Picker Header
  const roundEl = document.getElementById('stage-round-indicator');
  if (roundEl) {
    if (state.phase === 'MATCH_END') {
      roundEl.textContent = 'Final Scoreboard · Match Complete';
    } else {
      roundEl.textContent = `Round ${state.roundIndex + 1} of ${
        state.schedule.length
      } · ${getRoundTypeName(state.roundType)}`;
    }
  }

  const pickerEl = document.getElementById('stage-picker-indicator');
  if (pickerEl) {
    const picker = state.players[state.pickerPlayer - 1];
    pickerEl.textContent =
      state.roundType === 'C'
        ? 'Countdown Conundrum · Buzzer Active'
        : `Selection: ${picker ? picker.name : 'Contestant'}`;
  }

  // Central Board Zone
  const lettersBoard = document.getElementById('stage-letters-board');
  const numbersZone = document.getElementById('stage-numbers-zone');
  const numbersBoard = document.getElementById('stage-numbers-board');
  const targetVal = document.getElementById('stage-target-value');
  const numSolBox = document.getElementById('stage-numbers-solution');
  const endPodium = document.getElementById('stage-match-end-podium');
  const boardZone = document.getElementById('stage-board-zone');
  const conundrumPrompt = document.getElementById('stage-conundrum-prompt');

  if (state.phase === 'MATCH_END') {
    lastRenderedBoardKey = null;
    if (boardZone) boardZone.style.display = 'none';
    if (lettersBoard) lettersBoard.hidden = true;
    if (numbersZone) numbersZone.hidden = true;
    if (conundrumPrompt) conundrumPrompt.hidden = true;
    if (endPodium) {
      endPodium.hidden = false;
      const p1 = state.players[0];
      const p2 = state.players[1];
      const winnerTitle = document.getElementById('stage-winner-title');
      if (winnerTitle) {
        if (p1.score > p2.score) {
          winnerTitle.textContent = `Winner: ${p1.name} (${p1.score} – ${p2.score})`;
        } else if (p2.score > p1.score) {
          winnerTitle.textContent = `Winner: ${p2.name} (${p2.score} – ${p1.score})`;
        } else {
          winnerTitle.textContent = `Tied Match (${p1.score} – ${p2.score}) · Sudden Death!`;
        }
      }
      if (lastCelebratedMatchId !== state.matchId) {
        lastCelebratedMatchId = state.matchId;
        launchConfetti(4000);
      }
    }
  } else {
    if (boardZone) {
      boardZone.hidden = false;
      // Always keep board visible while the clock is running so the
      // question is never hidden from the Stage Display during countdown.
      boardZone.style.display = 'flex';
    }
    if (endPodium) endPodium.hidden = true;
    if (questionState.roundType === 'L') {
      if (conundrumPrompt) conundrumPrompt.hidden = true;
      if (numbersZone) numbersZone.hidden = true;
      if (lettersBoard) {
        lettersBoard.hidden = false;
        const boardKey = `L:${(questionState.letters || []).join('')}`;
        if (boardKey !== lastRenderedBoardKey) {
          renderLetterTiles(lettersBoard, questionState.letters, { noAnim: Boolean(state.clockRunning) });
          lastRenderedBoardKey = boardKey;
        }
      }
    } else if (questionState.roundType === 'N') {
      if (conundrumPrompt) conundrumPrompt.hidden = true;
      if (lettersBoard) lettersBoard.hidden = true;
      if (numbersZone) {
        numbersZone.hidden = false;
        const boardKey = `N:${(questionState.numbers || []).join(',')}:${questionState.target || ''}:${Boolean(state.showNumbersSolutionOnDisplay)}:${state.numbersSolution || ''}`;
        if (boardKey !== lastRenderedBoardKey) {
          renderNumberTiles(numbersBoard, questionState.numbers, { noAnim: Boolean(state.clockRunning) });
          if (targetVal) targetVal.textContent = questionState.target ? String(questionState.target) : '000';
          if (numSolBox) {
            numSolBox.hidden = !state.showNumbersSolutionOnDisplay || !state.numbersSolution;
            if (state.showNumbersSolutionOnDisplay && state.numbersSolution) {
              renderNumbersSolution(numSolBox, state.numbersSolution, state.target);
            }
          }
          lastRenderedBoardKey = boardKey;
        }
      }
    } else {
      // Conundrum
      if (numbersZone) numbersZone.hidden = true;
      if (lettersBoard) {
        lettersBoard.hidden = false;
        const word = questionState.conundrumRevealed ? questionState.conundrumAnswer : questionState.conundrumScrambled;
        const prompt = document.getElementById('stage-conundrum-prompt');
        if (prompt) prompt.hidden = true;
        const boardKey = `C:${word || ''}:${Boolean(questionState.conundrumRevealed)}`;
        if (boardKey !== lastRenderedBoardKey) {
          renderLetterTiles(lettersBoard, word ? word.split('') : [], { isConundrum: true, noAnim: Boolean(state.clockRunning) });
          lastRenderedBoardKey = boardKey;
        }
      }
    }
  }

  // Conundrum Buzzer Banner
  const buzzBanner = document.getElementById('stage-buzz-banner');
  if (buzzBanner) {
    if (state.activeBuzzerPlayer) {
      const p = state.players[state.activeBuzzerPlayer - 1];
      buzzBanner.hidden = false;
      buzzBanner.textContent = `🔔 ${p.name} BUZZED IN! (${(
        (state.buzzerRemainingMs || 5000) / 1000
      ).toFixed(1)}s)`;
    } else {
      buzzBanner.hidden = true;
    }
  }

  // Dictionary Corner is permanently hidden from Stage Display per user requirement
  const chalBanner = document.getElementById('stage-challenge-banner');
  if (chalBanner) {
    chalBanner.hidden = true;
    chalBanner.style.display = 'none';
  }

  // Contestant Name & Score Slots in the Left & Right Background Podiums
  const plate1 = document.getElementById('stage-plate-p1');
  const plate2 = document.getElementById('stage-plate-p2');
  const p1 = state.players[0];
  const p2 = state.players[1];

  if (plate1 && p1) {
    plate1.classList.toggle('is-active-picker', state.pickerPlayer === 1 && state.roundType !== 'C');
    plate1.classList.toggle('is-buzzed', state.activeBuzzerPlayer === 1);
    document.getElementById('stage-p1-name').textContent = p1.name;
    const decl1 = document.getElementById('stage-p1-decl');
    if (decl1) {
      const badge = p1.valid === true ? '✓ ' : p1.valid === false ? '✗ ' : '';
      const pts = p1.roundPoints > 0 ? ` (+${p1.roundPoints})` : '';
      decl1.textContent = p1.submission && p1.submission !== '—' ? `${badge}${p1.submission}${pts}` : '';
      decl1.style.color =
        p1.valid === true
          ? 'var(--status-valid)'
          : p1.valid === false
            ? 'var(--status-invalid)'
            : 'var(--accent-secondary)';
    }
    animateScoreTo(document.getElementById('stage-p1-score'), p1.score);
  }

  if (plate2 && p2) {
    plate2.classList.toggle('is-active-picker', state.pickerPlayer === 2 && state.roundType !== 'C');
    plate2.classList.toggle('is-buzzed', state.activeBuzzerPlayer === 2);
    document.getElementById('stage-p2-name').textContent = p2.name;
    const decl2 = document.getElementById('stage-p2-decl');
    if (decl2) {
      const badge = p2.valid === true ? '✓ ' : p2.valid === false ? '✗ ' : '';
      const pts = p2.roundPoints > 0 ? ` (+${p2.roundPoints})` : '';
      decl2.textContent = p2.submission && p2.submission !== '—' ? `${badge}${p2.submission}${pts}` : '';
      decl2.style.color =
        p2.valid === true
          ? 'var(--status-valid)'
          : p2.valid === false
            ? 'var(--status-invalid)'
            : 'var(--accent-secondary)';
    }
    animateScoreTo(document.getElementById('stage-p2-score'), p2.score);
  }

  // Update Clock Display running directly inside the background clock dial
  const clockEl = document.getElementById('stage-clock-container');
  if (clockEl) {
    renderClockWidget(
      clockEl,
      state.clockRemainingMs,
      (state.clockDuration || 30) * 1000,
      {
        handsOnly: Boolean(stageLayout.clockHandsOnly),
        showDigital: Boolean(stageLayout.showDigitalTimer)
      }
    );
  }
}

/**
 * Smooth 60fps local interpolation loop on the Display window when `clockRunning` is true,
 * anchored to `clockRemainingMs` so even if BroadcastChannel messages arrive at 15–30Hz
 * or the page refreshes, the sweeping hand renders at buttery 60fps inside the background clock.
 */
function startDisplayClockLoop() {
  let lastFrameTime = performance.now();
  const loop = (now) => {
    const dt = now - lastFrameTime;
    lastFrameTime = now;
    if (currentState && currentState.clockRunning && currentState.clockRemainingMs > 0) {
      currentState.clockRemainingMs = Math.max(0, currentState.clockRemainingMs - dt);
      const clockEl = document.getElementById('stage-clock-container');
      if (clockEl) {
        renderClockWidget(
          clockEl,
          currentState.clockRemainingMs,
          (currentState.clockDuration || 30) * 1000,
          {
            handsOnly: Boolean(stageLayout.clockHandsOnly),
            showDigital: Boolean(stageLayout.showDigitalTimer)
          }
        );
      }
    }
    rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);
}

/**
 * Handles custom background image file selection or drag-and-drop.
 * @param {File} file
 */
function handleBackgroundFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = String(reader.result || '');
    saveCustomStageBackground(dataUrl);
    applyStageLayoutToDOM(stageLayout, dataUrl);
    if (syncChannel) {
      syncChannel.send('STAGE_BG_SYNC', { bg: dataUrl });
    }
    showToast('Stage background updated! Press B to fine-tune clock, name & score positions.', 'success');
  };
  reader.readAsDataURL(file);
}

/**
 * Initialises interactive drag-to-move and wheel-to-resize calibration on the stage canvas.
 */
function initStageCalibration() {
  const canvas = document.getElementById('stage-canvas');
  const toolbar = document.getElementById('stage-calibration-toolbar');
  const btnToggle = document.getElementById('btn-toggle-calibrate');
  const btnDone = document.getElementById('btn-calib-done');
  const btnReset = document.getElementById('btn-calib-reset');
  const handsToggle = document.getElementById('calib-hands-only-toggle');
  const digToggle = document.getElementById('calib-digital-toggle');
  const fileInput = document.getElementById('stage-bg-file-input');
  const btnUpload = document.getElementById('btn-upload-stage-bg');

  if (!canvas) return;

  const setCalibrating = (active) => {
    canvas.classList.toggle('is-calibrating', active);
    if (toolbar) toolbar.hidden = !active;
  };

  btnToggle?.addEventListener('click', () => {
    setCalibrating(!canvas.classList.contains('is-calibrating'));
  });
  btnDone?.addEventListener('click', () => setCalibrating(false));

  btnReset?.addEventListener('click', () => {
    saveCustomStageBackground(null);
    const freshLayout = resetStageLayout();
    applyStageLayoutToDOM(freshLayout, null);
    if (syncChannel) {
      syncChannel.send('STAGE_BG_SYNC', { bg: null });
      syncChannel.send('STAGE_LAYOUT_SYNC', freshLayout);
    }
    showToast('Reset to default Countdown Studio background and positions.', 'info');
  });

  handsToggle?.addEventListener('change', () => {
    const next = saveStageLayout({ clockHandsOnly: handsToggle.checked });
    applyStageLayoutToDOM(next);
    syncChannel?.send('STAGE_LAYOUT_SYNC', next);
  });

  digToggle?.addEventListener('change', () => {
    const next = saveStageLayout({ showDigitalTimer: digToggle.checked });
    applyStageLayoutToDOM(next);
    syncChannel?.send('STAGE_LAYOUT_SYNC', next);
  });

  btnUpload?.addEventListener('click', () => fileInput?.click());
  document.getElementById('btn-calib-upload-bg')?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', () => {
    if (fileInput.files && fileInput.files[0]) {
      handleBackgroundFile(fileInput.files[0]);
      fileInput.value = '';
    }
  });

  // Drag & Drop image file directly onto Stage Display
  canvas.addEventListener('dragover', (e) => {
    e.preventDefault();
    canvas.classList.add('is-dragover');
  });
  canvas.addEventListener('dragleave', () => {
    canvas.classList.remove('is-dragover');
  });
  canvas.addEventListener('drop', (e) => {
    e.preventDefault();
    canvas.classList.remove('is-dragover');
    const file = e.dataTransfer?.files?.[0];
    if (file) handleBackgroundFile(file);
  });

  // Pointer drag for calibrated items when in .is-calibrating mode
  let dragTargetKey = null;
  let dragElement = null;

  canvas.querySelectorAll('[data-calib-key]').forEach((el) => {
    el.addEventListener('pointerdown', (e) => {
      if (!canvas.classList.contains('is-calibrating')) return;
      e.preventDefault();
      dragTargetKey = el.getAttribute('data-calib-key');
      dragElement = el;
      el.setPointerCapture(e.pointerId);
    });

    el.addEventListener('pointermove', (e) => {
      if (!dragTargetKey || dragElement !== el) return;
      const rect = canvas.getBoundingClientRect();
      const xPct = Number(Math.max(4, Math.min(96, ((e.clientX - rect.left) / rect.width) * 100)).toFixed(2));
      const yPct = Number(Math.max(4, Math.min(96, ((e.clientY - rect.top) / rect.height) * 100)).toFixed(2));

      const patch = {};
      if (dragTargetKey === 'clock') {
        patch.clockX = xPct;
        patch.clockY = yPct;
      } else if (dragTargetKey === 'board') {
        patch.boardX = xPct;
        patch.boardY = yPct;
      } else if (dragTargetKey === 'p1Name') {
        patch.p1NameX = xPct;
        patch.p1NameY = yPct;
      } else if (dragTargetKey === 'p1Score') {
        patch.p1ScoreX = xPct;
        patch.p1ScoreY = yPct;
      } else if (dragTargetKey === 'p2Name') {
        patch.p2NameX = xPct;
        patch.p2NameY = yPct;
      } else if (dragTargetKey === 'p2Score') {
        patch.p2ScoreX = xPct;
        patch.p2ScoreY = yPct;
      }

      const next = saveStageLayout(patch);
      applyStageLayoutToDOM(next);
      syncChannel?.send('STAGE_LAYOUT_SYNC', next);
    });

    const endDrag = () => {
      dragTargetKey = null;
      dragElement = null;
    };
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);

    // Mouse wheel resize while calibrating
    el.addEventListener(
      'wheel',
      (e) => {
        if (!canvas.classList.contains('is-calibrating')) return;
        e.preventDefault();
        const key = el.getAttribute('data-calib-key');
        const delta = e.deltaY < 0 ? 0.6 : -0.6;
        const patch = {};
        if (key === 'clock') {
          patch.clockSize = Number(Math.max(10, Math.min(48, stageLayout.clockSize + delta)).toFixed(2));
        } else if (key === 'board') {
          patch.boardW = Number(Math.max(24, Math.min(82, stageLayout.boardW + delta)).toFixed(2));
        } else if (key === 'p1Name') {
          patch.p1NameW = Number(Math.max(8, Math.min(35, stageLayout.p1NameW + delta)).toFixed(2));
        } else if (key === 'p2Name') {
          patch.p2NameW = Number(Math.max(8, Math.min(35, stageLayout.p2NameW + delta)).toFixed(2));
        }
        const next = saveStageLayout(patch);
        applyStageLayoutToDOM(next);
        syncChannel?.send('STAGE_LAYOUT_SYNC', next);
      },
      { passive: false }
    );
  });
}

document.addEventListener('DOMContentLoaded', () => {
  const settings = loadSettings();
  applySettingsToDOM(settings);
  audio.setMuted(!settings.soundEnabled);
  audio.setVolume(settings.volume);
  applyStageLayoutToDOM(loadStageLayout(), loadCustomStageBackground());
  requestWakeLock();

  // Audio unlock splash for stage display
  const splash = document.getElementById('stage-audio-splash');
  if (splash) {
    splash.addEventListener('click', async () => {
      const unlocked = await audio.unlock();
      if (!unlocked) return;
      // If the countdown started before the browser gesture, retry the first
      // clock cue after unlocking instead of losing the soundtrack entirely.
      audio.resetClockTracker();
      syncStageClockAudio(currentState);

      // The buzzer may have arrived while the browser still had audio locked.
      // Replay that active buzzer immediately after the user gesture.
      if (currentState.roundType === 'C' && currentState.activeBuzzerPlayer) {
        audio.playContestantBuzz(currentState.activeBuzzerPlayer);
        lastStageBuzzerPlayer = currentState.activeBuzzerPlayer;
      }
      splash.hidden = true;
    });
  }

  syncChannel = new StageSyncChannel('display', (msg) => {
    if (msg.type === 'STATE_SYNC' && msg.payload) {
      remoteFirstStateReceived = true;
      lastRemoteStateAt = Date.now();
      setStandbyVisible(false);
      renderStage(msg.payload);
    } else if (msg.type === 'STAGE_LAYOUT_SYNC' && msg.payload) {
      const next = saveStageLayout(msg.payload);
      applyStageLayoutToDOM(next);
    } else if (msg.type === 'STAGE_BG_SYNC' && msg.payload !== undefined) {
      saveCustomStageBackground(msg.payload.bg || null);
      applyStageLayoutToDOM(stageLayout, msg.payload.bg || null);
    } else if (msg.type === 'STAGE_CONTROLS_SYNC' && msg.payload !== undefined) {
      setStageControlsHidden(Boolean(msg.payload.hidden), false);
    } else if (msg.type === 'STAGE_CONFIG_SYNC' && msg.payload) {
      // Remote rooms may send either the initial room snapshot or a single
      // Host-authored config update. Display applies it locally but never
      // sends the change back as an authoritative command.
      const config = msg.payload;
      if (config.layout) {
        stageLayout = saveStageLayout(config.layout);
        applyStageLayoutToDOM(stageLayout);
      }
      if (Object.prototype.hasOwnProperty.call(config, 'background')) {
        saveCustomStageBackground(config.background || null);
        applyStageLayoutToDOM(stageLayout, config.background || null);
      }
      if (typeof config.controlsHidden === 'boolean') {
        setStageControlsHidden(config.controlsHidden, false);
      }
      if (config.kind === 'layout' && config.value) {
        stageLayout = saveStageLayout(config.value);
        applyStageLayoutToDOM(stageLayout);
      } else if (config.kind === 'background') {
        saveCustomStageBackground(config.value || null);
        applyStageLayoutToDOM(stageLayout, config.value || null);
      } else if (config.kind === 'controls' && config.value) {
        setStageControlsHidden(Boolean(config.value.hidden), false);
      }
    }
  });

  const urlParams = new URLSearchParams(window.location.search);
  const roomFromUrl = urlParams.get('room');
  const requestedRoom = (roomFromUrl || '').toUpperCase().trim();
  // A remote display must not reveal a locally cached match while its room is
  // being checked. This also prevents an old QR/link from showing stale data
  // when the room no longer exists.
  const autoJoinRoom = !roomFromUrl
    ? (localStorage.getItem(DISPLAY_AUTOJOIN_KEY) || '').toUpperCase().trim()
    : '';
  if (requestedRoom || autoJoinRoom) setRemoteDisplayGate(true);

  const persisted = syncChannel.recoverPersistedState();
  if (persisted && !requestedRoom) {
    renderStage(persisted);
  } else {
    renderStage(currentState);
  }

  // Ask for the latest local state. In remote mode this must not fire before
  // the WebSocket exists; the server pushes the latest room state immediately
  // after an authenticated display:join succeeds.
  if (!syncChannel.roomId) {
    syncChannel.send('REQUEST_STATE', {});
  }
  startDisplayClockLoop();
  initStageCalibration();

  // Initialize Stage Controls visibility from stored preference
  setStageControlsHidden(stageControlsHidden, false);

  // Button listeners for hiding and showing stage controls
  document.getElementById('btn-hide-stage-controls')?.addEventListener('click', () => {
    setStageControlsHidden(true, true);
  });
  document.getElementById('btn-show-stage-controls')?.addEventListener('click', () => {
    setStageControlsHidden(false, true);
  });
  document.getElementById('btn-calib-hide-controls')?.addEventListener('click', () => {
    setStageControlsHidden(!stageControlsHidden, true);
  });

  // --- REMOTE MULTI-DEVICE STAGE JOINER ---
  const roomBadge = document.getElementById('stage-room-badge');
  const roomDot = document.getElementById('stage-room-dot');
  const roomText = document.getElementById('stage-room-text');
  const joinModal = document.getElementById('modal-display-join-room');
  const inputRoomCode = document.getElementById('display-input-room-code');
  const btnJoinRemote = document.getElementById('btn-join-remote-stage');
  const btnCloseJoinModal = document.getElementById('btn-close-display-join-modal');
  const btnCancelJoin = document.getElementById('btn-cancel-display-join');
  const btnSubmitJoin = document.getElementById('btn-submit-display-join');
  const btnDisconnectRoom = document.getElementById('btn-display-disconnect-room');

  // Listen to remote connection status changes
  syncChannel.onStatusChange((status) => {
    if (typeof status.pingMs === 'number') hudPingMs = status.pingMs;
    if (status.roomClosed) {
      setRemoteDisplayGate(true, status.error || 'Room does not exist or was closed by Host.');
      localStorage.removeItem('countdown_studio_last_room');
      if (roomDot) roomDot.className = 'status-dot status-dot--offline';
      if (roomText) roomText.textContent = 'Room closed / not found';
      if (btnDisconnectRoom) btnDisconnectRoom.hidden = true;
      if (btnJoinRemote) btnJoinRemote.textContent = '🌐 Room Code (Online)';
      showToast(status.error || 'Room closed or does not exist.', 'error');
    } else if (status.roomId && status.connected) {
      setRemoteDisplayGate(false);
      if (roomDot) roomDot.className = 'status-dot status-dot--online';
      if (roomText) roomText.textContent = status.waitingEmpty
        ? `Room: ${status.roomId} (waiting for Host broadcast)`
        : `Room: ${status.roomId}`;
      if (btnDisconnectRoom) btnDisconnectRoom.hidden = false;
      if (btnJoinRemote) btnJoinRemote.textContent = `🌐 ${status.roomId}`;
    } else if (status.roomId && status.connectionFailed) {
      setRemoteDisplayGate(
        true,
        status.error || 'Unable to connect to server. Please check the server and try again.'
      );
      if (roomDot) roomDot.className = 'status-dot status-dot--offline';
      if (roomText) roomText.textContent = `Not connected: ${status.roomId}`;
      if (btnDisconnectRoom) btnDisconnectRoom.hidden = false;
      if (btnJoinRemote) btnJoinRemote.textContent = '🌐 Retry Connection';
    } else if (status.roomId && !status.connected) {
      setRemoteDisplayGate(true, status.error || 'Verifying room with server...');
      if (roomDot) roomDot.className = 'status-dot status-dot--connecting';
      if (roomText) roomText.textContent = `Connecting: ${status.roomId}...`;
      if (btnDisconnectRoom) btnDisconnectRoom.hidden = false;
      if (btnJoinRemote) btnJoinRemote.textContent = `🌐 ${status.roomId}...`;
    } else {
      // Keep the gate up for a URL/localStorage room until the first join
      // response arrives. Otherwise the initial status callback briefly
      // exposes the locally cached display before validation completes.
      if (!requestedRoom) setRemoteDisplayGate(false);
      if (roomDot) roomDot.className = 'status-dot status-dot--offline';
      if (roomText) roomText.textContent = 'Local Sync';
      if (btnDisconnectRoom) btnDisconnectRoom.hidden = true;
      if (btnJoinRemote) btnJoinRemote.textContent = '🌐 Room Code (Online)';
    }
  });

  // Technician telemetry loop: keeps the sync HUD and the STANDBY screen in
  // step with connection state, RTT, and broadcast staleness.
  const standbyGuard = () => {
    const standbyShouldShow = Boolean(syncChannel?.roomId)
      && syncChannel.isRemoteConnected
      && !remoteFirstStateReceived
      && !syncChannel.roomClosed;
    setStandbyVisible(standbyShouldShow);
  };
  refreshSyncHud();
  standbyGuard();
  setInterval(() => {
    refreshSyncHud();
    standbyGuard();
  }, 2000);

  const autoJoinCheckbox = document.getElementById('display-checkbox-autojoin');

  const openJoinModal = () => {
    if (!joinModal) return;
    joinModal.hidden = false;
    joinModal.style.display = 'flex';
    if (inputRoomCode && !inputRoomCode.value) {
      inputRoomCode.value = syncChannel.roomId
        || localStorage.getItem(DISPLAY_AUTOJOIN_KEY)
        || localStorage.getItem('countdown_studio_last_room')
        || '';
    }
    if (autoJoinCheckbox) {
      autoJoinCheckbox.checked = Boolean(localStorage.getItem(DISPLAY_AUTOJOIN_KEY));
    }
    inputRoomCode?.focus();
  };

  const closeJoinModal = () => {
    if (!joinModal) return;
    joinModal.hidden = true;
    joinModal.style.display = 'none';
  };

  btnJoinRemote?.addEventListener('click', openJoinModal);
  roomBadge?.addEventListener('click', openJoinModal);
  btnCloseJoinModal?.addEventListener('click', closeJoinModal);
  btnCancelJoin?.addEventListener('click', closeJoinModal);
  joinModal?.addEventListener('click', (e) => {
    if (e.target === joinModal) closeJoinModal();
  });

  btnSubmitJoin?.addEventListener('click', () => {
    const raw = (inputRoomCode?.value || '').toUpperCase().trim();
    if (!raw) {
      showToast('Please enter a Room Code.', 'error');
      return;
    }
    localStorage.setItem('countdown_studio_last_room', raw);
    if (autoJoinCheckbox?.checked) {
      localStorage.setItem(DISPLAY_AUTOJOIN_KEY, raw);
      showToast(`This display will auto-rejoin room ${raw}.`, 'info');
    } else {
      localStorage.removeItem(DISPLAY_AUTOJOIN_KEY);
    }
    remoteFirstStateReceived = false;
    lastRemoteStateAt = Date.now();
    syncChannel.connectRemote(raw, 'display');
    closeJoinModal();
    showToast(`Connecting display to room ${raw}...`, 'info');
  });

  btnDisconnectRoom?.addEventListener('click', () => {
    syncChannel.disconnectRemote();
    setRemoteDisplayGate(false);
    localStorage.removeItem('countdown_studio_last_room');
    localStorage.removeItem(DISPLAY_AUTOJOIN_KEY);
    remoteFirstStateReceived = false;
    setStandbyVisible(false);
    closeJoinModal();
    showToast('Left online room. Switched to Local Sync mode.', 'info');
  });

  // Check URL param ?room=CODE (e.g. from QR code or shared link). Failing
  // that, a display machine that ticked "remember this screen" auto-rejoins
  // its saved room so a projection rig boots straight into show readiness.
  // A plain saved room in localStorage is intentionally NOT auto-connected:
  // static deployments do not have a /ws endpoint, and a stale room would
  // otherwise block the normal local Stage Display every time it is opened.
  if (roomFromUrl) {
    const cleanRoom = roomFromUrl.toUpperCase().trim();
    localStorage.setItem('countdown_studio_last_room', cleanRoom);
    if (inputRoomCode) inputRoomCode.value = cleanRoom;
    remoteFirstStateReceived = false;
    syncChannel.connectRemote(cleanRoom, 'display');
    showToast(`Auto-connecting to match room: ${cleanRoom}`, 'success');
  } else if (autoJoinRoom) {
    if (inputRoomCode) inputRoomCode.value = autoJoinRoom;
    remoteFirstStateReceived = false;
    syncChannel.connectRemote(autoJoinRoom, 'display');
    showToast(`Auto-rejoining saved room: ${autoJoinRoom}`, 'success');
  } else if (inputRoomCode) {
    inputRoomCode.value = localStorage.getItem('countdown_studio_last_room') || '';
  }

  // Single-window Host Overlay Drawer (Hotkey H), Calibration (Hotkey B), & Fullscreen (Hotkey F)
  const overlayDrawer = document.getElementById('stage-host-overlay');
  if (overlayDrawer) {
    overlayDrawer.style.display = overlayDrawer.hidden ? 'none' : 'flex';
  }
  const stageHostIframe = document.getElementById('stage-host-iframe');
  const toggleOverlayDrawer = () => {
    if (!overlayDrawer) return;
    const willHide = overlayDrawer.style.display !== 'none';
    overlayDrawer.hidden = willHide;
    overlayDrawer.style.display = willHide ? 'none' : 'flex';
    if (!willHide && stageHostIframe) {
      // The embedded Host Console is lazily loaded on first open so the
      // display page never pays the cost of a second console instance
      // (states, sockets, sounds) while serving the projector screen.
      if (!stageHostIframe.getAttribute('src') && stageHostIframe.dataset.src) {
        stageHostIframe.src = stageHostIframe.dataset.src;
      }
    }
  };
  document.getElementById('btn-toggle-host-overlay')?.addEventListener('click', toggleOverlayDrawer);

  // Panic Blank Screen Local Dismissal (Click or Esc)
  const dismissPanic = () => {
    const panicEl = document.getElementById('stage-panic-screen');
    if (panicEl) {
      panicEl.hidden = true;
      panicEl.classList.add('is-hidden');
      panicEl.classList.remove('is-active');
      panicEl.setAttribute('data-active', 'false');
      panicEl.style.display = 'none';
    }
    if (currentState) {
      currentState.panicBlank = false;
    }
    syncChannel?.send('CLEAR_PANIC', {});
    showToast('Panic blank screen cleared.', 'info');
  };
  document.getElementById('btn-dismiss-panic')?.addEventListener('click', dismissPanic);

  // Copy Screen Link (for bookmarking the projection machine's stage URL)
  document.getElementById('btn-copy-display-link')?.addEventListener('click', async () => {
    const roomId = syncChannel?.roomId || (document.getElementById('display-input-room-code')?.value || '').toUpperCase().trim();
    if (!roomId) {
      showToast('Connect to a room first to copy its display link.', 'error');
      return;
    }
    const link = buildDisplayRoomLink(roomId);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(link);
      showToast(`Stage display link copied (${roomId}).`, 'success');
    } else {
      window.prompt('Copy this stage display link:', link);
    }
  });

  document.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    if (e.key === 'Escape') {
      dismissPanic();
      return;
    }
    if (key === '?') {
      e.preventDefault();
      showToast(
        'Hotkeys — H: Host Console · B/L: Calibration · C: Controls · F: Fullscreen · D: Sync HUD · Q/P or Shift: Buzzers · Esc: Dismiss Blank',
        'info'
      );
      return;
    }
    if (key === 'd') {
      e.preventDefault();
      hudVisible = !hudVisible;
      localStorage.setItem('countdown_studio_stage_hud_v1', hudVisible ? 'visible' : 'hidden');
      refreshSyncHud();
      showToast(hudVisible ? 'Technician sync HUD shown.' : 'Technician sync HUD hidden.', 'info');
      return;
    }
    if (key === 'c') {
      e.preventDefault();
      setStageControlsHidden(!stageControlsHidden, true);
    } else if (key === 'h') {
      e.preventDefault();
      toggleOverlayDrawer();
    } else if (key === 'b' || key === 'l') {
      e.preventDefault();
      const canvas = document.getElementById('stage-canvas');
      const toolbar = document.getElementById('stage-calibration-toolbar');
      if (canvas) {
        const nextActive = !canvas.classList.contains('is-calibrating');
        canvas.classList.toggle('is-calibrating', nextActive);
        if (toolbar) toolbar.hidden = !nextActive;
      }
    } else if (key === 'f') {
      e.preventDefault();
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen?.().catch(() => {});
      } else {
        document.exitFullscreen?.().catch(() => {});
      }
    } else if (e.code === 'ShiftLeft' || key === 'q') {
      syncChannel.send('DISPLAY_BUZZ', { player: 1, timestamp: performance.now() });
    } else if (e.code === 'ShiftRight' || key === 'p') {
      syncChannel.send('DISPLAY_BUZZ', { player: 2, timestamp: performance.now() });
    }
  });
});
