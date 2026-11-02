// Cloudflare failover (semi-automatic, Level 2).
//
// Runs on a GitHub Actions cron (*/2 min). Checks the public health endpoint of
// the production site. When Cloudflare's proxy is failing (5xx / timeout), it
// switches the DNS records "@" (apex) and "www" to "DNS Only" so traffic goes
// straight to the Render origin. When the site is healthy again, it
// automatically re-enables the proxy (failback).
//
// Hysteresis to avoid flip-flopping:
//   - failover  after 2 consecutive failed health checks
//   - failback  after 3 consecutive successful health checks
//
// State (consecutive fail/success counters + proxied flag) is persisted in a
// small JSON file, cached between workflow runs via actions/cache.
//
// Required environment (GitHub Actions secrets):
//   CF_ZONE_ID         - Cloudflare zone ID for countdown-studio.id.vn
//   CF_API_TOKEN       - API token with Zone:Read + DNS:Edit on that zone
//   CF_RECORD_ID_APEX  - DNS record ID of the apex "@" CNAME
//   CF_RECORD_ID_WWW   - DNS record ID of the "www" CNAME
// Optional:
//   HEALTH_URL         - defaults to https://countdown-studio.id.vn/api/health
//   STATE_FILE         - defaults to .cf-failover-state.json
//   CF_FAIL_THRESHOLD  - default 2 (consecutive failures before failover)
//   CF_SUCCESS_THRESHOLD - default 3 (consecutive successes before failback)

import { readFileSync, writeFileSync } from 'node:fs';

const ZONE_ID = process.env.CF_ZONE_ID?.trim() || '';
const API_TOKEN = process.env.CF_API_TOKEN?.trim() || '';
const RECORDS = {
  '@ (countdown-studio.id.vn)': process.env.CF_RECORD_ID_APEX?.trim() || '',
  'www': process.env.CF_RECORD_ID_WWW?.trim() || '',
};
const HEALTH_URL =
  process.env.HEALTH_URL?.trim() || 'https://countdown-studio.id.vn/api/health';
const STATE_FILE = process.env.STATE_FILE?.trim() || '.cf-failover-state.json';
const FAIL_THRESHOLD = Number(process.env.CF_FAIL_THRESHOLD) || 2;
const SUCCESS_THRESHOLD = Number(process.env.CF_SUCCESS_THRESHOLD) || 3;

const CF_ERRORS = new Set([520, 521, 522, 523, 524, 525, 526, 527, 530, 502, 503]);

if (!API_TOKEN || !ZONE_ID || Object.values(RECORDS).some((id) => !id)) {
  console.error(
    'Missing configuration. Set CF_ZONE_ID, CF_API_TOKEN, CF_RECORD_ID_APEX ' +
      'and CF_RECORD_ID_WWW (see scripts/cf-lookup.mjs to look up the IDs).',
  );
  process.exit(1);
}

// ── State ────────────────────────────────────────────────────────────────────
function loadState() {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return {
      consecutiveFails: Number(s.consecutiveFails) || 0,
      consecutiveSuccesses: Number(s.consecutiveSuccesses) || 0,
      proxied: typeof s.proxied === 'boolean' ? s.proxied : true,
    };
  } catch {
    return { consecutiveFails: 0, consecutiveSuccesses: 0, proxied: true };
  }
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Health check ─────────────────────────────────────────────────────────────
async function checkHealth() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(HEALTH_URL, {
      signal: controller.signal,
      headers: { 'User-Agent': 'cf-failover-check/1.0' },
      cache: 'no-store',
    });
    if (res.ok) return { ok: true, status: res.status };
    return { ok: false, status: res.status, cf: CF_ERRORS.has(res.status) };
  } catch (err) {
    return { ok: false, status: 0, cf: true, error: String(err?.cause || err) };
  } finally {
    clearTimeout(timer);
  }
}

// ── Cloudflare API ───────────────────────────────────────────────────────────
const CF_BASE = 'https://api.cloudflare.com/client/v4';

async function cfGetRecord(name, id) {
  const res = await fetch(`${CF_BASE}/zones/${ZONE_ID}/dns_records/${id}`, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
  });
  const body = await res.json();
  if (!body.success) throw new Error(`GET ${name}: ${JSON.stringify(body.errors)}`);
  return body.result;
}

async function cfSetProxied(name, id, proxied) {
  const res = await fetch(`${CF_BASE}/zones/${ZONE_ID}/dns_records/${id}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ proxied }),
  });
  const body = await res.json();
  if (!body.success) throw new Error(`PATCH ${name}: ${JSON.stringify(body.errors)}`);
  return body.result;
}

// ── Main ─────────────────────────────────────────────────────────────────────
const state = loadState();
const health = await checkHealth();

console.log(`HEALTH_URL=${HEALTH_URL} -> ${health.ok ? 'OK' : `FAIL(${health.status ?? 'network'})`}`);
if (health.error) console.log(`network error: ${health.error}`);

if (health.ok) {
  state.consecutiveFails = 0;
  state.consecutiveSuccesses += 1;
  if (state.consecutiveSuccesses >= SUCCESS_THRESHOLD && !state.proxied) {
    console.log(`Site stable for ${state.consecutiveSuccesses} checks -> re-enabling Cloudflare proxy (failback)...`);
    for (const [name, id] of Object.entries(RECORDS)) {
      const record = await cfGetRecord(name, id);
      if (record.proxied) {
        console.log(`SKIP ${name}: already proxied.`);
        continue; // API state drifted from our cache; sync silently.
      }
      await cfSetProxied(name, id, true);
      console.log(`Switched ${name} proxied=false -> true`);
    }
    state.proxied = true;
    state.consecutiveSuccesses = 0;
  } else if (!state.proxied) {
    console.log(
      `Failback pending: ${state.consecutiveSuccesses}/${SUCCESS_THRESHOLD} consecutive successes.`,
    );
  }
} else {
  state.consecutiveSuccesses = 0;
  state.consecutiveFails += 1;
  if (state.consecutiveFails >= FAIL_THRESHOLD && state.proxied) {
    console.log(`Site failing for ${state.consecutiveFails} checks -> switching to DNS Only (failover)...`);
    for (const [name, id] of Object.entries(RECORDS)) {
      const record = await cfGetRecord(name, id);
      if (!record.proxied) {
        console.log(`SKIP ${name}: already DNS Only.`);
        continue;
      }
      await cfSetProxied(name, id, false);
      console.log(`Switched ${name} proxied=true -> false (traffic now bypasses Cloudflare)`);
    }
    state.proxied = false;
    state.consecutiveFails = 0;
  } else if (state.proxied) {
    console.log(
      `Failover pending: ${state.consecutiveFails}/${FAIL_THRESHOLD} consecutive failures.` +
        (health.cf ? ' (Cloudflare error status)' : ''),
    );
  }
}

console.log(`STATE proxied=${state.proxied} consecutiveFails=${state.consecutiveFails} consecutiveSuccesses=${state.consecutiveSuccesses}`);
saveState(state);
console.log('DONE');
