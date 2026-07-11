import { createHash } from "node:crypto";
import { deleteKey, getValue, setValue } from "./redis";

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const CACHE_HASH_LENGTH = 32;
const CLOCK_SKEW_SECONDS = 30;

export function hashOAuthToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function cacheHash(tokenHash: string): string {
  if (!SHA256_HEX_PATTERN.test(tokenHash)) {
    throw new Error("OAuth token hash must be lowercase SHA-256 hex");
  }
  return tokenHash.slice(0, CACHE_HASH_LENGTH);
}

export function oauthPositiveCacheKey(tokenHash: string): string {
  return `oauth_token:${cacheHash(tokenHash)}`;
}

export function oauthRevocationKey(tokenHash: string): string {
  return `oauth_token_revoked:${cacheHash(tokenHash)}`;
}

export function oauthRevocationTtlSeconds(
  expiresAt: string | Date,
  now = new Date(),
): number {
  const expiryMs = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiryMs)) {
    throw new Error("OAuth token expiry must be a valid timestamp");
  }
  const secondsUntilExpiry = Math.ceil((expiryMs - now.getTime()) / 1000);
  return Math.max(CLOCK_SKEW_SECONDS, secondsUntilExpiry + CLOCK_SKEW_SECONDS);
}

export async function getOAuthTokenCacheState(tokenHash: string): Promise<{
  revoked: boolean;
  cached: string | null;
}> {
  const revoked = await getValue(oauthRevocationKey(tokenHash));
  if (revoked !== null) return { revoked: true, cached: null };
  return {
    revoked: false,
    cached: await getValue(oauthPositiveCacheKey(tokenHash)),
  };
}

export async function isOAuthTokenRevoked(tokenHash: string): Promise<boolean> {
  return (await getValue(oauthRevocationKey(tokenHash))) !== null;
}

export async function setOAuthTokenCache(
  tokenHash: string,
  value: string,
  ttlSeconds: number,
): Promise<void> {
  await setValue(oauthPositiveCacheKey(tokenHash), value, ttlSeconds);
}

export async function invalidateOAuthTokenCache(
  tokenHash: string,
  expiresAt: string | Date,
  now = new Date(),
): Promise<void> {
  const ttlSeconds = oauthRevocationTtlSeconds(expiresAt, now);
  await setValue(oauthRevocationKey(tokenHash), "1", ttlSeconds);
  await deleteKey(oauthPositiveCacheKey(tokenHash));
}
