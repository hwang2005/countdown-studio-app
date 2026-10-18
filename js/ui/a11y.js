/**
 * @file js/ui/a11y.js
 * Accessibility helpers: ARIA live region announcements, SpeechSynthesis reader,
 * Vibration API haptics, and Screen Wake Lock manager.
 */

let politeRegion = null;
let assertiveRegion = null;
let wakeLockSentinel = null;

/**
 * Ensures polite and assertive ARIA live regions exist in the document.
 */
function ensureLiveRegions() {
  if (typeof document === 'undefined') return;
  if (!politeRegion) {
    politeRegion = document.getElementById('a11y-live-polite');
    if (!politeRegion) {
      politeRegion = document.createElement('div');
      politeRegion.id = 'a11y-live-polite';
      politeRegion.className = 'sr-only';
      politeRegion.setAttribute('aria-live', 'polite');
      politeRegion.setAttribute('aria-atomic', 'true');
      document.body.appendChild(politeRegion);
    }
  }
  if (!assertiveRegion) {
    assertiveRegion = document.getElementById('a11y-live-assertive');
    if (!assertiveRegion) {
      assertiveRegion = document.createElement('div');
      assertiveRegion.id = 'a11y-live-assertive';
      assertiveRegion.className = 'sr-only';
      assertiveRegion.setAttribute('aria-live', 'assertive');
      assertiveRegion.setAttribute('aria-atomic', 'true');
      document.body.appendChild(assertiveRegion);
    }
  }
}

/**
 * Announces a message to screen readers via ARIA live region.
 * @param {string} message
 * @param {'polite'|'assertive'} [priority='polite']
 */
export function announce(message, priority = 'polite') {
  ensureLiveRegions();
  const target = priority === 'assertive' ? assertiveRegion : politeRegion;
  if (!target) return;
  target.textContent = '';
  requestAnimationFrame(() => {
    target.textContent = String(message);
  });
}

/**
 * Optionally speaks text aloud using the browser SpeechSynthesis API.
 * @param {string} text
 */
export function speakAloud(text) {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(String(text));
    utter.lang = 'en-GB';
    utter.rate = 1.0;
    window.speechSynthesis.speak(utter);
  } catch {
    // Ignore if speech synthesis is unavailable
  }
}

/**
 * Triggers gentle tactile feedback on supported mobile devices.
 * @param {number|number[]} [pattern=15]
 */
export function haptic(pattern = 15) {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try {
      navigator.vibrate(pattern);
    } catch {
      // Ignore if blocked
    }
  }
}

/**
 * Requests a Screen Wake Lock so the stage projector or solo screen does not sleep mid-match.
 */
export async function requestWakeLock() {
  if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;
  try {
    wakeLockSentinel = await navigator.wakeLock.request('screen');
  } catch {
    // Wake lock can fail if tab is backgrounded or unsupported
  }
}

/**
 * Releases active Screen Wake Lock.
 */
export async function releaseWakeLock() {
  if (wakeLockSentinel) {
    try {
      await wakeLockSentinel.release();
    } catch {
      // Ignore
    }
    wakeLockSentinel = null;
  }
}
