import crypto from 'crypto';
import { readPositiveInteger } from './env.js';

// ── Session tokens ───────────────────────────────────────────────────────────

const TOKEN_TTL_SECONDS = readPositiveInteger(process.env.AUTH_TOKEN_TTL_SECONDS, 60 * 60 * 24 * 7);

function sessionSecret(): string {
  const secret = process.env.AUTH_TOKEN_SECRET || process.env.SESSION_SECRET;
  if (!secret) throw new Error('AUTH_TOKEN_SECRET is not configured.');
  return secret;
}

function encodeTokenPart(value: string): string {
  return Buffer.from(value).toString('base64url');
}

export function signSession(user: { id: number }): string {
  const payload = encodeTokenPart(JSON.stringify({ sub: user.id, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS }));
  const secret = sessionSecret();
  return `${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

export function readSessionToken(token: string): { sub: number; exp: number } | null {
  try {
    const [payload, signature] = token.split('.');
    const secret = process.env.AUTH_TOKEN_SECRET || process.env.SESSION_SECRET;
    if (!payload || !signature || !secret || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(crypto.createHmac('sha256', secret).update(payload).digest('base64url')))) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { sub: number; exp: number };
    return data.exp > Math.floor(Date.now() / 1000) ? data : null;
  } catch { return null; }
}

// ── Google password-setup tokens ─────────────────────────────────────────────

export interface GoogleSetupPayload {
  purpose: 'google_password_setup';
  sub: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  existingUserId: number | null;
  iat: number;
  exp: number;
}

export function signGoogleSetupToken(data: Omit<GoogleSetupPayload, 'purpose' | 'iat' | 'exp'>): string {
  const secret = sessionSecret();
  const now = Math.floor(Date.now() / 1000);
  const payload: GoogleSetupPayload = {
    ...data,
    purpose: 'google_password_setup',
    iat: now,
    exp: now + 15 * 60, // 15 minutes
  };
  const encoded = encodeTokenPart(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

export function readGoogleSetupToken(token: string): GoogleSetupPayload | null {
  try {
    const [payloadPart, signature] = token.split('.');
    const secret = process.env.AUTH_TOKEN_SECRET || process.env.SESSION_SECRET;
    if (!payloadPart || !signature || !secret) return null;
    const expectedSig = crypto.createHmac('sha256', secret).update(payloadPart).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) return null;
    const data = JSON.parse(Buffer.from(payloadPart, 'base64url').toString()) as GoogleSetupPayload;
    if (data.purpose !== 'google_password_setup' || data.exp <= Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

export function sanitizeGoogleUsername(raw: string): string {
  let cleaned = raw.replace(/[^a-zA-Z0-9_.-]/g, '_').toLowerCase();
  while (cleaned.length < 3) cleaned += `${crypto.randomInt(1, 9)}`;
  return cleaned.slice(0, 32);
}

// ── Google ID token verification ─────────────────────────────────────────────

export async function verifyGoogleIdToken(token: string): Promise<{ sub: string; email: string; name: string; picture?: string } | null> {
  // Only accept a real Google ID token verified by Google's tokeninfo API.
  // Demo tokens and unsigned JWT payloads must never authenticate a user.
  try {
    const url = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok) {
      const data = (await res.json()) as any;
      if (data && data.sub && data.email) {
        const expectedClientId = process.env.GOOGLE_CLIENT_ID;
        if (expectedClientId && data.aud && data.aud !== expectedClientId) {
          console.warn('[Google Auth] Client ID mismatch. Expected:', expectedClientId, 'Got:', data.aud);
          return null;
        }
        return {
          sub: String(data.sub),
          email: String(data.email),
          name: String(data.name || data.email.split('@')[0]),
          picture: data.picture,
        };
      }
    }
  } catch (err) {
    console.warn('[Google Auth] Tokeninfo verification request failed:', err);
  }

  return null;
}
