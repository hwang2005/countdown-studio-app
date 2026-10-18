/**
 * @file js/core/audio.js
 * Synthesised Web Audio API sound engine for Countdown Studio.
 * 100% original procedural synthesis:
 *   - 30-second "Think Music" (woodwind/marimba motif + bass pulse + final ticking + brass buzzer)
 *   - Tile flip / deal click
 *   - Target slot roll ticks
 *   - Contestant buzzer alert
 *   - Valid word chime & Invalid word buzz
 *   - Winner fanfare & studio applause
 */

class StudioAudioEngine {
  constructor() {
    /** @type {AudioContext|null} */
    this.ctx = null;
    /** @type {GainNode|null} */
    this.masterGain = null;
    this.muted = false;
    this.volume = 0.75;
    this.unlocked = false;
    this.lastScheduledSecond = -1;
  }

  /**
   * Initialises and unlocks the Web Audio API context on user interaction.
   * @returns {Promise<boolean>}
   */
  async unlock() {
    try {
      if (!this.ctx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return false;
        this.ctx = new AudioCtx();
        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.value = this.muted ? 0 : this.volume;
        this.masterGain.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') {
        await this.ctx.resume();
      }
      this.unlocked = true;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Sets mute state.
   * @param {boolean} muted
   */
  setMuted(muted) {
    this.muted = Boolean(muted);
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(
        this.muted ? 0 : this.volume,
        this.ctx.currentTime,
        0.02
      );
    }
  }

  /**
   * Sets master volume [0..1].
   * @param {number} vol
   */
  setVolume(vol) {
    this.volume = Math.max(0, Math.min(1, Number(vol) || 0));
    if (this.masterGain && this.ctx && !this.muted) {
      this.masterGain.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
    }
  }

  /**
   * Plays a crisp mechanical tile flip / deal sound.
   */
  playTileFlip() {
    if (this.muted) return;
    this.unlock().then((ok) => {
      if (!ok || !this.ctx) return;
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(520, now);
      osc.frequency.exponentialRampToValueAtTime(980, now + 0.045);
      gain.gain.setValueAtTime(0.22, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.055);
      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(now);
      osc.stop(now + 0.06);
    });
  }

  /**
   * Plays a subtle tick for every elapsed second of the 30s clock,
   * plus the original synthesised studio "think music" motif.
   * @param {number} elapsedSeconds Integer 0..30
   * @param {number} totalSeconds Usually 30
   */
  playClockSecond(elapsedSeconds, totalSeconds = 30) {
    if (this.muted || elapsedSeconds === this.lastScheduledSecond) return;
    this.lastScheduledSecond = elapsedSeconds;

    this.unlock().then((ok) => {
      if (!ok || !this.ctx) return;
      const now = this.ctx.currentTime;
      const remaining = totalSeconds - elapsedSeconds;

      if (remaining <= 0) {
        this.playFinalBuzzer();
        return;
      }

      // 1. Crisp studio clock tick (higher pitch on even seconds, deeper on odd)
      const tickOsc = this.ctx.createOscillator();
      const tickGain = this.ctx.createGain();
      tickOsc.type = 'sine';
      const isFinalTen = remaining <= 10;
      tickOsc.frequency.setValueAtTime(
        elapsedSeconds % 2 === 0 ? (isFinalTen ? 1180 : 880) : (isFinalTen ? 980 : 660),
        now
      );
      tickGain.gain.setValueAtTime(isFinalTen ? 0.25 : 0.14, now);
      tickGain.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
      tickOsc.connect(tickGain);
      tickGain.connect(this.masterGain);
      tickOsc.start(now);
      tickOsc.stop(now + 0.08);

      // 2. Original procedural "think music" arpeggio motif
      // 4-bar phrase cycling through Fmaj7 -> Em7 -> Dm7 -> G7 -> Cmaj9
      const motifNotes = [
        [523.25, 659.25], // C5, E5
        [587.33, 698.46], // D5, F5
        [659.25, 783.99], // E5, G5
        [587.33, 783.99], // D5, G5
        [523.25, 659.25], // C5, E5
        [493.88, 587.33], // B4, D5
        [440.00, 523.25], // A4, C5
        [392.00, 493.88]  // G4, B4
      ];
      const pair = motifNotes[elapsedSeconds % motifNotes.length];

      pair.forEach((freq, idx) => {
        const noteOsc = this.ctx.createOscillator();
        const noteGain = this.ctx.createGain();
        noteOsc.type = isFinalTen ? 'sawtooth' : 'triangle';
        const start = now + idx * 0.42;
        noteOsc.frequency.setValueAtTime(freq, start);
        noteGain.gain.setValueAtTime(isFinalTen ? 0.11 : 0.09, start);
        noteGain.gain.exponentialRampToValueAtTime(0.001, start + 0.36);
        noteOsc.connect(noteGain);
        noteGain.connect(this.masterGain);
        noteOsc.start(start);
        noteOsc.stop(start + 0.38);
      });

      // 3. Warm bass pulse on final 10 seconds
      if (isFinalTen) {
        const bassOsc = this.ctx.createOscillator();
        const bassGain = this.ctx.createGain();
        bassOsc.type = 'triangle';
        bassOsc.frequency.setValueAtTime(remaining <= 5 ? 146.83 : 130.81, now);
        bassGain.gain.setValueAtTime(0.22, now);
        bassGain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
        bassOsc.connect(bassGain);
        bassGain.connect(this.masterGain);
        bassOsc.start(now);
        bassOsc.stop(now + 0.48);
      }
    });
  }

  /**
   * Resets the clock second tracker when clock restarts.
   */
  resetClockTracker() {
    this.lastScheduledSecond = -1;
  }

  /**
   * Plays the authoritative studio final chord/buzzer at 00.0s.
   */
  playFinalBuzzer() {
    if (this.muted) return;
    this.unlock().then((ok) => {
      if (!ok || !this.ctx) return;
      const now = this.ctx.currentTime;
      const freqs = [130.81, 196.0, 261.63, 329.63, 392.0]; // C major studio resolution chord
      freqs.forEach((f) => {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(f, now);
        gain.gain.setValueAtTime(0.14, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 1.15);
        osc.connect(gain);
        gain.connect(this.masterGain);
        osc.start(now);
        osc.stop(now + 1.2);
      });
    });
  }

  /**
   * Plays a sharp contestant Conundrum buzzer sound.
   * @param {number} [player=1] 1 or 2 (distinct pitches so operator can hear who buzzed)
   */
  playContestantBuzz(player = 1) {
    if (this.muted) return;
    this.unlock().then((ok) => {
      if (!ok || !this.ctx) return;
      const now = this.ctx.currentTime;
      const baseFreq = player === 1 ? 440 : 554.37;
      [baseFreq, baseFreq * 1.5].forEach((freq) => {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'square';
        osc.frequency.setValueAtTime(freq, now);
        gain.gain.setValueAtTime(0.18, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
        osc.connect(gain);
        gain.connect(this.masterGain);
        osc.start(now);
        osc.stop(now + 0.38);
      });
    });
  }

  /**
   * Plays a bright chime for a valid answer or points awarded.
   */
  playValidChime() {
    if (this.muted) return;
    this.unlock().then((ok) => {
      if (!ok || !this.ctx) return;
      const now = this.ctx.currentTime;
      [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'triangle';
        const start = now + i * 0.07;
        osc.frequency.setValueAtTime(freq, start);
        gain.gain.setValueAtTime(0.2, start);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.35);
        osc.connect(gain);
        gain.connect(this.masterGain);
        osc.start(start);
        osc.stop(start + 0.38);
      });
    });
  }

  /**
   * Plays a low two-tone buzz for an invalid answer.
   */
  playInvalidBuzz() {
    if (this.muted) return;
    this.unlock().then((ok) => {
      if (!ok || !this.ctx) return;
      const now = this.ctx.currentTime;
      [185, 145].forEach((freq, i) => {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sawtooth';
        const start = now + i * 0.14;
        osc.frequency.setValueAtTime(freq, start);
        gain.gain.setValueAtTime(0.18, start);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.22);
        osc.connect(gain);
        gain.connect(this.masterGain);
        osc.start(start);
        osc.stop(start + 0.25);
      });
    });
  }

  /**
   * Plays celebratory fanfare at end of match or 9-letter word discovery.
   */
  playFanfare() {
    if (this.muted) return;
    this.unlock().then((ok) => {
      if (!ok || !this.ctx) return;
      const now = this.ctx.currentTime;
      const notes = [523.25, 659.25, 783.99, 1046.5, 783.99, 1046.5];
      const times = [0, 0.12, 0.24, 0.38, 0.55, 0.7];
      notes.forEach((freq, i) => {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'triangle';
        const start = now + times[i];
        osc.frequency.setValueAtTime(freq, start);
        gain.gain.setValueAtTime(0.24, start);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.45);
        osc.connect(gain);
        gain.connect(this.masterGain);
        osc.start(start);
        osc.stop(start + 0.48);
      });
    });
  }
}

export const audio = new StudioAudioEngine();
