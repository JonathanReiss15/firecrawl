import {
  mirrorExternalSlotRelease,
  renewExternalSlot,
  reserveExternalSlot,
} from "./nuq-router";
import { isSelfHosted } from "../../lib/deployment";
import { ScrapeJobTimeoutError, TransportableError } from "../../lib/error";
import { logger as _logger } from "../../lib/logger";
import { nuqRedis, semaphoreKeys } from "./redis";
import { Gauge, Histogram, register } from "prom-client";

const activeSemaphores = new Gauge({
  name: "noq_semaphore_active",
  help: "Number of active semaphore holders",
});

const semaphoreAcquireDuration = new Histogram({
  name: "noq_semaphore_acquire_duration_seconds",
  help: "Semaphore acquire time",
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

const semaphoreHoldDuration = new Histogram({
  name: "noq_semaphore_hold_duration_seconds",
  help: "Semaphore hold time",
  buckets: [
    0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 10, 15, 20, 30, 60, 120, 300,
  ],
});

const { scripts, runScript, ensure } = nuqRedis;

const SEMAPHORE_TTL = 30 * 1000;
type MirrorState = { acquired: boolean };

async function acquire(
  teamId: string,
  holderId: string,
  limit: number,
): Promise<{ granted: boolean; count: number; removed: number }> {
  await ensure();

  const keys = semaphoreKeys(teamId);
  const [granted, count, removed] = await runScript<[number, number, number]>(
    scripts.semaphore.acquire,
    [keys.leases],
    [holderId, limit, SEMAPHORE_TTL],
  );

  return {
    granted: granted === 1,
    count,
    removed,
  };
}

async function acquireAuthoritativeBlocking(
  teamId: string,
  holderId: string,
  limit: number,
  options: {
    base_delay_ms: number;
    max_delay_ms: number;
    timeout_ms: number;
    signal: AbortSignal;
  },
): Promise<{ limited: boolean; removed: number }> {
  const deadline = Date.now() + options.timeout_ms;
  let delay = options.base_delay_ms;
  let limited = false;
  const endTimer = semaphoreAcquireDuration.startTimer();

  while (true) {
    if (options.signal.aborted || deadline < Date.now()) {
      throw new ScrapeJobTimeoutError();
    }
    if (await reserveExternalSlot(teamId, holderId, SEMAPHORE_TTL, limit)) {
      // An unbounded FDB retry can outlive the caller's deadline. Never start
      // protected work after a late reservation; release the owned holder first.
      if (options.signal.aborted || deadline < Date.now()) {
        await mirrorExternalSlotRelease(teamId, holderId);
        throw new ScrapeJobTimeoutError();
      }
      endTimer();
      return { limited, removed: 0 };
    }
    limited = true;
    const jitter = Math.floor(
      Math.random() * Math.max(1, Math.floor(delay / 4)),
    );
    await new Promise(resolve => setTimeout(resolve, delay + jitter));
    delay = Math.min(options.max_delay_ms, Math.floor(delay * 1.5));
  }
}

async function release(teamId: string, holderId: string): Promise<void> {
  await ensure();

  const keys = semaphoreKeys(teamId);
  await runScript<number>(scripts.semaphore.release, [keys.leases], [holderId]);
}

async function count(teamId: string): Promise<number> {
  await ensure();

  const keys = semaphoreKeys(teamId);
  const count = await nuqRedis.zcard(keys.leases);
  return count;
}

function startHeartbeat(
  teamId: string,
  holderId: string,
  intervalMs: number,
  mirrorState: MirrorState,
) {
  let stopped = false;
  let wake: (() => void) | null = null;

  const sleep = (ms: number) =>
    new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });

  const promise = (async () => {
    try {
      while (!stopped) {
        // This routed holder is the shared queue-capacity authority on both PG
        // and FDB. A swept/expired holder must never be resurrected from a
        // stale request limit; losing ownership makes protected work fail closed.
        const renewed = await renewExternalSlot(
          teamId,
          holderId,
          SEMAPHORE_TTL,
        );
        if (!renewed) {
          throw new TransportableError("SCRAPE_TIMEOUT", "heartbeat_failed");
        }
        mirrorState.acquired = true;
        if (stopped) break;
        await sleep(intervalMs);
      }
    } catch (error) {
      if (!stopped) {
        _logger.error("Error in semaphore heartbeat loop", { error });
        throw error;
      }
    }

    throw new Error("heartbeat loop stopped unexpectedly");
  })();

  return {
    promise,
    async stop() {
      stopped = true;
      wake?.();
      await promise.catch(() => {});
    },
  };
}

// Sync scrapes occupy queue capacity so async jobs see the team's real load.
// Router-owned durable holder pins survive rollout flag changes and remove the
// old convention that an in-memory backend choice was sufficient authority.
async function mirrorSlotRelease(
  teamId: string,
  holderId: string,
  state: MirrorState,
): Promise<void> {
  if (!state.acquired) return;
  await mirrorExternalSlotRelease(teamId, holderId);
  state.acquired = false;
}

async function withSemaphore<T>(
  teamId: string,
  holderId: string,
  limit: number,
  signal: AbortSignal,
  timeoutMs: number,
  func: (limited: boolean) => Promise<T>,
): Promise<T> {
  // Bypass concurrency limits for self-hosted deployments
  if (isSelfHosted()) {
    _logger.debug(`Bypassing concurrency limit for ${teamId}`, {
      teamId,
      jobId: holderId,
    });
    return await func(false);
  }

  // Reserve the backend-specific ledger shared with queue jobs. The legacy
  // `nuq:semaphore` ZSET counts only sync work and cannot safely govern this
  // path during normal PG operation or a backend transition.
  const { limited } = await acquireAuthoritativeBlocking(
    teamId,
    holderId,
    limit,
    {
      base_delay_ms: 25,
      max_delay_ms: 250,
      timeout_ms: timeoutMs,
      signal,
    },
  );

  const endTimer = semaphoreHoldDuration.startTimer();
  const mirrorState: MirrorState = { acquired: true };
  let hb: ReturnType<typeof startHeartbeat> | null = null;

  activeSemaphores.inc();
  try {
    hb = startHeartbeat(teamId, holderId, SEMAPHORE_TTL / 2, mirrorState);

    const result = await Promise.race([func(limited), hb.promise]);
    return result;
  } finally {
    await hb?.stop();

    await mirrorSlotRelease(teamId, holderId, mirrorState).catch(() => {
      _logger.warn("Failed to remove concurrency limit active job", {
        teamId,
        jobId: holderId,
      });
    });

    activeSemaphores.dec();
    endTimer();
  }
}

const getMetrics = async () => {
  return register.metrics();
};

export const teamConcurrencySemaphore = {
  acquire,
  release,
  withSemaphore,
  count,
  getMetrics,
};
