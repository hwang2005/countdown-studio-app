import 'dotenv/config';
import http from 'http';
import express, { Request, Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import pg, { Pool, PoolClient } from 'pg';
const { types } = pg;

// Keep BIGINT values as numbers because the application uses numeric user IDs.
types.setTypeParser(20, (value) => Number(value));

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

type AppRole = 'individual' | 'organization' | 'admin';
type AuthUser = { id: number; publicId: string; username: string; email: string; displayName: string; role: AppRole; permissions: string[] };

let dbPool: Pool | null = null;
function getDbPool(): Pool {
  if (!dbPool) {
    const connectionString = process.env.DATABASE_URL;
    const ssl = process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false };
    dbPool = connectionString
      ? new Pool({ connectionString, ssl, max: 10 })
      : new Pool({
          host: process.env.DB_HOST || '127.0.0.1',
          port: Number(process.env.DB_PORT) || 5432,
          database: process.env.DB_NAME,
          user: process.env.DB_USER,
          password: process.env.DB_PASSWORD,
          ssl,
          max: 10,
        });
  }
  return dbPool;
}

const ROLE_PERMISSIONS: Record<AppRole, string[]> = {
  individual: ['solo:practice'],
  organization: ['stage:display', 'host:operations'],
  admin: ['solo:practice', 'stage:display', 'host:operations', 'user:manage', 'role:manage'],
};
const TOKEN_TTL_SECONDS = readPositiveInteger(process.env.AUTH_TOKEN_TTL_SECONDS, 60 * 60 * 24 * 7);

function encodeTokenPart(value: string): string { return Buffer.from(value).toString('base64url'); }
function signSession(user: AuthUser): string {
  const payload = encodeTokenPart(JSON.stringify({ sub: user.id, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS }));
  const secret = process.env.AUTH_TOKEN_SECRET || process.env.SESSION_SECRET;
  if (!secret) throw new Error('AUTH_TOKEN_SECRET is not configured.');
  return `${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('base64url')}`;
}
function readSessionToken(token: string): { sub: number; exp: number } | null {
  try {
    const [payload, signature] = token.split('.');
    const secret = process.env.AUTH_TOKEN_SECRET || process.env.SESSION_SECRET;
    if (!payload || !signature || !secret || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(crypto.createHmac('sha256', secret).update(payload).digest('base64url')))) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { sub: number; exp: number };
    return data.exp > Math.floor(Date.now() / 1000) ? data : null;
  } catch { return null; }
}
function hashPassword(password: string, salt = crypto.randomBytes(16).toString('hex')) {
  return `scrypt$${salt}$${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}
function verifyPassword(password: string, stored: string): boolean {
  try { const [, salt, hash] = stored.split('$'); const actual = crypto.scryptSync(password, salt, 64); return crypto.timingSafeEqual(actual, Buffer.from(hash, 'hex')); } catch { return false; }
}
function publicUser(user: AuthUser) { return { id: user.publicId, username: user.username, email: user.email, displayName: user.displayName, role: user.role, permissions: user.permissions }; }
async function loadUser(userId: number): Promise<AuthUser | null> {
  const { rows } = await getDbPool().query<any>(`SELECT u.id, u.public_id, u.username, e.email, p.display_name, r.code role
    FROM users u JOIN user_emails e ON e.user_id=u.id AND e.is_primary=TRUE JOIN user_profiles p ON p.user_id=u.id
    JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id
    JOIN user_statuses s ON s.id=u.status_id AND s.code='active' WHERE u.id=$1 AND (ur.expires_at IS NULL OR ur.expires_at>NOW())`, [userId]);
  const row = rows[0]; if (!row || !['individual', 'organization', 'admin'].includes(row.role)) return null;
  const role = row.role as AppRole; return { id: row.id, publicId: row.public_id, username: row.username, email: row.email, displayName: row.display_name, role, permissions: ROLE_PERMISSIONS[role] };
}
async function authenticateToken(token: string | undefined): Promise<AuthUser | null> { const session = token ? readSessionToken(token) : null; return session ? loadUser(session.sub) : null; }
function bearer(req: Request): string | undefined { return req.get('Authorization')?.replace(/^Bearer\s+/i, '') || undefined; }
function requirePermission(permission: string) { return async (req: Request, res: Response, next: () => void) => { try { const user = await authenticateToken(bearer(req)); if (!user) return res.status(401).json({ error: 'UNAUTHENTICATED' }); if (!user.permissions.includes(permission)) return res.status(403).json({ error: 'FORBIDDEN' }); (req as any).user = user; next(); } catch { res.status(503).json({ error: 'AUTH_DATABASE_UNAVAILABLE' }); } }; }

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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }

    return next();
  });
  app.use(express.json());

  // Authentication and RBAC API. Organization accounts are provisioned by an
  // administrator; public registration intentionally exposes only Individual
  // and Admin (the latter requires the private bootstrap code).
  app.post('/api/auth/register', async (req: Request, res: Response) => {
    const { username, email, password, displayName, role = 'individual', adminCode } = req.body || {};
    const normalizedRole = String(role).toLowerCase() as AppRole;
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(String(username || '')) || !/^\S+@\S+\.\S+$/.test(String(email || '')) || String(password || '').length < 8 || !String(displayName || '').trim()) {
      return res.status(400).json({ error: 'INVALID_INPUT', message: 'Username, email, display name và mật khẩu tối thiểu 8 ký tự là bắt buộc.' });
    }
    if (normalizedRole !== 'individual' && normalizedRole !== 'admin') return res.status(403).json({ error: 'ROLE_NOT_REGISTERABLE', message: 'Organization chỉ được cấp bởi quản trị viên.' });
    if (normalizedRole === 'admin' && (!process.env.ADMIN_REGISTRATION_CODE || adminCode !== process.env.ADMIN_REGISTRATION_CODE)) return res.status(403).json({ error: 'INVALID_ADMIN_CODE' });
    let connection: PoolClient | undefined;
    try {
      connection = await getDbPool().connect(); await connection.query('BEGIN');
      const publicId = crypto.randomUUID();
      const userResult = await connection.query<{ id: number }>('INSERT INTO users (public_id, username, status_id) SELECT $1::uuid, $2, id FROM user_statuses WHERE code=\'active\' RETURNING id', [publicId, String(username).trim()]);
      const userId = userResult.rows[0]?.id;
      if (!userId) throw new Error('Active user status is missing.');
      await connection.query('INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)', [userId, hashPassword(String(password))]);
      await connection.query('INSERT INTO user_emails (user_id, email, is_primary, verified_at) VALUES ($1, LOWER($2), TRUE, NOW())', [userId, String(email).trim()]);
      await connection.query('INSERT INTO user_profiles (user_id, display_name) VALUES ($1, $2)', [userId, String(displayName).trim()]);
      await connection.query('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code=$2', [userId, normalizedRole]);
      await connection.query('COMMIT');
      const user = await loadUser(userId); if (!user) throw new Error('Created user could not be loaded.');
      return res.status(201).json({ user: publicUser(user), token: signSession(user) });
    } catch (error: any) { if (connection) await connection.query('ROLLBACK'); const duplicate = error?.code === '23505'; return res.status(duplicate ? 409 : 503).json({ error: duplicate ? 'ACCOUNT_EXISTS' : 'AUTH_DATABASE_UNAVAILABLE', message: duplicate ? 'Username hoặc email đã tồn tại.' : 'Không thể kết nối cơ sở dữ liệu.' }); }
    finally { connection?.release(); }
  });

  app.post('/api/auth/login', async (req: Request, res: Response) => {
    const identifier = String(req.body?.identifier || '').trim(); const password = String(req.body?.password || '');
    if (!identifier || !password) return res.status(400).json({ error: 'INVALID_INPUT' });
    try {
      const { rows } = await getDbPool().query<any>(`SELECT u.id, c.password_hash FROM users u JOIN user_credentials c ON c.user_id=u.id
        JOIN user_emails e ON e.user_id=u.id AND e.is_primary=TRUE
        WHERE LOWER(u.username)=LOWER($1) OR LOWER(e.email)=LOWER($2) LIMIT 1`, [identifier, identifier]);
      if (!rows[0] || !verifyPassword(password, rows[0].password_hash)) return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Thông tin đăng nhập không đúng.' });
      const user = await loadUser(rows[0].id); if (!user) return res.status(403).json({ error: 'ACCOUNT_INACTIVE_OR_ROLE_INVALID' });
      await getDbPool().query('UPDATE user_credentials SET last_login_at=NOW(), failed_attempts=0 WHERE user_id=$1', [user.id]);
      return res.json({ user: publicUser(user), token: signSession(user) });
    } catch (error) {
      console.error('[Auth] Login failed:', error);
      return res.status(503).json({ error: 'AUTH_DATABASE_UNAVAILABLE', message: 'Không thể kết nối cơ sở dữ liệu.' });
    }
  });
  app.get('/api/auth/me', async (req: Request, res: Response) => { try { const user = await authenticateToken(bearer(req)); if (!user) return res.status(401).json({ error: 'UNAUTHENTICATED' }); return res.json({ user: publicUser(user) }); } catch { return res.status(503).json({ error: 'AUTH_DATABASE_UNAVAILABLE' }); } });
  app.get('/api/auth/config', (_req, res) => res.json({ adminRegistrationEnabled: Boolean(process.env.ADMIN_REGISTRATION_CODE) }));

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
    let clientUser: AuthUser | null = null;

    ws.on('message', async (raw) => {
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
          clientUser = await authenticateToken(String(msg.authToken || ''));
          if (!clientUser || !clientUser.permissions.includes('host:operations')) {
            sendError(ws, 'FORBIDDEN', 'Tài khoản cần quyền Organization hoặc Admin để vận hành Host.');
            return;
          }
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
          clientUser = await authenticateToken(String(msg.authToken || ''));
          if (!clientUser || !clientUser.permissions.includes('stage:display')) {
            sendError(ws, 'FORBIDDEN', 'Tài khoản cần quyền Organization hoặc Admin để dùng Stage Display.');
            return;
          }
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
