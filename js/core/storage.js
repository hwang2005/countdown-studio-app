/**
 * @file js/core/storage.js
 * Persistent storage manager for user settings, Solo statistics, achievements,
 * match history (last 50 matches), and Versus stage recovery state.
 */

const KEYS = {
  SETTINGS: 'countdown_studio_settings_v1',
  STATS: 'countdown_studio_stats_v1',
  VERSUS_STATE: 'countdown_studio_versus_state_v1',
  DICT_CACHE: 'countdown_studio_dict_cache_v1',
  STAGE_LAYOUT: 'countdown_studio_stage_layout_v1',
  STAGE_BG: 'countdown_studio_stage_bg_v1'
};

/**
 * Default percentage coordinates (0-100) for the 16:9 Stage Display elements,
 * calibrated to match the Countdown TV Studio Set background (/assets/stage-bg.svg):
 * - Studio Clock centered in the upper-middle background wall (50%, 35%)
 * - Contestant 1 Name & Score in the Left Podium slots (16.15%, 70.0% and 16.15%, 82.87%)
 * - Contestant 2 Name & Score in the Right Podium slots (83.85%, 70.0% and 83.85%, 82.87%)
 * - Central Letters/Numbers Board in the center studio rack (50%, 81.8%)
 */
export const DEFAULT_STAGE_LAYOUT = {
  clockX: 50,
  clockY: 35,
  clockSize: 23.5,
  clockHandsOnly: true,
  showDigitalTimer: false,
  p1NameX: 16.15,
  p1NameY: 70.0,
  p1NameW: 19.2,
  p1ScoreX: 16.15,
  p1ScoreY: 82.87,
  p1ScoreW: 13.2,
  p2NameX: 83.85,
  p2NameY: 70.0,
  p2NameW: 19.2,
  p2ScoreX: 83.85,
  p2ScoreY: 82.87,
  p2ScoreW: 13.2,
  boardX: 50,
  boardY: 81.8,
  boardW: 41.2
};

/**
 * Loads stage layout coordinates merged with defaults.
 * @returns {typeof DEFAULT_STAGE_LAYOUT}
 */
export function loadStageLayout() {
  try {
    const raw = localStorage.getItem(KEYS.STAGE_LAYOUT);
    if (!raw) return { ...DEFAULT_STAGE_LAYOUT };
    return { ...DEFAULT_STAGE_LAYOUT, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_STAGE_LAYOUT };
  }
}

/**
 * Saves stage layout coordinates.
 * @param {Partial<typeof DEFAULT_STAGE_LAYOUT>} partial
 * @returns {typeof DEFAULT_STAGE_LAYOUT}
 */
export function saveStageLayout(partial) {
  const next = { ...loadStageLayout(), ...partial };
  try {
    localStorage.setItem(KEYS.STAGE_LAYOUT, JSON.stringify(next));
  } catch (err) {
    console.warn('[Storage] Failed to save stage layout:', err);
  }
  return next;
}

/**
 * Resets stage layout coordinates back to the default studio calibration.
 * @returns {typeof DEFAULT_STAGE_LAYOUT}
 */
export function resetStageLayout() {
  try {
    localStorage.removeItem(KEYS.STAGE_LAYOUT);
  } catch {
    // ignore
  }
  return { ...DEFAULT_STAGE_LAYOUT };
}

/**
 * Saves a custom stage background data URL (or clears it if null/empty).
 * @param {string|null} dataUrl
 */
export function saveCustomStageBackground(dataUrl) {
  try {
    if (!dataUrl) {
      localStorage.removeItem(KEYS.STAGE_BG);
    } else {
      localStorage.setItem(KEYS.STAGE_BG, dataUrl);
    }
  } catch (err) {
    console.warn('[Storage] Failed to save custom stage background (quota):', err);
  }
}

/**
 * Loads custom stage background data URL if set, otherwise null (uses ./assets/stage-bg.svg).
 * @returns {string|null}
 */
export function loadCustomStageBackground() {
  try {
    return localStorage.getItem(KEYS.STAGE_BG) || null;
  } catch {
    return null;
  }
}

/**
 * Loads whether stage control buttons are hidden on the display screen.
 * @returns {boolean}
 */
export function loadStageControlsHidden() {
  try {
    return localStorage.getItem('countdown_studio_stage_controls_hidden_v1') === 'true';
  } catch {
    return false;
  }
}

/**
 * Saves whether stage control buttons are hidden on the display screen.
 * @param {boolean} hidden
 * @returns {boolean}
 */
export function saveStageControlsHidden(hidden) {
  try {
    localStorage.setItem('countdown_studio_stage_controls_hidden_v1', String(Boolean(hidden)));
  } catch (err) {
    console.warn('[Storage] Failed to save stage controls state:', err);
  }
  return Boolean(hidden);
}

export const DEFAULT_SETTINGS = {
  theme: 'classic-blue', // 'classic-blue' | 'dark-studio' | 'high-contrast'
  clockDuration: 30,     // 30 | 60 | 0 (untimed)
  soundEnabled: true,
  volume: 0.75,
  dictionaryMode: 'standard', // 'standard' | 'strict-uk'
  onlyLongerScores: true,     // Standard TV rule: only longer valid word scores in Versus
  numbersExactPoints: 10,
  numbersClose5Points: 7,
  numbersClose10Points: 5,
  schedulePreset: 'tv-15',    // 'tv-15' | 'quick-5' | 'letters-only' | 'numbers-only' | 'custom'
  customSchedule: ['L','L','N','L','L','N','L','L','N','L','L','N','L','L','C'],
  startingPlayer: 1,          // 1 or 2
  p1BuzzerKey: 'q',
  p2BuzzerKey: 'p',
  language: 'en',
  reducedMotion: false,
  largeText: false,
  autoPauseOnHide: false
};

export const DEFAULT_STATS = {
  gamesPlayed: 0,
  totalPoints: 0,
  bestScore: 0,
  currentStreak: 0,
  bestStreak: 0,
  lastPlayedDate: null,
  bestWord: '',
  totalWordsSubmitted: 0,
  validWordsCount: 0,
  totalWordLength: 0,
  numbersRoundsPlayed: 0,
  numbersExactHits: 0,
  conundrumsPlayed: 0,
  conundrumsSolved: 0,
  achievements: [],
  history: [] // Last 50 completed sessions
};

/**
 * Loads settings merged with defaults.
 * @returns {typeof DEFAULT_SETTINGS}
 */
export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEYS.SETTINGS);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Saves settings and applies theme/motion attributes to document.documentElement.
 * @param {Partial<typeof DEFAULT_SETTINGS>} partial
 * @returns {typeof DEFAULT_SETTINGS}
 */
export function saveSettings(partial) {
  const next = { ...loadSettings(), ...partial };
  try {
    localStorage.setItem(KEYS.SETTINGS, JSON.stringify(next));
  } catch (err) {
    console.warn('[Storage] Failed to save settings:', err);
  }
  applySettingsToDOM(next);
  return next;
}

/**
 * Applies theme, large-text, and reduced-motion attributes to `<html>`.
 * @param {typeof DEFAULT_SETTINGS} [settings]
 */
export function applySettingsToDOM(settings = loadSettings()) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.setAttribute('data-theme', settings.theme || 'classic-blue');
  root.setAttribute('data-large-text', String(Boolean(settings.largeText)));
  root.setAttribute('data-reduced-motion', String(Boolean(settings.reducedMotion)));
}

/**
 * Loads persistent Solo statistics and match history.
 * @returns {typeof DEFAULT_STATS}
 */
export function loadStats() {
  try {
    const raw = localStorage.getItem(KEYS.STATS);
    if (!raw) return structuredClone(DEFAULT_STATS);
    const parsed = JSON.parse(raw);
    return {
      ...structuredClone(DEFAULT_STATS),
      ...parsed,
      achievements: Array.isArray(parsed.achievements) ? parsed.achievements : [],
      history: Array.isArray(parsed.history) ? parsed.history.slice(0, 50) : []
    };
  } catch {
    return structuredClone(DEFAULT_STATS);
  }
}

/**
 * Records a completed Solo match or drill session and evaluates achievements.
 * @param {object} sessionResult
 * @returns {typeof DEFAULT_STATS}
 */
export function recordSoloSession(sessionResult) {
  const stats = loadStats();
  const today = new Date().toISOString().slice(0, 10);

  stats.gamesPlayed += 1;
  stats.totalPoints += sessionResult.score || 0;
  if ((sessionResult.score || 0) > stats.bestScore) {
    stats.bestScore = sessionResult.score;
  }

  // Update daily streak
  if (stats.lastPlayedDate !== today) {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    stats.currentStreak = stats.lastPlayedDate === yesterday ? stats.currentStreak + 1 : 1;
    if (stats.currentStreak > stats.bestStreak) {
      stats.bestStreak = stats.currentStreak;
    }
    stats.lastPlayedDate = today;
  }

  if (sessionResult.bestWord && sessionResult.bestWord.length > stats.bestWord.length) {
    stats.bestWord = sessionResult.bestWord.toUpperCase();
  }

  stats.totalWordsSubmitted += sessionResult.wordsSubmitted || 0;
  stats.validWordsCount += sessionResult.validWords || 0;
  stats.totalWordLength += sessionResult.totalWordLength || 0;
  stats.numbersRoundsPlayed += sessionResult.numbersPlayed || 0;
  stats.numbersExactHits += sessionResult.numbersExact || 0;
  stats.conundrumsPlayed += sessionResult.conundrumsPlayed || 0;
  stats.conundrumsSolved += sessionResult.conundrumsSolved || 0;

  // Evaluate achievements
  const unlock = (id, title) => {
    if (!stats.achievements.some((a) => a.id === id)) {
      stats.achievements.push({ id, title, date: today });
    }
  };

  if (stats.gamesPlayed >= 1) unlock('first_match', 'Debut Contestant — Completed first session');
  if (sessionResult.bestWord && sessionResult.bestWord.length === 9) {
    unlock('nine_letter', 'Nine-Letter Master — Found a valid 9-letter word');
  }
  if ((sessionResult.numbersExact || 0) >= 1) {
    unlock('exact_numbers', 'Carol/Rachel Approved — Hit an exact 3-digit target');
  }
  if ((sessionResult.conundrumsSolved || 0) >= 1) {
    unlock('conundrum_solver', 'Crucial Conundrum — Solved the 9-letter anagram');
  }
  if ((sessionResult.score || 0) >= 100) {
    unlock('century_club', 'Octochamp Material — Scored 100+ points in a match');
  }

  stats.history.unshift({
    id: `sess-${Date.now()}`,
    date: new Date().toISOString(),
    mode: sessionResult.mode || 'Full Match',
    score: sessionResult.score || 0,
    maxPossible: sessionResult.maxPossible || 0,
    rounds: sessionResult.roundsCount || 1,
    bestWord: sessionResult.bestWord || '—',
    exactNumbers: sessionResult.numbersExact || 0
  });
  stats.history = stats.history.slice(0, 50);

  try {
    localStorage.setItem(KEYS.STATS, JSON.stringify(stats));
  } catch (err) {
    console.warn('[Storage] Failed to save stats:', err);
  }
  return stats;
}

/**
 * Exports all stats and settings as a JSON string.
 * @returns {string}
 */
export function exportStatsJSON() {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      settings: loadSettings(),
      stats: loadStats()
    },
    null,
    2
  );
}

/**
 * Imports stats and settings from a JSON string.
 * @param {string} jsonStr
 * @returns {boolean}
 */
export function importStatsJSON(jsonStr) {
  try {
    const data = JSON.parse(jsonStr);
    if (data.settings) saveSettings(data.settings);
    if (data.stats && typeof data.stats.gamesPlayed === 'number') {
      localStorage.setItem(KEYS.STATS, JSON.stringify(data.stats));
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Saves Versus match state keyed by match ID so display refreshes recover seamlessly.
 * @param {object} state
 */
export function saveVersusState(state) {
  try {
    localStorage.setItem(KEYS.VERSUS_STATE, JSON.stringify(state));
  } catch (err) {
    console.warn('[Storage] Failed to persist versus state:', err);
  }
}

/**
 * Loads persisted Versus match state.
 * @returns {object|null}
 */
export function loadVersusState() {
  try {
    const raw = localStorage.getItem(KEYS.VERSUS_STATE);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Caches online dictionary API definitions locally.
 * @param {string} word
 * @param {object} entry
 */
export function cacheWordDefinition(word, entry) {
  try {
    const raw = localStorage.getItem(KEYS.DICT_CACHE);
    const map = raw ? JSON.parse(raw) : {};
    map[word.toLowerCase()] = entry;
    const keys = Object.keys(map);
    if (keys.length > 150) {
      delete map[keys[0]];
    }
    localStorage.setItem(KEYS.DICT_CACHE, JSON.stringify(map));
  } catch {
    // Ignore quota errors
  }
}

/**
 * Retrieves cached word definition if present.
 * @param {string} word
 * @returns {object|null}
 */
export function getCachedWordDefinition(word) {
  try {
    const raw = localStorage.getItem(KEYS.DICT_CACHE);
    if (!raw) return null;
    const map = JSON.parse(raw);
    return map[word.toLowerCase()] || null;
  } catch {
    return null;
  }
}
