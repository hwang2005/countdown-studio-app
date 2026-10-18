/**
 * @file js/ui/board.js
 * Interactive Word-Building Tray, Numbers Calculation Board, and Dictionary Corner UI.
 */

import { fetchWordDefinition } from '../net/dictionaryApi.js';

/**
 * Renders the 9-slot Word Builder Tray under the letter tiles.
 *
 * @param {HTMLElement} container
 * @param {Array<{ index: number, letter: string }>} pickedSlots
 * @param {(slotPosition: number) => void} [onRemoveSlot]
 */
export function renderWordTray(container, pickedSlots = [], onRemoveSlot = null) {
  if (!container) return;
  container.innerHTML = '';

  for (let i = 0; i < 9; i++) {
    const item = pickedSlots[i];
    const slot = document.createElement(item && onRemoveSlot ? 'button' : 'div');
    if (slot.tagName === 'BUTTON') {
      slot.type = 'button';
      slot.title = `Remove ${item.letter}`;
      slot.addEventListener('click', () => onRemoveSlot(i));
    }
    slot.className = item ? 'word-tray__slot' : 'word-tray__slot word-tray__slot--empty';
    slot.textContent = item ? item.letter : '';
    container.appendChild(slot);
  }
}

/**
 * Renders the Dictionary Corner best-words panel after a Letters round,
 * with on-demand or automatic definition lookup from Free Dictionary API.
 *
 * @param {HTMLElement} container
 * @param {{ topWords: string[], maxLength: number, byLength: Record<number, string[]>, totalFound: number }} solverResult
 * @param {string} [playerWord='']
 */
export async function renderDictionaryCorner(container, solverResult, playerWord = '') {
  if (!container) return;
  container.innerHTML = '';

  const candidateWords = Array.isArray(solverResult?.topWords) ? solverResult.topWords : [];
  const loading = document.createElement('p');
  loading.style.color = 'var(--text-muted)';
  loading.textContent = 'Checking words in the online dictionary...';
  container.appendChild(loading);

  // The offline lexicon only supplies solver candidates. Display only words
  // confirmed by the dictionary API or its API-backed local cache.
  const checkedWords = await Promise.all(
    candidateWords.map(async (word) => ({ word, definition: await fetchWordDefinition(word) }))
  );
  const definedWords = checkedWords
    .filter(({ definition }) => definition)
    .map(({ word }) => word);
  container.innerHTML = '';

  const header = document.createElement('div');
  header.style.display = 'flex';
  header.style.alignItems = 'baseline';
  header.style.justifyContent = 'space-between';
  header.style.flexWrap = 'wrap';
  header.style.gap = '0.5rem';

  const title = document.createElement('h3');
  title.style.fontSize = '1.125rem';
  title.textContent = 'Dictionary Corner — Best Available Words';

  const meta = document.createElement('div');
  meta.className = 'meta-inline';
  const cleanPlayer = (playerWord || '').trim().toUpperCase();
  const foundMax =
    cleanPlayer.length > 0 &&
    definedWords.includes(cleanPlayer);

  meta.textContent = `${solverResult.totalFound} valid words in lexicon · Longest: ${
    solverResult.maxLength || 0
  } letters${foundMax ? ' · You matched the maximum length!' : ''}`;

  meta.textContent = `${definedWords.length} words with definitions - Longest: ${
    definedWords[0]?.length || 0
  } letters${foundMax ? ' - You matched the maximum length!' : ''}`;

  header.appendChild(title);
  header.appendChild(meta);
  container.appendChild(header);

  const defBox = document.createElement('div');
  defBox.className = 'panel--subtle';
  defBox.style.marginTop = '0.75rem';
  defBox.style.fontSize = '0.875rem';
  defBox.textContent = 'Select any word below to view its dictionary definition.';

  const grid = document.createElement('div');
  grid.className = 'dict-word-grid';

  if (definedWords.length === 0) {
    const empty = document.createElement('p');
    empty.style.color = 'var(--text-muted)';
    empty.textContent = 'No words with dictionary definitions were found for this draw.';
    container.appendChild(empty);
    return;
  }

  definedWords.forEach((word, index) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dict-word-btn';
    if (word === cleanPlayer) {
      btn.style.borderColor = 'var(--status-valid)';
    }

    const wordSpan = document.createElement('span');
    wordSpan.textContent = word;

    const lenSpan = document.createElement('span');
    lenSpan.style.color = word.length === 9 ? 'var(--accent-primary)' : 'var(--text-muted)';
    lenSpan.style.fontSize = '0.75rem';
    lenSpan.textContent = word.length === 9 ? '18 pts' : `${word.length}L`;

    btn.appendChild(wordSpan);
    btn.appendChild(lenSpan);

    const loadDef = async () => {
      defBox.textContent = `Looking up "${word}"…`;
      const info = await fetchWordDefinition(word);
      if (info) {
        defBox.textContent = `${info.word} (${info.partOfSpeech}): ${info.definition}`;
      } else {
        defBox.textContent = 'Definition unavailable.';
        return;
        defBox.textContent = `${word} (${word.length} letters) — Valid offline Countdown lexicon word.`;
      }
    };

    btn.addEventListener('click', loadDef);
    if (index === 0) {
      // Automatically enrich the #1 longest word
      loadDef();
    }

    grid.appendChild(btn);
  });

  container.appendChild(grid);
  container.appendChild(defBox);
}

/**
 * Renders the Numbers Solver solution steps into a container.
 *
 * @param {HTMLElement} container
 * @param {{ exact: boolean, bestValue: number, distance: number, steps: string[], elapsedMs: number }} solution
 * @param {number} target
 */
export function renderNumbersSolution(container, solution, target) {
  if (!container || !solution) return;
  container.innerHTML = '';

  const title = document.createElement('h3');
  title.style.fontSize = '1.125rem';
  title.style.marginBottom = '0.5rem';
  title.textContent = solution.exact
    ? `Solver Exact Solution (${solution.bestValue}) — solved in ${solution.elapsedMs} ms`
    : `Solver Closest Reachable (${solution.bestValue}, ${solution.distance} away from ${target})`;

  container.appendChild(title);

  const list = document.createElement('div');
  list.className = 'calc-steps';

  if (!solution.steps || solution.steps.length === 0) {
    const line = document.createElement('div');
    line.textContent = `Tile ${solution.bestValue} directly reaches ${solution.bestValue}.`;
    list.appendChild(line);
  } else {
    solution.steps.forEach((stepStr, idx) => {
      const row = document.createElement('div');
      row.textContent = `${idx + 1}. ${stepStr}`;
      list.appendChild(row);
    });
  }

  container.appendChild(list);
}
