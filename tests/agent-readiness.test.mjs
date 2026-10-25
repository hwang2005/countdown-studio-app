/**
 * Agent-readiness endpoint tests.
 *
 * Run against the LIVE site (or localhost when SERVER_URL is set).
 * These are integration-style smoke tests — no database or auth needed.
 *
 * Usage:
 *   node tests/agent-readiness.test.mjs
 *   SERVER_URL=http://localhost:3000 node tests/agent-readiness.test.mjs
 *
 * Exit code: 0 = all pass, 1 = at least one failure.
 */


const BASE = process.env.SERVER_URL || 'https://www.countdown-studio.id.vn';

let passed = 0;
let failed = 0;

async function check(label, fn) {
  try {
    await fn();
    console.log(`  ✅  ${label}`);
    passed++;
  } catch (err) {
    console.error(`  ❌  ${label}`);
    console.error(`      ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------

async function testMarkdownHomepage() {
  const res = await fetch(`${BASE}/`, {
    headers: { Accept: 'text/markdown' },
    redirect: 'follow',
  });
  assert(res.status === 200, `Expected 200, got ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  assert(ct.includes('text/markdown'), `Expected Content-Type text/markdown, got "${ct}"`);
  const vary = res.headers.get('vary') || '';
  assert(
    vary.toLowerCase().includes('accept'),
    `Expected Vary header to include 'accept', got "${vary}"`
  );
  const body = await res.text();
  assert(body.length > 20, `Markdown body too short (${body.length} chars)`);
  assert(body.includes('#'), 'Body should contain at least one Markdown heading');
}

async function testHtmlHomepage() {
  const res = await fetch(`${BASE}/`, {
    headers: { Accept: 'text/html' },
    redirect: 'follow',
  });
  assert(res.status === 200, `Expected 200, got ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  assert(ct.includes('text/html'), `Expected Content-Type text/html, got "${ct}"`);
  const body = await res.text();
  assert(body.includes('<html'), 'Body should be HTML');
}

async function testMarkdown404() {
  const res = await fetch(`${BASE}/__agent-404-probe-test`, {
    headers: { Accept: 'text/markdown' },
    redirect: 'follow',
  });
  assert(res.status === 404, `Expected HTTP 404, got ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  assert(ct.includes('text/markdown'), `Expected Content-Type text/markdown on 404, got "${ct}"`);
  const vary = res.headers.get('vary') || '';
  assert(
    vary.toLowerCase().includes('accept'),
    `Expected Vary: Accept on 404 response, got "${vary}"`
  );
  const body = await res.text();
  assert(body.length >= 20, `404 Markdown body too short (${body.length} chars)`);
  assert(
    body.toLowerCase().includes('404') || body.toLowerCase().includes('not found'),
    'Body should reference 404 or "not found"'
  );
}

async function testLlmsTxt() {
  const res = await fetch(`${BASE}/llms.txt`, { redirect: 'follow' });
  assert(res.status === 200, `Expected 200, got ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  assert(ct.includes('text/plain'), `Expected text/plain Content-Type, got "${ct}"`);
  const body = await res.text();
  assert(body.includes('When to use'), 'llms.txt should include a "When to use" section');
  assert(body.length > 200, 'llms.txt body too short');
}

async function testSitemapXml() {
  const res = await fetch(`${BASE}/sitemap.xml`, { redirect: 'follow' });
  assert(res.status === 200, `Expected 200, got ${res.status}`);
  const body = await res.text();
  assert(body.includes('<urlset'), 'sitemap.xml should contain <urlset>');
  assert(body.includes('countdown-studio.id.vn'), 'sitemap.xml should contain the domain');
}

async function testJsonLd() {
  const res = await fetch(`${BASE}/`, {
    headers: { Accept: 'text/html' },
    redirect: 'follow',
  });
  const body = await res.text();
  assert(
    body.includes('application/ld+json'),
    'Homepage HTML should include a JSON-LD script block'
  );
  assert(
    body.includes('SoftwareApplication') || body.includes('Organization'),
    'JSON-LD should declare a schema type'
  );
}

// ---------------------------------------------------------------------------

(async () => {
  console.log(`\nAgent-readiness tests → ${BASE}\n`);

  await check('Markdown homepage: returns 200 + Content-Type: text/markdown + Vary: Accept', testMarkdownHomepage);
  await check('HTML homepage: returns 200 + Content-Type: text/html (unchanged for browser clients)', testHtmlHomepage);
  await check('404 with Accept: text/markdown → HTTP 404 + text/markdown body (≥20 chars) + Vary: Accept', testMarkdown404);
  await check('GET /llms.txt → 200 + text/plain + "When to use" section', testLlmsTxt);
  await check('GET /sitemap.xml → 200 + <urlset> XML', testSitemapXml);
  await check('Homepage HTML contains JSON-LD structured data', testJsonLd);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
