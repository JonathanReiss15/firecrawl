import { vi } from "vitest";

const evalMock = vi.hoisted(() => vi.fn());

vi.mock("../services/queue-service", () => ({
  getRedisConnection: () => ({ eval: evalMock }),
}));

import {
  finalizeConcurrencyLimitActiveJobRollback,
  getConcurrencyLimitActiveJobsCount,
  pushConcurrencyLimitActiveJob,
  renewConcurrencyLimitActiveJob,
  reserveConcurrencyLimitActiveJob,
  rollbackConcurrencyLimitActiveJob,
} from "./concurrency-redis";

describe("PG concurrency slot reservation", () => {
  beforeEach(() => evalMock.mockReset());

  test("uses one Redis script for capacity check and insertion", async () => {
    evalMock.mockResolvedValue([1, 1]);

    await expect(
      reserveConcurrencyLimitActiveJob("team", "holder", 3, 30_000),
    ).resolves.toMatchObject({
      reserved: true,
      newlyAcquired: true,
      rollbackToken: expect.any(String),
      cleanupToken: null,
    });

    expect(evalMock).toHaveBeenCalledTimes(1);
    const [
      script,
      keyCount,
      key,
      reservationKey,
      holder,
      limit,
      ttl,
      operationToken,
    ] = evalMock.mock.calls[0];
    expect(script).toContain("ZREMRANGEBYSCORE");
    expect(script).toContain("ZCARD");
    expect(script).toContain("ZADD");
    expect(script).toContain("cleanup:");
    expect(keyCount).toBe(2);
    expect(key).toBe("concurrency-limiter:team");
    expect(reservationKey).toBe("concurrency-limiter:team:reservation:holder");
    expect([holder, limit, ttl]).toEqual(["holder", 3, 30_000]);
    expect(operationToken).toEqual(expect.any(String));
  });

  test("preserves denied and idempotent-renewal outcomes", async () => {
    evalMock.mockResolvedValueOnce([0, 0]).mockResolvedValueOnce([1, 0]);

    await expect(
      reserveConcurrencyLimitActiveJob("team", "new", 1, 30_000),
    ).resolves.toEqual({
      reserved: false,
      newlyAcquired: false,
      rollbackToken: null,
      cleanupToken: null,
    });
    await expect(
      reserveConcurrencyLimitActiveJob("team", "existing", 1, 30_000),
    ).resolves.toEqual({
      reserved: true,
      newlyAcquired: false,
      rollbackToken: null,
      cleanupToken: null,
    });
  });

  test("retries an ambiguous reservation reply without losing ownership", async () => {
    evalMock
      .mockRejectedValueOnce(new Error("connection lost after write"))
      .mockResolvedValueOnce([1, 1]);

    await expect(
      reserveConcurrencyLimitActiveJob("team", "holder", 1, 30_000),
    ).resolves.toMatchObject({
      reserved: true,
      newlyAcquired: true,
      rollbackToken: expect.any(String),
      cleanupToken: null,
    });
    expect(evalMock).toHaveBeenCalledTimes(2);
    expect(evalMock.mock.calls[1].slice(1)).toEqual(
      evalMock.mock.calls[0].slice(1),
    );
  });

  test("surfaces an abandoned cleanup tombstone for recovery", async () => {
    evalMock.mockResolvedValueOnce([2, "abandoned-token"]);

    await expect(
      reserveConcurrencyLimitActiveJob("team", "holder", 1, 30_000),
    ).resolves.toEqual({
      reserved: false,
      newlyAcquired: false,
      rollbackToken: null,
      cleanupToken: "abandoned-token",
    });
  });

  test("guarded rollback refuses to delete a replacement owner", async () => {
    evalMock.mockResolvedValueOnce(0);

    await expect(
      rollbackConcurrencyLimitActiveJob("team", "holder", "stale-token"),
    ).resolves.toBe(false);
    expect(evalMock.mock.calls[0]).toEqual([
      expect.stringContaining("GET"),
      2,
      "concurrency-limiter:team",
      "concurrency-limiter:team:reservation:holder",
      "holder",
      "stale-token",
    ]);
  });

  test("finalizes the cleanup tombstone by ownership token", async () => {
    evalMock.mockResolvedValueOnce(1);

    await expect(
      finalizeConcurrencyLimitActiveJobRollback(
        "team",
        "holder",
        "owned-token",
      ),
    ).resolves.toBe(true);
    expect(evalMock.mock.calls[0]).toEqual([
      expect.stringContaining("cleanup:"),
      1,
      "concurrency-limiter:team:reservation:holder",
      "owned-token",
    ]);
  });

  test("uses Redis time for legacy reads, writes, and renewals", async () => {
    evalMock
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1);

    await expect(getConcurrencyLimitActiveJobsCount("team")).resolves.toBe(2);
    await pushConcurrencyLimitActiveJob("team", "holder", 30_000);
    await expect(
      renewConcurrencyLimitActiveJob("team", "holder", 30_000),
    ).resolves.toBe(true);

    expect(evalMock.mock.calls[0][0]).toContain("redis.call('TIME')");
    expect(evalMock.mock.calls[1][0]).toContain("redis.call('TIME')");
    expect(evalMock.mock.calls[2][0]).toContain("redis.call('TIME')");
  });
});
