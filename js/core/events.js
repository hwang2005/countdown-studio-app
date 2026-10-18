/**
 * @file js/core/events.js
 * Lightweight pub/sub event bus for decoupled UI, audio, and sync modules.
 */

export class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map();
  }

  /**
   * Subscribe to an event.
   * @param {string} event
   * @param {Function} handler
   * @returns {() => void} Unsubscribe function
   */
  on(event, handler) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(handler);
    return () => this.off(event, handler);
  }

  /**
   * Unsubscribe from an event.
   * @param {string} event
   * @param {Function} handler
   */
  off(event, handler) {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(handler);
    }
  }

  /**
   * Emit an event with payload.
   * @param {string} event
   * @param {any} [payload]
   */
  emit(event, payload) {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const handler of Array.from(set)) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`[EventBus] Error in listener for "${event}":`, err);
      }
    }
  }
}

export const bus = new EventBus();
