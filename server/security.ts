import crypto from 'crypto';
import type { Request } from 'express';
import { readPositiveInteger } from './env.js';

// ── Password hashing ─────────────────────────────────────────────────────────

export function scryptAsync(password: string, salt: string, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

export const DUMMY_HASH = 'scrypt$00000000000000000000000000000000$00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';

export async function hashPassword(password: string, salt = crypto.randomBytes(16).toString('hex')): Promise<string> {
  const derivedKey = await scryptAsync(password, salt, 64);
  return `scrypt$${salt}$${derivedKey.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [, salt, hash] = stored.split('$');
    if (!salt || !hash) return false;
    const actual = await scryptAsync(password, salt, 64);
    const expected = Buffer.from(hash, 'hex');
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ── In-memory IP rate limiter ────────────────────────────────────────────────

export interface RateLimitRecord {
  count: number;
  resetAt: number;
}

const rateLimitMap = new Map<string, RateLimitRecord>();

export function checkRateLimit(ip: string, action: string, maxAttempts: number, windowMs: number): boolean {
  const key = `${action}:${ip}`;
  const now = Date.now();
  const record = rateLimitMap.get(key);
  if (!record || now > record.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (record.count >= maxAttempts) {
    return false;
  }
  record.count += 1;
  return true;
}

export function getClientIp(req: Request): string {
  const forwarded = req.get('x-forwarded-for');
  if (forwarded) {
    // Behind a single trusted reverse proxy (Render, nginx), the proxy APPENDS
    // the real client address, so the last entry is the only one the attacker
    // cannot forge by sending their own X-Forwarded-For header. Taking the
    // first entry would let spoofed IPs rotate the per-IP rate limits.
    const parts = forwarded.split(',').map((value) => value.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.socket.remoteAddress || '127.0.0.1';
}

setInterval(() => {
  const now = Date.now();
  for (const [key, record] of rateLimitMap.entries()) {
    if (now > record.resetAt) {
      rateLimitMap.delete(key);
    }
  }
}, 5 * 60 * 1000);

// ── Persistent room-PIN brute-force protection ───────────────────────────────
// The per-connection attempt counter in the WebSocket handler resets on every
// reconnect, so an attacker could brute-force the Host PIN with unlimited
// 5-attempt batches. Failures are therefore tracked per room code across
// connections and the room is locked for a cooldown window once the maximum
// is reached.

export interface RoomPinLockRecord {
  count: number;
  lockedUntil: number;
  resetAt: number;
}

const roomPinLocks = new Map<string, RoomPinLockRecord>();
export const PIN_LOCK_MAX_ATTEMPTS = readPositiveInteger(process.env.PIN_LOCK_MAX_ATTEMPTS, 5);
export const PIN_LOCK_WINDOW_MS = readPositiveInteger(process.env.PIN_LOCK_WINDOW_MS, 15 * 60 * 1000);

export function roomPinLockState(roomId: string): { locked: boolean; remainingSeconds: number; remainingAttempts: number } {
  const now = Date.now();
  const record = roomPinLocks.get(roomId);
  if (!record) {
    return { locked: false, remainingSeconds: 0, remainingAttempts: PIN_LOCK_MAX_ATTEMPTS };
  }
  if (record.lockedUntil > now) {
    return {
      locked: true,
      remainingSeconds: Math.ceil((record.lockedUntil - now) / 1000),
      remainingAttempts: 0,
    };
  }
  if (now > record.resetAt) {
    roomPinLocks.delete(roomId);
    return { locked: false, remainingSeconds: 0, remainingAttempts: PIN_LOCK_MAX_ATTEMPTS };
  }
  return { locked: false, remainingSeconds: 0, remainingAttempts: PIN_LOCK_MAX_ATTEMPTS - record.count };
}

export function recordRoomPinFailure(roomId: string): boolean {
  const now = Date.now();
  let record = roomPinLocks.get(roomId);
  if (!record || now > record.resetAt) {
    record = { count: 0, lockedUntil: 0, resetAt: now + PIN_LOCK_WINDOW_MS };
    roomPinLocks.set(roomId, record);
  }
  record.count += 1;
  if (record.count >= PIN_LOCK_MAX_ATTEMPTS) {
    record.lockedUntil = now + PIN_LOCK_WINDOW_MS;
    return true;
  }
  return false;
}

export function clearRoomPinFailures(roomId: string): void {
  roomPinLocks.delete(roomId);
}

setInterval(() => {
  const now = Date.now();
  for (const [roomId, record] of roomPinLocks.entries()) {
    if (now > record.lockedUntil && now > record.resetAt) {
      roomPinLocks.delete(roomId);
    }
  }
}, 60 * 1000);
