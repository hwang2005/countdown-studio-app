/**
 * @file js/ui/modal.js
 * Accessible modal dialogs with focus trapping and Escape-to-close support.
 */

/**
 * Opens a modal dialog by ID and traps keyboard focus inside it.
 * @param {string} modalId
 */
export function openModal(modalId) {
  const backdrop = document.getElementById(modalId);
  if (!backdrop) return;
  backdrop.removeAttribute('hidden');
  const firstFocusable = backdrop.querySelector(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  );
  if (firstFocusable instanceof HTMLElement) {
    firstFocusable.focus();
  }
}

/**
 * Closes a modal dialog by ID.
 * @param {string} modalId
 */
export function closeModal(modalId) {
  const backdrop = document.getElementById(modalId);
  if (!backdrop) return;
  backdrop.setAttribute('hidden', '');
}

/**
 * Wires up declarative `[data-modal-open]` and `[data-modal-close]` buttons
 * plus Escape key dismissal.
 */
export function initModalHandlers() {
  document.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;

    const openTrigger = target.closest('[data-modal-open]');
    if (openTrigger) {
      const id = openTrigger.getAttribute('data-modal-open');
      if (id) openModal(id);
      return;
    }

    const closeTrigger = target.closest('[data-modal-close]');
    if (closeTrigger) {
      const id = closeTrigger.getAttribute('data-modal-close');
      if (id) closeModal(id);
      return;
    }

    if (target.classList.contains('modal-backdrop')) {
      target.setAttribute('hidden', '');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-backdrop:not([hidden])').forEach((el) => {
        el.setAttribute('hidden', '');
      });
    }
  });
}
