import type { NextFunction, Request, Response } from 'express';

// ── Origin allowlist ─────────────────────────────────────────────────────────

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

export function isAllowedOrigin(origin: string | undefined, request?: { headers?: Record<string, string | string[] | undefined> }): boolean {
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

// ── Response helpers ─────────────────────────────────────────────────────────

// Keep every request header that changes the representation in Vary. This
// matters when a browser request also carries an Origin header: replacing
// `Vary: Origin` with `Vary: Accept` can make a CDN cache the wrong variant.
export function addVary(res: Response, ...fields: string[]) {
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

// ── Middleware stack ─────────────────────────────────────────────────────────

export function applySecurityHeaders(app: import('express').Express) {
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

  applyContentSecurityPolicy(app);
}

// Content-Security-Policy (vibe-check finding: app shipped no CSP at all).
// The pages ship inline bootstrap scripts and load Google Fonts, Google
// Identity Services and badge images, so the policy enumerates exactly those
// sources instead of using wildcards or 'unsafe-eval'. 'unsafe-inline' is
// still required in script-src for the static inline bootstrap scripts on
// GitHub Pages (which cannot serve per-request nonces); moving those scripts
// into files and switching to hashes is the follow-up hardening step.
// Default mode is Report-Only so the site keeps working while violations are
// reviewed; set CSP_MODE=enforce once the browser console is clean.
function applyContentSecurityPolicy(app: import('express').Express) {
  const CSP_MODE = (process.env.CSP_MODE || 'report-only').trim().toLowerCase();
  const CSP_POLICY = (
    process.env.CSP_POLICY || [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://accounts.google.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' data: https://fonts.gstatic.com",
      "img-src 'self' data: https://vietnamcos.com https://api.producthunt.com https://*.googleusercontent.com",
      "media-src 'self'",
      "connect-src 'self' wss://*.onrender.com https://api.datamuse.com https://api.dictionaryapi.dev",
      "frame-src 'self' https://accounts.google.com",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'self'",
    ].join('; ')
  ).trim();
  if (CSP_MODE === 'enforce' || CSP_MODE === 'report-only') {
    app.use((_req: Request, res: Response, next) => {
      res.setHeader(
        CSP_MODE === 'enforce' ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only',
        CSP_POLICY
      );
      next();
    });
  }
}

// CORS is needed by the GitHub Pages/custom-domain frontend when it calls
// the hosted backend. The same allowlist is applied to WebSocket upgrades
// in the WebSocket gateway so an arbitrary website cannot open a browser
// session to this server.
export function applyCors(app: import('express').Express) {
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.get('Origin');

    if (origin && !isAllowedOrigin(origin, req)) {
      return res.status(403).json({ error: 'Origin not allowed' });
    }

    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }

    return next();
  });
}
