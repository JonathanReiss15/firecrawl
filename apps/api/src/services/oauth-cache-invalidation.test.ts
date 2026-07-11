import { beforeEach, describe, expect, it, vi } from "vitest";

const { claim, acknowledge, invalidate } = vi.hoisted(() => ({
  claim: vi.fn(),
  acknowledge: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock("../db/rpc", () => ({
  oauthClaimCacheInvalidations: claim,
  oauthAckCacheInvalidation: acknowledge,
}));
vi.mock("./oauth-token-cache", () => ({
  invalidateOAuthTokenCache: invalidate,
}));

import {
  runOAuthCacheInvalidationBatch,
  startOAuthCacheInvalidationWorkerIfEnabled,
} from "./oauth-cache-invalidation";

const ROW = {
  id: "9007199254740993",
  access_token_hash: "a".repeat(64),
  access_token_expires_at: "2026-07-12T01:00:00.000Z",
  reason: "grant_revoked",
  attempts: 1,
};

describe("OAuth cache invalidation consumer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claim.mockResolvedValue([ROW]);
    acknowledge.mockResolvedValue(true);
    invalidate.mockResolvedValue(undefined);
  });

  it("claims, invalidates, then acknowledges without coercing bigint IDs", async () => {
    await expect(runOAuthCacheInvalidationBatch()).resolves.toEqual({
      claimed: 1,
      succeeded: 1,
      failed: 0,
    });
    expect(claim).toHaveBeenCalledWith({ limit: 100, leaseSeconds: 30 });
    expect(invalidate).toHaveBeenCalledWith(
      ROW.access_token_hash,
      ROW.access_token_expires_at,
    );
    expect(acknowledge).toHaveBeenCalledWith({
      id: ROW.id,
      attempt: ROW.attempts,
      succeeded: true,
      error: null,
    });
    expect(typeof acknowledge.mock.calls[0][0].id).toBe("string");
  });

  it("schedules retry instead of acknowledging success after Redis failure", async () => {
    invalidate.mockRejectedValue(new Error("redis unavailable"));
    await expect(runOAuthCacheInvalidationBatch()).resolves.toEqual({
      claimed: 1,
      succeeded: 0,
      failed: 1,
    });
    expect(acknowledge).toHaveBeenCalledWith({
      id: ROW.id,
      attempt: ROW.attempts,
      succeeded: false,
      error: "redis unavailable",
    });
  });

  it("leaves an item recoverable when acknowledgement fails", async () => {
    acknowledge
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce(true);
    await expect(runOAuthCacheInvalidationBatch()).resolves.toEqual({
      claimed: 1,
      succeeded: 0,
      failed: 1,
    });
    expect(acknowledge).toHaveBeenNthCalledWith(2, {
      id: ROW.id,
      attempt: ROW.attempts,
      succeeded: false,
      error: "database unavailable",
    });
  });

  it("does not report success when acknowledgement resolves false", async () => {
    acknowledge.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await expect(runOAuthCacheInvalidationBatch()).resolves.toEqual({
      claimed: 1,
      succeeded: 0,
      failed: 1,
    });
    expect(acknowledge).toHaveBeenNthCalledWith(1, {
      id: ROW.id,
      attempt: ROW.attempts,
      succeeded: true,
      error: null,
    });
    expect(acknowledge).toHaveBeenNthCalledWith(2, {
      id: ROW.id,
      attempt: ROW.attempts,
      succeeded: false,
      error: "OAuth cache invalidation acknowledgement failed",
    });
  });

  it("redacts credentials from stored retry errors", async () => {
    invalidate.mockRejectedValue(new Error("Bearer fco_super-secret failed"));
    await runOAuthCacheInvalidationBatch();
    expect(acknowledge).toHaveBeenCalledWith({
      id: ROW.id,
      attempt: ROW.attempts,
      succeeded: false,
      error: "Bearer [redacted] failed",
    });
  });

  it("does not overlap ticks within one process", async () => {
    let release: (() => void) | undefined;
    claim.mockImplementation(
      () => new Promise(resolve => (release = () => resolve([]))),
    );
    const worker = startOAuthCacheInvalidationWorkerIfEnabled({
      enabled: true,
      intervalMs: 1000,
      setIntervalFn: () => ({ unref: vi.fn() }),
      clearIntervalFn: vi.fn(),
    })!;
    const overlapping = worker.run();
    expect(claim).toHaveBeenCalledTimes(1);
    release?.();
    await worker.ready;
    await overlapping;
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("unrefs and stops its polling timer", async () => {
    claim.mockResolvedValue([]);
    const timer = { unref: vi.fn() };
    const clearIntervalFn = vi.fn();
    const worker = startOAuthCacheInvalidationWorkerIfEnabled({
      enabled: true,
      setIntervalFn: (_callback, intervalMs) => {
        expect(intervalMs).toBe(5000);
        return timer;
      },
      clearIntervalFn,
    })!;
    await worker.ready;
    expect(timer.unref).toHaveBeenCalledTimes(1);
    worker.stop();
    expect(clearIntervalFn).toHaveBeenCalledWith(timer);
  });

  it("stays fully dark while disabled", () => {
    const setIntervalFn = vi.fn();
    expect(
      startOAuthCacheInvalidationWorkerIfEnabled({
        enabled: false,
        setIntervalFn,
      }),
    ).toBeNull();
    expect(setIntervalFn).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });
});
