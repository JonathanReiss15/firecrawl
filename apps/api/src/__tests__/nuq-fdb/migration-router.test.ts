import { randomUUID } from "crypto";
import { vi } from "vitest";

const controls = vi.hoisted(() => ({ fdbFlag: false, pgResidue: 0 }));

vi.mock("../../controllers/auth", () => ({
  getACUCTeam: vi.fn(async () => ({ flags: { nuqFdb: controls.fdbFlag } })),
}));
vi.mock("../../lib/deployment", () => ({ isSelfHosted: vi.fn(() => false) }));
vi.mock("../../services/worker/nuq", () => {
  const queue = {
    getJob: vi.fn().mockResolvedValue(null),
    getJobs: vi.fn().mockResolvedValue([]),
    getJobsFromBacklog: vi.fn().mockResolvedValue([]),
    getJobToProcess: vi.fn().mockResolvedValue(null),
  };
  return {
    scrapeQueue: queue,
    crawlFinishedQueue: queue,
    crawlGroup: {
      getGroup: vi.fn().mockResolvedValue(null),
      getOngoingByOwner: vi.fn().mockResolvedValue([]),
    },
    getNuQPgOwnerLiveResidue: vi.fn(async () => ({
      scrape: controls.pgResidue,
      backlog: 0,
      groups: 0,
      crawlFinished: 0,
      total: controls.pgResidue,
    })),
  };
});
vi.mock("../../lib/concurrency-redis", () => ({
  getTeamQueueLimit: vi.fn().mockResolvedValue(100),
  getConcurrencyLimitActiveJobsCount: vi.fn().mockResolvedValue(0),
  pushConcurrencyLimitActiveJob: vi.fn(),
  removeConcurrencyLimitActiveJob: vi.fn(),
  constructConcurrencyLimitKey: vi.fn((teamId: string) => `limit:${teamId}`),
}));

import { config } from "../../config";
import { getRedisConnection } from "../../services/queue-service";
import {
  isFdbTeam,
  mirrorExternalSlotAcquire,
  mirrorExternalSlotRelease,
  resolveJobBackend,
} from "../../services/worker/nuq-router";
import {
  crawlFinishedQueueFdb,
  crawlGroupFdb,
  externalSlotMigrationObjectId,
  externalSlotsFdb,
  nuqFdbMigrationStore,
  scrapeQueueFdb,
} from "../../services/worker/nuq-fdb";
import {
  getFdb,
  getNuqFdbDatabase,
} from "../../services/worker/nuq-fdb/client";

const describeIf = config.FDB_CLUSTER_FILE ? describe : describe.skip;
const teams = new Set<string>();
const previousBackend = config.NUQ_BACKEND;

async function clearTeam(teamId: string): Promise<void> {
  const pins = await nuqFdbMigrationStore.inspectTeamPins(teamId);
  const fdb = getFdb();
  const db = getNuqFdbDatabase();
  await db.doTn(async tn => {
    for (const pin of pins) {
      tn.clear(nuqFdbMigrationStore.objectKey(pin.kind, pin.objectId));
    }
    const range = fdb.tuple.range(["nuq-migration", 1, "team", teamId]);
    tn.clearRange(range.begin as Buffer, range.end as Buffer);
  });
}

async function makeMetricsReady(): Promise<void> {
  for (const queue of [scrapeQueueFdb, crawlFinishedQueueFdb]) {
    await queue.beginMetricCounterBackfill();
    while (!(await queue.backfillMetricCounts(100))) {
      // bounded pages; queues are empty in this focused suite
    }
  }
}

describeIf("NuQ durable migration router", () => {
  beforeAll(async () => {
    config.NUQ_BACKEND = "pg";
    controls.fdbFlag = false;
    controls.pgResidue = 0;
    await Promise.all([
      scrapeQueueFdb.invalidateMetricCounterGeneration(),
      crawlFinishedQueueFdb.invalidateMetricCounterGeneration(),
    ]);
  });

  afterAll(async () => {
    controls.fdbFlag = false;
    controls.pgResidue = 0;
    config.NUQ_BACKEND = previousBackend;
    for (const teamId of teams) await clearTeam(teamId);
  });

  test("freezes authority initialization until both corrected-core counters are ready", async () => {
    const teamId = randomUUID();
    teams.add(teamId);

    await expect(isFdbTeam(teamId)).rejects.toMatchObject({
      code: "NUQ_FDB_CORE_METRICS_NOT_READY",
      retryable: true,
    });
    await expect(nuqFdbMigrationStore.inspectState(teamId)).resolves.toBeNull();

    await makeMetricsReady();
    await expect(isFdbTeam(teamId)).resolves.toBe(false);
    await expect(
      nuqFdbMigrationStore.inspectState(teamId),
    ).resolves.toMatchObject({
      activeBackend: "pg",
      activeGeneration: 1,
      phase: "PG_ONLY",
    });
  });

  test("discovers and drains an uncounted pre-protocol FDB job without dual authority", async () => {
    const teamId = randomUUID();
    const jobId = randomUUID();
    teams.add(teamId);
    controls.fdbFlag = false;
    controls.pgResidue = 0;
    await scrapeQueueFdb.addJob(
      jobId,
      {
        mode: "single_urls",
        url: "https://example.com/legacy-direct",
        team_id: teamId,
      } as any,
      { ownerId: teamId, bypassGate: true },
      { teamLimit: 1, queueCap: 10 },
    );

    // The owner index catches bypass jobs that intentionally hold no team slot.
    await expect(isFdbTeam(teamId)).resolves.toBe(true);
    await expect(
      nuqFdbMigrationStore.inspectState(teamId),
    ).resolves.toMatchObject({
      activeBackend: "fdb",
      phase: "FDB_ONLY",
    });
    await expect(isFdbTeam(teamId)).rejects.toMatchObject({
      code: "NUQ_MIGRATION_IN_PROGRESS",
    });

    const active = await scrapeQueueFdb.getJobToProcess();
    expect(active?.id).toBe(jobId);
    await scrapeQueueFdb.jobFinish(jobId, active!.lock!, {});
    await scrapeQueueFdb.removeJob(jobId);
    await expect(
      nuqFdbMigrationStore.inspectPin("scrape_job", jobId),
    ).resolves.toMatchObject({
      admission: "legacy-backfill",
      lifecycle: "terminal",
    });

    await expect(isFdbTeam(teamId)).resolves.toBe(false);
    await expect(
      nuqFdbMigrationStore.inspectState(teamId),
    ).resolves.toMatchObject({
      activeBackend: "pg",
      phase: "PG_ONLY",
    });
  });

  test("a legacy FDB group pins descendants and crawl-finished control through drain", async () => {
    const teamId = randomUUID();
    const groupId = randomUUID();
    const childId = randomUUID();
    teams.add(teamId);
    controls.fdbFlag = false;
    controls.pgResidue = 0;
    await crawlGroupFdb.addGroup(groupId, teamId);

    const data = {
      mode: "single_urls",
      team_id: teamId,
      crawl_id: groupId,
      url: "https://example.com/legacy-group",
    } as any;
    await expect(resolveJobBackend(data)).resolves.toBe("fdb");
    await expect(
      nuqFdbMigrationStore.inspectPin("group", groupId),
    ).resolves.toMatchObject({
      admission: "legacy-backfill",
      backend: "fdb",
      lifecycle: "prepared",
    });
    await nuqFdbMigrationStore.preparePinnedObject({
      teamId,
      kind: "scrape_job",
      objectId: childId,
      admission: {
        type: "pinned-continuation",
        source: { kind: "group", objectId: groupId },
      },
      requiredBackend: "fdb",
      residue: { intent_unresolved: 1 },
    });
    await scrapeQueueFdb.addJob(
      childId,
      data,
      { ownerId: teamId, groupId },
      { teamLimit: null, queueCap: 10 },
    );

    await expect(isFdbTeam(teamId)).rejects.toMatchObject({
      code: "NUQ_MIGRATION_IN_PROGRESS",
    });
    const child = await scrapeQueueFdb.getJobToProcess();
    expect(child?.id).toBe(childId);
    await scrapeQueueFdb.jobFinish(childId, child!.lock!, {});
    const finished = await crawlFinishedQueueFdb.getJobToProcess();
    expect(finished?.groupId).toBe(groupId);
    await crawlFinishedQueueFdb.jobFinish(finished!.id, finished!.lock!, {});
    await Promise.all([
      scrapeQueueFdb.removeJob(childId),
      crawlFinishedQueueFdb.removeJob(finished!.id),
    ]);

    await expect(isFdbTeam(teamId)).resolves.toBe(false);
    await expect(
      nuqFdbMigrationStore.inspectState(teamId),
    ).resolves.toMatchObject({
      activeBackend: "pg",
      phase: "PG_ONLY",
    });
    const db = getNuqFdbDatabase();
    await db.doTn(async tn => {
      const range = crawlGroupFdb.ks.groupRange(groupId);
      tn.clearRange(range.begin, range.end);
      tn.clear(crawlGroupFdb.ks.ongoingGroup(teamId, groupId));
    });
  });

  test("legacy external holders detect dual presence and retain their FDB generation", async () => {
    const teamId = randomUUID();
    const holderId = randomUUID();
    teams.add(teamId);
    controls.fdbFlag = false;
    controls.pgResidue = 0;
    await externalSlotsFdb.acquire(teamId, holderId, 60_000);
    await getRedisConnection().zadd(
      `limit:${teamId}`,
      Date.now() + 60_000,
      holderId,
    );

    await expect(
      mirrorExternalSlotAcquire(teamId, holderId, 120_000),
    ).rejects.toMatchObject({ code: "NUQ_ROUTER_BOTH_BACKENDS_PRESENT" });
    await getRedisConnection().zrem(`limit:${teamId}`, holderId);

    await mirrorExternalSlotAcquire(teamId, holderId, 120_000);
    const externalObjectId = externalSlotMigrationObjectId(teamId, holderId);
    await expect(
      nuqFdbMigrationStore.inspectPin("external_holder", externalObjectId),
    ).resolves.toMatchObject({
      admission: "legacy-backfill",
      backend: "fdb",
      lifecycle: "active",
      residue: { capacity_external_holders: 1 },
    });
    await mirrorExternalSlotRelease(teamId, holderId);
    await expect(externalSlotsFdb.has(teamId, holderId)).resolves.toBe(false);
    await expect(
      nuqFdbMigrationStore.inspectPin("external_holder", externalObjectId),
    ).resolves.toMatchObject({ lifecycle: "terminal" });
  });

  test("durable source residue blocks seal until the authoritative ledger drains", async () => {
    const teamId = randomUUID();
    teams.add(teamId);
    controls.fdbFlag = false;
    controls.pgResidue = 1;
    await expect(isFdbTeam(teamId)).resolves.toBe(false);

    controls.fdbFlag = true;
    await expect(isFdbTeam(teamId)).rejects.toMatchObject({
      code: "NUQ_MIGRATION_IN_PROGRESS",
    });
    await expect(isFdbTeam(teamId)).rejects.toMatchObject({
      code: "NUQ_MIGRATION_RESIDUE_NOT_EMPTY",
      retryable: true,
    });
    await expect(
      nuqFdbMigrationStore.inspectState(teamId),
    ).resolves.toMatchObject({
      phase: "DRAINING_TO_FDB",
      activeBackend: "pg",
    });

    controls.pgResidue = 0;
    await expect(isFdbTeam(teamId)).resolves.toBe(true);
    await expect(
      nuqFdbMigrationStore.inspectState(teamId),
    ).resolves.toMatchObject({
      phase: "FDB_ONLY",
      activeBackend: "fdb",
    });
  });

  test("pause/drain seals both directions and a flag flap burns its target generation", async () => {
    const teamId = randomUUID();
    teams.add(teamId);
    controls.fdbFlag = false;
    controls.pgResidue = 0;
    await expect(isFdbTeam(teamId)).resolves.toBe(false);

    controls.fdbFlag = true;
    await expect(isFdbTeam(teamId)).rejects.toMatchObject({
      code: "NUQ_MIGRATION_IN_PROGRESS",
      retryable: true,
    });
    await expect(
      nuqFdbMigrationStore.inspectState(teamId),
    ).resolves.toMatchObject({
      phase: "DRAINING_TO_FDB",
      targetGeneration: 2,
    });

    controls.fdbFlag = false;
    await expect(isFdbTeam(teamId)).resolves.toBe(false);
    await expect(
      nuqFdbMigrationStore.inspectState(teamId),
    ).resolves.toMatchObject({
      phase: "PG_ONLY",
      activeGeneration: 1,
      maxGeneration: 2,
    });

    controls.fdbFlag = true;
    await expect(isFdbTeam(teamId)).rejects.toMatchObject({
      code: "NUQ_MIGRATION_IN_PROGRESS",
    });
    await expect(
      nuqFdbMigrationStore.inspectState(teamId),
    ).resolves.toMatchObject({
      phase: "DRAINING_TO_FDB",
      targetGeneration: 3,
    });
    await expect(isFdbTeam(teamId)).resolves.toBe(true);
    await expect(
      nuqFdbMigrationStore.inspectState(teamId),
    ).resolves.toMatchObject({
      phase: "FDB_ONLY",
      activeGeneration: 3,
      maxGeneration: 3,
    });

    controls.fdbFlag = false;
    await expect(isFdbTeam(teamId)).rejects.toMatchObject({
      code: "NUQ_MIGRATION_IN_PROGRESS",
    });
    await expect(isFdbTeam(teamId)).resolves.toBe(false);
    await expect(
      nuqFdbMigrationStore.inspectState(teamId),
    ).resolves.toMatchObject({
      phase: "PG_ONLY",
      activeGeneration: 4,
      maxGeneration: 4,
    });
  });
});
