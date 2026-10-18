/**
 * @file js/ui/toast.js
 * Non-blocking toast notifications with safe textContent rendering.
 */

let region = null;

function ensureToastRegion() {
  if (typeof document === 'undefined') return null;
  if (!region) {
    region = document.getElementById('toast-region');
    if (!region) {
      region = document.createElement('div');
      region.id = 'toast-region';
      region.className = 'toast-Region';
      region.setAttribute('role', 'status');
      region.setAttribute('aria-live', 'polite');
      document.body.appendChild(region);
    }
  }
  return region;
}

/**
 * Displays a temporary toast message.
 * @param {string} message
 * @param {'info'|'success'|'error'} [type='info']
 * @param {number} [durationMs=3200]
 */
export function showToast(message, type = 'info', durationMs = 3200) {
  const container = ensureToastRegion();
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'toast anim-fade-in';
  if (type === 'error') {
    toast.style.borderColor = 'var(--status-invalid)';
  } else if (type === 'success') {
    toast.style.borderColor = 'var(--status-valid)';
  }

  const textSpan = document.createElement('span');
  textSpan.textContent = String(message);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'btn btn--sm btn--secondary';
  closeBtn.textContent = 'Dismiss';
  closeBtn.setAttribute('aria-label', 'Dismiss notification');
  closeBtn.addEventListener('click', () => toast.remove());

  toast.appendChild(textSpan);
  toast.appendChild(closeBtn);
  container.appendChild(toast);

  setTimeout(() => {
    if (toast.isConnected) {
      toast.remove();
    }
  }, durationMs);
}
