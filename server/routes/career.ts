import type { Express, Request, Response } from 'express';
import { getDbPool } from '../db.js';
import { authenticateToken, bearer } from '../users.js';

export function registerCareerRoutes(app: Express) {
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
}
