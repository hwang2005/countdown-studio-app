import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const server = read('server.ts');
const sync = read('js/net/sync.js');
const host = read('js/app-host.js');
const display = read('js/app-display.js');
const displayCss = read('css/display.css');
const roomMigration = read('database/versus-room-history.sql');
const packageJson = read('package.json');
const seedAccounts = read('scripts/seed-test-accounts.ts');

const checks = [
  ['rooms retain stage configuration', server.includes('stageConfig')],
  ['server validates WebSocket message size', server.includes('MAX_WS_MESSAGE_BYTES')],
  ['server accepts display buzzer requests', server.includes("type === 'display:buzz'")],
  ['server accepts display state requests', server.includes("type === 'display:request_state'")],
  ['server restricts stage configuration to Host', server.includes("type === 'host:stage_config'")],
  ['server validates room identity on forwarded messages', server.includes('Room identifier does not match')],
  ['client forwards remote display buzzer', sync.includes("type: 'display:buzz'")],
  ['client forwards remote state requests', sync.includes("type: 'display:request_state'")],
  ['client receives remote stage config', sync.includes("type: 'STAGE_CONFIG_SYNC'")],
  ['Host publishes saved stage setup after connecting', host.includes("send('STAGE_LAYOUT_SYNC', loadStageLayout())")],
  ['Display applies initial and incremental stage config', display.includes('config.kind === \'layout\'' )],
  ['Display uses the real SVG stage background fallback', displayCss.includes('url(\'../assets/stage-bg.svg\')')],
  ['persistent room migration defines active rooms', roomMigration.includes('CREATE TABLE IF NOT EXISTS versus_rooms')],
  ['archive migration is idempotent per room lifecycle', roomMigration.includes('uq_versus_archive_room_once')],
  ['server restores persistent rooms on startup', server.includes('hydratePersistentRooms()')],
  ['server archives closed rooms transactionally', server.includes('archiveAndCloseRoom') && server.includes('ON CONFLICT (room_id) DO NOTHING')],
  ['server exposes permission-scoped history APIs', server.includes("/api/versus/history") && server.includes("requirePermission('host:operations')")],
  ['Host Console renders archived history', host.includes('loadMatchHistory') && host.includes('host-history-list')],
  ['test account bootstrap uses environment passwords', seedAccounts.includes('TEST_INDIVIDUAL_PASSWORD') && seedAccounts.includes('TEST_ADMIN_PASSWORD')],
  ['test account bootstrap is available as an npm script', packageJson.includes('seed:test-accounts')],
  ['server relays display panic dismissal to the Host', server.includes("type === 'display:clear_panic'") && server.includes("'room:clear_panic'")],
  ['client forwards remote display panic dismissal', sync.includes("type: 'display:clear_panic'") && sync.includes("'room:clear_panic'")],
  ['client stops the reconnect loop on fatal login errors', sync.includes('TOO_MANY_FAILED_ATTEMPTS') && sync.includes('INVALID_PIN_FORMAT')],
  ['client keeps a long reconnect budget for display reattachment', sync.includes('MAX_REMOTE_CONNECT_ATTEMPTS = 12')],
  ['server acknowledges state requests with no stored state', server.includes("'stage:empty'")],
  ['server exposes admin organization provisioning', server.includes("'/api/admin/users'") && server.includes("Role must be 'organization' or 'individual'.")],
  ['admin provisioning is gated behind user management permission', server.includes("requirePermission('user:manage')")],
  ['Host Console history supports room and date filters', host.includes('host-history-filter-room') && host.includes('/api/versus/history?')],
  ['Host Console offers incremental history pagination', host.includes('host-btn-more-history') && host.includes('append: true')],
  ['Display lazily loads the embedded host console iframe', display.includes('stage-host-iframe') && display.includes('dataset.src')],
  ['Display avoids requesting state before the room socket exists', display.includes('if (!syncChannel.roomId)')],
  ['Host never persists the plaintext room PIN', !host.includes('countdown_studio_host_pin_v1')],
  ['history list rejects invalid date filters', server.includes('INVALID_HISTORY_FILTER')],
];

for (const [label, condition] of checks) {
  assert.equal(condition, true, label);
  console.log(`✅ ${label}`);
}

assert.equal(displayCss.includes('countdown-clock-placeholder.jpg'), false, 'placeholder stage asset must not be referenced');
console.log('✅ no missing placeholder stage asset reference');
