import 'dotenv/config';
import http from 'http';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

import { projectRoot } from './server/env.js';
import { applySecurityHeaders, applyCors } from './server/middleware.js';
import { registerAgentRoutes, registerHomepageRoutes, registerNotFoundHandler } from './server/routes/pages.js';
import { registerAdminRoutes } from './server/routes/admin.js';
import { registerAuthRoutes } from './server/routes/auth.js';
import { registerCareerRoutes } from './server/routes/career.js';
import { registerVersusRoutes } from './server/routes/versus.js';
import { createWebSocketGateway } from './server/ws.js';
import { hydratePersistentRooms, startRoomMaintenance } from './server/rooms.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function startServer() {
  const app = express();
  app.disable('x-powered-by');

  applySecurityHeaders(app);
  applyCors(app);
  app.use(express.json({ limit: '100kb' }));

  // ── Agent-readiness endpoints ────────────────────────────────────────────────
  // These routes run before auth so they never touch the database.
  registerAgentRoutes(app);
  registerHomepageRoutes(app);

  registerAdminRoutes(app);
  registerAuthRoutes(app);
  registerCareerRoutes(app);
  registerVersusRoutes(app);

  const server = http.createServer(app);
  createWebSocketGateway(server);

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
  registerNotFoundHandler(app);

  startRoomMaintenance();
  await hydratePersistentRooms();
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, '0.0.0.0', () => {
    console.log(`[Countdown Studio] Server running at http://localhost:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
