/**
 * @file js/net/sync.js
 * Cross-window and Cross-device synchronisation for Live Versus (Stage Mode).
 * Supports:
 * 1. Local Transport: BroadcastChannel API, direct window.postMessage, storage events.
 * 2. Remote Transport: Secure WebSocket connection for cross-machine host & display sync
 *    using Room Code and Host PIN.
 */

import { saveVersusState, loadVersusState } from '../core/storage.js';

const CHANNEL_NAME = 'countdown_studio_stage_sync_v1';
const STORAGE_SIGNAL_KEY = 'countdown_studio_stage_signal_v1';

export class StageSyncChannel {
  /**
   * @param {'host'|'display'} role
   * @param {(message: object) => void} onMessage
   */
  constructor(role, onMessage) {
    this.role = role;
    this.onMessage = onMessage;
    /** @type {BroadcastChannel|null} */
    this.channel = null;
    this.pollTimer = null;
    this.lastObservedStateJson = '';

    // Remote WebSocket state
    this.ws = null;
    this.roomId = null;
    this.hostPin = null;
    this.hostToken = null;
    this.isRemoteConnected = false;
    this.remoteReconnectTimer = null;
    this.heartbeatTimer = null;
    this.onStatusChangeCallbacks = new Set();
    this.displayCount = 0;
    this.roomClosed = false;

    if (typeof BroadcastChannel !== 'undefined') {
      try {
        this.channel = new BroadcastChannel(CHANNEL_NAME);
        this.channel.onmessage = (event) => {
          if (event.data && event.data.sender !== this.role) {
            this.handleIncoming(event.data);
          }
        };
      } catch {
        this.channel = null;
      }
    }

    // Direct window.postMessage listener for iframe or opener parent-child sync
    this.postMessageListener = (event) => {
      const data = event.data;
      if (data && typeof data === 'object' && data.type && data.sender && data.sender !== this.role) {
        this.handleIncoming(data);
      }
    };

    // Storage event fallback for cross-tab communication
    this.storageListener = (event) => {
      if (event.key === STORAGE_SIGNAL_KEY && event.newValue) {
        try {
          const parsed = JSON.parse(event.newValue);
          if (parsed && parsed.sender !== this.role) {
            this.handleIncoming(parsed);
          }
        } catch {
          // Ignore malformed storage payload
        }
      }
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('storage', this.storageListener);
      window.addEventListener('message', this.postMessageListener);

      // In display role, add 350ms localStorage poll check so display is never stale in local mode
      if (this.role === 'display') {
        this.pollTimer = setInterval(() => {
          try {
            // Only fall back to local storage poll if not actively connected to a remote room
            if (!this.roomId) {
              const raw = localStorage.getItem('countdown_studio_versus_state_v1');
              if (raw && raw !== this.lastObservedStateJson) {
                this.lastObservedStateJson = raw;
                const parsed = JSON.parse(raw);
                this.onMessage({ type: 'STATE_SYNC', sender: 'host', payload: parsed });
              }
            }
          } catch {
            // Ignore polling errors
          }
        }, 350);
      }
    }
  }

  /**
   * Register listener for remote status updates (connecting, connected, disconnected, displayCount)
   * @param {(status: { connected: boolean, roomId: string|null, displayCount: number, error?: string }) => void} callback
   */
  onStatusChange(callback) {
    this.onStatusChangeCallbacks.add(callback);
    callback({
      connected: this.isRemoteConnected,
      roomId: this.roomId,
      displayCount: this.displayCount,
    });
    return () => this.onStatusChangeCallbacks.delete(callback);
  }

  notifyStatus(extra = {}) {
    const status = {
      connected: this.isRemoteConnected,
      roomId: this.roomId,
      displayCount: this.displayCount,
      roomClosed: this.roomClosed,
      ...extra,
    };
    for (const cb of this.onStatusChangeCallbacks) {
      try {
        cb(status);
      } catch (e) {
        console.error('Status callback error:', e);
      }
    }
  }

  /**
   * Connect to remote room via WebSocket for cross-machine sync.
   * @param {string} roomId Room Code (e.g. CD-8842)
   * @param {'host'|'display'} role
   * @param {string} [hostPin] Host password/PIN if role is host
   */
  connectRemote(roomId, role = this.role, hostPin = '') {
    if (!roomId) return;
    this.roomId = roomId.toUpperCase().trim();
    this.role = role;
    this.hostPin = hostPin ? String(hostPin).trim() : '';
    this.roomClosed = false;

    if (this.remoteReconnectTimer) {
      clearTimeout(this.remoteReconnectTimer);
      this.remoteReconnectTimer = null;
    }

    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }

    this._initWebSocket();
  }

  _initWebSocket() {
    if (typeof window === 'undefined') return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/ws`;

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        // Authenticate or join
        if (this.role === 'host') {
          this.ws.send(JSON.stringify({
            type: 'host:auth',
            roomId: this.roomId,
            pin: this.hostPin,
          }));
        } else {
          this.ws.send(JSON.stringify({
            type: 'display:join',
            roomId: this.roomId,
          }));
        }

        // Start heartbeat ping every 25s
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, 25000);
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'pong') return;

          if (msg.type === 'host:auth_success') {
            this.isRemoteConnected = true;
            this.hostToken = msg.token;
            this.displayCount = msg.displayCount || 0;
            this.notifyStatus({ isNew: msg.isNew });
            return;
          }

          if (msg.type === 'display:join_success') {
            this.isRemoteConnected = true;
            this.notifyStatus({ hasHost: msg.hasHost });
            return;
          }

          if (msg.type === 'room:display_count') {
            this.displayCount = msg.displayCount || 0;
            this.notifyStatus();
            return;
          }

          if (msg.type === 'room:closed') {
            const closedRoomId = this.roomId;
            this.roomClosed = true;
            this.isRemoteConnected = false;
            clearInterval(this.heartbeatTimer);
            this.notifyStatus({ roomClosed: true, roomId: closedRoomId, error: msg.message || 'Phòng đã được Host đóng.' });
            if (this.ws) {
              try { this.ws.close(); } catch {}
              this.ws = null;
            }
            return;
          }

          if (msg.type === 'stage:sync' && msg.payload) {
            // Received state from Host across the network
            this.handleIncoming({
              type: 'STATE_SYNC',
              sender: 'host',
              payload: msg.payload,
            });
            return;
          }

          if (msg.type === 'error') {
            if (msg.code === 'ROOM_NOT_FOUND') {
              this.roomClosed = true;
              this.isRemoteConnected = false;
              this.notifyStatus({ roomClosed: true, error: msg.message });
              if (this.ws) {
                try { this.ws.close(); } catch {}
                this.ws = null;
              }
              return;
            }
            this.notifyStatus({ error: msg.message });
          }
        } catch (err) {
          console.error('Error parsing remote message:', err);
        }
      };

      this.ws.onclose = () => {
        this.isRemoteConnected = false;
        clearInterval(this.heartbeatTimer);
        this.notifyStatus();

        // Auto-reconnect if roomId is still configured
        if (this.roomId && !this.roomClosed) {
          this.remoteReconnectTimer = setTimeout(() => {
            if (this.roomId) {
              this._initWebSocket();
            }
          }, 3000);
        }
      };

      this.ws.onerror = () => {
        this.isRemoteConnected = false;
        this.notifyStatus({ error: 'Không thể kết nối đến máy chủ WebSocket' });
      };
    } catch (e) {
      console.error('Failed to instantiate WebSocket:', e);
      this.isRemoteConnected = false;
      this.notifyStatus({ error: String(e) });
    }
  }

  disconnectRemote() {
    if (this.remoteReconnectTimer) {
      clearTimeout(this.remoteReconnectTimer);
      this.remoteReconnectTimer = null;
    }
    clearInterval(this.heartbeatTimer);
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this.roomId = null;
    this.hostToken = null;
    this.isRemoteConnected = false;
    this.displayCount = 0;
    this.roomClosed = false;
    this.notifyStatus();
  }

  handleIncoming(packet) {
    if (packet && packet.type === 'STATE_SYNC' && packet.payload) {
      try {
        this.lastObservedStateJson = JSON.stringify(packet.payload);
      } catch {}
    }
    this.onMessage(packet);
  }

  /**
   * Broadcasts full match state from Host to Display.
   * @param {string} type
   * @param {object} payload
   */
  send(type, payload) {
    const packet = {
      type,
      sender: this.role,
      timestamp: Date.now(),
      payload
    };

    if (type === 'STATE_SYNC' && payload) {
      saveVersusState(payload);
      try {
        this.lastObservedStateJson = JSON.stringify(payload);
      } catch {}
    }

    // 1. Local transport (BroadcastChannel)
    if (this.channel) {
      try {
        this.channel.postMessage(packet);
      } catch {
        // Fallback below
      }
    }

    // 2. Local storage transport
    try {
      localStorage.setItem(STORAGE_SIGNAL_KEY, JSON.stringify(packet));
    } catch {
      // Ignore quota errors
    }

    // 3. Direct window postMessage to child iframes, opener, or parent
    if (typeof window !== 'undefined') {
      try {
        if (window.opener && window.opener !== window) {
          window.opener.postMessage(packet, '*');
        }
        if (window.parent && window.parent !== window) {
          window.parent.postMessage(packet, '*');
        }
        const iframes = document.querySelectorAll('iframe');
        iframes.forEach((ifr) => {
          try {
            ifr.contentWindow?.postMessage(packet, '*');
          } catch {}
        });
      } catch {
        // Ignore cross-origin warnings
      }
    }

    // 4. Remote WebSocket broadcast (Host -> Server -> Displays)
    if (this.role === 'host' && this.ws && this.ws.readyState === WebSocket.OPEN && this.hostToken && this.roomId) {
      try {
        this.ws.send(JSON.stringify({
          type: 'host:broadcast',
          roomId: this.roomId,
          token: this.hostToken,
          payload: payload,
        }));
      } catch (err) {
        console.error('Remote broadcast failed:', err);
      }
    }
  }

  /**
   * Requests the latest persisted state on startup or refresh.
   * @returns {object|null}
   */
  recoverPersistedState() {
    return loadVersusState();
  }

  /**
   * Cleans up listeners.
   */
  close() {
    this.disconnectRemote();
    if (this.channel) {
      this.channel.close();
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', this.storageListener);
      window.removeEventListener('message', this.postMessageListener);
    }
  }
}
