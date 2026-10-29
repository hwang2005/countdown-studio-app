import fs from 'fs';

// Resolve the first existing candidate path, or null when none exists.
export function resolveAssetPath(...candidates: string[]): string | null {
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}
