/**
 * @file js/ui/tiles.js
 * Renders 3D beveled studio tiles for Letters, Numbers, and Conundrum rounds.
 * Supports screen-reader-friendly ARIA labels ("Letter R, tile 3 of 9"),
 * click-to-select in Solo mode, and pointer-based drag/tap reordering in Conundrum mode.
 */

/**
 * Renders a row of 9 Letter tiles (or Conundrum tiles).
 *
 * @param {HTMLElement} container
 * @param {string[]} letters Array of up to 9 letters
 * @param {object} [options]
 * @param {number[]} [options.usedIndices=[]] Indices of tiles currently consumed in word tray
 * @param {boolean} [options.isConundrum=false]
 * @param {boolean} [options.interactive=false]
 * @param {(index: number, letter: string) => void} [options.onTileClick]
 * @param {(newOrder: string[]) => void} [options.onReorder] Enables drag/swap reordering
 */
export function renderLetterTiles(container, letters = [], options = {}) {
  if (!container) return;
  const {
    usedIndices = [],
    isConundrum = false,
    interactive = false,
    onTileClick = null,
    onReorder = null,
    noAnim = false
  } = options;

  const usedSet = new Set(usedIndices);
  container.innerHTML = '';
  container.className = 'tile-row';
  container.setAttribute('role', 'group');
  container.setAttribute(
    'aria-label',
    isConundrum ? 'Conundrum 9-letter anagram tiles' : '9 drawn letter tiles'
  );

  let dragStartIdx = null;

  for (let i = 0; i < 9; i++) {
    const ch = letters[i] ? String(letters[i]).toUpperCase() : '';
    const isRevealed = Boolean(ch);
    const isUsed = usedSet.has(i);

    const tileEl = document.createElement(interactive && isRevealed ? 'button' : 'div');
    if (tileEl.tagName === 'BUTTON') {
      tileEl.type = 'button';
      tileEl.disabled = isUsed;
    }

    const classes = ['tile'];
    if (isConundrum) classes.push('tile--conundrum');
    if (interactive && isRevealed) classes.push('tile--interactive');
    if (isUsed) classes.push('tile--used');
    if (isRevealed) {
      classes.push('is-revealed');
      if (!noAnim) {
        classes.push('anim-flip-in');
        tileEl.style.animationDelay = `${i * 35}ms`;
      }
    } else {
      classes.push('is-unrevealed');
    }
    tileEl.className = classes.join(' ');

    tileEl.setAttribute(
      'aria-label',
      isRevealed
        ? `Letter ${ch}, tile ${i + 1} of 9${isUsed ? ', used' : ''}`
        : `Empty tile ${i + 1} of 9`
    );

    const backFace = document.createElement('div');
    backFace.className = 'tile__face tile__face--back';
    backFace.textContent = String(i + 1);

    const frontFace = document.createElement('div');
    frontFace.className = 'tile__face tile__face--front';
    frontFace.textContent = ch;

    tileEl.appendChild(backFace);
    tileEl.appendChild(frontFace);

    if (interactive && isRevealed && onTileClick) {
      tileEl.addEventListener('click', () => {
        if (!isUsed) onTileClick(i, ch);
      });
    }

    // Pointer-friendly drag/tap swap for Conundrum tiles
    if (isRevealed && typeof onReorder === 'function') {
      tileEl.draggable = true;
      tileEl.style.cursor = 'grab';
      tileEl.addEventListener('dragstart', (e) => {
        dragStartIdx = i;
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
        }
      });
      tileEl.addEventListener('dragover', (e) => {
        e.preventDefault();
      });
      tileEl.addEventListener('drop', (e) => {
        e.preventDefault();
        if (dragStartIdx !== null && dragStartIdx !== i) {
          const next = [...letters];
          const tmp = next[dragStartIdx];
          next[dragStartIdx] = next[i];
          next[i] = tmp;
          dragStartIdx = null;
          onReorder(next);
        }
      });
    }

    container.appendChild(tileEl);
  }
}

/**
 * Renders the 6 Numbers round tiles.
 *
 * @param {HTMLElement} container
 * @param {Array<number|null>} numbers Array of up to 6 numbers
 * @param {object} [options]
 * @param {number|null} [options.selectedIndex=null]
 * @param {number[]} [options.consumedIndices=[]]
 * @param {boolean} [options.interactive=false]
 * @param {(index: number, value: number) => void} [options.onTileClick]
 */
export function renderNumberTiles(container, numbers = [], options = {}) {
  if (!container) return;
  const {
    selectedIndex = null,
    consumedIndices = [],
    interactive = false,
    onTileClick = null,
    noAnim = false
  } = options;

  const consumedSet = new Set(consumedIndices);
  container.innerHTML = '';
  container.className = 'tile-row tile-row--numbers';
  container.setAttribute('role', 'group');
  container.setAttribute('aria-label', '6 drawn number tiles');

  const count = Math.max(6, numbers.length);
  for (let i = 0; i < count; i++) {
    const val = numbers[i];
    const hasVal = val !== undefined && val !== null;
    const isConsumed = consumedSet.has(i);
    const isSelected = selectedIndex === i;

    const tileEl = document.createElement(interactive && hasVal ? 'button' : 'div');
    if (tileEl.tagName === 'BUTTON') {
      tileEl.type = 'button';
      tileEl.disabled = isConsumed;
    }

    const classes = ['tile', 'tile--number'];
    if (interactive && hasVal) classes.push('tile--interactive');
    if (isConsumed) classes.push('tile--used');
    if (hasVal) {
      classes.push('is-revealed');
      if (!noAnim) {
        classes.push('anim-flip-in');
        tileEl.style.animationDelay = `${i * 45}ms`;
      }
    } else {
      classes.push('is-unrevealed');
    }
    tileEl.className = classes.join(' ');

    if (isSelected) {
      tileEl.style.outline = '3px solid var(--accent-primary)';
      tileEl.style.transform = 'translateY(-5px)';
    }

    tileEl.setAttribute(
      'aria-label',
      hasVal
        ? `Number ${val}, tile ${i + 1} of ${count}${isConsumed ? ', used' : ''}`
        : `Empty number tile ${i + 1} of ${count}`
    );

    const backFace = document.createElement('div');
    backFace.className = 'tile__face tile__face--back';
    backFace.textContent = '?';

    const frontFace = document.createElement('div');
    frontFace.className = 'tile__face tile__face--front tabular-nums';
    frontFace.textContent = hasVal ? String(val) : '';

    tileEl.appendChild(backFace);
    tileEl.appendChild(frontFace);

    if (interactive && hasVal && onTileClick) {
      tileEl.addEventListener('click', () => {
        if (!isConsumed) onTileClick(i, Number(val));
      });
    }

    container.appendChild(tileEl);
  }
}

/**
 * Animates a 3-digit "slot machine" roll into `targetEl` before settling on `finalTarget`.
 * Respects `prefers-reduced-motion`.
 *
 * @param {HTMLElement} targetEl
 * @param {number} finalTarget
 * @param {() => void} [onSettled]
 */
export function animateTargetSlotRoll(targetEl, finalTarget, onSettled) {
  if (!targetEl) return;
  const reducedMotion =
    window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
    document.documentElement.getAttribute('data-reduced-motion') === 'true';

  if (reducedMotion) {
    targetEl.textContent = String(finalTarget);
    if (onSettled) onSettled();
    return;
  }

  const duration = 650;
  const start = performance.now();

  const frame = (now) => {
    const elapsed = now - start;
    if (elapsed >= duration) {
      targetEl.textContent = String(finalTarget);
      if (onSettled) onSettled();
      return;
    }
    const random3Digit = Math.floor(101 + Math.random() * 899);
    targetEl.textContent = String(random3Digit);
    requestAnimationFrame(frame);
  };

  requestAnimationFrame(frame);
}
