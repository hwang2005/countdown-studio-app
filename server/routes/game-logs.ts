import type { Express, Request, Response } from 'express';
import { getDbPool } from '../db.js';
import { authenticateToken, bearer } from '../users.js';
import type { AuthUser } from '../types.js';

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

function parsePositiveInt(value: string | undefined, fallback: number) {
  const n = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseNonNegativeInt(value: string | undefined, fallback: number) {
  const n = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function registerGameLogsRoutes(app: Express) {
  // ── POST /api/game/logs ──
  // Records a completed game session for the authenticated user.
  // Any authenticated role (individual, organization, admin) may write their own logs.
  app.post('/api/game/logs', async (req: Request, res: Response) => {
    try {
      const user = await authenticateToken(bearer(req));
      if (!user) return res.status(401).json({ error: 'UNAUTHENTICATED' });

      const body = req.body || {};
      const mode = String(body.mode || '').trim();
      if (!mode) return res.status(400).json({ error: 'INVALID_MODE', message: 'mode is required.' });

      const score = Number.parseInt(String(body.score || '0'), 10) || 0;
      const maxPossible = Number.parseInt(String(body.maxPossible || '0'), 10) || 0;
      const roundsCount = Number.parseInt(String(body.roundsCount || '0'), 10) || 0;
      const matchId = body.matchId ? String(body.matchId).trim() : null;
      const roomCode = body.roomCode ? String(body.roomCode).trim().toUpperCase() : null;
      const sessionData = body.sessionData && typeof body.sessionData === 'object' && !Array.isArray(body.sessionData)
        ? body.sessionData
        : {};

      try {
        await getDbPool().query(
          `INSERT INTO user_game_logs
            (user_id, role, mode, match_id, room_code, score, max_possible, rounds_count, session_data, played_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NOW())`,
          [user.id, user.role, mode, matchId, roomCode, score, maxPossible, roundsCount, JSON.stringify(sessionData)]
        );
        return res.json({ ok: true, message: 'Game log recorded.' });
      } catch (error) {
        console.error('[Game logs] Insert failed:', error);
        return res.status(503).json({ error: 'GAME_LOG_DATABASE_UNAVAILABLE' });
      }
    } catch {
      return res.status(503).json({ error: 'GAME_LOG_DATABASE_UNAVAILABLE' });
    }
  });

  // ── GET /api/game/logs ──
  // Lists game logs for the authenticated user.
  // Admins with user:manage may query another user's logs via ?userId=.
  app.get('/api/game/logs', async (req: Request, res: Response) => {
    try {
      const user = await authenticateToken(bearer(req));
      if (!user) return res.status(401).json({ error: 'UNAUTHENTICATED' });

      const limit = Math.min(MAX_PAGE_SIZE, parsePositiveInt(String(req.query.limit), DEFAULT_PAGE_SIZE));
      const offset = parseNonNegativeInt(String(req.query.offset), 0);
      const modeFilter = String(req.query.mode || '').trim();
      const from = String(req.query.from || '').trim();
      const to = String(req.query.to || '').trim();

      let targetUserId: number = user.id;
      let isAdminQueryingOthers = false;

      const requestedUserId = req.query.userId;
      if (requestedUserId !== undefined) {
        if (!user.permissions.includes('user:manage')) {
          return res.status(403).json({ error: 'FORBIDDEN', message: 'Only administrators may query another user game logs.' });
        }
        const parsed = Number.parseInt(String(requestedUserId), 10);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          return res.status(400).json({ error: 'INVALID_USER_ID', message: 'userId must be a positive integer.' });
        }
        targetUserId = parsed;
        isAdminQueryingOthers = true;
      }

      const filters: string[] = [];
      const values: unknown[] = [];
      values.push(targetUserId);
      filters.push(`user_id = $${values.length}`);

      if (modeFilter) {
        values.push(modeFilter);
        filters.push(`mode = $${values.length}`);
      }
      if (from) {
        values.push(from);
        filters.push(`played_at >= $${values.length}::timestamptz`);
      }
      if (to) {
        values.push(to);
        filters.push(`played_at < ($${values.length}::date + INTERVAL '1 day')`);
      }
      const where = filters.join(' AND ');

      try {
        const countResult = await getDbPool().query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM user_game_logs WHERE ${where}`, values
        );
        const listValues = [...values, limit, offset];
        const { rows } = await getDbPool().query<any>(
          `SELECT id, user_id, role, mode, match_id, room_code, score, max_possible, rounds_count,
                  session_data, played_at, created_at
           FROM user_game_logs
           WHERE ${where}
           ORDER BY played_at DESC
           LIMIT $${listValues.length - 1} OFFSET $${listValues.length}`,
          listValues
        );
        return res.json({
          items: rows.map((row) => ({
            id: row.id,
            userId: row.user_id,
            role: row.role,
            mode: row.mode,
            matchId: row.match_id,
            roomCode: row.room_code,
            score: row.score,
            maxPossible: row.max_possible,
            roundsCount: row.rounds_count,
            sessionData: row.session_data || {},
            playedAt: row.played_at,
            createdAt: row.created_at,
          })),
          total: Number(countResult.rows[0]?.count || 0),
          limit,
          offset,
          isAdminQueryingOthers,
        });
      } catch (error) {
        console.error('[Game logs] List failed:', error);
        return res.status(503).json({ error: 'GAME_LOG_DATABASE_UNAVAILABLE' });
      }
    } catch {
      return res.status(503).json({ error: 'GAME_LOG_DATABASE_UNAVAILABLE' });
    }
  });
}
