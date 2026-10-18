/**
 * @file js/core/clock.js
 * High-precision 60fps 30-second Countdown studio clock.
 * Uses requestAnimationFrame and performance.now() / epoch timestamps
 * so it never drifts and survives background tab throttling.
 */

export class CountdownClock {
  /**
   * @param {object} options
   * @param {number} [options.durationSeconds=30]
   * @param {(remainingMs: number, elapsedSeconds: number) => void} [options.onTick]
   * @param {() => void} [options.onComplete]
   */
  constructor({ durationSeconds = 30, onTick, onComplete } = {}) {
    this.durationMs = durationSeconds * 1000;
    this.remainingMs = this.durationMs;
    this.running = false;
    this.rafId = null;
    this.startPerfTime = 0;
    this.elapsedBeforePauseMs = 0;
    this.onTick = onTick || (() => {});
    this.onComplete = onComplete || (() => {});
    this.lastAnnouncedSecond = -1;
  }

  /**
   * Sets total clock duration in seconds and resets remaining time.
   * @param {number} seconds
   */
  setDuration(seconds) {
    this.pause();
    this.durationMs = Math.max(0, Number(seconds) || 0) * 1000;
    this.remainingMs = this.durationMs;
    this.elapsedBeforePauseMs = 0;
    this.lastAnnouncedSecond = -1;
    this.onTick(this.remainingMs, 0);
  }

  /**
   * Starts or resumes the countdown clock.
   * @param {number} [fromRemainingMs] Optional override when recovering state
   */
  start(fromRemainingMs) {
    if (typeof fromRemainingMs === 'number') {
      this.remainingMs = Math.max(0, Math.min(this.durationMs, fromRemainingMs));
      this.elapsedBeforePauseMs = this.durationMs - this.remainingMs;
    }
    if (this.durationMs <= 0) return; // Untimed mode
    if (this.running) return;
    if (this.remainingMs <= 0) {
      this.remainingMs = this.durationMs;
      this.elapsedBeforePauseMs = 0;
    }

    this.running = true;
    this.startPerfTime = performance.now();

    const loop = (now) => {
      if (!this.running) return;
      const totalElapsed = this.elapsedBeforePauseMs + (now - this.startPerfTime);
      this.remainingMs = Math.max(0, this.durationMs - totalElapsed);
      const elapsedSeconds = Math.min(
        Math.floor(this.durationMs / 1000),
        Math.floor(totalElapsed / 1000)
      );

      this.onTick(this.remainingMs, elapsedSeconds);

      if (this.remainingMs <= 0) {
        this.running = false;
        this.remainingMs = 0;
        this.onTick(0, Math.floor(this.durationMs / 1000));
        this.onComplete();
        return;
      }

      this.rafId = requestAnimationFrame(loop);
    };

    this.rafId = requestAnimationFrame(loop);
  }

  /**
   * Pauses the clock at its exact millisecond position.
   */
  pause() {
    if (!this.running) return;
    this.running = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.elapsedBeforePauseMs = this.durationMs - this.remainingMs;
  }

  /**
   * Resets the clock back to full duration.
   */
  reset() {
    this.pause();
    this.remainingMs = this.durationMs;
    this.elapsedBeforePauseMs = 0;
    this.lastAnnouncedSecond = -1;
    this.onTick(this.remainingMs, 0);
  }
}

/**
 * Renders the iconic circular Countdown studio clock SVG into a container,
 * or updates the existing SVG nodes in-place for zero layout thrash at 60fps.
 * @param {HTMLElement} container
 * @param {number} remainingMs
 * @param {number} [durationMs=30000]
 * @param {object} [options]
 * @param {boolean} [options.handsOnly=false] If true, renders transparent dial so the hand sweeps directly over a background image clock
 * @param {boolean} [options.showDigital=true] Whether to show the digital timer readout below the clock
 */
export function renderClockWidget(container, remainingMs, durationMs = 30000, options = {}) {
  if (!container) return;

  const { handsOnly = false, showDigital = true } = options;
  const modeKey = `${handsOnly ? 'hands' : 'full'}-${showDigital ? 'dig' : 'nodig'}`;

  const totalSec = durationMs > 0 ? durationMs / 1000 : 30;
  const clampedRem = Math.max(0, Math.min(durationMs || 30000, remainingMs));
  const elapsedMs = (durationMs || 30000) - clampedRem;
  // Classic British TV Countdown clock: 30s sweeps 180 degrees (from 12 o'clock top to 6 o'clock bottom)
  const progress = durationMs > 0 ? elapsedMs / durationMs : 0;
  const angleDeg = progress * 180;
  const angleRad = ((angleDeg - 90) * Math.PI) / 180;

  let svg = container.querySelector('.clock-svg');
  if (!svg || container.dataset.clockMode !== modeKey) {
    container.dataset.clockMode = modeKey;
    let pipsHtml = '';
    for (let i = 0; i < 60; i++) {
      const a = (i * 6 - 90) * (Math.PI / 180);
      const isMajor = i % 5 === 0;
      const r1 = isMajor ? 100 : 105;
      const r2 = 114;
      const x1 = (130 + r1 * Math.cos(a)).toFixed(2);
      const y1 = (130 + r1 * Math.sin(a)).toFixed(2);
      const x2 = (130 + r2 * Math.cos(a)).toFixed(2);
      const y2 = (130 + r2 * Math.sin(a)).toFixed(2);
      // Warm glowing studio bulbs along the perimeter
      const pipColor = handsOnly
        ? isMajor
          ? 'rgba(254, 240, 138, 0.9)'
          : 'rgba(148, 163, 184, 0.55)'
        : isMajor
          ? '#0F172A'
          : '#64748B';
      pipsHtml += `<line class="clock-pip" data-pip-index="${i}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${pipColor}" stroke-width="${
        isMajor ? '3.6' : '1.9'
      }" stroke-linecap="round"/>`;
    }

    const dialMarkup = handsOnly
      ? `
          <!-- Transparent Dial Mode: runs directly inside the background photo's clock face -->
          <circle cx="130" cy="130" r="118" fill="transparent" stroke="rgba(245, 158, 11, 0.35)" stroke-width="2"/>
        `
      : `
          <!-- Studio Clock Bezel & Cream Dial integrated with Background Housing -->
          <circle cx="130" cy="130" r="124" fill="#0F172A" stroke="#F59E0B" stroke-width="6"/>
          <circle cx="130" cy="130" r="118" fill="url(#clockFaceGrad)" stroke="#1E3A8A" stroke-width="4"/>
          <line x1="130" y1="14" x2="130" y2="246" stroke="#94A3B8" stroke-width="2"/>
          <line x1="14" y1="130" x2="246" y2="130" stroke="#94A3B8" stroke-width="2"/>
        `;

    container.innerHTML = `
      <div class="clock-widget ${handsOnly ? 'clock-widget--hands-only' : ''}">
        <svg class="clock-svg" viewBox="0 0 260 260" role="img" aria-label="Countdown 30 second studio clock">
          <defs>
            <radialGradient id="clockFaceGrad" cx="50%" cy="45%" r="55%">
              <stop offset="0%" stop-color="#FFFFFF"/>
              <stop offset="85%" stop-color="#F1F5F9"/>
              <stop offset="100%" stop-color="#CBD5E1"/>
            </radialGradient>
            <radialGradient id="sectorGlow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stop-color="rgba(251, 191, 36, 0.52)"/>
              <stop offset="100%" stop-color="rgba(245, 158, 11, 0.28)"/>
            </radialGradient>
          </defs>
          ${dialMarkup}
          <!-- Illuminated Swept Sector -->
          <path class="clock-sector" d="M130,130 L130,16 A114,114 0 0,1 130,16 Z" fill="url(#sectorGlow)"/>
          <!-- 60 Perimeter Pips -->
          <g>${pipsHtml}</g>
          <!-- Sweeping Clock Hand -->
          <g class="clock-hand-group" transform="rotate(0 130 130)">
            <line x1="130" y1="154" x2="130" y2="20" stroke="#1E3A8A" stroke-width="9" stroke-linecap="round" opacity="0.45"/>
            <line x1="130" y1="152" x2="130" y2="22" stroke="#DC2626" stroke-width="6.5" stroke-linecap="round"/>
            <line x1="130" y1="130" x2="130" y2="32" stroke="#FEF08A" stroke-width="2.4" stroke-linecap="round"/>
          </g>
          <!-- Center Cap -->
          <circle cx="130" cy="130" r="11.5" fill="#0F172A" stroke="#F59E0B" stroke-width="3.8"/>
        </svg>
        ${showDigital ? '<div class="clock-digital tabular-nums">30.0s</div>' : ''}
      </div>
    `;
    svg = container.querySelector('.clock-svg');
  }

  // Update hand rotation & sector path via compositor-friendly attributes
  const handGroup = svg.querySelector('.clock-hand-group');
  if (handGroup) {
    handGroup.setAttribute('transform', `rotate(${angleDeg.toFixed(2)} 130 130)`);
  }

  const sector = svg.querySelector('.clock-sector');
  if (sector) {
    const r = 114;
    const endX = 130 + r * Math.cos(angleRad);
    const endY = 130 + r * Math.sin(angleRad);
    const largeArc = angleDeg > 180 ? 1 : 0;
    if (angleDeg <= 0.2) {
      sector.setAttribute('d', 'M130,130 L130,16 Z');
    } else {
      sector.setAttribute(
        'd',
        `M130,130 L130,16 A${r},${r} 0 ${largeArc},1 ${endX.toFixed(2)},${endY.toFixed(2)} Z`
      );
    }
  }

  const digital = container.querySelector('.clock-digital');
  if (digital) {
    if (durationMs === 0) {
      digital.textContent = 'Untimed';
    } else {
      const sec = (clampedRem / 1000).toFixed(1);
      digital.textContent = `${sec.padStart(4, '0')}s / ${totalSec}s`;
    }
  }
}
