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
const REMOTE_CONNECT_TIMEOUT_MS = 5000;
const REMOTE_RECONNECT_DELAY_MS = 1000;
const MAX_REMOTE_CONNECT_ATTEMPTS = 4;
const STAGE_WS_QUERY_PARAM = 'ws';
const STAGE_WS_GLOBAL_CONFIG = '__COUNTDOWN_STAGE_WS_URL__';
const AUTH_TOKEN_KEY = 'countdown_studio_auth_token_v1';

function getBrowserLocation() {
  return typeof window !== 'undefined' ? window.location : null;
}

function isTrustedWsEndpoint(urlString, pageUrl) {
  if (!urlString) return false;
  try {
    const target = new URL(urlString, pageUrl.href);
    const hostname = target.hostname.toLowerCase();
    if (hostname === pageUrl.hostname.toLowerCase()) return true;
    if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
    if (hostname === 'countdown-studio.id.vn' || hostname === 'www.countdown-studio.id.vn') return true;
    if (hostname === 'countdown-studio-app.onrender.com') return true;
    return false;
  } catch {
    return false;
  }
}

function getConfiguredWebSocketEndpoint(pageUrl) {
  const queryEndpoint = new URLSearchParams(pageUrl.search).get(STAGE_WS_QUERY_PARAM);
  if (queryEndpoint && isTrustedWsEndpoint(queryEndpoint, pageUrl)) {
    return queryEndpoint.trim();
  }

  if (typeof window !== 'undefined') {
    const globalEndpoint = window[STAGE_WS_GLOBAL_CONFIG];
    if (typeof globalEndpoint === 'string' && globalEndpoint.trim() && isTrustedWsEndpoint(globalEndpoint, pageUrl)) {
      return globalEndpoint.trim();
    }
  }

  return '';
}

/**
 * Resolve the WebSocket endpoint for the current deployment.
 *
 * A full-stack deployment serves the endpoint from the same origin at /ws.
 * Static deployments can pass a separate backend endpoint through ?ws=, for
 * example: ?ws=wss%3A%2F%2Fapi.example.com%2Fws. A deployment can also set
 * window.__COUNTDOWN_STAGE_WS_URL__ before the module loads. Supporting both
 * at runtime keeps the frontend deployable without baking an environment-
 * specific URL into the source bundle.
 *
 * @param {Location|URL} [pageLocation]
 * @returns {string}
 */
export function getStageSyncWebSocketUrl(pageLocation = getBrowserLocation()) {
  if (!pageLocation) {
    throw new Error('A browser page URL is required to resolve the WebSocket endpoint.');
  }

  const pageUrl = new URL(pageLocation.href || pageLocation.toString(), pageLocation.origin);
  const configuredEndpoint = getConfiguredWebSocketEndpoint(pageUrl);

  if (configuredEndpoint) {
    const endpoint = new URL(configuredEndpoint, pageUrl.href);
    if (endpoint.protocol === 'http:') endpoint.protocol = 'ws:';
    if (endpoint.protocol === 'https:') endpoint.protocol = 'wss:';
    if (!endpoint.pathname || endpoint.pathname === '/') endpoint.pathname = '/ws';
    return endpoint.toString();
  }

  // The Node server owns /ws at the origin root. Using '/ws' instead of
  // './ws' also works when the static frontend is served from a subpath.
  const endpoint = new URL('/ws', pageUrl.origin);
  endpoint.protocol = pageUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  return endpoint.toString();
}

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
    this.remoteConnectTimeoutTimer = null;
    this.remoteConnectAttempts = 0;
    this.remoteConnectionFailed = false;
    this.lastRemoteError = null;
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
      error: this.lastRemoteError || undefined,
      connectionFailed: this.remoteConnectionFailed,
    });
    return () => this.onStatusChangeCallbacks.delete(callback);
  }

  notifyStatus(extra = {}) {
    const status = {
      connected: this.isRemoteConnected,
      roomId: this.roomId,
      displayCount: this.displayCount,
      roomClosed: this.roomClosed,
      connectionFailed: this.remoteConnectionFailed,
      error: this.lastRemoteError || undefined,
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
    this.remoteConnectionFailed = false;
    this.lastRemoteError = null;
    this.remoteConnectAttempts = 0;

    if (this.remoteReconnectTimer) {
      clearTimeout(this.remoteReconnectTimer);
      this.remoteReconnectTimer = null;
    }
    clearTimeout(this.remoteConnectTimeoutTimer);
    this.remoteConnectTimeoutTimer = null;
    clearInterval(this.heartbeatTimer);

    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }

    this.notifyStatus({ connecting: true, error: undefined });
    this._initWebSocket();
  }

  _initWebSocket() {
    if (typeof window === 'undefined') return;

    const wsUrl = getStageSyncWebSocketUrl();
    this.remoteConnectAttempts += 1;

    try {
      const socket = new WebSocket(wsUrl);
      this.ws = socket;
      const isCurrentSocket = () => this.ws === socket;
      const failConnection = (message) => {
        if (!isCurrentSocket() || this.isRemoteConnected || this.remoteConnectionFailed) return;
        this.lastRemoteError = message;
        clearTimeout(this.remoteConnectTimeoutTimer);
        this.remoteConnectTimeoutTimer = null;
        try { socket.close(); } catch {}
      };

      // A WebSocket can remain in CONNECTING forever behind a proxy or on a
      // static host. Always fail that attempt so the UI can offer a recovery.
      this.remoteConnectTimeoutTimer = setTimeout(() => {
        failConnection('Unable to authenticate room with the server after 5 seconds. Please check the server and /ws endpoint.');
      }, REMOTE_CONNECT_TIMEOUT_MS);

      socket.onopen = () => {
        if (!isCurrentSocket()) return;
        // Authenticate or join
        if (this.role === 'host') {
          socket.send(JSON.stringify({
            type: 'host:auth',
            roomId: this.roomId,
            pin: this.hostPin,
            authToken: localStorage.getItem(AUTH_TOKEN_KEY) || '',
          }));
        } else {
          socket.send(JSON.stringify({
            type: 'display:join',
            roomId: this.roomId,
            authToken: localStorage.getItem(AUTH_TOKEN_KEY) || '',
          }));
        }

        // Start heartbeat ping every 25s
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => {
          if (isCurrentSocket() && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'ping' }));
          }
        }, 25000);
      };

      socket.onmessage = (event) => {
        if (!isCurrentSocket()) return;
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'pong') return;

          if (msg.type === 'host:auth_success') {
            clearTimeout(this.remoteConnectTimeoutTimer);
            this.remoteConnectTimeoutTimer = null;
            this.isRemoteConnected = true;
            this.remoteConnectionFailed = false;
            this.lastRemoteError = null;
            this.remoteConnectAttempts = 0;
            this.hostToken = msg.token;
            this.displayCount = msg.displayCount || 0;
            this.notifyStatus({ isNew: msg.isNew });
            return;
          }

          if (msg.type === 'display:join_success') {
            clearTimeout(this.remoteConnectTimeoutTimer);
            this.remoteConnectTimeoutTimer = null;
            this.isRemoteConnected = true;
            this.remoteConnectionFailed = false;
            this.lastRemoteError = null;
            this.remoteConnectAttempts = 0;
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
            this.lastRemoteError = msg.message || 'Room was closed by the Host.';
            clearTimeout(this.remoteConnectTimeoutTimer);
            this.remoteConnectTimeoutTimer = null;
            clearInterval(this.heartbeatTimer);
            this.notifyStatus({ roomClosed: true, roomId: closedRoomId, error: this.lastRemoteError });
            if (isCurrentSocket()) {
              try { socket.close(); } catch {}
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

          if (msg.type === 'stage:config' && msg.payload) {
            this.handleIncoming({
              type: 'STAGE_CONFIG_SYNC',
              sender: 'host',
              payload: msg.payload,
            });
            return;
          }

          if (msg.type === 'display:buzz' && msg.payload && this.role === 'host') {
            this.handleIncoming({
              type: 'DISPLAY_BUZZ',
              sender: 'display',
              payload: msg.payload,
            });
            return;
          }

          if (msg.type === 'error') {
            if (msg.code === 'ROOM_WAITING') {
              const waitingMessage = msg.message || 'Waiting for Host to reconnect.';
              this.lastRemoteError = null;
              clearTimeout(this.remoteConnectTimeoutTimer);
              this.remoteConnectTimeoutTimer = null;
              this.notifyStatus({ retrying: true, error: waitingMessage });
              try { socket.close(); } catch {}
              this.ws = null;
              return;
            }
            if (msg.code === 'ROOM_NOT_FOUND') {
              this.roomClosed = true;
              this.isRemoteConnected = false;
              this.lastRemoteError = msg.message || 'Room does not exist or has not been opened by the Host.';
              clearTimeout(this.remoteConnectTimeoutTimer);
              this.remoteConnectTimeoutTimer = null;
              this.notifyStatus({ roomClosed: true, error: this.lastRemoteError });
              if (isCurrentSocket()) {
                try { socket.close(); } catch {}
                this.ws = null;
              }
              return;
            }
            this.lastRemoteError = msg.message || 'Server rejected room connection.';
            if (['INVALID_PIN', 'INVALID_ROOM', 'ROOM_OCCUPIED', 'ROOM_FULL', 'UNAUTHORIZED', 'SESSION_EXPIRED'].includes(msg.code)) {
              this.remoteConnectionFailed = true;
              clearTimeout(this.remoteConnectTimeoutTimer);
              this.remoteConnectTimeoutTimer = null;
              this.notifyStatus({ connectionFailed: true, error: this.lastRemoteError });
              try { socket.close(); } catch {}
              this.ws = null;
              return;
            }
            this.notifyStatus({ error: this.lastRemoteError });
          }
        } catch (err) {
          console.error('Error parsing remote message:', err);
        }
      };

      socket.onclose = () => {
        if (!isCurrentSocket()) return;
        this.isRemoteConnected = false;
        this.ws = null;
        clearTimeout(this.remoteConnectTimeoutTimer);
        this.remoteConnectTimeoutTimer = null;
        clearInterval(this.heartbeatTimer);
        if (!this.roomClosed && !this.remoteConnectionFailed && !this.lastRemoteError) {
          this.lastRemoteError = 'Connection to the WebSocket server was closed.';
        }

        // Auto-reconnect if roomId is still configured
        if (this.roomId && !this.roomClosed) {
          if (this.remoteConnectAttempts < MAX_REMOTE_CONNECT_ATTEMPTS) {
            this.notifyStatus({ retrying: true, error: this.lastRemoteError });
            const retryDelay = Math.min(
              8000,
              REMOTE_RECONNECT_DELAY_MS * (2 ** Math.max(0, this.remoteConnectAttempts - 1))
            );
            this.remoteReconnectTimer = setTimeout(() => {
              this.remoteReconnectTimer = null;
              if (this.roomId && !this.remoteConnectionFailed) this._initWebSocket();
            }, retryDelay);
          } else {
            this.remoteConnectionFailed = true;
            this.notifyStatus({ connectionFailed: true, error: this.lastRemoteError });
          }
        } else {
          this.notifyStatus({ error: this.lastRemoteError });
        }
      };

      socket.onerror = () => {
        if (!isCurrentSocket()) return;
        this.isRemoteConnected = false;
        this.lastRemoteError = 'Unable to connect to the WebSocket server.';
        this.notifyStatus({ error: this.lastRemoteError });
      };
    } catch (e) {
      console.error('Failed to instantiate WebSocket:', e);
      this.isRemoteConnected = false;
      this.remoteConnectionFailed = true;
      this.lastRemoteError = `Failed to initialize WebSocket connection: ${String(e)}`;
      this.notifyStatus({ connectionFailed: true, error: this.lastRemoteError });
    }
  }

  disconnectRemote() {
    if (this.remoteReconnectTimer) {
      clearTimeout(this.remoteReconnectTimer);
      this.remoteReconnectTimer = null;
    }
    clearTimeout(this.remoteConnectTimeoutTimer);
    this.remoteConnectTimeoutTimer = null;
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
    this.remoteConnectionFailed = false;
    this.lastRemoteError = null;
    this.remoteConnectAttempts = 0;
    this.notifyStatus({ error: undefined });
  }

  /**
   * Ask the server to permanently close the currently authenticated room.
   * The server sends the acknowledgement/closed event back to this socket;
   * keeping the socket open until that event prevents the close packet from
   * being lost when the browser closes the connection immediately after send.
   * @returns {boolean}
   */
  closeRemoteRoom() {
    if (
      this.role !== 'host' ||
      !this.isRemoteConnected ||
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN ||
      !this.roomId ||
      !this.hostToken
    ) {
      return false;
    }

    this.ws.send(JSON.stringify({
      type: 'host:close_room',
      roomId: this.roomId,
      token: this.hostToken,
    }));
    return true;
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
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.roomId) {
      try {
        if (this.role === 'host' && this.hostToken) {
          if (type === 'STATE_SYNC') {
            this.ws.send(JSON.stringify({
              type: 'host:broadcast',
              roomId: this.roomId,
              token: this.hostToken,
              payload,
            }));
          } else if (type === 'STAGE_LAYOUT_SYNC' || type === 'STAGE_BG_SYNC' || type === 'STAGE_CONTROLS_SYNC') {
            const kind = type === 'STAGE_LAYOUT_SYNC'
              ? 'layout'
              : type === 'STAGE_BG_SYNC'
                ? 'background'
                : 'controls';
            const value = type === 'STAGE_BG_SYNC' ? (payload?.bg || null) : payload;
            this.ws.send(JSON.stringify({
              type: 'host:stage_config',
              roomId: this.roomId,
              token: this.hostToken,
              payload: { kind, value },
            }));
          }
        } else if (this.role === 'display' && type === 'REQUEST_STATE') {
          this.ws.send(JSON.stringify({
            type: 'display:request_state',
            roomId: this.roomId,
          }));
        } else if (this.role === 'display' && type === 'DISPLAY_BUZZ') {
          this.ws.send(JSON.stringify({
            type: 'display:buzz',
            roomId: this.roomId,
            payload: {
              player: Number(payload?.player),
              timestamp: Number(payload?.timestamp) || Date.now(),
            },
          }));
        }
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
