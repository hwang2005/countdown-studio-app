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
    } else {
      audio.stopClockMusic();
      audio.resetClockTracker();
    }
    stageAudioWasRunning = false;
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
  if (!state.clockRunning || !stageQuestionSnapshot || stageQuestionSnapshot.key !== roundKey) {
    stageQuestionSnapshot = {
      key: roundKey,
      letters: Array.isArray(state.letters) ? [...state.letters] : [],
      numbers: Array.isArray(state.numbers) ? [...state.numbers] : [],
      target: state.target,
      conundrumScrambled: state.conundrumScrambled,
      conundrumAnswer: state.conundrumAnswer,
      conundrumRevealed: state.conundrumRevealed
    };
  }
  return state.clockRunning ? { ...state, ...stageQuestionSnapshot } : state;
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
    hideBtn.textContent = stageControlsHidden ? '👁 Hiện điều khiển (C)' : '👁 Ẩn điều khiển (C)';
  }
  const calibHideBtn = document.getElementById('btn-calib-hide-controls');
  if (calibHideBtn) {
    calibHideBtn.textContent = stageControlsHidden ? '👁 Hiện điều khiển (C)' : '👁 Ẩn điều khiển (C)';
  }

  if (notify) {
    if (stageControlsHidden) {
      showToast('Đã ẩn các nút điều khiển. Nhấn phím "C" hoặc rê chuột xuống đáy màn hình để hiện lại.', 'info');
    } else {
      showToast('Đã hiện lại các nút điều khiển trên màn hình.', 'info');
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
    probe.src = './assets/countdown-clock-placeholder.jpg';
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

  if (state.phase === 'MATCH_END') {
    if (lettersBoard) lettersBoard.hidden = true;
    if (numbersZone) numbersZone.hidden = true;
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
    if (endPodium) endPodium.hidden = true;
    if (questionState.roundType === 'L') {
      if (lettersBoard) {
        lettersBoard.hidden = false;
        renderLetterTiles(lettersBoard, questionState.letters);
      }
      if (numbersZone) numbersZone.hidden = true;
    } else if (questionState.roundType === 'N') {
      if (lettersBoard) lettersBoard.hidden = true;
      if (numbersZone) {
        numbersZone.hidden = false;
        renderNumberTiles(numbersBoard, questionState.numbers);
        if (targetVal) targetVal.textContent = questionState.target ? String(questionState.target) : '000';
        if (numSolBox) {
          numSolBox.hidden = !state.showNumbersSolutionOnDisplay || !state.numbersSolution;
          if (state.showNumbersSolutionOnDisplay && state.numbersSolution) {
            renderNumbersSolution(numSolBox, state.numbersSolution, state.target);
          }
        }
      }
    } else {
      // Conundrum
      if (numbersZone) numbersZone.hidden = true;
      if (lettersBoard) {
        lettersBoard.hidden = false;
        const word = questionState.conundrumRevealed ? questionState.conundrumAnswer : questionState.conundrumScrambled;
        renderLetterTiles(lettersBoard, word ? word.split('') : [], { isConundrum: true });
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
      await audio.unlock();
      // If the countdown started before the browser gesture, retry the first
      // clock cue after unlocking instead of losing the soundtrack entirely.
      audio.resetClockTracker();
      syncStageClockAudio(currentState);
      splash.hidden = true;
    });
  }

  syncChannel = new StageSyncChannel('display', (msg) => {
    if (msg.type === 'STATE_SYNC' && msg.payload) {
      renderStage(msg.payload);
    } else if (msg.type === 'STAGE_LAYOUT_SYNC' && msg.payload) {
      const next = saveStageLayout(msg.payload);
      applyStageLayoutToDOM(next);
    } else if (msg.type === 'STAGE_BG_SYNC' && msg.payload !== undefined) {
      saveCustomStageBackground(msg.payload.bg || null);
      applyStageLayoutToDOM(stageLayout, msg.payload.bg || null);
    } else if (msg.type === 'STAGE_CONTROLS_SYNC' && msg.payload !== undefined) {
      setStageControlsHidden(Boolean(msg.payload.hidden), false);
    }
  });

  const persisted = syncChannel.recoverPersistedState();
  if (persisted) {
    renderStage(persisted);
  } else {
    renderStage(currentState);
  }

  syncChannel.send('REQUEST_STATE', {});
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
    if (status.roomClosed) {
      localStorage.removeItem('countdown_studio_last_room');
      if (roomDot) roomDot.className = 'status-dot status-dot--offline';
      if (roomText) roomText.textContent = 'Phòng đã đóng / không tồn tại';
      if (btnDisconnectRoom) btnDisconnectRoom.hidden = true;
      if (btnJoinRemote) btnJoinRemote.textContent = '🌐 Mã Phòng (Online)';
      showToast(status.error || 'Phòng đã đóng hoặc không tồn tại.', 'error');
    } else if (status.roomId && status.connected) {
      if (roomDot) roomDot.className = 'status-dot status-dot--online';
      if (roomText) roomText.textContent = `Phòng: ${status.roomId}`;
      if (btnDisconnectRoom) btnDisconnectRoom.hidden = false;
      if (btnJoinRemote) btnJoinRemote.textContent = `🌐 ${status.roomId}`;
    } else if (status.roomId && !status.connected) {
      if (roomDot) roomDot.className = 'status-dot status-dot--connecting';
      if (roomText) roomText.textContent = `Kết nối: ${status.roomId}...`;
      if (btnDisconnectRoom) btnDisconnectRoom.hidden = false;
      if (btnJoinRemote) btnJoinRemote.textContent = `🌐 ${status.roomId}...`;
    } else {
      if (roomDot) roomDot.className = 'status-dot status-dot--offline';
      if (roomText) roomText.textContent = 'Local Sync';
      if (btnDisconnectRoom) btnDisconnectRoom.hidden = true;
      if (btnJoinRemote) btnJoinRemote.textContent = '🌐 Mã Phòng (Online)';
    }
  });

  const openJoinModal = () => {
    if (!joinModal) return;
    joinModal.hidden = false;
    joinModal.style.display = 'flex';
    if (inputRoomCode && !inputRoomCode.value) {
      inputRoomCode.value = syncChannel.roomId || localStorage.getItem('countdown_studio_last_room') || '';
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
      showToast('Vui lòng nhập Mã Phòng.', 'error');
      return;
    }
    localStorage.setItem('countdown_studio_last_room', raw);
    syncChannel.connectRemote(raw, 'display');
    closeJoinModal();
    showToast(`Đang kết nối màn hình tới phòng ${raw}...`, 'info');
  });

  btnDisconnectRoom?.addEventListener('click', () => {
    syncChannel.disconnectRemote();
    localStorage.removeItem('countdown_studio_last_room');
    closeJoinModal();
    showToast('Đã rời phòng trực tuyến. Chuyển về chế độ đồng bộ cục bộ (Local).', 'info');
  });

  // Check URL param ?room=CODE (e.g. from QR code or shared link)
  const urlParams = new URLSearchParams(window.location.search);
  const roomFromUrl = urlParams.get('room');
  if (roomFromUrl) {
    const cleanRoom = roomFromUrl.toUpperCase().trim();
    localStorage.setItem('countdown_studio_last_room', cleanRoom);
    if (inputRoomCode) inputRoomCode.value = cleanRoom;
    syncChannel.connectRemote(cleanRoom, 'display');
    showToast(`Tự động kết nối tới phòng thi đấu: ${cleanRoom}`, 'success');
  } else {
    // Check saved room in localStorage
    const savedRoom = localStorage.getItem('countdown_studio_last_room');
    if (savedRoom) {
      if (inputRoomCode) inputRoomCode.value = savedRoom;
      syncChannel.connectRemote(savedRoom, 'display');
    }
  }

  // Single-window Host Overlay Drawer (Hotkey H), Calibration (Hotkey B), & Fullscreen (Hotkey F)
  const overlayDrawer = document.getElementById('stage-host-overlay');
  if (overlayDrawer) {
    overlayDrawer.style.display = overlayDrawer.hidden ? 'none' : 'flex';
  }
  const toggleOverlayDrawer = () => {
    if (!overlayDrawer) return;
    const willHide = overlayDrawer.style.display !== 'none';
    overlayDrawer.hidden = willHide;
    overlayDrawer.style.display = willHide ? 'none' : 'flex';
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

  document.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    if (e.key === 'Escape') {
      dismissPanic();
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
