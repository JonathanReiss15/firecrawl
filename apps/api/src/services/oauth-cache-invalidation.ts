import { logger } from "../lib/logger";
import {
  oauthAckCacheInvalidation,
  oauthClaimCacheInvalidations,
} from "../db/rpc";
import { invalidateOAuthTokenCache } from "./oauth-token-cache";

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_LEASE_SECONDS = 30;
const ACKNOWLEDGEMENT_FAILED =
  "OAuth cache invalidation acknowledgement failed";

type Timer = { unref?: () => void };

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
      .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/\b(?:fc-|fco_|fcr_)[A-Za-z0-9_-]+/g, "[redacted]")
      .slice(0, 500);
  }
  return "OAuth cache invalidation failed";
}

export async function runOAuthCacheInvalidationBatch(options?: {
  limit?: number;
  leaseSeconds?: number;
}) {
  const rows = await oauthClaimCacheInvalidations({
    limit: options?.limit ?? DEFAULT_BATCH_SIZE,
    leaseSeconds: options?.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
  });
  let succeeded = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      await invalidateOAuthTokenCache(
        row.access_token_hash,
        row.access_token_expires_at,
      );
      const acknowledged = await oauthAckCacheInvalidation({
        id: row.id,
        attempt: row.attempts,
        succeeded: true,
        error: null,
      });
      if (!acknowledged) throw new Error(ACKNOWLEDGEMENT_FAILED);
      succeeded += 1;
    } catch (error) {
      failed += 1;
      try {
        const retryScheduled = await oauthAckCacheInvalidation({
          id: row.id,
          attempt: row.attempts,
          succeeded: false,
          error: errorMessage(error),
        });
        if (!retryScheduled) {
          logger.warn("OAuth cache invalidation lease was not released", {
            outboxId: row.id,
          });
        }
      } catch (ackError) {
        logger.warn("Failed to schedule OAuth cache invalidation retry", {
          outboxId: row.id,
          error: errorMessage(ackError),
        });
      }
    }
  }

  return { claimed: rows.length, succeeded, failed };
}

function startOAuthCacheInvalidationWorker(options: {
  intervalMs?: number;
  setIntervalFn?: (callback: () => void, intervalMs: number) => Timer;
  clearIntervalFn?: (timer: Timer) => void;
}) {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const setIntervalFn =
    options.setIntervalFn ?? ((callback, ms) => setInterval(callback, ms));
  const clearIntervalFn =
    options.clearIntervalFn ??
    (timer => clearInterval(timer as NodeJS.Timeout));
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runOAuthCacheInvalidationBatch();
      if (result.claimed > 0) {
        logger.info("OAuth cache invalidation batch complete", result);
      }
    } catch (error) {
      logger.warn("OAuth cache invalidation tick failed", {
        error: errorMessage(error),
      });
    } finally {
      running = false;
    }
  };

  const timer = setIntervalFn(() => void run(), intervalMs);
  timer.unref?.();
  const ready = run();
  return {
    ready,
    run,
    stop: () => clearIntervalFn(timer),
  };
}

export function startOAuthCacheInvalidationWorkerIfEnabled(options: {
  enabled: boolean;
  intervalMs?: number;
  setIntervalFn?: (callback: () => void, intervalMs: number) => Timer;
  clearIntervalFn?: (timer: Timer) => void;
}) {
  if (!options.enabled) return null;
  return startOAuthCacheInvalidationWorker(options);
}
