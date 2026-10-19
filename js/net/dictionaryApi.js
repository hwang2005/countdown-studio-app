/**
 * @file js/net/dictionaryApi.js
 * Optional online enrichment via Free Dictionary API and Datamuse API.
 * Enforces a strict 4-second AbortController timeout, caches results in localStorage,
 * and degrades gracefully when offline without blocking gameplay.
 */

import { cacheWordDefinition, getCachedWordDefinition } from '../core/storage.js';

const TIMEOUT_MS = 3500;

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

  // 1. Try Datamuse API (fast, high-coverage WordNet/GCIDE definitions for Countdown words)
  const dmController = new AbortController();
  const dmTimer = setTimeout(() => dmController.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(
      `https://api.datamuse.com/words?sp=${encodeURIComponent(clean)}&md=d&max=1`,
      { signal: dmController.signal }
    );
    clearTimeout(dmTimer);

    if (res.ok) {
      const items = await res.json();
      if (Array.isArray(items) && items.length > 0 && Array.isArray(items[0].defs) && items[0].defs.length > 0) {
        const rawDef = items[0].defs[0];
        const tabIdx = rawDef.indexOf('\t');
        const posCode = tabIdx !== -1 ? rawDef.slice(0, tabIdx).trim() : 'word';
        const posMap = { n: 'noun', v: 'verb', adj: 'adjective', adv: 'adverb', u: 'word' };
        const partOfSpeech = posMap[posCode] || posCode || 'word';
        const defText = tabIdx !== -1 ? rawDef.slice(tabIdx + 1).trim() : rawDef.trim();

        const entry = {
          word: clean.toUpperCase(),
          partOfSpeech,
          definition: defText || 'Valid entry in lexicon.',
          phonetic: ''
        };

        cacheWordDefinition(clean, entry);
        return entry;
      }
    }
  } catch {
    clearTimeout(dmTimer);
  }

  // 2. Fallback to Free Dictionary API
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
