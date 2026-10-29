import type { Express, Request, Response } from 'express';
import { getDbPool } from '../db.js';
import { getRoomStats, rooms, MAX_DISPLAYS_PER_ROOM } from '../rooms.js';
import { requirePermission } from '../users.js';
import type { AuthUser } from '../types.js';

export function registerVersusRoutes(app: Express) {
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
    if ((from && Number.isNaN(new Date(from).getTime())) || (to && Number.isNaN(new Date(to).getTime()))) {
      return res.status(400).json({ error: 'INVALID_HISTORY_FILTER', message: "The 'from' and 'to' filters must be valid dates (YYYY-MM-DD)." });
    }
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
}
