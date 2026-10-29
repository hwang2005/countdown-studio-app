import fs from 'fs';
import type { Express, Request, Response } from 'express';
import path from 'path';
import { projectRoot } from '../env.js';
import { addVary } from '../middleware.js';
import { resolveAssetPath } from '../assets.js';

// Serve llms.txt (agent instructions)
function sendLlmsTxt(_req: Request, res: Response) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  const target = resolveAssetPath(
    path.join(projectRoot, 'llms.txt'),
    path.join(projectRoot, 'public', 'llms.txt')
  );
  if (target) return res.sendFile(target);
  return res.status(404).send('# llms.txt not found');
}

// ── Trust anchor pages (/about, /contact, /privacy) ──────────────────────────
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

function sendTrustPage(pageFile: string, notFoundMessage: string) {
  return (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    const target = resolveAssetPath(
      path.join(projectRoot, pageFile),
      path.join(projectRoot, 'dist', pageFile)
    );
    if (target) return res.sendFile(target);
    return res.status(404).send(notFoundMessage);
  };
}

export function registerAgentRoutes(app: Express) {
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
}

// Homepage Markdown negotiation (acceptmarkdown.com check).
// When an agent sends Accept: text/markdown we return a Markdown summary of
// the site instead of the HTML page. HTML clients are unaffected.
export function registerHomepageRoutes(app: Express) {
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
      '- `POST /api/auth/forgot-password` — Request a password reset email for `{ email }`; always returns a generic success message',
      '- `POST /api/auth/reset-password` — Complete a reset with `{ token, password }`; the token is single-use and expires in 30 minutes',
      '- `GET /api/auth/me` — Return authenticated user (requires `Authorization: Bearer <token>`)',
      '- `WebSocket /ws` — Real-time game state sync (host broadcast + display sync)',
    ].join('\n');

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).send(body);
  });

  app.get('/about', trustPageMarkdown('About', 'https://www.countdown-studio.id.vn/about', 'about.html'), sendTrustPage('about.html', 'About page not found'));
  app.get('/contact', trustPageMarkdown('Contact', 'https://www.countdown-studio.id.vn/contact', 'contact.html'), sendTrustPage('contact.html', 'Contact page not found'));
  app.get('/privacy', trustPageMarkdown('Privacy Policy', 'https://www.countdown-studio.id.vn/privacy', 'privacy.html'), sendTrustPage('privacy.html', 'Privacy page not found'));
}

// Universal 404 handler for nonexistent paths (runs in both dev and prod)
export function registerNotFoundHandler(app: Express) {
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
}
