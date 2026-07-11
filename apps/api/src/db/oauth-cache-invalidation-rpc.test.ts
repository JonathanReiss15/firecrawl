import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));

vi.mock("./connection", () => ({
  db: { execute },
  dbIndex: { execute: vi.fn() },
}));

import { oauthAckCacheInvalidation, oauthClaimCacheInvalidations } from "./rpc";

describe("OAuth cache invalidation database RPCs", () => {
  beforeEach(() => vi.clearAllMocks());

  it("claims expiry-bearing rows while preserving bigint IDs as strings", async () => {
    execute.mockResolvedValue({
      rows: [
        {
          id: "9007199254740993",
          access_token_hash: "a".repeat(64),
          access_token_expires_at: new Date("2026-07-12T01:00:00.000Z"),
          reason: "grant_revoked",
          attempts: 1,
        },
      ],
    });
    const rows = await oauthClaimCacheInvalidations({
      limit: 100,
      leaseSeconds: 30,
    });
    expect(rows[0].id).toBe("9007199254740993");
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
    expect(query.sql).toContain("oauth_claim_cache_invalidations");
    expect(query.params).toEqual([100, 30]);
  });

  it("acknowledges using the string bigint identifier", async () => {
    execute.mockResolvedValue({
      rows: [{ oauth_ack_cache_invalidation: true }],
    });
    await expect(
      oauthAckCacheInvalidation({
        id: "9007199254740993",
        attempt: 4,
        succeeded: true,
        error: null,
      }),
    ).resolves.toBe(true);
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
    expect(query.sql).toContain("oauth_ack_cache_invalidation");
    expect(query.sql).toContain("::bigint");
    expect(query.params).toEqual(["9007199254740993", 4, true, null]);
  });
});
