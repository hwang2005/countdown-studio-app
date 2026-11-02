// One-shot helper: prints the Cloudflare zone ID and DNS record IDs needed by
// cloudflare-failover.mjs so you can copy them into GitHub Actions secrets.
//
//   CF_ZONE_ID, CF_RECORD_ID_APEX (@), CF_RECORD_ID_WWW (www)
//
// Usage:  CF_API_TOKEN=... node scripts/cf-lookup.mjs  [zoneName]
//         (on Windows PowerShell:  $env:CF_API_TOKEN="..."; node scripts/cf-lookup.mjs)
//
// Token needs the "Zone:Read" + "DNS:Read" permissions (View template works too).

const API_TOKEN = process.env.CF_API_TOKEN?.trim() || '';
const ZONE_NAME = process.argv[2]?.trim() || 'countdown-studio.id.vn';

if (!API_TOKEN) {
  console.error('Set CF_API_TOKEN in the environment first.');
  process.exit(1);
}

const headers = { Authorization: `Bearer ${API_TOKEN}` };
const base = 'https://api.cloudflare.com/client/v4';

const zres = await fetch(`${base}/zones?name=${encodeURIComponent(ZONE_NAME)}`, { headers });
const zbody = await zres.json();
if (!zbody.success || zbody.result.length === 0) {
  console.error(`Zone "${ZONE_NAME}" not found: ${JSON.stringify(zbody.errors)}`);
  process.exit(1);
}

const zone = zbody.result[0];
console.log(`Zone:            ${zone.name}`);
console.log(`CF_ZONE_ID:      ${zone.id}`);
console.log('');

const rres = await fetch(`${base}/zones/${zone.id}/dns_records?per_page=100`, { headers });
const rbody = await rres.json();
if (!rbody.success) {
  console.error(`Failed to list DNS records: ${JSON.stringify(rbody.errors)}`);
  process.exit(1);
}

let apex = rbody.result.find((r) => r.name === zone.name);
let www = rbody.result.find((r) => r.name === `www.${zone.name}`);

for (const [label, rec] of [['CF_RECORD_ID_APEX', apex], ['CF_RECORD_ID_WWW', www]]) {
  if (rec) {
    console.log(`${label.padEnd(16)} ${rec.id}   (${rec.type} ${rec.name} -> ${rec.content}, proxied=${rec.proxied})`);
  } else {
    console.log(`${label.padEnd(16)} NOT FOUND - create the record first, then re-run.`);
  }
}
