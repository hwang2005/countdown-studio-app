/**
 * @file js/net/dictionaryApi.js
 * Optional online enrichment via Free Dictionary API and Datamuse API.
 * Enforces a strict 4-second AbortController timeout, caches results in localStorage,
 * and degrades gracefully when offline without blocking gameplay.
 */

import { cacheWordDefinition, getCachedWordDefinition } from '../core/storage.js';

const TIMEOUT_MS = 4000;

/**
 * Fetches part of speech and concise definition for a word.
 * Returns cached entry if available, or null if offline/not found.
 *
 * @param {string} word
 * @returns {Promise<{ word: string, partOfSpeech: string, definition: string, phonetic?: string } | null>}
 */
export async function fetchWordDefinition(word) {
  const clean = String(word || '').trim().toLowerCase();
  if (!clean) return null;

  const cached = getCachedWordDefinition(clean);
  if (cached) return cached;

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(
      `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(clean)}`,
      { signal: controller.signal }
    );
    clearTimeout(timer);

    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;

    const first = data[0];
    const meaning = first.meanings && first.meanings[0];
    const defObj = meaning && meaning.definitions && meaning.definitions[0];

    const entry = {
      word: clean.toUpperCase(),
      partOfSpeech: (meaning && meaning.partOfSpeech) || 'word',
      definition: (defObj && defObj.definition) || 'Valid entry in lexicon.',
      phonetic: first.phonetic || ''
    };

    cacheWordDefinition(clean, entry);
    return entry;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

/**
 * Fetches related or similar-meaning clue words from Datamuse API for Solo drills.
 * Gracefully returns empty array if offline or timed out.
 *
 * @param {string} word
 * @returns {Promise<string[]>}
 */
export async function fetchRelatedClues(word) {
  const clean = String(word || '').trim().toLowerCase();
  if (!clean || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
    return [];
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(
      `https://api.datamuse.com/words?ml=${encodeURIComponent(clean)}&max=4`,
      { signal: controller.signal }
    );
    clearTimeout(timer);
    if (!res.ok) return [];
    const items = await res.json();
    return Array.isArray(items) ? items.map((x) => x.word).filter(Boolean) : [];
  } catch {
    clearTimeout(timer);
    return [];
  }
}
