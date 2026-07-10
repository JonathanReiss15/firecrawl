import { randomUUID } from "crypto";
import { getRedisConnection } from "../services/queue-service";

// Redis primitives of the concurrency limiter, split out of
// concurrency-limit.ts so light consumers (the NuQ dual-backend router) can
// use them without dragging in the scraper tree via crawl-redis.

// min 50k, max 2M, 2000 per concurrent browser
export function getTeamQueueLimit(concurrencyLimit: number): number {
  return Math.min(Math.max(concurrencyLimit * 2000, 50_000), 2_000_000);
}

// Upper bound for how long a job may sit in the concurrency-limit backlog.
// This bounds both the Redis ZSET score and the Postgres `times_out_at`
// column on `nuq.queue_scrape_backlog`, so the reaper can always evict
// stale rows. A backlogged crawl job that outlives this window is
// unrecoverable anyway — its StoredCrawl in Redis (24h TTL) is gone.
export const MAX_BACKLOG_TIMEOUT_MS = 172800000; // 48h

export const constructConcurrencyLimitKey = (team_id: string) =>
  "concurrency-limiter:" + team_id;

const constructConcurrencyReservationKey = (teamId: string, id: string) =>
  `${constructConcurrencyLimitKey(teamId)}:reservation:${id}`;

const countConcurrencySlotsScript = `
local t = redis.call('TIME')
local now_ms = t[1] * 1000 + math.floor(t[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now_ms)
return redis.call('ZCARD', KEYS[1])
`;

export async function getConcurrencyLimitActiveJobsCount(
  team_id: string,
): Promise<number> {
  return (await getRedisConnection().eval(
    countConcurrencySlotsScript,
    1,
    constructConcurrencyLimitKey(team_id),
  )) as number;
}

type ConcurrencySlotReservation = {
  reserved: boolean;
  newlyAcquired: boolean;
  rollbackToken: string | null;
  cleanupToken: string | null;
};

const reserveConcurrencySlotScript = `
local t = redis.call('TIME')
local now_ms = t[1] * 1000 + math.floor(t[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now_ms)

if redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  redis.call('ZADD', KEYS[1], 'XX', now_ms + tonumber(ARGV[3]), ARGV[1])
  if redis.call('GET', KEYS[2]) == 'owner:' .. ARGV[4] then
    redis.call('PEXPIRE', KEYS[2], ARGV[3])
    return {1, 1}
  end
  -- A distinct retry/renewal now owns the stable holder. Fence any older
  -- insertion token without granting this renewal destructive rollback rights.
  redis.call('SET', KEYS[2], 'held', 'PX', ARGV[3])
  return {1, 0}
end

local marker = redis.call('GET', KEYS[2])
if marker then
  if string.sub(marker, 1, 8) == 'cleanup:' then
    return {2, string.sub(marker, 9)}
  end
  return {0, 0}
end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then
  return {0, 0}
end

redis.call('ZADD', KEYS[1], 'NX', now_ms + tonumber(ARGV[3]), ARGV[1])
redis.call('SET', KEYS[2], 'owner:' .. ARGV[4], 'PX', ARGV[3])
return {1, 1}
`;

// The PG capacity ledger is a Redis ZSET. Admission and insertion must remain
// one server-side operation: browser/session requests may arrive concurrently.
export async function reserveConcurrencyLimitActiveJob(
  team_id: string,
  id: string,
  limit: number,
  timeout: number,
): Promise<ConcurrencySlotReservation> {
  const redis = getRedisConnection();
  const operationToken = randomUUID();
  let result: [number, number | string] | null = null;
  let firstError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      result = (await redis.eval(
        reserveConcurrencySlotScript,
        2,
        constructConcurrencyLimitKey(team_id),
        constructConcurrencyReservationKey(team_id, id),
        id,
        limit,
        timeout,
        operationToken,
      )) as [number, number | string];
      break;
    } catch (error) {
      if (attempt === 1) {
        throw new AggregateError(
          firstError === undefined ? [error] : [firstError, error],
          "Redis concurrency reservation failed after idempotent retry",
        );
      }
      firstError = error;
    }
  }
  const [status, detail] = result!;
  const newlyAcquired = status === 1 && detail === 1;
  return {
    reserved: status === 1,
    newlyAcquired,
    rollbackToken: newlyAcquired ? operationToken : null,
    cleanupToken: status === 2 ? String(detail) : null,
  };
}

const pushConcurrencySlotScript = `
local marker = redis.call('GET', KEYS[2])
if marker and string.sub(marker, 1, 8) == 'cleanup:' then return 0 end
local t = redis.call('TIME')
local now_ms = t[1] * 1000 + math.floor(t[2] / 1000)
redis.call('DEL', KEYS[2])
return redis.call('ZADD', KEYS[1], now_ms + tonumber(ARGV[2]), ARGV[1])
`;

export async function pushConcurrencyLimitActiveJob(
  team_id: string,
  id: string,
  timeout: number,
) {
  await getRedisConnection().eval(
    pushConcurrencySlotScript,
    2,
    constructConcurrencyLimitKey(team_id),
    constructConcurrencyReservationKey(team_id, id),
    id,
    timeout,
  );
}

const removeConcurrencySlotScript = `
if redis.call('ZREM', KEYS[1], ARGV[1]) == 0 then return 0 end
local marker = redis.call('GET', KEYS[2])
if marker and string.sub(marker, 1, 8) ~= 'cleanup:' then
  redis.call('DEL', KEYS[2])
end
return 1
`;

export async function removeConcurrencyLimitActiveJob(
  team_id: string,
  id: string,
) {
  await getRedisConnection().eval(
    removeConcurrencySlotScript,
    2,
    constructConcurrencyLimitKey(team_id),
    constructConcurrencyReservationKey(team_id, id),
    id,
  );
}

const rollbackConcurrencySlotScript = `
if redis.call('GET', KEYS[2]) ~= 'owner:' .. ARGV[2] then return 0 end
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], 'cleanup:' .. ARGV[2])
redis.call('PERSIST', KEYS[2])
return 1
`;

export async function rollbackConcurrencyLimitActiveJob(
  teamId: string,
  id: string,
  rollbackToken: string,
): Promise<boolean> {
  return (
    (await getRedisConnection().eval(
      rollbackConcurrencySlotScript,
      2,
      constructConcurrencyLimitKey(teamId),
      constructConcurrencyReservationKey(teamId, id),
      id,
      rollbackToken,
    )) === 1
  );
}

const finalizeConcurrencyRollbackScript = `
if redis.call('GET', KEYS[1]) ~= 'cleanup:' .. ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
return 1
`;

export async function finalizeConcurrencyLimitActiveJobRollback(
  teamId: string,
  id: string,
  rollbackToken: string,
): Promise<boolean> {
  return (
    (await getRedisConnection().eval(
      finalizeConcurrencyRollbackScript,
      1,
      constructConcurrencyReservationKey(teamId, id),
      rollbackToken,
    )) === 1
  );
}

const renewConcurrencySlotScript = `
local t = redis.call('TIME')
local now_ms = t[1] * 1000 + math.floor(t[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now_ms)
if not redis.call('ZSCORE', KEYS[1], ARGV[1]) then return 0 end
redis.call('ZADD', KEYS[1], 'XX', now_ms + tonumber(ARGV[2]), ARGV[1])
-- Heartbeat renewal fences a delayed rollback from the original insertion.
redis.call('SET', KEYS[2], 'held', 'PX', ARGV[2])
return 1
`;

export async function renewConcurrencyLimitActiveJob(
  teamId: string,
  id: string,
  timeout: number,
): Promise<boolean> {
  return (
    (await getRedisConnection().eval(
      renewConcurrencySlotScript,
      2,
      constructConcurrencyLimitKey(teamId),
      constructConcurrencyReservationKey(teamId, id),
      id,
      timeout,
    )) === 1
  );
}
