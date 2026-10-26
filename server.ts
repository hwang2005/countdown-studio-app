import 'dotenv/config';
import http from 'http';
import express, { Request, Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import pg, { Pool, PoolClient } from 'pg';
const { types } = pg;

import fs from 'fs';

// Keep BIGINT values as numbers because the application uses numeric user IDs.
types.setTypeParser(20, (value) => Number(value));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = fs.existsSync(path.join(__dirname, 'package.json'))
  ? __dirname
  : path.resolve(__dirname, '..');

interface GameRoom {
  id: string;
  dbId: number | null;
  hostUserId: number;
  pinHash: string;
  hostToken: string;
  hostSocket: WebSocket | null;
  displays: Set<WebSocket>;
  latestState: any;
  stageConfig: {
    layout?: Record<string, unknown>;
    background?: string | null;
    controlsHidden?: boolean;
  };
  openedAt: number;
  lastActive: number;
  hostDisconnectedAt: number | null;
  // PostgreSQL writes must stay ordered. Production latency can otherwise
  // make an older snapshot overwrite a newer one while the room is live.
  persistenceTail: Promise<void>;
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
function scryptAsync(password: string, salt: string, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

const DUMMY_HASH = 'scrypt$00000000000000000000000000000000$00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';

async function hashPassword(password: string, salt = crypto.randomBytes(16).toString('hex')): Promise<string> {
  const derivedKey = await scryptAsync(password, salt, 64);
  return `scrypt$${salt}$${derivedKey.toString('hex')}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [, salt, hash] = stored.split('$');
    if (!salt || !hash) return false;
    const actual = await scryptAsync(password, salt, 64);
    const expected = Buffer.from(hash, 'hex');
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

interface GoogleSetupPayload {
  purpose: 'google_password_setup';
  sub: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  existingUserId: number | null;
  iat: number;
  exp: number;
}

function signGoogleSetupToken(data: Omit<GoogleSetupPayload, 'purpose' | 'iat' | 'exp'>): string {
  const secret = process.env.AUTH_TOKEN_SECRET || process.env.SESSION_SECRET;
  if (!secret) throw new Error('AUTH_TOKEN_SECRET is not configured.');
  const now = Math.floor(Date.now() / 1000);
  const payload: GoogleSetupPayload = {
    ...data,
    purpose: 'google_password_setup',
    iat: now,
    exp: now + 15 * 60, // 15 minutes
  };
  const encoded = encodeTokenPart(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

function readGoogleSetupToken(token: string): GoogleSetupPayload | null {
  try {
    const [payloadPart, signature] = token.split('.');
    const secret = process.env.AUTH_TOKEN_SECRET || process.env.SESSION_SECRET;
    if (!payloadPart || !signature || !secret) return null;
    const expectedSig = crypto.createHmac('sha256', secret).update(payloadPart).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) return null;
    const data = JSON.parse(Buffer.from(payloadPart, 'base64url').toString()) as GoogleSetupPayload;
    if (data.purpose !== 'google_password_setup' || data.exp <= Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

function sanitizeGoogleUsername(raw: string): string {
  let cleaned = raw.replace(/[^a-zA-Z0-9_.-]/g, '_').toLowerCase();
  while (cleaned.length < 3) cleaned += `${crypto.randomInt(1, 9)}`;
  return cleaned.slice(0, 32);
}

async function verifyGoogleIdToken(token: string): Promise<{ sub: string; email: string; name: string; picture?: string } | null> {
  // Only accept a real Google ID token verified by Google's tokeninfo API.
  // Demo tokens and unsigned JWT payloads must never authenticate a user.
  try {
    const url = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok) {
      const data = (await res.json()) as any;
      if (data && data.sub && data.email) {
        const expectedClientId = process.env.GOOGLE_CLIENT_ID;
        if (expectedClientId && data.aud && data.aud !== expectedClientId) {
          console.warn('[Google Auth] Client ID mismatch. Expected:', expectedClientId, 'Got:', data.aud);
          return null;
        }
        return {
          sub: String(data.sub),
          email: String(data.email),
          name: String(data.name || data.email.split('@')[0]),
          picture: data.picture,
        };
      }
    }
  } catch (err) {
    console.warn('[Google Auth] Tokeninfo verification request failed:', err);
  }

  return null;
}

// In-memory IP rate limiter to protect authentication endpoints from brute-force & credential stuffing
interface RateLimitRecord {
  count: number;
  resetAt: number;
}
const rateLimitMap = new Map<string, RateLimitRecord>();

function checkRateLimit(ip: string, action: string, maxAttempts: number, windowMs: number): boolean {
  const key = `${action}:${ip}`;
  const now = Date.now();
  const record = rateLimitMap.get(key);
  if (!record || now > record.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (record.count >= maxAttempts) {
    return false;
  }
  record.count += 1;
  return true;
}

function getClientIp(req: Request): string {
  const forwarded = req.get('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || '127.0.0.1';
}

setInterval(() => {
  const now = Date.now();
  for (const [key, record] of rateLimitMap.entries()) {
    if (now > record.resetAt) {
      rateLimitMap.delete(key);
    }
  }
}, 5 * 60 * 1000);
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
const ROOM_PIN_PATTERN = /^\d{4,8}$/;
const MAX_WS_MESSAGE_BYTES = 900 * 1024;
const MAX_STAGE_BACKGROUND_BYTES = 700 * 1024;
const ROOM_IDLE_TIMEOUT_MS = readPositiveInteger(process.env.ROOM_IDLE_TIMEOUT_MS, 12 * 60 * 60 * 1000);
const ORPHANED_ROOM_TIMEOUT_MS = readPositiveInteger(process.env.ORPHANED_ROOM_TIMEOUT_MS, 30 * 1000);
const MAX_DISPLAYS_PER_ROOM = readPositiveInteger(process.env.MAX_DISPLAYS_PER_ROOM, 20);
const ROOM_PERSISTENCE_ENABLED = Boolean(process.env.DATABASE_URL || process.env.DB_NAME);
const ROOM_SCHEMA_VERSION = 1;
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

function isAllowedOrigin(origin: string | undefined, request?: { headers?: Record<string, string | string[] | undefined> }): boolean {
  // Non-browser clients do not send an Origin header. Keep those clients
  // compatible while validating every browser-originated request.
  if (!origin || ALLOWED_ORIGINS.has(origin)) return true;

  // A same-origin browser request is safe even when the deployment uses a
  // provider hostname that is not known at build time (for example a Render
  // preview/service URL). Compare against the actual Host header supplied by
  // the reverse proxy instead of maintaining a provider-specific allowlist.
  try {
    const hostHeader = request?.headers?.host;
    const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
    if (!host) return false;
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isValidStageConfigPayload(payload: unknown): boolean {
  if (!isPlainObject(payload)) return false;
  const kind = payload.kind;
  if (kind === 'layout') return isPlainObject(payload.value);
  if (kind === 'controls') return isPlainObject(payload.value) && typeof payload.value.hidden === 'boolean';
  if (kind === 'background') {
    return payload.value === null || (
      typeof payload.value === 'string' &&
      payload.value.startsWith('data:image/') &&
      Buffer.byteLength(payload.value, 'utf8') <= MAX_STAGE_BACKGROUND_BYTES
    );
  }
  return false;
}

function isValidStatePayload(payload: unknown): boolean {
  if (!isPlainObject(payload)) return false;
  return typeof payload.matchId === 'string'
    && typeof payload.phase === 'string'
    && Array.isArray(payload.players)
    && payload.players.length === 2
    && Array.isArray(payload.schedule)
    && payload.schedule.length >= 1
    && payload.schedule.length <= 25;
}

function applyStageConfig(room: GameRoom, payload: Record<string, unknown>) {
  const value = payload.value;
  if (payload.kind === 'layout' && isPlainObject(value)) room.stageConfig.layout = value;
  if (payload.kind === 'controls' && isPlainObject(value)) room.stageConfig.controlsHidden = value.hidden as boolean;
  if (payload.kind === 'background') room.stageConfig.background = value as string | null;
}

function roomStageConfigJson(room: GameRoom) {
  return JSON.stringify(room.stageConfig || {});
}

async function persistRoomCreated(room: GameRoom): Promise<void> {
  if (!ROOM_PERSISTENCE_ENABLED) return;
  try {
    const { rows } = await getDbPool().query<{ id: number }>(
      `INSERT INTO versus_rooms
        (room_code, host_user_id, pin_hash, status, latest_state, stage_config, opened_at, last_active_at, updated_at)
       VALUES ($1, $2, $3, 'active', $4::jsonb, $5::jsonb, to_timestamp($6 / 1000.0), to_timestamp($6 / 1000.0), NOW())
       ON CONFLICT (room_code) WHERE status='active' DO UPDATE SET
         host_user_id = EXCLUDED.host_user_id,
         pin_hash = EXCLUDED.pin_hash,
         status = 'active',
         latest_state = COALESCE(EXCLUDED.latest_state, versus_rooms.latest_state),
         stage_config = COALESCE(EXCLUDED.stage_config, versus_rooms.stage_config),
         last_active_at = NOW(),
         host_disconnected_at = NULL,
         closed_at = NULL,
         close_reason = NULL,
         updated_at = NOW()
       RETURNING id`,
      [room.id, room.hostUserId, room.pinHash, room.latestState ? JSON.stringify(room.latestState) : null, roomStageConfigJson(room), room.openedAt]
    );
    room.dbId = rows[0]?.id || room.dbId;
  } catch (error) {
    console.error('[Versus persistence] Could not create/update room:', error);
  }
}

async function persistRoomState(room: GameRoom): Promise<void> {
  if (!ROOM_PERSISTENCE_ENABLED || !room.dbId) return;
  const dbId = room.dbId;
  const latestState = room.latestState ? JSON.stringify(room.latestState) : null;
  const stageConfig = roomStageConfigJson(room);
  const previous = room.persistenceTail || Promise.resolve();
  const write = previous
    .catch(() => undefined)
    .then(async () => {
      try {
        await getDbPool().query(
          `UPDATE versus_rooms
           SET latest_state=$2::jsonb, stage_config=$3::jsonb, last_active_at=NOW(), updated_at=NOW(), host_disconnected_at=NULL
           WHERE id=$1 AND status='active'`,
          [dbId, latestState, stageConfig]
        );
      } catch (error) {
        console.error('[Versus persistence] Could not save room state:', error);
      }
    });
  room.persistenceTail = write;
  await write;
}

async function persistRoomDisconnected(room: GameRoom): Promise<void> {
  if (!ROOM_PERSISTENCE_ENABLED || !room.dbId) return;
  const dbId = room.dbId;
  const previous = room.persistenceTail || Promise.resolve();
  const write = previous
    .catch(() => undefined)
    .then(async () => {
      try {
        await getDbPool().query(
          `UPDATE versus_rooms SET host_disconnected_at=NOW(), last_active_at=NOW(), updated_at=NOW() WHERE id=$1 AND status='active'`,
          [dbId]
        );
      } catch (error) {
        console.error('[Versus persistence] Could not save host disconnect:', error);
      }
    });
  room.persistenceTail = write;
  await write;
}

async function archiveAndCloseRoom(room: GameRoom, reason: string): Promise<void> {
  if (!ROOM_PERSISTENCE_ENABLED || !room.dbId) return;
  // Finish any queued snapshot write before taking the archival lock. This
  // guarantees the archive contains the last state sent by the Host.
  await (room.persistenceTail || Promise.resolve()).catch(() => undefined);
  let client: PoolClient | undefined;
  try {
    client = await getDbPool().connect();
    await client.query('BEGIN');
    const locked = await client.query<any>(
      `SELECT id, room_code, host_user_id, opened_at, latest_state, stage_config, status
       FROM versus_rooms WHERE id=$1 FOR UPDATE`, [room.dbId]
    );
    const row = locked.rows[0];
    if (!row || row.status === 'closed') {
      await client.query('COMMIT');
      return;
    }
    const finalState = room.latestState || row.latest_state || null;
    const stageConfig = room.stageConfig || row.stage_config || {};
    const scores = finalState && Array.isArray(finalState.players)
      ? finalState.players.map((player: any) => ({ id: player.id, name: player.name, score: player.score }))
      : null;
    await client.query(
      `INSERT INTO versus_match_archive
        (room_id, room_code, host_user_id, match_id, schema_version, opened_at, closed_at, close_reason, final_state, stage_config, final_scores)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, $8::jsonb, $9::jsonb, $10::jsonb)
       ON CONFLICT (room_id) DO NOTHING`,
      [row.id, row.room_code, row.host_user_id, finalState?.matchId || null, ROOM_SCHEMA_VERSION,
        row.opened_at, reason, finalState ? JSON.stringify(finalState) : null, JSON.stringify(stageConfig), scores ? JSON.stringify(scores) : null]
    );
    await client.query(
      `UPDATE versus_rooms SET status='closed', closed_at=NOW(), close_reason=$2, updated_at=NOW() WHERE id=$1`,
      [room.dbId, reason]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client?.query('ROLLBACK').catch(() => undefined);
    console.error('[Versus persistence] Could not archive room:', error);
  } finally {
    client?.release();
  }
}

async function hydratePersistentRooms(): Promise<void> {
  if (!ROOM_PERSISTENCE_ENABLED) return;
  try {
    const { rows } = await getDbPool().query<any>(
      `SELECT id, room_code, host_user_id, pin_hash, latest_state, stage_config, opened_at, last_active_at, host_disconnected_at
       FROM versus_rooms WHERE status='active'`
    );
    for (const row of rows) {
      rooms.set(row.room_code, {
        id: row.room_code,
        dbId: row.id,
        hostUserId: row.host_user_id,
        pinHash: row.pin_hash,
        hostToken: crypto.randomUUID(),
        hostSocket: null,
        displays: new Set(),
        latestState: row.latest_state || null,
        stageConfig: row.stage_config || {},
        openedAt: new Date(row.opened_at).getTime(),
        lastActive: new Date(row.last_active_at).getTime(),
        hostDisconnectedAt: null,
        persistenceTail: Promise.resolve(),
      });
    }
    if (rows.length) console.log(`[Versus persistence] Restored ${rows.length} active room(s).`);
  } catch (error) {
    console.error('[Versus persistence] Could not restore active rooms:', error);
  }
}

async function loadPersistentRoom(roomId: string): Promise<GameRoom | null> {
  if (!ROOM_PERSISTENCE_ENABLED) return null;
  try {
    const { rows } = await getDbPool().query<any>(
      `SELECT id, room_code, host_user_id, pin_hash, latest_state, stage_config, opened_at, last_active_at
       FROM versus_rooms WHERE room_code=$1 AND status='active' LIMIT 1`, [roomId]
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.room_code,
      dbId: row.id,
      hostUserId: row.host_user_id,
      pinHash: row.pin_hash,
      hostToken: crypto.randomUUID(),
      hostSocket: null,
      displays: new Set(),
      latestState: row.latest_state || null,
      stageConfig: row.stage_config || {},
      openedAt: new Date(row.opened_at).getTime(),
      lastActive: new Date(row.last_active_at).getTime(),
      hostDisconnectedAt: null,
      persistenceTail: Promise.resolve(),
    };
  } catch (error) {
    console.error('[Versus persistence] Could not load room:', error);
    return null;
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
setInterval(async () => {
  const now = Date.now();
  for (const [id, room] of rooms.entries()) {
    const orphanedTooLong =
      !room.hostSocket &&
      room.hostDisconnectedAt !== null &&
      now - room.hostDisconnectedAt > ORPHANED_ROOM_TIMEOUT_MS;
    const idleTooLong = now - room.lastActive > ROOM_IDLE_TIMEOUT_MS;

    if (orphanedTooLong || (idleTooLong && !room.hostSocket)) {
      closeRoomForDisplays(room, 'Host has left the room or the room has expired.');
      await archiveAndCloseRoom(room, orphanedTooLong ? 'host_disconnected_timeout' : 'idle_timeout');
      rooms.delete(id);
    }
  }
}, 60 * 1000);

async function startServer() {
  const app = express();
  app.disable('x-powered-by');

  // Security Headers Middleware (DevSecOps baseline)
  app.use((_req: Request, res: Response, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('X-XSS-Protection', '0');
    if (process.env.NODE_ENV === 'production') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });

  // CORS is needed by the GitHub Pages/custom-domain frontend when it calls
  // the hosted backend. The same allowlist is applied to WebSocket upgrades
  // below so an arbitrary website cannot open a browser session to this server.
  app.use((req: Request, res: Response, next) => {
    const origin = req.get('Origin');

    if (origin && !isAllowedOrigin(origin, req)) {
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
  app.use(express.json({ limit: '100kb' }));

  // ── Agent-readiness endpoints ────────────────────────────────────────────────
  // These routes run before auth so they never touch the database.

  function resolveAssetPath(...candidates: string[]): string | null {
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  }

  // Keep every request header that changes the representation in Vary. This
  // matters when a browser request also carries an Origin header: replacing
  // `Vary: Origin` with `Vary: Accept` can make a CDN cache the wrong variant.
  function addVary(res: Response, ...fields: string[]) {
    const existing = (res.getHeader('Vary') || '').toString()
      .split(',')
      .map((field) => field.trim().toLowerCase())
      .filter(Boolean);
    const merged = [...existing];
    for (const field of fields) {
      if (!merged.includes(field.toLowerCase())) merged.push(field.toLowerCase());
    }
    res.setHeader('Vary', merged.join(', '));
  }

  // Serve llms.txt (agent instructions)
  const sendLlmsTxt = (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    const target = resolveAssetPath(
      path.join(projectRoot, 'llms.txt'),
      path.join(projectRoot, 'public', 'llms.txt')
    );
    if (target) return res.sendFile(target);
    return res.status(404).send('# llms.txt not found');
  };
  app.get('/llms.txt', sendLlmsTxt);
  app.get('/.well-known/llms.txt', sendLlmsTxt);

  // Serve sitemap.xml
  app.get('/sitemap.xml', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    const target = resolveAssetPath(
      path.join(projectRoot, 'sitemap.xml'),
      path.join(projectRoot, 'public', 'sitemap.xml')
    );
    if (target) return res.sendFile(target);
    return res.status(404).send('<!-- sitemap.xml not found -->');
  });

  // Serve robots.txt
  app.get('/robots.txt', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    const target = resolveAssetPath(
      path.join(projectRoot, 'robots.txt'),
      path.join(projectRoot, 'public', 'robots.txt')
    );
    if (target) return res.sendFile(target);
    return res.status(404).send('User-agent: *\nAllow: /\n');
  });

  // Homepage Markdown negotiation (acceptmarkdown.com check).
  // When an agent sends Accept: text/markdown we return a Markdown summary of
  // the site instead of the HTML page. HTML clients are unaffected.
  app.get('/', (req: Request, res: Response, next) => {
    // Both Markdown and HTML responses negotiate on Accept
    addVary(res, 'Accept', 'Origin');
    const accept = req.get('Accept') || '';
    const wantsMarkdown = accept.includes('text/markdown');
    if (!wantsMarkdown) return next();

    const body = [
      '# Countdown Studio',
      '',
      '> A faithful, offline-capable recreation of the British TV game show Countdown.',
      '> Supports Letters, Numbers & Conundrum rounds with solo practice and live dual-screen Versus mode.',
      '',
      '## When to use this',
      '',
      'Use Countdown Studio when you need to:',
      '- Run a live Countdown game show session with dedicated host controls and display screen.',
      '- Practice Countdown Letters, Numbers, and Conundrum rounds solo with dictionary corner solver.',
      '- Solve or verify 9-letter anagrams and 3-digit arithmetic targets.',
      '',
      '## Quick links',
      '',
      '- [Homepage](https://www.countdown-studio.id.vn/) — Product overview and mode selection',
      '- [Solo Practice](https://www.countdown-studio.id.vn/solo.html) — Timed solo game (requires individual account)',
      '- [Versus Host](https://www.countdown-studio.id.vn/versus-host.html) — Live host control panel (requires organisation account)',
      '- [Stage Display](https://www.countdown-studio.id.vn/versus-display.html) — Audience display screen (requires organisation account)',
      '- [Agent instructions](https://www.countdown-studio.id.vn/llms.txt) — llms.txt with when-to-use guidance',
      '- [Sitemap](https://www.countdown-studio.id.vn/sitemap.xml) — Full page index',
      '- [About](https://www.countdown-studio.id.vn/about) — About Countdown Studio',
      '- [Contact](https://www.countdown-studio.id.vn/contact) — Contact and support',
      '- [Privacy](https://www.countdown-studio.id.vn/privacy) — Privacy policy',
      '',
      '## API',
      '',
      '- `GET /api/health` — Server health and room stats',
      '- `POST /api/auth/login` — Authenticate with `{ identifier, password }`; returns `{ user, token }`',
      '- `GET /api/auth/me` — Return authenticated user (requires `Authorization: Bearer <token>`)',
      '- `WebSocket /ws` — Real-time game state sync (host broadcast + display sync)',
    ].join('\n');

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).send(body);
  });

  // ── Trust anchor pages (/about, /contact, /privacy) ──────────────────────
  // These routes serve real content pages that AI agents check to verify
  // business legitimacy. They also support Markdown negotiation.

  function trustPageMarkdown(title: string, url: string, _filePath: string) {
    return (req: Request, res: Response, next: () => void) => {
      addVary(res, 'Accept', 'Origin');
      const accept = req.get('Accept') || '';
      if (!accept.includes('text/markdown')) return next();
      const body = [
        `# ${title} — Countdown Studio`,
        '',
        `> See the full page at ${url}`,
        '',
        '## When to use this',
        '',
        'Use Countdown Studio for British TV Countdown game practice, anagram solving, and dual-screen live stage hosting.',
        '',
        '## Quick links',
        '',
        '- [Homepage](https://www.countdown-studio.id.vn/) — Product overview',
        '- [Agent instructions](https://www.countdown-studio.id.vn/llms.txt) — llms.txt',
        '- [Sitemap](https://www.countdown-studio.id.vn/sitemap.xml) — Page index',
        '- [About](https://www.countdown-studio.id.vn/about) — About',
        '- [Contact](https://www.countdown-studio.id.vn/contact) — Contact',
        '- [Privacy](https://www.countdown-studio.id.vn/privacy) — Privacy policy',
      ].join('\n');
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.status(200).send(body);
    };
  }

  app.get('/about', trustPageMarkdown('About', 'https://www.countdown-studio.id.vn/about', 'about.html'), (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    const target = resolveAssetPath(
      path.join(projectRoot, 'about.html'),
      path.join(projectRoot, 'dist', 'about.html')
    );
    if (target) return res.sendFile(target);
    return res.status(404).send('About page not found');
  });

  app.get('/contact', trustPageMarkdown('Contact', 'https://www.countdown-studio.id.vn/contact', 'contact.html'), (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    const target = resolveAssetPath(
      path.join(projectRoot, 'contact.html'),
      path.join(projectRoot, 'dist', 'contact.html')
    );
    if (target) return res.sendFile(target);
    return res.status(404).send('Contact page not found');
  });

  app.get('/privacy', trustPageMarkdown('Privacy Policy', 'https://www.countdown-studio.id.vn/privacy', 'privacy.html'), (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    const target = resolveAssetPath(
      path.join(projectRoot, 'privacy.html'),
      path.join(projectRoot, 'dist', 'privacy.html')
    );
    if (target) return res.sendFile(target);
    return res.status(404).send('Privacy page not found');
  });
  // ── End trust anchor pages ────────────────────────────────────────────────

  // Authentication and RBAC API. Organization accounts are provisioned by an
  // administrator; public registration intentionally exposes only Individual
  // and Admin (the latter requires the private bootstrap code).
  app.post('/api/auth/register', async (req: Request, res: Response) => {
    const clientIp = getClientIp(req);
    if (!checkRateLimit(clientIp, 'register', 5, 10 * 60 * 1000)) {
      return res.status(429).json({ error: 'TOO_MANY_REQUESTS', message: 'Too many registration requests from this address. Please try again after 10 minutes.' });
    }

    const { username, email, password, displayName, role = 'individual', adminCode } = req.body || {};
    const normalizedRole = String(role).toLowerCase() as AppRole;
    if (
      !/^[a-zA-Z0-9_.-]{3,32}$/.test(String(username || '')) ||
      !/^\S+@\S+\.\S+$/.test(String(email || '')) ||
      String(password || '').length < 8 ||
      String(password || '').length > 128 ||
      !String(displayName || '').trim() ||
      String(displayName || '').length > 64
    ) {
      return res.status(400).json({ error: 'INVALID_INPUT', message: 'Username, email, display name, and password (8-128 characters) are required.' });
    }
    if (normalizedRole !== 'individual' && normalizedRole !== 'admin') return res.status(403).json({ error: 'ROLE_NOT_REGISTERABLE', message: 'Organization accounts can only be provisioned by an administrator.' });
    
    if (normalizedRole === 'admin') {
      const serverAdminCode = process.env.ADMIN_REGISTRATION_CODE;
      if (!serverAdminCode || !adminCode) return res.status(403).json({ error: 'INVALID_ADMIN_CODE' });
      const clientBuf = Buffer.from(String(adminCode));
      const serverBuf = Buffer.from(String(serverAdminCode));
      if (clientBuf.length !== serverBuf.length || !crypto.timingSafeEqual(clientBuf, serverBuf)) {
        return res.status(403).json({ error: 'INVALID_ADMIN_CODE' });
      }
    }

    let connection: PoolClient | undefined;
    try {
      connection = await getDbPool().connect(); await connection.query('BEGIN');
      const publicId = crypto.randomUUID();
      const userResult = await connection.query<{ id: number }>('INSERT INTO users (public_id, username, status_id) SELECT $1::uuid, $2, id FROM user_statuses WHERE code=\'active\' RETURNING id', [publicId, String(username).trim()]);
      const userId = userResult.rows[0]?.id;
      if (!userId) throw new Error('Active user status is missing.');
      const passHash = await hashPassword(String(password));
      await connection.query('INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)', [userId, passHash]);
      await connection.query('INSERT INTO user_emails (user_id, email, is_primary, verified_at) VALUES ($1, LOWER($2), TRUE, NOW())', [userId, String(email).trim()]);
      await connection.query('INSERT INTO user_profiles (user_id, display_name) VALUES ($1, $2)', [userId, String(displayName).trim()]);
      await connection.query('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code=$2', [userId, normalizedRole]);
      await connection.query('COMMIT');
      const user = await loadUser(userId); if (!user) throw new Error('Created user could not be loaded.');
      return res.status(201).json({ user: publicUser(user), token: signSession(user) });
    } catch (error: any) { if (connection) await connection.query('ROLLBACK'); const duplicate = error?.code === '23505'; return res.status(duplicate ? 409 : 503).json({ error: duplicate ? 'ACCOUNT_EXISTS' : 'AUTH_DATABASE_UNAVAILABLE', message: duplicate ? 'Username or email already exists.' : 'Cannot connect to authentication database.' }); }
    finally { connection?.release(); }
  });

  app.post('/api/auth/login', async (req: Request, res: Response) => {
    const clientIp = getClientIp(req);
    if (!checkRateLimit(clientIp, 'login', 10, 60 * 1000)) {
      return res.status(429).json({ error: 'TOO_MANY_REQUESTS', message: 'Too many login attempts. Please try again after 1 minute.' });
    }

    const identifier = String(req.body?.identifier || '').trim();
    const password = String(req.body?.password || '');
    if (!identifier || !password || identifier.length > 100 || password.length > 128) {
      return res.status(400).json({ error: 'INVALID_INPUT', message: 'Invalid login input.' });
    }

    try {
      const { rows } = await getDbPool().query<any>(`SELECT u.id, c.password_hash, c.failed_attempts, c.locked_until FROM users u JOIN user_credentials c ON c.user_id=u.id
        JOIN user_emails e ON e.user_id=u.id AND e.is_primary=TRUE
        WHERE LOWER(u.username)=LOWER($1) OR LOWER(e.email)=LOWER($2) LIMIT 1`, [identifier, identifier]);
      
      const record = rows[0];
      if (record && record.locked_until && new Date(record.locked_until) > new Date()) {
        const remainingMinutes = Math.ceil((new Date(record.locked_until).getTime() - Date.now()) / (60 * 1000));
        return res.status(423).json({
          error: 'ACCOUNT_LOCKED',
          message: `Account is temporarily locked due to multiple failed attempts. Please try again after ${remainingMinutes} minute(s).`,
        });
      }

      if (!record) {
        // Run dummy verification to eliminate username/email enumeration timing attacks
        await verifyPassword(password, DUMMY_HASH);
        return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Invalid credentials.' });
      }

      const isValid = await verifyPassword(password, record.password_hash);
      if (!isValid) {
        const nextAttempts = (record.failed_attempts || 0) + 1;
        if (nextAttempts >= 5) {
          await getDbPool().query(
            `UPDATE user_credentials SET failed_attempts=$1, locked_until=NOW() + INTERVAL '15 minutes' WHERE user_id=$2`,
            [nextAttempts, record.id]
          );
          return res.status(423).json({
            error: 'ACCOUNT_LOCKED',
            message: 'Account has been temporarily locked for 15 minutes due to 5 consecutive failed login attempts.',
          });
        } else {
          await getDbPool().query(
            `UPDATE user_credentials SET failed_attempts=$1 WHERE user_id=$2`,
            [nextAttempts, record.id]
          );
          return res.status(401).json({
            error: 'INVALID_CREDENTIALS',
            message: `Invalid credentials. ${5 - nextAttempts} attempt(s) remaining.`,
          });
        }
      }

      const user = await loadUser(record.id);
      if (!user) return res.status(403).json({ error: 'ACCOUNT_INACTIVE_OR_ROLE_INVALID' });
      await getDbPool().query('UPDATE user_credentials SET last_login_at=NOW(), failed_attempts=0, locked_until=NULL WHERE user_id=$1', [user.id]);
      return res.json({ user: publicUser(user), token: signSession(user) });
    } catch (error) {
      console.error('[Auth] Login failed:', error);
      return res.status(503).json({ error: 'AUTH_DATABASE_UNAVAILABLE', message: 'Cannot connect to authentication database.' });
    }
  });

  // Google OAuth endpoint: verifies Google credential & checks whether password initialization is required
  app.post('/api/auth/google', async (req: Request, res: Response) => {
    const clientIp = getClientIp(req);
    if (!checkRateLimit(clientIp, 'google_auth', 20, 60 * 1000)) {
      return res.status(429).json({ error: 'TOO_MANY_REQUESTS', message: 'Too many requests. Please wait a minute.' });
    }

    const { credential } = req.body || {};
    let googleUser: { sub: string; email: string; name: string; picture?: string } | null = null;

    if (credential) {
      googleUser = await verifyGoogleIdToken(String(credential));
    }

    if (!googleUser || !googleUser.email || !googleUser.sub) {
      return res.status(400).json({
        error: 'INVALID_CREDENTIAL',
        message: 'Google authentication credential verification failed.',
      });
    }

    const normalizedEmail = googleUser.email.trim().toLowerCase();

    try {
      // 1. Check if user already exists by Google provider_user_id
      const identityQuery = await getDbPool().query<any>(
        `SELECT u.id, u.username, u.status_id, c.password_hash
         FROM users u
         JOIN user_identities ui ON ui.user_id = u.id
         JOIN auth_providers ap ON ap.id = ui.provider_id AND ap.code = 'google'
         LEFT JOIN user_credentials c ON c.user_id = u.id
         WHERE ui.provider_user_id = $1 LIMIT 1`,
        [googleUser.sub]
      );

      let record = identityQuery.rows[0];

      // 2. If not found by Google provider ID, check by primary email
      if (!record) {
        const emailQuery = await getDbPool().query<any>(
          `SELECT u.id, u.username, u.status_id, c.password_hash
           FROM users u
           JOIN user_emails e ON e.user_id = u.id AND LOWER(e.email) = LOWER($1)
           LEFT JOIN user_credentials c ON c.user_id = u.id LIMIT 1`,
          [normalizedEmail]
        );
        record = emailQuery.rows[0];
      }

      // Google authentication is login-only. The account must already exist
      // from the web registration flow and have a password credential.
      if (!record || !record.password_hash) {
        return res.status(403).json({
          error: 'ACCOUNT_NOT_REGISTERED',
          message: 'This account is not registered on the website. Please register first.',
        });
      }

      // Existing registered user: authenticate session directly.
      if (record && record.password_hash) {
        const user = await loadUser(record.id);
        if (!user) {
          return res.status(403).json({
            error: 'ACCOUNT_INACTIVE_OR_ROLE_INVALID',
            message: 'Account is suspended or invalid.',
          });
        }

        // Ensure Google identity is linked if not already
        await getDbPool().query(
          `INSERT INTO auth_providers (code) VALUES ('google') ON CONFLICT (code) DO NOTHING`
        );
        await getDbPool().query(
          `INSERT INTO user_identities (user_id, provider_id, provider_user_id)
           SELECT $1, id, $2 FROM auth_providers WHERE code = 'google'
           ON CONFLICT (provider_id, provider_user_id) DO NOTHING`,
          [user.id, googleUser.sub]
        );

        await getDbPool().query(
          'UPDATE user_credentials SET last_login_at=NOW(), failed_attempts=0, locked_until=NULL WHERE user_id=$1',
          [user.id]
        );

        return res.json({
          requirePasswordSetup: false,
          user: publicUser(user),
          token: signSession(user),
        });
      }

      // If user is new OR user does not have a password initialized:
      // MANDATORY: Require initializing password to save into database!
      const setupToken = signGoogleSetupToken({
        sub: googleUser.sub,
        email: normalizedEmail,
        displayName: googleUser.name,
        avatarUrl: googleUser.picture || null,
        existingUserId: record ? record.id : null,
      });

      return res.json({
        requirePasswordSetup: true,
        setupToken,
        email: normalizedEmail,
        displayName: googleUser.name,
        avatarUrl: googleUser.picture || null,
        suggestedUsername: record ? record.username : sanitizeGoogleUsername(normalizedEmail.split('@')[0]),
      });
    } catch (error) {
      console.error('[Google Auth] Error during lookup:', error);
      return res.status(503).json({
        error: 'AUTH_DATABASE_UNAVAILABLE',
        message: 'Cannot connect to authentication database.',
      });
    }
  });

  // Password Initialization Endpoint: Saves initialized password into database
  app.post('/api/auth/google/set-password', async (req: Request, res: Response) => {
    const clientIp = getClientIp(req);
    if (!checkRateLimit(clientIp, 'google_set_password', 10, 60 * 1000)) {
      return res.status(429).json({ error: 'TOO_MANY_REQUESTS', message: 'Too many requests. Please wait a minute.' });
    }

    const { setupToken, password, username, displayName } = req.body || {};
    if (!setupToken || !password) {
      return res.status(400).json({ error: 'INVALID_INPUT', message: 'Setup token and password are required.' });
    }

    const payload = readGoogleSetupToken(String(setupToken));
    if (!payload) {
      return res.status(401).json({
        error: 'EXPIRED_OR_INVALID_TOKEN',
        message: 'Password setup session has expired or is invalid. Please sign in with Google again.',
      });
    }

    const trimmedPassword = String(password);
    if (trimmedPassword.length < 8 || trimmedPassword.length > 128) {
      return res.status(400).json({
        error: 'INVALID_PASSWORD',
        message: 'Password must be between 8 and 128 characters.',
      });
    }

    const finalUsername = String(username || payload.email.split('@')[0]).trim();
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(finalUsername)) {
      return res.status(400).json({
        error: 'INVALID_USERNAME',
        message: 'Username must be 3-32 characters (letters, numbers, hyphens, dots, underscores).',
      });
    }

    const finalDisplayName = String(displayName || payload.displayName || finalUsername).trim().slice(0, 64);
    if (!finalDisplayName) {
      return res.status(400).json({ error: 'INVALID_NAME', message: 'Display name is required.' });
    }

    let connection: PoolClient | undefined;
    try {
      connection = await getDbPool().connect();
      await connection.query('BEGIN');

      // Ensure 'google' provider exists in auth_providers
      await connection.query(`INSERT INTO auth_providers (code) VALUES ('google') ON CONFLICT (code) DO NOTHING`);

      const passHash = await hashPassword(trimmedPassword);
      let targetUserId: number;

      if (payload.existingUserId) {
        targetUserId = payload.existingUserId;

        // Save password into user_credentials
        await connection.query(
          `INSERT INTO user_credentials (user_id, password_hash, password_changed_at, failed_attempts, last_login_at)
           VALUES ($1, $2, NOW(), 0, NOW())
           ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, password_changed_at = NOW(), failed_attempts = 0, locked_until = NULL, last_login_at = NOW()`,
          [targetUserId, passHash]
        );

        // Ensure Google identity is linked
        await connection.query(
          `INSERT INTO user_identities (user_id, provider_id, provider_user_id)
           SELECT $1, id, $2 FROM auth_providers WHERE code = 'google'
           ON CONFLICT (provider_id, provider_user_id) DO NOTHING`,
          [targetUserId, payload.sub]
        );

        // Update profile
        await connection.query(
          `UPDATE user_profiles SET display_name = $2, avatar_url = COALESCE($3, avatar_url), updated_at = NOW() WHERE user_id = $1`,
          [targetUserId, finalDisplayName, payload.avatarUrl]
        );

        // Update username if requested and changed
        if (finalUsername) {
          await connection.query(`UPDATE users SET username = $2, updated_at = NOW() WHERE id = $1`, [targetUserId, finalUsername]);
        }
      } else {
        // Create new user in users table
        const publicId = crypto.randomUUID();
        const userRes = await connection.query<{ id: number }>(
          `INSERT INTO users (public_id, username, status_id)
           SELECT $1::uuid, $2, id FROM user_statuses WHERE code='active'
           RETURNING id`,
          [publicId, finalUsername]
        );
        const newId = userRes.rows[0]?.id;
        if (!newId) throw new Error('Failed to create user record.');
        targetUserId = newId;

        // Save password into user_credentials
        await connection.query(
          `INSERT INTO user_credentials (user_id, password_hash, password_changed_at, last_login_at)
           VALUES ($1, $2, NOW(), NOW())`,
          [targetUserId, passHash]
        );

        // Save email into user_emails
        await connection.query(
          `INSERT INTO user_emails (user_id, email, is_primary, verified_at)
           VALUES ($1, LOWER($2), TRUE, NOW())`,
          [targetUserId, payload.email]
        );

        // Save profile into user_profiles
        await connection.query(
          `INSERT INTO user_profiles (user_id, display_name, avatar_url)
           VALUES ($1, $2, $3)`,
          [targetUserId, finalDisplayName, payload.avatarUrl]
        );

        // Save identity into user_identities
        await connection.query(
          `INSERT INTO user_identities (user_id, provider_id, provider_user_id)
           SELECT $1, id, $2 FROM auth_providers WHERE code = 'google'`,
          [targetUserId, payload.sub]
        );

        // Assign individual role
        await connection.query(
          `INSERT INTO user_roles (user_id, role_id)
           SELECT $1, id FROM roles WHERE code = 'individual'`,
          [targetUserId]
        );
      }

      await connection.query('COMMIT');

      const user = await loadUser(targetUserId);
      if (!user) throw new Error('Active user could not be loaded after creation.');

      return res.status(201).json({
        user: publicUser(user),
        token: signSession(user),
        message: 'Password successfully initialized and saved to database.',
      });
    } catch (error: any) {
      if (connection) await connection.query('ROLLBACK');
      const isDuplicate = error?.code === '23505';
      if (isDuplicate) {
        return res.status(409).json({
          error: 'USERNAME_OR_EMAIL_EXISTS',
          message: 'Username or email already exists. Please choose a different username.',
        });
      }
      console.error('[Google Auth] Set password failed:', error);
      return res.status(503).json({
        error: 'AUTH_DATABASE_UNAVAILABLE',
        message: 'Cannot save credentials to database.',
      });
    } finally {
      connection?.release();
    }
  });

  app.get('/api/auth/me', async (req: Request, res: Response) => {
    try {
      const user = await authenticateToken(bearer(req));
      if (!user) return res.status(401).json({ error: 'UNAUTHENTICATED' });
      return res.json({ user: publicUser(user) });
    } catch {
      return res.status(503).json({ error: 'AUTH_DATABASE_UNAVAILABLE' });
    }
  });

  // Career progression is account-owned data. It is deliberately restricted to
  // Individual accounts; admins may use Solo Practice but do not get a career
  // profile, and guests must never fall back to device storage.
  app.get('/api/career/stats', async (req: Request, res: Response) => {
    try {
      const user = await authenticateToken(bearer(req));
      if (!user) return res.status(401).json({ error: 'UNAUTHENTICATED' });
      if (user.role !== 'individual') return res.status(403).json({ error: 'INDIVIDUAL_ACCOUNT_REQUIRED' });
      const { rows } = await getDbPool().query<{ stats: unknown }>(
        'SELECT stats FROM user_career_stats WHERE user_id=$1', [user.id]
      );
      return res.json({ stats: rows[0]?.stats || null });
    } catch {
      return res.status(503).json({ error: 'CAREER_DATABASE_UNAVAILABLE' });
    }
  });

  app.put('/api/career/stats', async (req: Request, res: Response) => {
    try {
      const user = await authenticateToken(bearer(req));
      if (!user) return res.status(401).json({ error: 'UNAUTHENTICATED' });
      if (user.role !== 'individual') return res.status(403).json({ error: 'INDIVIDUAL_ACCOUNT_REQUIRED' });
      const stats = req.body?.stats;
      if (!stats || typeof stats !== 'object' || Array.isArray(stats)) {
        return res.status(400).json({ error: 'INVALID_CAREER_STATS' });
      }
      const { rows } = await getDbPool().query<{ stats: unknown }>(
        `INSERT INTO user_career_stats (user_id, stats, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (user_id) DO UPDATE SET stats=EXCLUDED.stats, updated_at=NOW()
         RETURNING stats`, [user.id, JSON.stringify(stats)]
      );
      return res.json({ stats: rows[0].stats });
    } catch {
      return res.status(503).json({ error: 'CAREER_DATABASE_UNAVAILABLE' });
    }
  });

  app.get('/api/auth/config', (_req, res) =>
    res.json({
      adminRegistrationEnabled: Boolean(process.env.ADMIN_REGISTRATION_CODE),
      googleClientId: process.env.GOOGLE_CLIENT_ID || '',
      googleAuthEnabled: true,
    })
  );

  const server = http.createServer(app);

  // REST endpoints for health and room checks
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: Date.now(), ...getRoomStats() });
  });

  app.get('/api/room/:roomId', (req: Request, res: Response) => {
    const roomId = String(req.params.roomId).toUpperCase().trim();
    const room = rooms.get(roomId);
    if (!room) {
      return res.status(404).json({ exists: false, message: 'Room does not exist' });
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

  app.get('/api/versus/history', requirePermission('host:operations'), async (req: Request, res: Response) => {
    const user = (req as any).user as AuthUser;
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit || '25'), 10) || 25));
    const offset = Math.max(0, Number.parseInt(String(req.query.offset || '0'), 10) || 0);
    const roomCode = String(req.query.room || '').toUpperCase().trim();
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();
    const filters: string[] = [];
    const values: unknown[] = [];
    if (user.role !== 'admin') {
      values.push(user.id);
      filters.push(`a.host_user_id=$${values.length}`);
    }
    if (roomCode) {
      values.push(roomCode);
      filters.push(`a.room_code=$${values.length}`);
    }
    if (from) {
      values.push(from);
      filters.push(`a.closed_at >= $${values.length}::timestamptz`);
    }
    if (to) {
      values.push(to);
      filters.push(`a.closed_at < ($${values.length}::date + INTERVAL '1 day')`);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    try {
      const countResult = await getDbPool().query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM versus_match_archive a ${where}`, values
      );
      const listValues = [...values, limit, offset];
      const { rows } = await getDbPool().query<any>(
        `SELECT a.id, a.room_code, a.match_id, a.schema_version, a.opened_at, a.closed_at,
                a.close_reason, a.final_scores, a.host_user_id, p.display_name AS host_name
         FROM versus_match_archive a
         JOIN user_profiles p ON p.user_id=a.host_user_id
         ${where} ORDER BY a.closed_at DESC LIMIT $${listValues.length - 1} OFFSET $${listValues.length}`,
        listValues
      );
      return res.json({ items: rows, total: Number(countResult.rows[0]?.count || 0), limit, offset });
    } catch (error) {
      console.error('[Versus history] List failed:', error);
      return res.status(503).json({ error: 'VERSUS_HISTORY_UNAVAILABLE' });
    }
  });

  app.get('/api/versus/history/:archiveId', requirePermission('host:operations'), async (req: Request, res: Response) => {
    const user = (req as any).user as AuthUser;
    const archiveId = Number.parseInt(String(req.params.archiveId), 10);
    if (!Number.isInteger(archiveId) || archiveId <= 0) return res.status(400).json({ error: 'INVALID_ARCHIVE_ID' });
    try {
      const { rows } = await getDbPool().query<any>(
        `SELECT a.*, p.display_name AS host_name
         FROM versus_match_archive a JOIN user_profiles p ON p.user_id=a.host_user_id
         WHERE a.id=$1 AND ($2='admin' OR a.host_user_id=$3)`,
        [archiveId, user.role, user.id]
      );
      if (!rows[0]) return res.status(404).json({ error: 'ARCHIVE_NOT_FOUND' });
      return res.json({ item: rows[0] });
    } catch (error) {
      console.error('[Versus history] Detail failed:', error);
      return res.status(503).json({ error: 'VERSUS_HISTORY_UNAVAILABLE' });
    }
  });

  // Setup WebSocket Server attached to the same HTTP server on /ws
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: 1024 * 1024,
    verifyClient: (info: { origin: string; req: { headers: Record<string, string | string[] | undefined> } }) =>
      isAllowedOrigin(info.origin, info.req),
  });

  wss.on('connection', (ws: WebSocket) => {
    let clientRole: 'host' | 'display' | null = null;
    let clientRoomId: string | null = null;
    let clientHostToken: string | null = null;
    let clientUser: AuthUser | null = null;
    let failedPinAttempts = 0;

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

          if (!rawRoomId) {
            ws.send(JSON.stringify({ type: 'error', code: 'INVALID_ROOM', message: 'Invalid room code' }));
            return;
          }
          if (pin && !ROOM_PIN_PATTERN.test(pin)) {
            sendError(ws, 'INVALID_PIN_FORMAT', 'Host PIN must contain 4 to 8 digits.');
            return;
          }

          let room = rooms.get(rawRoomId) || await loadPersistentRoom(rawRoomId);
          if (room && !rooms.has(rawRoomId)) rooms.set(rawRoomId, room);
          if (!room) {
            // Create new room with provided PIN (or default 0000)
            const token = crypto.randomUUID();
            const openedAt = Date.now();
            room = {
              id: rawRoomId,
              dbId: null,
              hostUserId: clientUser.id,
              pinHash: await hashPassword(pin || '0000'),
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
            if (!(await verifyPassword(pin || '0000', room.pinHash))) {
              failedPinAttempts += 1;
              if (failedPinAttempts >= 5) {
                sendError(ws, 'TOO_MANY_FAILED_ATTEMPTS', 'Too many failed Host PIN attempts. Connection closed.');
                ws.close(1008, 'Too many failed PIN attempts');
                return;
              }
              ws.send(JSON.stringify({
                type: 'error',
                code: 'INVALID_PIN',
                message: `Incorrect Host password / PIN. ${5 - failedPinAttempts} attempt(s) remaining.`,
              }));
              return;
            }
            failedPinAttempts = 0;

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

        // Displays may send only contestant buzzer events or request the
        // latest state. They cannot mutate room state or stage configuration.
        if (type === 'display:buzz' || type === 'display:request_state') {
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
          } else if (room.latestState) {
            ws.send(JSON.stringify({
              type: 'stage:sync',
              sender: 'host',
              payload: room.latestState,
              timestamp: Date.now(),
            }));
          }
          room.lastActive = Date.now();
          return;
        }

        // Only the authenticated Host may publish stage configuration.
        if (type === 'host:stage_config') {
          if (clientRole !== 'host' || !clientRoomId || !clientHostToken) {
            sendError(ws, 'UNAUTHORIZED', 'Only the authenticated Host may publish stage configuration.');
            return;
          }
          if (String(msg.roomId || '').toUpperCase().trim() !== clientRoomId) {
            sendError(ws, 'UNAUTHORIZED', 'Room identifier does not match the authenticated Host session.');
            return;
          }
          const room = rooms.get(clientRoomId);
          if (!room || room.hostToken !== clientHostToken || room.hostSocket !== ws) {
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
          if (clientRole !== 'host' || !clientRoomId || !clientHostToken) {
            ws.send(JSON.stringify({ type: 'error', code: 'UNAUTHORIZED', message: 'You do not have Host permissions' }));
            return;
          }
          if (String(msg.roomId || '').toUpperCase().trim() !== clientRoomId) {
            sendError(ws, 'UNAUTHORIZED', 'Room identifier does not match the authenticated Host session.');
            return;
          }
          const room = rooms.get(clientRoomId);
          if (!room || room.hostToken !== clientHostToken || room.hostSocket !== ws) {
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
          if (clientRole !== 'host' || !clientRoomId || !clientHostToken) {
            ws.send(JSON.stringify({ type: 'error', code: 'UNAUTHORIZED', message: 'You do not have Host permissions' }));
            return;
          }
          if (String(msg.roomId || '').toUpperCase().trim() !== clientRoomId) {
            sendError(ws, 'UNAUTHORIZED', 'Room identifier does not match the authenticated Host session.');
            return;
          }
          if (!isValidStatePayload(msg.payload)) {
            sendError(ws, 'INVALID_PAYLOAD', 'State payload does not match the Versus match contract.');
            return;
          }

          const room = rooms.get(clientRoomId);
          if (!room || room.hostToken !== clientHostToken) {
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

  // Vite middleware in dev or static files in prod
  const isProd = process.env.NODE_ENV === 'production' || __dirname.includes('dist-server');
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
    const frontendDistPath = path.resolve(projectRoot, 'dist');
    app.use(express.static(frontendDistPath));
  }

  // Universal 404 handler for nonexistent paths (runs in both dev and prod)
  app.use((req: Request, res: Response) => {
    addVary(res, 'Accept', 'Origin');
    const accept = req.get('Accept') || '';

    // Agent-friendly Markdown 404
    if (accept.includes('text/markdown')) {
      const body = [
        '# 404 — Page Not Found',
        '',
        `The path \`${req.path}\` does not exist on Countdown Studio.`,
        '',
        '## Where to go instead',
        '',
        '- [Homepage](https://www.countdown-studio.id.vn/) — Start here',
        '- [Agent instructions](https://www.countdown-studio.id.vn/llms.txt) — llms.txt with full API guidance',
        '- [Sitemap](https://www.countdown-studio.id.vn/sitemap.xml) — All available pages',
        '- [Solo Practice](https://www.countdown-studio.id.vn/solo.html) — Practice letters, numbers, and conundrums',
        '- [About](https://www.countdown-studio.id.vn/about) — About the game show app',
      ].join('\n');
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      return res.status(404).send(body);
    }

    // HTML 404
    const static404Candidates = [
      path.join(projectRoot, 'dist', '404.html'),
      path.join(projectRoot, '404.html'),
      path.join(projectRoot, 'public', '404.html'),
    ];
    for (const c of static404Candidates) {
      if (fs.existsSync(c)) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(404).sendFile(c);
      }
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(404).send('<!doctype html><html><head><title>404 Not Found</title></head><body><h1>404 Not Found</h1><p>The page you requested does not exist on Countdown Studio.</p><p><a href="/">Back to Homepage</a> | <a href="/llms.txt">llms.txt</a></p></body></html>');
  });

  await hydratePersistentRooms();
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, '0.0.0.0', () => {
    console.log(`[Countdown Studio] Server running at http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
