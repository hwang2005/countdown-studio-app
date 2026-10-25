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
  assert(body.includes('<lastmod>'), 'sitemap.xml should include <lastmod> dates');
  assert(body.includes('/about'), 'sitemap.xml should list /about');
  assert(body.includes('/contact'), 'sitemap.xml should list /contact');
  assert(body.includes('/privacy'), 'sitemap.xml should list /privacy');
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
  assert(body.includes('Organization'), 'JSON-LD should include an Organization type');
  assert(body.includes('contactPoint'), 'Organization JSON-LD should include contactPoint');
  assert(body.includes('PostalAddress'), 'Organization JSON-LD should include address/PostalAddress');
}

async function testMetadataCompleteness() {
  const res = await fetch(`${BASE}/`, {
    headers: { Accept: 'text/html' },
    redirect: 'follow',
  });
  const body = await res.text();
  assert(body.includes('rel="canonical"'), 'Homepage should have a canonical link tag');
  assert(body.includes('og:image'), 'Homepage should have og:image meta tag');
  assert(body.includes('og:type'), 'Homepage should have og:type meta tag');
  assert(body.includes('lang="en"'), 'Homepage html element should have lang attribute');
}

async function testTrustAnchorAbout() {
  const res = await fetch(`${BASE}/about`, {
    headers: { Accept: 'text/html' },
    redirect: 'follow',
  });
  assert(res.status === 200, `Expected 200 for /about, got ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  assert(ct.includes('text/html'), `Expected text/html for /about, got "${ct}"`);
  const body = await res.text();
  assert(body.length >= 500, `/about body too short (${body.length} chars), need ≥500`);
  assert(
    body.toLowerCase().includes('countdown'),
    '/about page should mention Countdown'
  );
}

async function testTrustAnchorContact() {
  const res = await fetch(`${BASE}/contact`, {
    headers: { Accept: 'text/html' },
    redirect: 'follow',
  });
  assert(res.status === 200, `Expected 200 for /contact, got ${res.status}`);
  const body = await res.text();
  assert(body.length >= 500, `/contact body too short (${body.length} chars), need ≥500`);
  assert(body.toLowerCase().includes('email') || body.toLowerCase().includes('contact'),
    '/contact page should contain contact information');
}

async function testTrustAnchorPrivacy() {
  const res = await fetch(`${BASE}/privacy`, {
    headers: { Accept: 'text/html' },
    redirect: 'follow',
  });
  assert(res.status === 200, `Expected 200 for /privacy, got ${res.status}`);
  const body = await res.text();
  assert(body.length >= 500, `/privacy body too short (${body.length} chars), need ≥500`);
  assert(body.toLowerCase().includes('privacy') || body.toLowerCase().includes('data'),
    '/privacy page should mention privacy or data');
}

async function testAboutMarkdownNegotiation() {
  const res = await fetch(`${BASE}/about`, {
    headers: { Accept: 'text/markdown' },
    redirect: 'follow',
  });
  assert(res.status === 200, `Expected 200 for /about with Accept: text/markdown, got ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  assert(ct.includes('text/markdown'), `Expected text/markdown for /about, got "${ct}"`);
  const vary = res.headers.get('vary') || '';
  assert(vary.toLowerCase().includes('accept'), `Expected Vary: Accept on /about, got "${vary}"`);
}

// ---------------------------------------------------------------------------

(async () => {
  console.log(`\nAgent-readiness tests → ${BASE}\n`);

  await check('Markdown homepage: returns 200 + Content-Type: text/markdown + Vary: Accept', testMarkdownHomepage);
  await check('HTML homepage: returns 200 + Content-Type: text/html (unchanged for browser clients)', testHtmlHomepage);
  await check('404 with Accept: text/markdown → HTTP 404 + text/markdown body (≥20 chars) + Vary: Accept', testMarkdown404);
  await check('GET /llms.txt → 200 + text/plain + "When to use" section', testLlmsTxt);
  await check('GET /sitemap.xml → 200 + <urlset> XML + lastmod + /about /contact /privacy', testSitemapXml);
  await check('Homepage HTML contains JSON-LD structured data', testJsonLd);
  await check('Homepage metadata completeness: canonical, og:image, og:type, lang', testMetadataCompleteness);
  await check('GET /about → 200 + HTML + ≥500 chars', testTrustAnchorAbout);
  await check('GET /contact → 200 + HTML + ≥500 chars', testTrustAnchorContact);
  await check('GET /privacy → 200 + HTML + ≥500 chars', testTrustAnchorPrivacy);
  await check('GET /about with Accept: text/markdown → 200 + text/markdown + Vary: Accept', testAboutMarkdownNegotiation);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
