import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Resolve the project root regardless of whether the server runs from source
// (tsx server.ts) or from the compiled build (dist-server/server.js).
const currentDir = path.dirname(fileURLToPath(import.meta.url));

export const projectRoot = fs.existsSync(path.join(currentDir, '..', 'package.json'))
  ? path.resolve(currentDir, '..')
  : path.resolve(currentDir, '../..');

export function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
