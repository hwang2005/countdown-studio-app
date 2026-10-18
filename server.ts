import 'dotenv/config';
import http from 'http';
import express, { Request, Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface GameRoom {
  id: string;
  pin: string;
  hostToken: string;
  hostSocket: WebSocket | null;
  displays: Set<WebSocket>;
  latestState: any;
  lastActive: number;
  hostDisconnectedAt: number | null;
}

const rooms = new Map<string, GameRoom>();

const ROOM_ID_PATTERN = /^[A-Z0-9][A-Z0-9-]{2,31}$/;
const ROOM_IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000;
const ORPHANED_ROOM_TIMEOUT_MS = 30 * 1000;
const MAX_DISPLAYS_PER_ROOM = readPositiveInteger(process.env.MAX_DISPLAYS_PER_ROOM, 20);
const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://www.countdown-studio.id.vn',
  'https://www.countdown-studio.id.vn',
  'http://countdown-studio.id.vn',
  'https://countdown-studio.id.vn',
];

const ALLOWED_ORIGINS = new Set([
  ...DEFAULT_ALLOWED_ORIGINS,
  ...(process.env.CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
]);

function isAllowedOrigin(origin: string | undefined): boolean {
  // Non-browser clients do not send an Origin header. Keep those clients
  // compatible while validating every browser-originated request.
  return !origin || ALLOWED_ORIGINS.has(origin);
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getRoomStats() {
  let displayConnections = 0;
  let hostConnections = 0;

  for (const room of rooms.values()) {
    if (room.hostSocket) hostConnections += 1;
    displayConnections += room.displays.size;
  }

  return {
    activeRooms: rooms.size,
    hostConnections,
    displayConnections,
    totalConnections: hostConnections + displayConnections,
    maxDisplaysPerRoom: MAX_DISPLAYS_PER_ROOM,
  };
}

function sendError(ws: WebSocket, code: string, message: string) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'error', code, message }));
  }
}

function closeRoomForDisplays(room: GameRoom, message: string) {
  const closedPacket = JSON.stringify({ type: 'room:closed', roomId: room.id, message });
  for (const displayWs of room.displays) {
    if (displayWs.readyState === WebSocket.OPEN) {
      displayWs.send(closedPacket);
      displayWs.close(1000, 'Room unavailable');
    }
  }
  room.displays.clear();
}

// Clean up inactive and orphaned rooms without affecting other active rooms.
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms.entries()) {
    const orphanedTooLong =
      !room.hostSocket &&
      room.hostDisconnectedAt !== null &&
      now - room.hostDisconnectedAt > ORPHANED_ROOM_TIMEOUT_MS;
    const idleTooLong = now - room.lastActive > ROOM_IDLE_TIMEOUT_MS;

    if (orphanedTooLong || (idleTooLong && !room.hostSocket)) {
      closeRoomForDisplays(room, 'Host đã rời phòng hoặc phòng đã hết hạn.');
      rooms.delete(id);
    }
  }
}, 60 * 1000);

async function startServer() {
  const app = express();

  // CORS is needed by the GitHub Pages/custom-domain frontend when it calls
  // the hosted backend. The same allowlist is applied to WebSocket upgrades
  // below so an arbitrary website cannot open a browser session to this server.
  app.use((req: Request, res: Response, next) => {
    const origin = req.get('Origin');

    if (origin && !isAllowedOrigin(origin)) {
      return res.status(403).json({ error: 'Origin not allowed' });
    }

    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }

    return next();
  });
  app.use(express.json());

  const server = http.createServer(app);

  // REST endpoints for health and room checks
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: Date.now(), ...getRoomStats() });
  });

  app.get('/api/room/:roomId', (req: Request, res: Response) => {
    const roomId = String(req.params.roomId).toUpperCase().trim();
    const room = rooms.get(roomId);
    if (!room) {
      return res.status(404).json({ exists: false, message: 'Phòng không tồn tại' });
    }
    return res.json({
      exists: true,
      roomId: room.id,
      hasHost: !!room.hostSocket,
      displayCount: room.displays.size,
      lastActive: room.lastActive,
      maxDisplays: MAX_DISPLAYS_PER_ROOM,
    });
  });

  // Setup WebSocket Server attached to the same HTTP server on /ws
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: 1024 * 1024,
    verifyClient: (info: { origin: string }) => isAllowedOrigin(info.origin),
  });

  wss.on('connection', (ws: WebSocket) => {
    let clientRole: 'host' | 'display' | null = null;
    let clientRoomId: string | null = null;
    let clientHostToken: string | null = null;

    ws.on('message', (raw) => {
      try {
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
          const rawRoomId = String(msg.roomId || '').toUpperCase().trim();
          const pin = String(msg.pin || '').trim();

          if (!ROOM_ID_PATTERN.test(rawRoomId)) {
            sendError(ws, 'INVALID_ROOM', 'Mã phòng không hợp lệ.');
            return;
          }

          if (!rawRoomId) {
            ws.send(JSON.stringify({ type: 'error', code: 'INVALID_ROOM', message: 'Mã phòng không hợp lệ' }));
            return;
          }

          let room = rooms.get(rawRoomId);
          if (!room) {
            // Create new room with provided PIN (or default 0000)
            const token = crypto.randomUUID();
            room = {
              id: rawRoomId,
              pin: pin || '0000',
              hostToken: token,
              hostSocket: ws,
              displays: new Set(),
              latestState: null,
              lastActive: Date.now(),
              hostDisconnectedAt: null,
            };
            rooms.set(rawRoomId, room);
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
              sendError(ws, 'ROOM_OCCUPIED', 'Phòng đang được điều khiển bởi một Host khác.');
              return;
            }

            // Verify existing PIN
            if (room.pin && room.pin !== pin) {
              ws.send(JSON.stringify({
                type: 'error',
                code: 'INVALID_PIN',
                message: 'Mật khẩu / PIN Host không đúng. Vui lòng kiểm tra lại.',
              }));
              return;
            }

            // Authentication successful
            const token = crypto.randomUUID();
            room.hostToken = token;
            room.hostSocket = ws;
            room.lastActive = Date.now();
            room.hostDisconnectedAt = null;
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
          const rawRoomId = String(msg.roomId || '').toUpperCase().trim();

          if (!ROOM_ID_PATTERN.test(rawRoomId)) {
            sendError(ws, 'INVALID_ROOM', 'Mã phòng không hợp lệ.');
            return;
          }

          let room = rooms.get(rawRoomId);

          // A display may only join a room that is currently owned by a host.
          // Never create placeholder rooms from an unauthenticated display.
          if (!room || !room.hostSocket) {
            ws.send(JSON.stringify({
              type: 'error',
              code: 'ROOM_NOT_FOUND',
              message: 'Phòng không tồn tại hoặc chưa được mở bởi Host.',
            }));
            return;
          }

          if (room.displays.size >= MAX_DISPLAYS_PER_ROOM) {
            sendError(ws, 'ROOM_FULL', 'Phòng đã đạt giới hạn số màn hình trình chiếu.');
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

          // Notify host about new display count
          if (room.hostSocket && room.hostSocket.readyState === WebSocket.OPEN) {
            room.hostSocket.send(JSON.stringify({
              type: 'room:display_count',
              displayCount: room.displays.size,
            }));
          }
          return;
        }

        // Host closes the room permanently. Displays are notified and removed
        // so an old QR/link cannot keep accessing the room afterwards.
        if (type === 'host:close_room') {
          if (clientRole !== 'host' || !clientRoomId || !clientHostToken) {
            ws.send(JSON.stringify({ type: 'error', code: 'UNAUTHORIZED', message: 'Bạn không có quyền Host' }));
            return;
          }
          const room = rooms.get(clientRoomId);
          if (!room || room.hostToken !== clientHostToken || room.hostSocket !== ws) {
            ws.send(JSON.stringify({ type: 'error', code: 'SESSION_EXPIRED', message: 'Phiên Host đã hết hạn' }));
            return;
          }
          closeRoomForDisplays(room, 'Host đã đóng phòng này.');
          room.hostSocket = null;
          room.hostDisconnectedAt = null;
          rooms.delete(room.id);
          ws.send(JSON.stringify({ type: 'room:closed', roomId: room.id, message: 'Đã đóng phòng.' }));
          clientRole = null;
          clientRoomId = null;
          clientHostToken = null;
          return;
        }

        // Host broadcasts state to displays (One-way sync)
        if (type === 'host:broadcast') {
          if (clientRole !== 'host' || !clientRoomId || !clientHostToken) {
            ws.send(JSON.stringify({ type: 'error', code: 'UNAUTHORIZED', message: 'Bạn không có quyền Host' }));
            return;
          }

          const room = rooms.get(clientRoomId);
          if (!room || room.hostToken !== clientHostToken) {
            ws.send(JSON.stringify({ type: 'error', code: 'SESSION_EXPIRED', message: 'Phiên Host đã hết hạn' }));
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

  // Vite middleware in dev or static files in prod
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'mpa',
    });
    app.use(vite.middlewares);
  } else {
    // The compiled server runs from dist-server, while Vite outputs the
    // frontend one directory above it in dist.
    const frontendDistPath = path.resolve(__dirname, '..', 'dist');
    app.use(express.static(frontendDistPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(frontendDistPath, 'index.html'));
    });
  }

  const port = Number(process.env.PORT) || 3000;
  server.listen(port, '0.0.0.0', () => {
    console.log(`[Countdown Studio] Server running at http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
