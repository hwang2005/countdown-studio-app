/**
 * @file js/core/audio.js
 * Web Audio API sound engine for Countdown Studio.
 *   - 30-second "Think Music" MP3 + final buzzer
 *   - Tile flip / deal click
 *   - Target slot roll ticks
 *   - Contestant buzzer alert
 *   - Valid word chime & Invalid word buzz
 *   - Winner fanfare & studio applause
 */

// Keep the soundtrack in Vite's asset graph. A literal URL to a file under
// assets/ is not copied by Vite during a production build, which made the
// countdown music work locally but return 404 after deployment.
const THINK_MUSIC_URL = new URL('../../assets/countdown-clock-30s.mp3', import.meta.url).href;

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
    this.clockMusicGeneration = 0;
    this.thinkMusic = new Audio(THINK_MUSIC_URL);
    this.thinkMusic.preload = 'auto';
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
    this.thinkMusic.volume = this.muted ? 0 : this.volume;
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
    this.thinkMusic.volume = this.muted ? 0 : this.volume;
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
   * Starts the supplied 30-second studio "think music" once per clock.
   * The elapsed-second callback is retained so the final buzzer remains
   * synchronised with the clock.
   * @param {number} elapsedSeconds Integer 0..30
   * @param {number} totalSeconds Usually 30
   */
  playClockSecond(elapsedSeconds, totalSeconds = 30) {
    if (this.muted) return;

    // A paused clock can emit the same elapsed second when it resumes. In
    // that case the cue is already scheduled, but the soundtrack still needs
    // to be resumed from its current position.
    if (elapsedSeconds === this.lastScheduledSecond) {
      this.resumeClockMusic();
      return;
    }

    this.lastScheduledSecond = elapsedSeconds;
    const generation = this.clockMusicGeneration;

    this.unlock().then((ok) => {
      if (!ok || !this.ctx || generation !== this.clockMusicGeneration) return;
      const remaining = totalSeconds - elapsedSeconds;

      if (remaining <= 0) {
        this.playFinalBuzzer();
        return;
      }

      // Start a new soundtrack at its intended intro offset. When resuming
      // after pause, currentTime is kept intact and is therefore not reset.
      if (this.thinkMusic.currentTime <= 0 || this.thinkMusic.ended) {
        this.thinkMusic.currentTime = 2;
      }
      this.thinkMusic.volume = this.volume;
      this.thinkMusic.play().catch(() => {});
    });
  }

  /**
   * Resets the clock second tracker when clock restarts.
   */
  resetClockTracker() {
    this.lastScheduledSecond = -1;
    this.stopClockMusic();
  }

  /**
   * Stops the countdown music immediately when a round is submitted.
   */
  stopClockMusic() {
    this.clockMusicGeneration += 1;
    this.thinkMusic.pause();
    this.thinkMusic.currentTime = 0;
  }

  /**
   * Pauses the countdown soundtrack without resetting its playback position.
   * Used when the clock is paused so resume can continue at the same point.
   */
  pauseClockMusic() {
    this.clockMusicGeneration += 1;
    this.lastScheduledSecond = -1;
    this.thinkMusic.pause();
  }

  /**
   * Resumes the countdown soundtrack from its current playback position.
   * A fresh clock is started by playClockSecond(), so this is intentionally a
   * no-op until the track has a saved position.
   */
  resumeClockMusic() {
    if (this.muted || this.thinkMusic.currentTime <= 0 || this.thinkMusic.ended) return;
    this.thinkMusic.volume = this.volume;
    this.thinkMusic.play().catch(() => {});
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
