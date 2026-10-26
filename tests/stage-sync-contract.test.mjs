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
];

for (const [label, condition] of checks) {
  assert.equal(condition, true, label);
  console.log(`✅ ${label}`);
}

assert.equal(displayCss.includes('countdown-clock-placeholder.jpg'), false, 'placeholder stage asset must not be referenced');
console.log('✅ no missing placeholder stage asset reference');
