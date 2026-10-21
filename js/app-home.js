/**
 * @file js/app-home.js
 * Controller for /index.html (Home Screen, Mode Picker, Settings & Schedule Editor,
 * Persistent Stats Dashboard, Achievements, and PWA Installation).
 */

import {
  loadSettings,
  saveSettings,
  applySettingsToDOM,
  loadStats,
  exportStatsJSON,
  importStatsJSON
} from './core/storage.js';
import { SCHEDULE_PRESETS, getScheduleRounds, getRoundTypeName } from './game/schedule.js';
import { initModalHandlers, openModal, closeModal } from './ui/modal.js';
import { showToast } from './ui/toast.js';
import { renderStatsChartSVG } from './ui/scoreboard.js';
import { audio } from './core/audio.js';
import { getTodaySeed } from './core/rng.js';
import { currentUser } from './auth.js';

function initPWA() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker
      .register('./sw.js')
      .then((reg) => {
        reg.update().catch(() => {});
      })
      .catch(() => {
        // Service worker optional in restricted preview environments
      });
  }
}

async function renderHomeStats() {
  const stats = await loadStats();
  const setTxt = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = String(val);
  };

  setTxt('stat-games-played', stats.gamesPlayed);
  setTxt('stat-best-score', stats.bestScore);
  setTxt('stat-streak', `${stats.currentStreak} day${stats.currentStreak === 1 ? '' : 's'}`);
  setTxt('stat-best-word', stats.bestWord || '—');

  const avgLen =
    stats.validWordsCount > 0
      ? (stats.totalWordLength / stats.validWordsCount).toFixed(1)
      : '0.0';
  setTxt('stat-avg-len', `${avgLen} letters`);

  const numHitRate =
    stats.numbersRoundsPlayed > 0
      ? `${Math.round((stats.numbersExactHits / stats.numbersRoundsPlayed) * 100)}%`
      : '0%';
  setTxt('stat-num-rate', numHitRate);

  const roleBannerEl = document.getElementById('career-role-banner');
  if (roleBannerEl) {
    const user = currentUser();
    if (user) {
      roleBannerEl.innerHTML = `
        <div class="career-user-banner">
          <span>👤 Career synced to <strong>${user.displayName || user.username}</strong> (${user.role === 'individual' ? 'Individual Player' : user.role})</span>
        </div>
      `;
    } else {
      roleBannerEl.innerHTML = `
        <div class="career-guest-banner">
          <span>💡 Playing as <strong>Guest</strong>. <a href="./login.html" style="color:var(--accent-primary);text-decoration:underline">Sign In or Register Free</a> to persist your career stats &amp; daily streaks across devices.</span>
        </div>
      `;
    }
  }

  const chartBox = document.getElementById('home-stats-chart');
  if (chartBox) {
    renderStatsChartSVG(chartBox, stats.history);
  }

  const achList = document.getElementById('home-achievements-list');
  if (achList) {
    achList.innerHTML = '';
    if (!stats.achievements || stats.achievements.length === 0) {
      const p = document.createElement('p');
      p.style.color = 'var(--text-muted)';
      p.style.fontSize = '0.875rem';
      p.textContent = 'Play Solo drills or a Full Match to unlock studio achievements.';
      achList.appendChild(p);
    } else {
      stats.achievements.forEach((ach) => {
        const row = document.createElement('div');
        row.className = 'meta-inline';
        row.style.color = 'var(--text-primary)';
        row.style.padding = '0.35rem 0';
        row.textContent = `★ ${ach.title} · Unlocked ${ach.date}`;
        achList.appendChild(row);
      });
    }
  }
}

function initSettingsModal() {
  const settings = loadSettings();
  applySettingsToDOM(settings);
  audio.setMuted(!settings.soundEnabled);
  audio.setVolume(settings.volume);

  const themeSelect = document.getElementById('setting-theme');
  const clockSelect = document.getElementById('setting-clock');
  const dictSelect = document.getElementById('setting-dict');
  const longerToggle = document.getElementById('setting-longer-only');
  const soundToggle = document.getElementById('setting-sound');
  const volumeSlider = document.getElementById('setting-volume');
  const motionToggle = document.getElementById('setting-reduced-motion');
  const largeTextToggle = document.getElementById('setting-large-text');
  const presetSelect = document.getElementById('setting-schedule-preset');
  const customBuilder = document.getElementById('custom-schedule-list');
  const addRoundSelect = document.getElementById('add-round-type');
  const addRoundBtn = document.getElementById('add-round-btn');

  let workingSchedule = getScheduleRounds(settings.schedulePreset, settings.customSchedule);

  const renderScheduleChips = () => {
    if (!customBuilder) return;
    customBuilder.innerHTML = '';
    let dragSrcIndex = null;

    workingSchedule.forEach((code, idx) => {
      const item = document.createElement('div');
      item.draggable = true;
      item.className = 'btn btn--sm btn--secondary';
      item.style.cursor = 'grab';
      item.setAttribute('aria-label', `Round ${idx + 1}: ${getRoundTypeName(code)}. Drag to reorder.`);

      const label = document.createElement('span');
      label.textContent = `R${idx + 1}: ${code}`;

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.style.marginLeft = '0.35rem';
      removeBtn.style.color = 'var(--text-muted)';
      removeBtn.textContent = '×';
      removeBtn.title = 'Remove round';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (workingSchedule.length <= 1) {
          showToast('Schedule must have at least 1 round.', 'error');
          return;
        }
        workingSchedule.splice(idx, 1);
        if (presetSelect) presetSelect.value = 'custom';
        renderScheduleChips();
      });

      item.appendChild(label);
      item.appendChild(removeBtn);

      item.addEventListener('dragstart', () => {
        dragSrcIndex = idx;
      });
      item.addEventListener('dragover', (e) => e.preventDefault());
      item.addEventListener('drop', (e) => {
        e.preventDefault();
        if (dragSrcIndex !== null && dragSrcIndex !== idx) {
          const moved = workingSchedule.splice(dragSrcIndex, 1)[0];
          workingSchedule.splice(idx, 0, moved);
          dragSrcIndex = null;
          if (presetSelect) presetSelect.value = 'custom';
          renderScheduleChips();
        }
      });

      customBuilder.appendChild(item);
    });
  };

  if (themeSelect) themeSelect.value = settings.theme;
  if (clockSelect) clockSelect.value = String(settings.clockDuration);
  if (dictSelect) dictSelect.value = settings.dictionaryMode;
  if (longerToggle) longerToggle.checked = Boolean(settings.onlyLongerScores);
  if (soundToggle) soundToggle.checked = Boolean(settings.soundEnabled);
  if (volumeSlider) volumeSlider.value = String(settings.volume);
  if (motionToggle) motionToggle.checked = Boolean(settings.reducedMotion);
  if (largeTextToggle) largeTextToggle.checked = Boolean(settings.largeText);
  if (presetSelect) {
    presetSelect.value = settings.schedulePreset;
    presetSelect.addEventListener('change', () => {
      if (presetSelect.value !== 'custom') {
        workingSchedule = [...SCHEDULE_PRESETS[presetSelect.value].rounds];
        renderScheduleChips();
      }
    });
  }

  if (addRoundBtn && addRoundSelect) {
    addRoundBtn.addEventListener('click', () => {
      if (workingSchedule.length >= 25) {
        showToast('Maximum 25 rounds per match.', 'error');
        return;
      }
      workingSchedule.push(addRoundSelect.value);
      if (presetSelect) presetSelect.value = 'custom';
      renderScheduleChips();
    });
  }

  renderScheduleChips();

  const saveBtn = document.getElementById('save-settings-btn');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      const updated = saveSettings({
        theme: themeSelect ? themeSelect.value : 'classic-blue',
        clockDuration: clockSelect ? Number(clockSelect.value) : 30,
        dictionaryMode: dictSelect ? dictSelect.value : 'standard',
        onlyLongerScores: longerToggle ? longerToggle.checked : true,
        soundEnabled: soundToggle ? soundToggle.checked : true,
        volume: volumeSlider ? Number(volumeSlider.value) : 0.75,
        reducedMotion: motionToggle ? motionToggle.checked : false,
        largeText: largeTextToggle ? largeTextToggle.checked : false,
        schedulePreset: presetSelect ? presetSelect.value : 'tv-15',
        customSchedule: workingSchedule
      });
      audio.setMuted(!updated.soundEnabled);
      audio.setVolume(updated.volume);
      audio.playValidChime();
      closeModal('modal-settings');
      showToast('Studio settings saved.', 'success');
    });
  }

  // Export & Import Stats JSON
  const exportBtn = document.getElementById('export-stats-btn');
  if (exportBtn) {
    exportBtn.addEventListener('click', async () => {
      const blob = new Blob([await exportStatsJSON()], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `countdown-studio-stats-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('Exported stats JSON.', 'success');
    });
  }

  const importInput = document.getElementById('import-stats-input');
  if (importInput) {
    importInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const text = await file.text();
      if (await importStatsJSON(text)) {
        await renderHomeStats();
        showToast('Stats & settings imported successfully!', 'success');
      } else {
        showToast('Invalid stats JSON file.', 'error');
      }
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initModalHandlers();
  initPWA();
  initSettingsModal();
  renderHomeStats();

  const dailyBadge = document.getElementById('daily-seed-label');
  if (dailyBadge) {
    dailyBadge.textContent = `Today's Seed: ${getTodaySeed().replace('daily-', '')}`;
  }
});
