import { beforeEach, describe, expect, it, vi } from "vitest";

const { getValue, setValue, deleteKey } = vi.hoisted(() => ({
  getValue: vi.fn(),
  setValue: vi.fn(),
  deleteKey: vi.fn(),
}));

vi.mock("./redis", () => ({ getValue, setValue, deleteKey }));

import {
  getOAuthTokenCacheState,
  hashOAuthToken,
  invalidateOAuthTokenCache,
  oauthPositiveCacheKey,
  oauthRevocationKey,
  oauthRevocationTtlSeconds,
} from "./oauth-token-cache";

const RAW_TOKEN = "fco_test-token";
const TOKEN_HASH = "a".repeat(32) + "b".repeat(32);

describe("OAuth token cache", () => {
  beforeEach(() => vi.clearAllMocks());

  it("derives matching positive and revocation keys from full hashes", () => {
    const rawHash = hashOAuthToken(RAW_TOKEN);
    expect(oauthPositiveCacheKey(rawHash)).toBe(
      `oauth_token:${rawHash.slice(0, 32)}`,
    );
    expect(oauthRevocationKey(rawHash)).toBe(
      `oauth_token_revoked:${rawHash.slice(0, 32)}`,
    );
  });

  it("rejects malformed or uppercase hashes", () => {
    expect(() => oauthPositiveCacheKey("A".repeat(64))).toThrow(
      "lowercase SHA-256",
    );
    expect(() => oauthPositiveCacheKey("a".repeat(63))).toThrow(
      "lowercase SHA-256",
    );
  });

  it("checks the revocation tombstone before a positive cache entry", async () => {
    getValue.mockResolvedValueOnce("1");
    await expect(getOAuthTokenCacheState(TOKEN_HASH)).resolves.toEqual({
      revoked: true,
      cached: null,
    });
    expect(getValue).toHaveBeenCalledTimes(1);
    expect(getValue).toHaveBeenCalledWith(oauthRevocationKey(TOKEN_HASH));
  });

  it("keeps tombstones through token expiry with clock-skew protection", () => {
    const now = new Date("2026-07-12T00:00:00.000Z");
    expect(oauthRevocationTtlSeconds("2026-07-12T01:00:00.000Z", now)).toBe(
      3630,
    );
    expect(oauthRevocationTtlSeconds("2026-07-11T23:59:00.000Z", now)).toBe(30);
  });

  it("writes a tombstone before deleting the positive cache entry", async () => {
    setValue.mockResolvedValue(undefined);
    deleteKey.mockResolvedValue(undefined);
    await invalidateOAuthTokenCache(
      TOKEN_HASH,
      "2026-07-12T01:00:00.000Z",
      new Date("2026-07-12T00:00:00.000Z"),
    );
    expect(setValue).toHaveBeenCalledWith(
      oauthRevocationKey(TOKEN_HASH),
      "1",
      3630,
    );
    expect(deleteKey).toHaveBeenCalledWith(oauthPositiveCacheKey(TOKEN_HASH));
    expect(setValue.mock.invocationCallOrder[0]).toBeLessThan(
      deleteKey.mock.invocationCallOrder[0],
    );
  });

  it("treats repeated invalidation and a missing positive key as success", async () => {
    setValue.mockResolvedValue(undefined);
    deleteKey.mockResolvedValue(undefined);
    await invalidateOAuthTokenCache(TOKEN_HASH, "2026-07-12T01:00:00.000Z");
    await invalidateOAuthTokenCache(TOKEN_HASH, "2026-07-12T01:00:00.000Z");
    expect(setValue).toHaveBeenCalledTimes(2);
    expect(deleteKey).toHaveBeenCalledTimes(2);
  });
});
