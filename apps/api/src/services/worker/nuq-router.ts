import { Logger } from "winston";
import { logger as _logger } from "../../lib/logger";
import { config } from "../../config";
import { RateLimiterMode, ScrapeJobData } from "../../types";
import { getACUCTeam } from "../../controllers/auth";
import { redisEvictConnection } from "../../services/redis";
import { isSelfHosted } from "../../lib/deployment";
import { getApiKeyConcurrencyLimit } from "../../lib/api-key-concurrency";
import { getRedisConnection } from "../queue-service";
import {
  getTeamQueueLimit,
  getConcurrencyLimitActiveJobsCount,
  pushConcurrencyLimitActiveJob,
  removeConcurrencyLimitActiveJob,
  constructConcurrencyLimitKey,
} from "../../lib/concurrency-redis";
import {
  NuQJob,
  NuQJobStatus,
  NuQGroupStatus,
  NuQJobGroupInstance,
  scrapeQueue as scrapeQueuePg,
  crawlFinishedQueue as crawlFinishedQueuePg,
  crawlGroup as crawlGroupPg,
  getNuQPgOwnerLiveResidue,
  type NuQPgOwnerLiveResidue,
  type NuQRemovedJobResidue,
} from "./nuq";
import {
  scrapeQueueFdb,
  crawlFinishedQueueFdb,
  crawlGroupFdb,
  externalSlotsFdb,
  externalSlotMigrationObjectId,
  isFdbConfigured,
  nuqFdbHealthCheck,
  withFdbTimeout,
  NuQFdbQueue,
  NuQFdbJob,
  nuqFdbMigrationStore,
  type MigrationObjectKind,
  type MigrationObjectPin,
} from "./nuq-fdb";
import type { QueueOperationOptions } from "./nuq-worker-runtime";
import {
  DurableNuQPgPublicationAdapter,
  NuQRouterBothBackendsError,
  NuQRouterError,
  NuQRouterObjectNotFoundError,
  NuQRouterPinMismatchError,
  discoverLegacyTeamBackend,
  hasLegacyFdbTeamResidue,
  reconcileDesiredTeamBackend,
  recoverLegacyTeamState,
  reconcileFdbResidueFence,
  reconcilePgResidueFence,
  resolveAuthoritativeObjectBackend,
  type BackendMarker,
} from "./nuq-migration-control";
import {
  passthroughNuQPgPublicationAdapter,
  setNuQPgPublicationAdapter,
} from "./nuq-pg-publication";

// Dual-backend router for the NuQ migration to FoundationDB. FDB migration
// state and object pins are authoritative; Redis backend markers are repairable
// hints only. Production workers still consume PG and FDB via separate
// entrypoints, while this class tracks in-flight backend for direct consumers.

export type QueueBackend = "pg" | "fdb";

export type { NuQJob, NuQJobStatus, NuQGroupStatus, NuQJobGroupInstance };

export function fdbQueueEnabled(): boolean {
  return isFdbConfigured();
}

// PG-only deployments deliberately opt into passthrough. Once FDB migration is
// configured, publication fails closed unless its durable pin/intent commits.
setNuQPgPublicationAdapter(
  fdbQueueEnabled()
    ? new DurableNuQPgPublicationAdapter(nuqFdbMigrationStore)
    : passthroughNuQPgPublicationAdapter,
);

function fdbForced(): boolean {
  // Self-hosted forced-FDB deployments have no legacy PG ledger to migrate.
  // Cloud-wide forcing still flows through durable per-team state.
  return config.NUQ_BACKEND === "fdb" && isSelfHosted();
}

const FDB_OPTIONAL_OP_TIMEOUT_MS = 500;

async function optionalFdbRead<T>(operation: () => Promise<T>): Promise<T> {
  if (fdbForced()) return operation();
  if (!(await nuqFdbHealthCheck(FDB_OPTIONAL_OP_TIMEOUT_MS))) {
    throw new Error("FDB health check failed before optional read");
  }
  return await withFdbTimeout(operation(), FDB_OPTIONAL_OP_TIMEOUT_MS);
}

// Mutations are deliberately never wrapped in a JavaScript timeout and never
// fall back to PG. Await the definitive FDB retry loop; logical operations use
// stable ids so commit-unknown retries reconcile rather than duplicate work.
async function fdbMutation<T>(operation: () => Promise<T>): Promise<T> {
  return await operation();
}

async function desiredTeamBackend(teamId: string): Promise<QueueBackend> {
  if (config.NUQ_BACKEND === "fdb") return "fdb";
  const acuc = await getACUCTeam(teamId, false, true, RateLimiterMode.Crawl);
  return acuc?.flags?.nuqFdb === true ? "fdb" : "pg";
}

async function hasAuthoritativeFdbTeamResidue(
  teamId: string,
): Promise<boolean> {
  return await optionalFdbRead(async () => {
    const [
      scrapePending,
      scrapeActive,
      scrapeIndexedLive,
      crawlFinishedPending,
      crawlFinishedActive,
      crawlFinishedIndexedLive,
      groups,
    ] = await Promise.all([
      scrapeQueueFdb.getTeamPendingCount(teamId),
      scrapeQueueFdb.getTeamActiveCount(teamId),
      scrapeQueueFdb.hasReadyOrActiveJobForOwner(teamId),
      crawlFinishedQueueFdb.getTeamPendingCount(teamId),
      crawlFinishedQueueFdb.getTeamActiveCount(teamId),
      crawlFinishedQueueFdb.hasReadyOrActiveJobForOwner(teamId),
      crawlGroupFdb.getOngoingByOwner(teamId),
    ]);
    return hasLegacyFdbTeamResidue({
      scrapePending,
      scrapeActive,
      scrapeIndexedLive,
      crawlFinishedPending,
      crawlFinishedActive,
      crawlFinishedIndexedLive,
      activeGroups: groups.length,
    });
  });
}

async function requireFdbCoreMetricReadiness(): Promise<void> {
  const [scrape, crawlFinished] = await optionalFdbRead(() =>
    Promise.all([
      scrapeQueueFdb.getMetricCounterBackfillStatus(),
      crawlFinishedQueueFdb.getMetricCounterBackfillStatus(),
    ]),
  );
  if (scrape?.phase !== "ready" || crawlFinished?.phase !== "ready") {
    throw new NuQRouterError(
      "NUQ_FDB_CORE_METRICS_NOT_READY",
      "NuQ FDB migration is frozen until scrape and crawl_finished metric counters are ready",
      true,
    );
  }
}

async function discoverLegacyTeamAuthority(
  teamId: string,
): Promise<QueueBackend> {
  return await discoverLegacyTeamBackend({
    teamId,
    probeFdbResidue: () => hasAuthoritativeFdbTeamResidue(teamId),
    probePgResidue: async () => {
      const [residue, redisOccupancy] = await Promise.all([
        getNuQPgOwnerLiveResidue(teamId),
        getConcurrencyLimitActiveJobsCount(teamId),
      ]);
      return residue.total + redisOccupancy > 0;
    },
    // This rollout starts from PG. Empty is an explicit deployment default,
    // not a fallback after an unavailable FDB probe.
    emptyBackend: "pg",
  });
}

async function ensureMigrationTeamState(teamId: string) {
  let state = await optionalFdbRead(() =>
    nuqFdbMigrationStore.inspectState(teamId),
  );
  if (!state) {
    await requireFdbCoreMetricReadiness();
    state = await fdbMutation(() =>
      recoverLegacyTeamState(nuqFdbMigrationStore, teamId, () =>
        discoverLegacyTeamAuthority(teamId),
      ),
    );
  }
  return state;
}

async function legacyGenerationForBackend(
  teamId: string,
  backend: QueueBackend,
  terminal: boolean,
): Promise<number> {
  const state = await ensureMigrationTeamState(teamId);
  if (state.activeBackend === backend) return state.activeGeneration;
  if (!terminal) {
    throw new NuQRouterPinMismatchError(
      "team",
      teamId,
      state.activeBackend,
      backend,
    );
  }
  for (let generation = state.maxGeneration; generation >= 1; generation--) {
    const record = await optionalFdbRead(() =>
      nuqFdbMigrationStore.inspectGeneration(teamId, generation),
    );
    if (record.generation.backend === backend) return generation;
  }
  throw new NuQRouterPinMismatchError(
    "team",
    teamId,
    state.activeBackend,
    backend,
  );
}

async function reconcileTerminalPgPins(teamId: string): Promise<void> {
  const pins = (await nuqFdbMigrationStore.inspectTeamPins(teamId)).filter(
    pin => pin.backend === "pg" && pin.lifecycle !== "terminal",
  );
  const jobPins = pins.filter(pin => pin.kind === "scrape_job");
  if (jobPins.length > 0) {
    const ids = jobPins.map(pin => pin.objectId);
    const [jobs, backlog] = await Promise.all([
      scrapeQueuePg.getJobs(ids),
      scrapeQueuePg.getJobsFromBacklog(ids),
    ]);
    const byId = new Map([...jobs, ...backlog].map(job => [job.id, job]));
    for (const pin of jobPins) {
      const job = byId.get(pin.objectId);
      const terminal = job?.status === "completed" || job?.status === "failed";
      // A missing prepared object may still be between FDB intent commit and
      // PG publication. Only an observed terminal row, or disappearance after
      // durable activation, proves that its residue can be retired.
      if (terminal || (!job && pin.lifecycle === "active")) {
        await completeRoutingPin(pin, "pg-reconcile-terminal");
      }
    }
  }
  for (const pin of pins) {
    if (pin.kind === "group") {
      const group = await crawlGroupPg.getGroup(pin.objectId);
      if (
        (group && group.status !== "active") ||
        (!group && pin.lifecycle === "active")
      ) {
        await completeRoutingPin(pin, "pg-reconcile-terminal");
      }
    } else if (pin.kind === "external_holder") {
      // Redis disappearance is not terminal evidence (flushes/failovers lose
      // this hint). Explicit release or the corrected durable holder-expiry
      // reconciler owns retirement, so an orphan conservatively blocks seal.
      continue;
    } else if (pin.kind === "crawl_finished") {
      const job = await crawlFinishedQueuePg.getJob(pin.objectId);
      if (
        job?.status === "completed" ||
        job?.status === "failed" ||
        (!job && pin.lifecycle === "active")
      ) {
        await completeRoutingPin(pin, "pg-reconcile-terminal");
      }
    }
  }
}

async function authoritativeTeamBackend(teamId: string): Promise<QueueBackend> {
  if (!fdbQueueEnabled()) return "pg";
  if (fdbForced()) return "fdb";
  const desired = await desiredTeamBackend(teamId);
  let current = await optionalFdbRead(() =>
    nuqFdbMigrationStore.inspectState(teamId),
  );
  if (!current) {
    // Authority discovery must not trust indexes that can still be written by
    // a pre-protocol binary. Core readiness is the release-B deployment fence.
    await requireFdbCoreMetricReadiness();
    current = await fdbMutation(() =>
      recoverLegacyTeamState(nuqFdbMigrationStore, teamId, () =>
        discoverLegacyTeamAuthority(teamId),
      ),
    );
    // Discovery may have lost an initialize-if-absent race. Trust the durable
    // winner exactly as returned; desired begin/cancel is a subsequent request.
    return current.activeBackend;
  }

  const advancingRequestedTransition =
    ((current.phase === "PG_ONLY" || current.phase === "FDB_ONLY") &&
      current.activeBackend !== desired) ||
    current.targetBackend === desired;
  if (advancingRequestedTransition) {
    await requireFdbCoreMetricReadiness();
  }

  // Before pausing PG admissions, snapshot authoritative legacy PG residue
  // into a durable FDB fence. During drain, refresh the fence first and ask
  // finalSeal to decide exclusively from durable counters.
  if (
    desired === "fdb" &&
    current?.activeBackend === "pg" &&
    (current.phase === "PG_ONLY" || current.phase === "DRAINING_TO_FDB")
  ) {
    await fdbMutation(() => reconcileTerminalPgPins(teamId));
    const [residue, redisOccupancy] = await Promise.all([
      getNuQPgOwnerLiveResidue(teamId),
      getConcurrencyLimitActiveJobsCount(teamId),
    ]);
    // Redis is authoritative only for legacy external holders, not backend
    // routing. Including all PG occupancy is conservative and prevents a
    // pre-control-plane holder from becoming invisible to the seal.
    const pgResidueTotal = residue.total + redisOccupancy;
    await fdbMutation(() =>
      reconcilePgResidueFence(nuqFdbMigrationStore, {
        teamId,
        total: pgResidueTotal,
        observationId: `${teamId}/${current!.revision}/${pgResidueTotal === 0 ? "zero" : "nonzero"}`,
      }),
    );
  }

  // Existing FDB records from before generation hooks cannot be reconstructed
  // from the new counters alone. Keep one generation-scoped durable fence until
  // the authoritative source ledgers are empty; this also covers legacy
  // external slots through the team's active count.
  if (
    desired === "pg" &&
    current.activeBackend === "fdb" &&
    (current.phase === "FDB_ONLY" || current.phase === "DRAINING_TO_PG")
  ) {
    const hasFdbResidue = await hasAuthoritativeFdbTeamResidue(teamId);
    await fdbMutation(() =>
      reconcileFdbResidueFence(nuqFdbMigrationStore, {
        teamId,
        total: hasFdbResidue ? 1 : 0,
        observationId: `${teamId}/${current!.revision}/${hasFdbResidue ? "nonzero" : "zero"}`,
      }),
    );
  }

  if (
    current.targetBackend === desired &&
    current.transitionOperationId !== undefined
  ) {
    current = await fdbMutation(() =>
      nuqFdbMigrationStore.finalSeal({
        teamId,
        transitionOperationId: current!.transitionOperationId!,
        expectedRevision: current!.revision,
      }),
    );
  }

  if (current.activeBackend === desired && current.phase !== "ERROR") {
    if (current.phase === "PG_ONLY" || current.phase === "FDB_ONLY") {
      return current.activeBackend;
    }
  }
  const state = await fdbMutation(() =>
    reconcileDesiredTeamBackend(nuqFdbMigrationStore, teamId, desired, () =>
      discoverLegacyTeamAuthority(teamId),
    ),
  );
  return state.activeBackend;
}

async function teamUsesFdbLedger(teamId: string): Promise<boolean> {
  if (!fdbQueueEnabled()) return false;
  if (fdbForced()) return true;
  const state = await optionalFdbRead(() =>
    nuqFdbMigrationStore.inspectState(teamId),
  );
  if (!state) return (await authoritativeTeamBackend(teamId)) === "fdb";
  return state.activeBackend === "fdb" || state.targetBackend === "fdb";
}

// Whether NEW root work may use FDB. A flag only requests a durable state
// transition; transition phases reject admission with a retryable error.
export async function isFdbTeam(teamId: string | undefined): Promise<boolean> {
  if (!teamId || !fdbQueueEnabled()) return false;
  return (await authoritativeTeamBackend(teamId)) === "fdb";
}

export async function resolveNewGroupBackend(
  teamId: string,
): Promise<QueueBackend> {
  return await authoritativeTeamBackend(teamId);
}

function decodeBackendMarker(raw: string | null): BackendMarker {
  if (raw === null) return null;
  return raw === "pg" || raw === "fdb" ? raw : "corrupt";
}

const groupBackendKey = (groupId: string) => `nuq:group_backend:${groupId}`;
const jobBackendKey = (jobId: string) => `nuq:job_backend:${jobId}`;

async function markBackend(key: string, backend: QueueBackend): Promise<void> {
  if (fdbForced()) return;
  await redisEvictConnection.set(key, backend, "EX", 30 * 24 * 60 * 60);
}

async function repairBackendMarker(
  key: string,
  backend: QueueBackend | null,
): Promise<void> {
  if (backend) await markBackend(key, backend);
  else await redisEvictConnection.del(key);
}

async function markJobBackend(
  jobId: string,
  backend: QueueBackend,
): Promise<void> {
  await markBackend(jobBackendKey(jobId), backend);
}

async function readRedisBackendHint(key: string): Promise<string | null> {
  try {
    return await redisEvictConnection.get(key);
  } catch (error) {
    _logger.warn("Failed to read Redis backend hint", {
      module: "nuq-router",
      key,
      error,
    });
    return null;
  }
}

async function pgHasScrapeJob(jobId: string): Promise<boolean> {
  if (await scrapeQueuePg.getJob(jobId)) return true;
  return (await scrapeQueuePg.getJobsFromBacklog([jobId])).length > 0;
}

async function getCrawlQueueBackend(
  crawlId: string,
): Promise<QueueBackend | null> {
  if (fdbForced()) return "fdb";
  const [markerRaw, crawlRaw] = await Promise.all([
    readRedisBackendHint(groupBackendKey(crawlId)),
    readRedisBackendHint("crawl:" + crawlId),
  ]);
  let marker = decodeBackendMarker(markerRaw);
  if (marker === null && crawlRaw) {
    try {
      const stored = JSON.parse(crawlRaw);
      marker =
        stored?.queueBackend === "pg" || stored?.queueBackend === "fdb"
          ? stored.queueBackend
          : stored?.queueBackend === undefined
            ? null
            : "corrupt";
    } catch {
      marker = "corrupt";
    }
  }
  if (!fdbQueueEnabled()) return crawlRaw ? "pg" : null;
  const backend = await resolveAuthoritativeObjectBackend({
    kind: "group",
    objectId: crawlId,
    marker,
    readPin: () =>
      optionalFdbRead(() => nuqFdbMigrationStore.inspectPin("group", crawlId)),
    probeFdb: () =>
      optionalFdbRead(
        async () => (await crawlGroupFdb.getGroup(crawlId)) !== null,
      ),
    probePg: async () => (await crawlGroupPg.getGroup(crawlId)) !== null,
    repairMarker: backend =>
      repairBackendMarker(groupBackendKey(crawlId), backend),
  });
  const existingPin = await optionalFdbRead(() =>
    nuqFdbMigrationStore.inspectPin("group", crawlId),
  );
  if (backend === "fdb" && !existingPin) {
    const group = await optionalFdbRead(() => crawlGroupFdb.getGroup(crawlId));
    if (!group) return null;
    const terminal = group.status !== "active";
    const generation = await legacyGenerationForBackend(
      group.ownerId,
      "fdb",
      terminal,
    );
    await fdbMutation(() =>
      nuqFdbMigrationStore.preparePinnedObject({
        teamId: group.ownerId,
        kind: "group",
        objectId: crawlId,
        admission: {
          type: "legacy-backfill",
          backend: "fdb",
          generation,
          terminal,
        },
        requiredBackend: "fdb",
        residue: { control_groups: terminal ? 0 : 1 },
      }),
    );
  } else if (backend === "pg" && !existingPin) {
    const group = await crawlGroupPg.getGroup(crawlId);
    if (!group) return null;
    const terminal = group.status !== "active";
    const generation = await legacyGenerationForBackend(
      group.ownerId,
      "pg",
      terminal,
    );
    await fdbMutation(() =>
      nuqFdbMigrationStore.preparePinnedObject({
        teamId: group.ownerId,
        kind: "group",
        objectId: crawlId,
        admission: {
          type: "legacy-backfill",
          backend: "pg",
          generation,
          terminal,
        },
        requiredBackend: "pg",
        residue: { control_groups: terminal ? 0 : 1 },
      }),
    );
  }
  return backend;
}

async function getJobQueueBackend(
  jobId: string,
  hint?: QueueBackend,
  probes: {
    kind?: MigrationObjectKind;
    hasFdbJob?: () => Promise<boolean>;
    hasPgJob?: () => Promise<boolean>;
  } = {},
): Promise<QueueBackend | null> {
  if (fdbForced()) return "fdb";
  const cachedMarker = decodeBackendMarker(
    await readRedisBackendHint(jobBackendKey(jobId)),
  );
  const marker = cachedMarker ?? hint ?? null;
  if (!fdbQueueEnabled()) return "pg";
  const kind = probes.kind ?? "scrape_job";
  return await resolveAuthoritativeObjectBackend({
    kind,
    objectId: jobId,
    marker,
    readPin: () =>
      optionalFdbRead(() => nuqFdbMigrationStore.inspectPin(kind, jobId)),
    probeFdb: () =>
      optionalFdbRead(probes.hasFdbJob ?? (() => scrapeQueueFdb.hasJob(jobId))),
    probePg: probes.hasPgJob ?? (() => pgHasScrapeJob(jobId)),
    repairMarker: backend => repairBackendMarker(jobBackendKey(jobId), backend),
  });
}

// Which backend a job belongs to at enqueue time. Crawl jobs follow their
// crawl's pinned backend; standalone jobs follow the team flag.
export async function resolveJobBackend(
  data: ScrapeJobData,
): Promise<QueueBackend> {
  if (!fdbQueueEnabled()) return "pg";
  if (fdbForced()) return "fdb";
  if (data.crawl_id) {
    const backend = await getCrawlQueueBackend(data.crawl_id);
    if (!backend)
      throw new NuQRouterObjectNotFoundError("group", data.crawl_id);
    return backend;
  }
  return await authoritativeTeamBackend(data.team_id);
}

function tagFdbJob<T extends object>(job: T): T & { backend: "fdb" } {
  (job as any).backend = "fdb";
  return job as T & { backend: "fdb" };
}

async function prepareRoutingPin(input: {
  teamId: string;
  kind: MigrationObjectKind;
  objectId: string;
  sourceGroupId?: string;
}): Promise<MigrationObjectPin | null> {
  if (!fdbQueueEnabled() || fdbForced()) return null;
  return await fdbMutation(() =>
    nuqFdbMigrationStore.preparePinnedObject({
      teamId: input.teamId,
      kind: input.kind,
      objectId: input.objectId,
      admission: input.sourceGroupId
        ? {
            type: "pinned-continuation",
            source: { kind: "group", objectId: input.sourceGroupId },
          }
        : { type: "new-root" },
      // The pre-intent fences an ambiguous call boundary. FDB runtime writers
      // consume it into exact residue in the same transaction as their record
      // mutation; PG publication resolves it through the durable saga adapter.
      residue: { intent_unresolved: 1 },
    }),
  );
}

async function activateRoutingPin(
  pin: MigrationObjectPin | null,
  residue: Partial<
    Record<
      | "capacity_team_pending"
      | "capacity_ready_active"
      | "capacity_external_holders"
      | "control_groups",
      number
    >
  >,
  operation: string,
): Promise<void> {
  if (!pin || pin.lifecycle === "active") return;
  const current = await optionalFdbRead(() =>
    nuqFdbMigrationStore.inspectPin(pin.kind, pin.objectId),
  );
  if (current?.lifecycle === "active" || current?.lifecycle === "terminal") {
    return;
  }
  if (!current) {
    throw new Error(`Missing migration pin ${pin.kind}/${pin.objectId}`);
  }
  await fdbMutation(() =>
    nuqFdbMigrationStore.transitionObjectResidue({
      teamId: current.teamId,
      kind: current.kind,
      objectId: current.objectId,
      operationId: `nuq-router/v1/${operation}/${current.objectId}`,
      fromLifecycle: "prepared",
      toLifecycle: "active",
      residue,
    }),
  );
}

async function inspectRoutingPin(
  kind: MigrationObjectKind,
  objectId: string,
): Promise<MigrationObjectPin | null> {
  if (!fdbQueueEnabled() || fdbForced()) return null;
  return await optionalFdbRead(() =>
    nuqFdbMigrationStore.inspectPin(kind, objectId),
  );
}

async function completeRoutingPin(
  pin: MigrationObjectPin | null,
  operation: string,
): Promise<void> {
  if (!pin || pin.lifecycle === "terminal") return;
  // FDB runtime mutations terminalize their pin in the same transaction. The
  // router may hold the pre-mutation snapshot, so re-read before applying the
  // cross-store completion used by PG paths.
  const current = await optionalFdbRead(() =>
    nuqFdbMigrationStore.inspectPin(pin.kind, pin.objectId),
  );
  if (!current || current.lifecycle === "terminal") return;
  const fromLifecycle = current.lifecycle;
  await fdbMutation(() =>
    nuqFdbMigrationStore.completePinnedObject({
      teamId: current.teamId,
      kind: current.kind,
      objectId: current.objectId,
      operationId: `nuq-router/v1/${operation}/${current.objectId}`,
      fromLifecycle,
    }),
  );
}

// === External capacity holders (browser sessions, sync scrapes)
//
// Non-queue work that occupies team capacity is durably pinned. Renew/release
// follows that pin even if the rollout flag changes mid-hold.

async function inspectOrRecoverExternalSlotPin(
  teamId: string,
  holderId: string,
): Promise<MigrationObjectPin | null> {
  if (!fdbQueueEnabled() || fdbForced()) return null;
  const pinId = externalSlotMigrationObjectId(teamId, holderId);
  const existing = await optionalFdbRead(() =>
    nuqFdbMigrationStore.inspectPin("external_holder", pinId),
  );
  if (existing) return existing;

  // Query both holder ledgers before interpreting a legacy record. Redis loss
  // is never evidence for FDB, and simultaneous presence is corruption.
  const [pgScore, fdbPresent] = await Promise.all([
    getRedisConnection().zscore(constructConcurrencyLimitKey(teamId), holderId),
    optionalFdbRead(() => externalSlotsFdb.has(teamId, holderId)),
  ]);
  const pgPresent = pgScore !== null;
  if (pgPresent && fdbPresent) {
    throw new NuQRouterBothBackendsError("external_holder", holderId);
  }
  const backend: QueueBackend | null = pgPresent
    ? "pg"
    : fdbPresent
      ? "fdb"
      : null;
  if (!backend) return null;
  const state = await ensureMigrationTeamState(teamId);
  if (state.activeBackend !== backend) {
    throw new NuQRouterPinMismatchError(
      "external_holder",
      holderId,
      state.activeBackend,
      backend,
    );
  }
  return await fdbMutation(() =>
    nuqFdbMigrationStore.preparePinnedObject({
      teamId,
      kind: "external_holder",
      objectId: pinId,
      admission: {
        type: "legacy-backfill",
        backend,
        generation: state.activeGeneration,
      },
      requiredBackend: backend,
      residue: { capacity_external_holders: 1 },
    }),
  );
}

async function acquireExternalSlot(
  teamId: string,
  holderId: string,
  ttlMs: number,
): Promise<void> {
  const existingPin = await inspectOrRecoverExternalSlotPin(teamId, holderId);
  if (!existingPin) await authoritativeTeamBackend(teamId);
  const pin =
    existingPin ??
    (await prepareRoutingPin({
      teamId,
      kind: "external_holder",
      objectId: externalSlotMigrationObjectId(teamId, holderId),
    }));
  const backend = pin?.backend ?? (await authoritativeTeamBackend(teamId));
  if (backend === "fdb") {
    await fdbMutation(() => externalSlotsFdb.acquire(teamId, holderId, ttlMs));
  } else {
    await pushConcurrencyLimitActiveJob(teamId, holderId, ttlMs);
    await syncFdbLimitToPgOccupancy(teamId);
  }
  await activateRoutingPin(
    pin,
    { capacity_external_holders: 1 },
    "external-holder-active",
  );
}

export async function reserveExternalSlot(
  teamId: string,
  holderId: string,
  ttlMs: number,
  concurrencyLimit: number,
): Promise<boolean> {
  return await withTeamMigrationAdmission(teamId, async () => {
    if ((await getCombinedTeamActiveCount(teamId)) >= concurrencyLimit) {
      return false;
    }
    await acquireExternalSlot(teamId, holderId, ttlMs);
    return true;
  });
}

export async function mirrorExternalSlotAcquire(
  teamId: string,
  holderId: string,
  ttlMs: number,
): Promise<void> {
  await withTeamMigrationAdmission(teamId, async () =>
    acquireExternalSlot(teamId, holderId, ttlMs),
  );
}

export async function mirrorExternalSlotRelease(
  teamId: string,
  holderId: string,
): Promise<void> {
  await withTeamMigrationAdmission(teamId, async () => {
    const pin = await inspectOrRecoverExternalSlotPin(teamId, holderId);
    const backend = pin?.backend ?? (fdbForced() ? "fdb" : "pg");
    if (backend === "fdb") {
      await fdbMutation(() => externalSlotsFdb.release(teamId, holderId));
    } else {
      await removeConcurrencyLimitActiveJob(teamId, holderId);
      await syncFdbLimitToPgOccupancy(teamId);
    }
    await completeRoutingPin(pin, "external-holder-terminal");
  });
}

// Compatibility hook for PG-only call sites. Pause/drain guarantees that PG
// and FDB never admit concurrently, so no cross-ledger limit mirroring exists.
export async function syncFdbLimitToPgOccupancy(
  _teamId: string,
): Promise<void> {}

async function activeTeamBackend(teamId: string): Promise<QueueBackend> {
  if (!fdbQueueEnabled()) return "pg";
  if (fdbForced()) return "fdb";
  const state = await optionalFdbRead(() =>
    nuqFdbMigrationStore.inspectState(teamId),
  );
  return state?.activeBackend ?? (await authoritativeTeamBackend(teamId));
}

export async function getCombinedTeamPendingCount(
  teamId: string,
): Promise<number> {
  if ((await activeTeamBackend(teamId)) === "fdb") {
    return await optionalFdbRead(() =>
      scrapeQueueFdb.getTeamPendingCount(teamId),
    );
  }
  return await getRedisConnection().zcard(`concurrency-limit-queue:${teamId}`);
}

export async function getCombinedTeamActiveCount(
  teamId: string,
): Promise<number> {
  if ((await activeTeamBackend(teamId)) === "fdb") {
    return await optionalFdbRead(() =>
      scrapeQueueFdb.getTeamActiveCount(teamId),
    );
  }
  return await getConcurrencyLimitActiveJobsCount(teamId);
}

// === FDB enqueue (the whole gating block of queue-jobs collapses into this)

export function backlogTimeoutMsForGate(timeoutMs: number): Date {
  return new Date(Date.now() + timeoutMs);
}

// Compatibility boundary retained for callers that release/renew existing
// work. It only verifies that durable FDB authority is reachable. New-root and
// continuation admission happens through conflictful object-pin operations,
// not a process-local critical section.
export async function withTeamMigrationAdmission<T>(
  teamId: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (fdbQueueEnabled() && !fdbForced()) {
    await optionalFdbRead(() => nuqFdbMigrationStore.inspectState(teamId));
  }
  return await operation();
}

export async function getAuthoritativePgOwnerLiveResidue(
  ownerId: string,
): Promise<NuQPgOwnerLiveResidue> {
  return await getNuQPgOwnerLiveResidue(ownerId);
}

export async function fdbEnqueueScrapeJobs(
  jobs: {
    jobId: string;
    data: ScrapeJobData;
    priority: number;
    listenable?: boolean;
    backlogTimeoutMs: number;
  }[],
  teamId: string,
  options?: { bypassGate?: boolean },
): Promise<{
  jobs: (NuQJob<ScrapeJobData> & { backend: "fdb" })[];
  backloggedCount: number;
  teamLimit: number | null;
}> {
  const pins =
    !fdbQueueEnabled() || fdbForced()
      ? jobs.map(() => null)
      : await fdbMutation(() =>
          nuqFdbMigrationStore.preparePinnedObjects(
            jobs.map(job => ({
              teamId,
              kind: "scrape_job" as const,
              objectId: job.jobId,
              admission: job.data.crawl_id
                ? ({
                    type: "pinned-continuation",
                    source: {
                      kind: "group",
                      objectId: job.data.crawl_id,
                    },
                  } as const)
                : ({ type: "new-root" } as const),
              requiredBackend: "fdb" as const,
              residue: { intent_unresolved: 1 },
            })),
          ),
        );
  for (const pin of pins) {
    if (pin && pin.backend !== "fdb") {
      throw new NuQRouterPinMismatchError(
        pin.kind,
        pin.objectId,
        pin.backend,
        "fdb",
      );
    }
  }
  let teamLimit: number | null = null;
  if (!isSelfHosted() && !fdbForced()) {
    const acuc = await getACUCTeam(teamId, false, true, RateLimiterMode.Crawl);
    teamLimit = acuc?.concurrency ?? 2;
  } else if (!isSelfHosted()) {
    const acuc = await getACUCTeam(teamId, false, true, RateLimiterMode.Crawl);
    teamLimit = acuc?.concurrency ?? null;
  }

  const queueCap =
    teamLimit === null ? Number.MAX_SAFE_INTEGER : getTeamQueueLimit(teamLimit);

  // API-key-scoped concurrency: applies when every job in the batch was
  // requested with the same key (batches always are; child jobs inherit the
  // kickoff's apiKeyId) and that key has a limit configured.
  let keyGate: { id: string; limit: number } | null = null;
  if (teamLimit !== null) {
    const keyIds = new Set(jobs.map(j => j.data.apiKeyId ?? null));
    const apiKeyId = keyIds.size === 1 ? [...keyIds][0] : null;
    if (apiKeyId !== null) {
      const keyLimit = await getApiKeyConcurrencyLimit(apiKeyId);
      if (keyLimit !== null) {
        keyGate = { id: String(apiKeyId), limit: keyLimit };
      }
    }
  }

  const results = await fdbMutation(() =>
    scrapeQueueFdb.addJobs(
      jobs.map(j => ({
        id: j.jobId,
        data: j.data,
        options: {
          priority: j.priority,
          listenable: j.listenable ?? false,
          ownerId: j.data.team_id ?? undefined,
          groupId: j.data.crawl_id ?? undefined,
          bypassGate:
            options?.bypassGate ||
            j.data.mode === "kickoff" ||
            j.data.mode === "kickoff_sitemap",
          timesOutAt: new Date(Date.now() + j.backlogTimeoutMs),
        },
      })),
      { teamLimit, queueCap, key: keyGate },
    ),
  );

  const tagged = results.map(r => tagFdbJob(r as NuQJob<ScrapeJobData>));
  await Promise.all(
    tagged.map((job, index) =>
      activateRoutingPin(
        pins[index],
        job.status === "backlog"
          ? { capacity_team_pending: 1 }
          : { capacity_ready_active: 1 },
        "fdb-job-active",
      ),
    ),
  );
  for (const job of tagged) {
    void markJobBackend(job.id, "fdb").catch(error =>
      _logger.warn("Failed to cache FDB job backend", {
        module: "nuq-router",
        jobId: job.id,
        error,
      }),
    );
  }
  return {
    jobs: tagged,
    backloggedCount: tagged.filter(j => j.status === "backlog").length,
    teamLimit,
  };
}

// === Routed scrape queue

const pgRemoveResidueKey = (id: string) => `nuq:pg_remove_residue:${id}`;

async function cleanPgRedisJobResidue(
  id: string,
  removed: NuQRemovedJobResidue | null,
  queuedPayload: string | null,
): Promise<void> {
  let payload: any = null;
  if (queuedPayload) {
    try {
      payload = JSON.parse(queuedPayload);
    } catch {
      // The payload key is deleted below even when corrupt.
    }
  }
  const data = (removed?.data as any) ?? payload?.data;
  const ownerId = removed?.ownerId ?? data?.team_id;
  const groupId = removed?.groupId ?? data?.crawl_id;
  const redis = getRedisConnection();
  const queueKeys = await redis.smembers("concurrency-limit-queues");
  const pipeline = redis.pipeline();
  pipeline.del(`cq-job:${id}`);
  pipeline.del(`cq-claim:${id}`);
  for (const queueKey of queueKeys) pipeline.zrem(queueKey, id);
  if (ownerId) {
    pipeline.zrem(constructConcurrencyLimitKey(ownerId), id);
    pipeline.zrem(`concurrency-limit-queue:${ownerId}`, id);
  }
  if (groupId) pipeline.zrem(`crawl-concurrency-limiter:${groupId}`, id);
  const results = await pipeline.exec();
  const failures =
    results?.filter(
      (result): result is [Error, unknown] => result[0] instanceof Error,
    ) ?? [];
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map(([error]) => error),
      `Failed to remove Redis queue residue for ${id}`,
    );
  }
  // Keep the recovery descriptor until every destructive cleanup command is
  // known successful. A failed final DEL is harmless and retryable.
  await redis.del(pgRemoveResidueKey(id));
}

class RoutedScrapeQueue {
  // in-flight jobs taken by THIS process, so renew/finish/fail can route
  private inflightBackend = new Map<string, QueueBackend>();

  private backendFor(id: string): QueueBackend {
    return this.inflightBackend.get(id) ?? "pg";
  }

  public async getJobToProcess(
    logger: Logger = _logger,
    operation?: QueueOperationOptions,
  ): Promise<NuQJob<ScrapeJobData> | null> {
    // Optional deployments have dedicated PG and FDB consumers. Never race a
    // mutating FDB take against PG fallback: an ambiguous FDB commit would
    // otherwise lease an invisible "ghost" job while this worker runs PG work.
    if (fdbForced()) {
      const job = await fdbMutation(() =>
        scrapeQueueFdb.getJobToProcess(logger, operation),
      );
      if (job) {
        this.inflightBackend.set(job.id, "fdb");
        return tagFdbJob(job as NuQJob<ScrapeJobData>);
      }
      return null;
    }
    const job = await scrapeQueuePg.getJobToProcess();
    if (job) this.inflightBackend.set(job.id, "pg");
    return job;
  }

  public async renewLock(
    id: string,
    lock: string,
    logger: Logger = _logger,
    operation?: QueueOperationOptions,
  ): Promise<boolean> {
    if (this.backendFor(id) === "fdb") {
      return await fdbMutation(() =>
        scrapeQueueFdb.renewLock(id, lock, logger, operation),
      );
    }
    return scrapeQueuePg.renewLock(id, lock, logger);
  }

  public async jobFinish(
    id: string,
    lock: string,
    returnvalue: any | null,
    logger: Logger = _logger,
    operation?: QueueOperationOptions,
  ): Promise<boolean> {
    const backend = this.backendFor(id);
    const finished =
      backend === "fdb"
        ? await fdbMutation(() =>
            scrapeQueueFdb.jobFinish(id, lock, returnvalue, logger, operation),
          )
        : await scrapeQueuePg.jobFinish(id, lock, returnvalue, logger);
    if (finished) {
      this.inflightBackend.delete(id);
      await completeRoutingPin(
        await inspectRoutingPin("scrape_job", id),
        "job-finish",
      );
    }
    return finished;
  }

  public async jobFail(
    id: string,
    lock: string,
    failedReason: string,
    logger: Logger = _logger,
    operation?: QueueOperationOptions,
  ): Promise<boolean> {
    const backend = this.backendFor(id);
    const failed =
      backend === "fdb"
        ? await fdbMutation(() =>
            scrapeQueueFdb.jobFail(id, lock, failedReason, logger, operation),
          )
        : await scrapeQueuePg.jobFail(id, lock, failedReason, logger);
    if (failed) {
      this.inflightBackend.delete(id);
      await completeRoutingPin(
        await inspectRoutingPin("scrape_job", id),
        "job-fail",
      );
    }
    return failed;
  }

  public async getJob(
    id: string,
    logger: Logger = _logger,
  ): Promise<NuQJob<ScrapeJobData> | null> {
    const backend = await getJobQueueBackend(id);
    if (!backend) return null;
    if (backend === "fdb") {
      const job = await optionalFdbRead(() =>
        scrapeQueueFdb.getJob(id, logger),
      );
      return job ? tagFdbJob(job as NuQJob<ScrapeJobData>) : null;
    }
    return scrapeQueuePg.getJob(id, logger);
  }

  public async getJobs(
    ids: string[],
    logger: Logger = _logger,
  ): Promise<NuQJob<ScrapeJobData>[]> {
    if (ids.length === 0) return [];
    const backends = await Promise.all(ids.map(id => getJobQueueBackend(id)));
    const fdbIds = ids.filter((_, i) => backends[i] === "fdb");
    const pgIds = ids.filter((_, i) => backends[i] === "pg");
    const [fdbJobs, pgJobs] = await Promise.all([
      fdbIds.length > 0
        ? optionalFdbRead(() => scrapeQueueFdb.getJobs(fdbIds, logger))
        : Promise.resolve([] as NuQFdbJob<ScrapeJobData>[]),
      pgIds.length > 0
        ? scrapeQueuePg.getJobs(pgIds, logger)
        : Promise.resolve([] as NuQJob<ScrapeJobData>[]),
    ]);
    const byId = new Map<string, NuQJob<ScrapeJobData>>();
    for (const j of fdbJobs)
      byId.set(j.id, tagFdbJob(j as NuQJob<ScrapeJobData>));
    for (const j of pgJobs) byId.set(j.id, j);
    return ids
      .map(id => byId.get(id))
      .filter((j): j is NuQJob<ScrapeJobData> => j !== undefined);
  }

  public async getJobsWithStatus(
    ids: string[],
    status: NuQJobStatus,
    logger: Logger = _logger,
  ): Promise<NuQJob<ScrapeJobData>[]> {
    return (await this.getJobs(ids, logger)).filter(j => j.status === status);
  }

  public async getJobsWithStatuses(
    ids: string[],
    statuses: NuQJobStatus[],
    logger: Logger = _logger,
  ): Promise<NuQJob<ScrapeJobData>[]> {
    const set = new Set(statuses);
    return (await this.getJobs(ids, logger)).filter(j => set.has(j.status));
  }

  private async isFdbGroup(groupId: string): Promise<boolean> {
    const backend = await getCrawlQueueBackend(groupId);
    if (backend) return backend === "fdb";
    return fdbForced();
  }

  public async getGroupAnyJob(
    groupId: string,
    ownerId: string,
    logger: Logger = _logger,
  ): Promise<NuQJob<ScrapeJobData> | null> {
    if (await this.isFdbGroup(groupId)) {
      const job = await optionalFdbRead(() =>
        scrapeQueueFdb.getGroupAnyJob(groupId, ownerId, logger),
      );
      return job ? tagFdbJob(job as NuQJob<ScrapeJobData>) : null;
    }
    return scrapeQueuePg.getGroupAnyJob(groupId, ownerId);
  }

  public async getGroupNumericStats(
    groupId: string,
    logger: Logger = _logger,
  ): Promise<Record<NuQJobStatus, number>> {
    if (await this.isFdbGroup(groupId)) {
      return (await optionalFdbRead(() =>
        scrapeQueueFdb.getGroupNumericStats(groupId, logger),
      )) as Record<NuQJobStatus, number>;
    }
    return scrapeQueuePg.getGroupNumericStats(groupId, logger);
  }

  public async getCrawlJobsForListing(
    groupId: string,
    limit: number,
    offset: number,
    logger: Logger = _logger,
  ): Promise<NuQJob<ScrapeJobData>[]> {
    if (await this.isFdbGroup(groupId)) {
      const jobs = await optionalFdbRead(() =>
        scrapeQueueFdb.getCrawlJobsForListing(groupId, limit, offset, logger),
      );
      return jobs.map(j => tagFdbJob(j as NuQJob<ScrapeJobData>));
    }
    return scrapeQueuePg.getCrawlJobsForListing(groupId, limit, offset, logger);
  }

  public async removeJob(id: string, logger: Logger = _logger): Promise<void> {
    const backend = await getJobQueueBackend(id);
    if (!backend) return;
    const pin = await inspectRoutingPin("scrape_job", id);
    if (backend === "fdb") {
      await fdbMutation(() => scrapeQueueFdb.removeJob(id, logger));
      await completeRoutingPin(pin, "job-remove");
      return;
    }
    const redis = getRedisConnection();
    const [queuedPayload, priorDescriptor, active, backlog] = await Promise.all(
      [
        redis.get(`cq-job:${id}`),
        redis.get(pgRemoveResidueKey(id)),
        scrapeQueuePg.getJob(id, logger),
        scrapeQueuePg.getJobsFromBacklog([id], logger),
      ],
    );
    const existing = active ?? backlog[0] ?? null;
    if (existing) {
      // Persist the routing metadata before deleting PG. A retry after process
      // death or a Redis pipeline failure can still remove team/crawl residue.
      await redis.set(
        pgRemoveResidueKey(id),
        JSON.stringify({
          id,
          ownerId: existing.ownerId,
          groupId: existing.groupId,
          data: {},
        }),
        "EX",
        24 * 60 * 60,
      );
    }
    const removed = await scrapeQueuePg.removeJobResidue(id, logger);
    let descriptor = removed;
    if (!descriptor && priorDescriptor) {
      try {
        descriptor = JSON.parse(priorDescriptor) as NuQRemovedJobResidue;
      } catch {
        // Corrupt descriptor is deleted by the cleanup pipeline.
      }
    }
    if (!descriptor && existing) {
      descriptor = {
        id,
        ownerId: existing.ownerId,
        groupId: existing.groupId,
        data: {},
      };
    }
    await cleanPgRedisJobResidue(id, descriptor, queuedPayload);
    await completeRoutingPin(pin, "job-remove");
  }

  public async removeJobs(
    ids: string[],
    logger: Logger = _logger,
  ): Promise<void> {
    for (const id of ids) {
      await this.removeJob(id, logger);
    }
  }

  public async waitForJob<T = any>(
    id: string,
    timeout: number | null,
    logger: Logger = _logger,
    backendHint?: QueueBackend,
  ): Promise<T> {
    const backend = await getJobQueueBackend(id, backendHint);
    if (!backend) throw new NuQRouterObjectNotFoundError("scrape_job", id);
    if (backend === "fdb") {
      // Waiting is intentionally long-lived; callers pass the real scrape
      // timeout. The backend hint from the enqueue result also avoids any
      // dependency on the best-effort Redis marker.
      return scrapeQueueFdb.waitForJob(id, timeout, logger);
    }
    return scrapeQueuePg.waitForJob(id, timeout, logger) as Promise<T>;
  }

  public async getMetrics(logger: Logger = _logger) {
    return scrapeQueuePg.getMetrics();
  }
}

// === Routed crawl-finished queue (worker consumer + reads)

class RoutedCrawlFinishedQueue {
  private inflightBackend = new Map<string, QueueBackend>();

  public async getJobToProcess(
    logger: Logger = _logger,
    operation?: QueueOperationOptions,
  ): Promise<NuQJob<any> | null> {
    if (fdbForced()) {
      const job = await fdbMutation(() =>
        crawlFinishedQueueFdb.getJobToProcess(logger, operation),
      );
      if (job) {
        this.inflightBackend.set(job.id, "fdb");
        return tagFdbJob(job as NuQJob<any>);
      }
      return null;
    }
    const job = await crawlFinishedQueuePg.getJobToProcess();
    if (job) this.inflightBackend.set(job.id, "pg");
    return job;
  }

  public async renewLock(
    id: string,
    lock: string,
    logger: Logger = _logger,
    operation?: QueueOperationOptions,
  ): Promise<boolean> {
    if (this.inflightBackend.get(id) === "fdb") {
      return await fdbMutation(() =>
        crawlFinishedQueueFdb.renewLock(id, lock, logger, operation),
      );
    }
    return crawlFinishedQueuePg.renewLock(id, lock, logger);
  }

  public async jobFinish(
    id: string,
    lock: string,
    returnvalue: any | null,
    logger: Logger = _logger,
    operation?: QueueOperationOptions,
  ): Promise<boolean> {
    const backend = this.inflightBackend.get(id) ?? "pg";
    if (backend === "fdb") {
      const finished = await fdbMutation(() =>
        crawlFinishedQueueFdb.jobFinish(
          id,
          lock,
          returnvalue,
          logger,
          operation,
        ),
      );
      if (finished) this.inflightBackend.delete(id);
      return finished;
    }
    const finished = await crawlFinishedQueuePg.jobFinish(
      id,
      lock,
      returnvalue,
      logger,
    );
    if (finished) this.inflightBackend.delete(id);
    return finished;
  }

  public async jobFail(
    id: string,
    lock: string,
    failedReason: string,
    logger: Logger = _logger,
    operation?: QueueOperationOptions,
  ): Promise<boolean> {
    const backend = this.inflightBackend.get(id) ?? "pg";
    if (backend === "fdb") {
      const failed = await fdbMutation(() =>
        crawlFinishedQueueFdb.jobFail(
          id,
          lock,
          failedReason,
          logger,
          operation,
        ),
      );
      if (failed) this.inflightBackend.delete(id);
      return failed;
    }
    const failed = await crawlFinishedQueuePg.jobFail(
      id,
      lock,
      failedReason,
      logger,
    );
    if (failed) this.inflightBackend.delete(id);
    return failed;
  }

  public async getJob(
    id: string,
    logger: Logger = _logger,
  ): Promise<NuQJob<any> | null> {
    if (
      (await getJobQueueBackend(id, undefined, {
        kind: "crawl_finished",
        hasFdbJob: () => crawlFinishedQueueFdb.hasJob(id),
        hasPgJob: async () =>
          (await crawlFinishedQueuePg.getJob(id, logger)) !== null,
      })) === "fdb"
    ) {
      const job = await optionalFdbRead(() =>
        crawlFinishedQueueFdb.getJob(id, logger),
      );
      return job ? tagFdbJob(job as NuQJob<any>) : null;
    }
    return crawlFinishedQueuePg.getJob(id, logger);
  }
}

// === Routed crawl group

class RoutedCrawlGroup {
  public async addGroup(
    id: string,
    ownerId: string,
    ttl?: number,
    opts?: {
      backend?: QueueBackend;
      maxConcurrency?: number;
      delaySeconds?: number;
    },
    logger: Logger = _logger,
  ): Promise<NuQJobGroupInstance> {
    const pin = await prepareRoutingPin({
      teamId: ownerId,
      kind: "group",
      objectId: id,
    });
    const backend = pin?.backend ?? opts?.backend ?? "pg";
    if (opts?.backend && opts.backend !== backend) {
      throw new NuQRouterPinMismatchError(
        "group",
        id,
        pin?.backend ?? backend,
        opts.backend,
      );
    }
    const group =
      backend === "fdb"
        ? ((await fdbMutation(() =>
            crawlGroupFdb.addGroup(
              id,
              ownerId,
              ttl,
              {
                maxConcurrency: opts?.maxConcurrency,
                delaySeconds: opts?.delaySeconds,
              },
              logger,
            ),
          )) as NuQJobGroupInstance)
        : await crawlGroupPg.addGroup(id, ownerId, ttl, logger);
    await activateRoutingPin(pin, { control_groups: 1 }, "group-active");
    void markBackend(groupBackendKey(id), backend).catch(error =>
      _logger.warn("Failed to cache group backend", {
        module: "nuq-router",
        groupId: id,
        error,
      }),
    );
    return group;
  }

  public async getGroup(
    id: string,
    logger: Logger = _logger,
  ): Promise<NuQJobGroupInstance | null> {
    const backend = await getCrawlQueueBackend(id);
    if (backend === "fdb" || (!backend && fdbForced())) {
      return (await optionalFdbRead(() =>
        crawlGroupFdb.getGroup(id, logger),
      )) as NuQJobGroupInstance | null;
    }
    return crawlGroupPg.getGroup(id, logger);
  }

  public async getOngoingByOwner(
    ownerId: string,
    logger: Logger = _logger,
  ): Promise<NuQJobGroupInstance[]> {
    if (!(await teamUsesFdbLedger(ownerId))) {
      return crawlGroupPg.getOngoingByOwner(ownerId, logger);
    }
    const fdb = (await optionalFdbRead(() =>
      crawlGroupFdb.getOngoingByOwner(ownerId, logger),
    )) as NuQJobGroupInstance[];
    if (fdbForced()) return fdb;
    // Query both ledgers regardless of today's flag. Turning the flag off only
    // stops new FDB groups; pinned groups remain authoritative until drained.
    const pg = await crawlGroupPg.getOngoingByOwner(ownerId, logger);
    const seen = new Set(fdb.map(g => g.id));
    const duplicate = pg.find(group => seen.has(group.id));
    if (duplicate) {
      throw new NuQRouterBothBackendsError("group", duplicate.id);
    }
    return [
      ...(fdb as NuQJobGroupInstance[]),
      ...pg.filter(g => !seen.has(g.id)),
    ];
  }

  // O(1) cancel; only meaningful for FDB groups. PG crawls keep their
  // existing Redis-based cancellation path.
  public async cancelGroup(
    id: string,
    logger: Logger = _logger,
  ): Promise<boolean> {
    const backend = await getCrawlQueueBackend(id);
    if (backend !== "fdb" && !(backend === null && fdbForced())) return false;
    const cancelled = await fdbMutation(() =>
      crawlGroupFdb.cancelGroup(id, logger),
    );
    if (cancelled) {
      await completeRoutingPin(
        await inspectRoutingPin("group", id),
        "group-cancel",
      );
    }
    return cancelled;
  }
}

export const scrapeQueue = new RoutedScrapeQueue();
export const crawlFinishedQueue = new RoutedCrawlFinishedQueue();
export const crawlGroup = new RoutedCrawlGroup();
