import crypto from 'crypto';
import { WebSocket } from 'ws';
import { getDbPool, type PoolClient } from './db.js';
import { readPositiveInteger } from './env.js';
import type { GameRoom } from './types.js';

// ── Constants ────────────────────────────────────────────────────────────────

export const ROOM_ID_PATTERN = /^[A-Z0-9][A-Z0-9-]{2,31}$/;
export const ROOM_PIN_PATTERN = /^\d{4,8}$/;
export const MAX_WS_MESSAGE_BYTES = 900 * 1024;
export const MAX_STAGE_BACKGROUND_BYTES = 700 * 1024;
export const ROOM_IDLE_TIMEOUT_MS = readPositiveInteger(process.env.ROOM_IDLE_TIMEOUT_MS, 12 * 60 * 60 * 1000);
export const ORPHANED_ROOM_TIMEOUT_MS = readPositiveInteger(process.env.ORPHANED_ROOM_TIMEOUT_MS, 30 * 1000);
export const MAX_DISPLAYS_PER_ROOM = readPositiveInteger(process.env.MAX_DISPLAYS_PER_ROOM, 20);
export const ROOM_PERSISTENCE_ENABLED = Boolean(process.env.DATABASE_URL || process.env.DB_NAME);
export const ROOM_SCHEMA_VERSION = 1;

// ── In-memory room store ─────────────────────────────────────────────────────

export const rooms = new Map<string, GameRoom>();

export function getRoomStats() {
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

// ── Payload validation ───────────────────────────────────────────────────────

export function sendError(ws: WebSocket, code: string, message: string) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'error', code, message }));
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function isValidStageConfigPayload(payload: unknown): boolean {
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

export function isValidStatePayload(payload: unknown): boolean {
  if (!isPlainObject(payload)) return false;
  return typeof payload.matchId === 'string'
    && typeof payload.phase === 'string'
    && Array.isArray(payload.players)
    && payload.players.length === 2
    && Array.isArray(payload.schedule)
    && payload.schedule.length >= 1
    && payload.schedule.length <= 25;
}

export function applyStageConfig(room: GameRoom, payload: Record<string, unknown>) {
  const value = payload.value;
  if (payload.kind === 'layout' && isPlainObject(value)) room.stageConfig.layout = value;
  if (payload.kind === 'controls' && isPlainObject(value)) room.stageConfig.controlsHidden = value.hidden as boolean;
  if (payload.kind === 'background') room.stageConfig.background = value as string | null;
}

// ── Persistence ──────────────────────────────────────────────────────────────

function roomStageConfigJson(room: GameRoom) {
  return JSON.stringify(room.stageConfig || {});
}

export async function persistRoomCreated(room: GameRoom): Promise<void> {
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

export async function persistRoomState(room: GameRoom): Promise<void> {
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

export async function persistRoomDisconnected(room: GameRoom): Promise<void> {
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

export async function archiveAndCloseRoom(room: GameRoom, reason: string): Promise<void> {
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

// ── Room restore ─────────────────────────────────────────────────────────────

function createRoomFromRow(row: any): GameRoom {
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
}

export async function hydratePersistentRooms(): Promise<void> {
  if (!ROOM_PERSISTENCE_ENABLED) return;
  try {
    const { rows } = await getDbPool().query<any>(
      `SELECT id, room_code, host_user_id, pin_hash, latest_state, stage_config, opened_at, last_active_at, host_disconnected_at
       FROM versus_rooms WHERE status='active'`
    );
    for (const row of rows) {
      rooms.set(row.room_code, createRoomFromRow(row));
    }
    if (rows.length) console.log(`[Versus persistence] Restored ${rows.length} active room(s).`);
  } catch (error) {
    console.error('[Versus persistence] Could not restore active rooms:', error);
  }
}

export async function loadPersistentRoom(roomId: string): Promise<GameRoom | null> {
  if (!ROOM_PERSISTENCE_ENABLED) return null;
  try {
    const { rows } = await getDbPool().query<any>(
      `SELECT id, room_code, host_user_id, pin_hash, latest_state, stage_config, opened_at, last_active_at
       FROM versus_rooms WHERE room_code=$1 AND status='active' LIMIT 1`, [roomId]
    );
    const row = rows[0];
    if (!row) return null;
    return createRoomFromRow(row);
  } catch (error) {
    console.error('[Versus persistence] Could not load room:', error);
    return null;
  }
}

// ── Room lifecycle ───────────────────────────────────────────────────────────

export function closeRoomForDisplays(room: GameRoom, message: string) {
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
export function startRoomMaintenance(): void {
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
}
