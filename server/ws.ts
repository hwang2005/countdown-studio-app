import http from 'http';
import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { AuthUser } from './types.js';
import {
  rooms, loadPersistentRoom, persistRoomCreated, persistRoomState, persistRoomDisconnected,
  archiveAndCloseRoom, closeRoomForDisplays, sendError, isPlainObject,
  isValidStageConfigPayload, isValidStatePayload, applyStageConfig,
  ROOM_ID_PATTERN, ROOM_PIN_PATTERN, MAX_WS_MESSAGE_BYTES, MAX_DISPLAYS_PER_ROOM,
} from './rooms.js';
import { hashPassword, verifyPassword, roomPinLockState, recordRoomPinFailure, clearRoomPinFailures } from './security.js';
import { authenticateToken } from './users.js';
import { isAllowedOrigin } from './middleware.js';

type ClientRole = 'host' | 'display' | null;

// WebSocket gateway attached to the same HTTP server on /ws.
export function createWebSocketGateway(server: http.Server): WebSocketServer {
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: 1024 * 1024,
    verifyClient: (info: { origin: string; req: { headers: Record<string, string | string[] | undefined> } }) => {
      const allowed = isAllowedOrigin(info.origin, info.req);
      console.log('[WS verifyClient]', {
        origin: info.origin,
        allowed,
        host: info.req?.headers?.host,
      });
      return allowed;
    },
  });

  wss.on('connection', (ws: WebSocket) => {
    console.log('[WS connection] new client connected');
    let clientRole: ClientRole = null;
    let clientRoomId: string | null = null;
    let clientHostToken: string | null = null;
    let clientUser: AuthUser | null = null;

    ws.on('message', async (raw) => {
      try {
        if (Buffer.byteLength(raw.toString(), 'utf8') > MAX_WS_MESSAGE_BYTES) {
          sendError(ws, 'PAYLOAD_TOO_LARGE', 'WebSocket message exceeds the allowed size.');
          return;
        }
        const msg = JSON.parse(raw.toString());
        const type = msg.type;

        if (type === 'ping') {
          if (clientRoomId) {
            const room = rooms.get(clientRoomId);
            if (room) room.lastActive = Date.now();
          }
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          }
          return;
        }

        // Host authenticates / creates room
        if (type === 'host:auth') {
          clientUser = await authenticateToken(String(msg.authToken || ''));
          if (!clientUser || !clientUser.permissions.includes('host:operations')) {
            sendError(ws, 'FORBIDDEN', 'Account requires Organization or Admin permission to operate Host.');
            return;
          }
          const rawRoomId = String(msg.roomId || '').toUpperCase().trim();
          const pin = String(msg.pin || '').trim();

          if (!ROOM_ID_PATTERN.test(rawRoomId)) {
            sendError(ws, 'INVALID_ROOM', 'Invalid room code.');
            return;
          }
          if (pin && !ROOM_PIN_PATTERN.test(pin)) {
            sendError(ws, 'INVALID_PIN_FORMAT', 'Host PIN must contain 4 to 8 digits.');
            return;
          }

          let room = rooms.get(rawRoomId) || await loadPersistentRoom(rawRoomId);
          if (room && !rooms.has(rawRoomId)) rooms.set(rawRoomId, room);
          if (!room) {
            // A Host PIN is mandatory: without this check a room would be
            // created with the weak default '0000' whenever the field is
            // left empty.
            if (!pin) {
              sendError(ws, 'INVALID_PIN_FORMAT', 'A Host PIN (4 to 8 digits) is required when opening a new room.');
              return;
            }
            // Create new room with the provided PIN
            const token = crypto.randomUUID();
            const openedAt = Date.now();
            room = {
              id: rawRoomId,
              dbId: null,
              hostUserId: clientUser.id,
              pinHash: await hashPassword(pin),
              hostToken: token,
              hostSocket: ws,
              displays: new Set(),
              latestState: null,
              stageConfig: {},
              openedAt,
              lastActive: openedAt,
              hostDisconnectedAt: null,
              persistenceTail: Promise.resolve(),
            };
            rooms.set(rawRoomId, room);
            await persistRoomCreated(room);
            clientRole = 'host';
            clientRoomId = rawRoomId;
            clientHostToken = token;

            ws.send(JSON.stringify({
              type: 'host:auth_success',
              roomId: room.id,
              token,
              displayCount: 0,
              isNew: true,
            }));
          } else {
            // Never let a second active Host silently take over a live room.
            // A reconnect is allowed after the old socket has closed.
            if (room.hostSocket && room.hostSocket !== ws && room.hostSocket.readyState === WebSocket.OPEN) {
              sendError(ws, 'ROOM_OCCUPIED', 'Room is currently controlled by another Host.');
              return;
            }

            // Verify existing PIN without ever storing the PIN in plaintext.
            // The legacy `pin || '0000'` fallback only covers rooms created
            // before PINs became mandatory.
            const pinLock = roomPinLockState(rawRoomId);
            if (pinLock.locked) {
              sendError(ws, 'TOO_MANY_FAILED_ATTEMPTS', `Too many failed Host PIN attempts. This room is locked; try again in ${pinLock.remainingSeconds} second(s).`);
              return;
            }
            if (!(await verifyPassword(pin || '0000', room.pinHash))) {
              const nowLocked = recordRoomPinFailure(rawRoomId);
              if (nowLocked) {
                sendError(ws, 'TOO_MANY_FAILED_ATTEMPTS', 'Too many failed Host PIN attempts. This room is locked for 15 minutes.');
                return;
              }
              ws.send(JSON.stringify({
                type: 'error',
                code: 'INVALID_PIN',
                message: `Incorrect Host password / PIN. ${pinLock.remainingAttempts - 1} attempt(s) remaining.`,
              }));
              return;
            }
            clearRoomPinFailures(rawRoomId);

            // Authentication successful
            const token = crypto.randomUUID();
            room.hostToken = token;
            room.hostSocket = ws;
            room.lastActive = Date.now();
            room.hostDisconnectedAt = null;
            await persistRoomState(room);
            clientRole = 'host';
            clientRoomId = rawRoomId;
            clientHostToken = token;

            ws.send(JSON.stringify({
              type: 'host:auth_success',
              roomId: room.id,
              token,
              displayCount: room.displays.size,
              isNew: false,
            }));
          }
          return;
        }

        // Display connects to watch room (NO password needed, read-only)
        if (type === 'display:join') {
          clientUser = await authenticateToken(String(msg.authToken || ''));
          if (!clientUser || !clientUser.permissions.includes('stage:display')) {
            sendError(ws, 'FORBIDDEN', 'Account requires Organization or Admin permission to use Stage Display.');
            return;
          }
          const rawRoomId = String(msg.roomId || '').toUpperCase().trim();

          if (!ROOM_ID_PATTERN.test(rawRoomId)) {
            sendError(ws, 'INVALID_ROOM', 'Invalid room code.');
            return;
          }

          let room = rooms.get(rawRoomId);

          // A display may only join a room that is currently owned by a host.
          // Never create placeholder rooms from an unauthenticated display.
          if (!room || !room.hostSocket) {
            ws.send(JSON.stringify({
              type: 'error',
              code: room ? 'ROOM_WAITING' : 'ROOM_NOT_FOUND',
              message: room ? 'Room is restoring; waiting for Host to reconnect.' : 'Room does not exist or has not been opened by Host.',
            }));
            return;
          }

          if (room.displays.size >= MAX_DISPLAYS_PER_ROOM) {
            sendError(ws, 'ROOM_FULL', 'Room has reached the maximum display screen limit.');
            return;
          }

          clientRole = 'display';
          clientRoomId = rawRoomId;
          room.displays.add(ws);
          room.lastActive = Date.now();

          // Send confirmation
          ws.send(JSON.stringify({
            type: 'display:join_success',
            roomId: room.id,
            hasHost: !!room.hostSocket,
          }));

          // Send current state immediately if available (initial sync)
          if (room.latestState) {
            ws.send(JSON.stringify({
              type: 'stage:sync',
              sender: 'host',
              payload: room.latestState,
              timestamp: Date.now(),
            }));
          }

          if (Object.keys(room.stageConfig).length > 0) {
            ws.send(JSON.stringify({
              type: 'stage:config',
              sender: 'host',
              payload: room.stageConfig,
              timestamp: Date.now(),
            }));
          }

          // Notify host about new display count
          if (room.hostSocket && room.hostSocket.readyState === WebSocket.OPEN) {
            room.hostSocket.send(JSON.stringify({
              type: 'room:display_count',
              displayCount: room.displays.size,
            }));
          }
          return;
        }

        // Displays may send only contestant buzzer events, request the
        // latest state, or dismiss the panic blank screen. They cannot
        // mutate room state or stage configuration.
        if (type === 'display:buzz' || type === 'display:request_state' || type === 'display:clear_panic') {
          if (clientRole !== 'display' || !clientRoomId) {
            sendError(ws, 'UNAUTHORIZED', 'Only an authenticated Stage Display may send this message.');
            return;
          }
          if (String(msg.roomId || '').toUpperCase().trim() !== clientRoomId) {
            sendError(ws, 'UNAUTHORIZED', 'Room identifier does not match the authenticated Display session.');
            return;
          }
          const room = rooms.get(clientRoomId);
          if (!room || !room.hostSocket || room.hostSocket.readyState !== WebSocket.OPEN) {
            sendError(ws, 'ROOM_NOT_FOUND', 'The Host is no longer connected to this room.');
            return;
          }
          if (type === 'display:buzz') {
            const payload = msg.payload;
            if (!isPlainObject(payload) || ![1, 2].includes(Number(payload.player))) {
              sendError(ws, 'INVALID_PAYLOAD', 'Invalid contestant buzzer payload.');
              return;
            }
            room.hostSocket.send(JSON.stringify({
              type: 'display:buzz',
              sender: 'display',
              payload: { player: Number(payload.player), timestamp: Number(payload.timestamp) || Date.now() },
              timestamp: Date.now(),
            }));
          } else if (type === 'display:clear_panic') {
            // Relay the dismissal to the Host, which owns the authoritative
            // match state. The Host clears panicBlank and rebroadcasts the
            // state so no screen re-renders the blank overlay.
            room.hostSocket.send(JSON.stringify({
              type: 'room:clear_panic',
              sender: 'display',
              timestamp: Date.now(),
            }));
          } else if (room.latestState) {
            ws.send(JSON.stringify({
              type: 'stage:sync',
              sender: 'host',
              payload: room.latestState,
              timestamp: Date.now(),
            }));
          } else {
            // Explicit acknowledgement instead of silence so the Display never
            // assumes an indefinitely pending state request succeeded.
            ws.send(JSON.stringify({
              type: 'stage:empty',
              message: 'The Host has not broadcast any match state yet.',
            }));
          }
          room.lastActive = Date.now();
          return;
        }

        // Only the authenticated Host may publish stage configuration.
        if (type === 'host:stage_config') {
          if (clientRole !== 'host' || !clientRoomId || (!clientHostToken && !String(msg.token || ''))) {
            sendError(ws, 'UNAUTHORIZED', 'Only the authenticated Host may publish stage configuration.');
            return;
          }
          // The socket-bound token is authoritative; the per-message token is
          // accepted as an alternative so a client that sends its stored
          // secret without a live socket token is not silently rejected.
          if (!clientHostToken && String(msg.token || '')) clientHostToken = String(msg.token);
          if (String(msg.roomId || '').toUpperCase().trim() !== clientRoomId) {
            sendError(ws, 'UNAUTHORIZED', 'Room identifier does not match the authenticated Host session.');
            return;
          }
          const room = rooms.get(clientRoomId);
          if (!room || (room.hostToken !== clientHostToken && room.hostToken !== String(msg.token || '')) || room.hostSocket !== ws) {
            sendError(ws, 'SESSION_EXPIRED', 'Host session has expired.');
            return;
          }
          if (!isValidStageConfigPayload(msg.payload)) {
            sendError(ws, 'INVALID_PAYLOAD', 'Invalid stage configuration payload.');
            return;
          }
          applyStageConfig(room, msg.payload);
          room.lastActive = Date.now();
          const packet = JSON.stringify({
            type: 'stage:config',
            sender: 'host',
            payload: msg.payload,
            timestamp: Date.now(),
          });
          for (const displayWs of room.displays) {
            if (displayWs.readyState === WebSocket.OPEN) displayWs.send(packet);
          }
          // Broadcast from in-memory state before awaiting PostgreSQL. The
          // websocket message handler is entered in order, while DB writes
          // may complete out of order under production latency.
          void persistRoomState(room);
          return;
        }

        // Host closes the room permanently. Displays are notified and removed
        // so an old QR/link cannot keep accessing the room afterwards.
        if (type === 'host:close_room') {
          if (clientRole !== 'host' || !clientRoomId || (!clientHostToken && !String(msg.token || ''))) {
            ws.send(JSON.stringify({ type: 'error', code: 'UNAUTHORIZED', message: 'You do not have Host permissions' }));
            return;
          }
          if (!clientHostToken && String(msg.token || '')) clientHostToken = String(msg.token);
          if (String(msg.roomId || '').toUpperCase().trim() !== clientRoomId) {
            sendError(ws, 'UNAUTHORIZED', 'Room identifier does not match the authenticated Host session.');
            return;
          }
          const room = rooms.get(clientRoomId);
          if (!room || (room.hostToken !== clientHostToken && room.hostToken !== String(msg.token || ''))) {
            ws.send(JSON.stringify({ type: 'error', code: 'SESSION_EXPIRED', message: 'Host session has expired' }));
            return;
          }
          closeRoomForDisplays(room, 'Host has closed this room.');
          await archiveAndCloseRoom(room, 'host_closed');
          room.hostSocket = null;
          room.hostDisconnectedAt = null;
          rooms.delete(room.id);
          ws.send(JSON.stringify({ type: 'room:closed', roomId: room.id, message: 'Room closed.' }));
          clientRole = null;
          clientRoomId = null;
          clientHostToken = null;
          return;
        }

        // Host broadcasts state to displays (One-way sync)
        if (type === 'host:broadcast') {
          if (clientRole !== 'host' || !clientRoomId || (!clientHostToken && !String(msg.token || ''))) {
            ws.send(JSON.stringify({ type: 'error', code: 'UNAUTHORIZED', message: 'You do not have Host permissions' }));
            return;
          }
          if (!clientHostToken && String(msg.token || '')) clientHostToken = String(msg.token);
          if (String(msg.roomId || '').toUpperCase().trim() !== clientRoomId) {
            sendError(ws, 'UNAUTHORIZED', 'Room identifier does not match the authenticated Host session.');
            return;
          }
          if (!isValidStatePayload(msg.payload)) {
            sendError(ws, 'INVALID_PAYLOAD', 'State payload does not match the Versus match contract.');
            return;
          }

          const room = rooms.get(clientRoomId);
          if (!room || (room.hostToken !== clientHostToken && room.hostToken !== String(msg.token || ''))) {
            ws.send(JSON.stringify({ type: 'error', code: 'SESSION_EXPIRED', message: 'Host session has expired' }));
            return;
          }

          room.latestState = msg.payload;
          room.lastActive = Date.now();

          // Broadcast to all connected displays in this room
          const syncPacket = JSON.stringify({
            type: 'stage:sync',
            sender: 'host',
            payload: msg.payload,
            timestamp: Date.now(),
          });

          for (const displayWs of room.displays) {
            if (displayWs.readyState === WebSocket.OPEN) {
              displayWs.send(syncPacket);
            }
          }
          // Persistence is deliberately queued after the live broadcast so
          // database latency cannot reorder or stall Host -> Display sync.
          void persistRoomState(room);
          return;
        }
      } catch (err) {
        console.error('Error handling WebSocket message:', err);
      }
    });

    ws.on('close', () => {
      if (clientRole === 'host' && clientRoomId) {
        const room = rooms.get(clientRoomId);
        if (room && room.hostSocket === ws) {
          room.hostSocket = null;
          room.hostDisconnectedAt = Date.now();
          void persistRoomDisconnected(room);
        }
      } else if (clientRole === 'display' && clientRoomId) {
        const room = rooms.get(clientRoomId);
        if (room) {
          room.displays.delete(ws);
          if (room.hostSocket && room.hostSocket.readyState === WebSocket.OPEN) {
            room.hostSocket.send(JSON.stringify({
              type: 'room:display_count',
              displayCount: room.displays.size,
            }));
          }
        }
      }
    });
  });

  return wss;
}
