import { randomUUID } from "crypto";
import { vi } from "vitest";

vi.mock("../../controllers/auth", () => ({
  getACUCTeam: vi.fn(async () => ({ flags: { nuqFdb: false } })),
}));
vi.mock("../../lib/deployment", () => ({ isSelfHosted: vi.fn(() => false) }));
vi.mock("../../services/ab-test", () => ({ abTestJob: vi.fn() }));

import { config } from "../../config";
import { _addScrapeJobToBullMQ } from "../../services/queue-jobs";
import { getRedisConnection } from "../../services/queue-service";
import {
  crawlFinishedQueueFdb,
  nuqFdbMigrationStore,
  scrapeQueueFdb,
} from "../../services/worker/nuq-fdb";
import {
  getFdb,
  getNuqFdbDatabase,
} from "../../services/worker/nuq-fdb/client";
import {
  NuQPublicationConflictError,
  nuqShutdown,
  scrapeQueue as scrapeQueuePg,
} from "../../services/worker/nuq";
import { scrapeQueue as routedScrapeQueue } from "../../services/worker/nuq-router";

const describeIf =
  config.FDB_CLUSTER_FILE && config.NUQ_DATABASE_URL ? describe : describe.skip;
const previousBackend = config.NUQ_BACKEND;

async function makeMetricsReady(): Promise<void> {
  for (const queue of [scrapeQueueFdb, crawlFinishedQueueFdb]) {
    await queue.beginMetricCounterBackfill();
    while (!(await queue.backfillMetricCounts(100))) {
      // bounded pages
    }
  }
}

async function clearMigrationTeam(teamId: string): Promise<void> {
  const pins = await nuqFdbMigrationStore.inspectTeamPins(teamId);
  const db = getNuqFdbDatabase();
  const fdb = getFdb();
  await db.doTn(async tn => {
    for (const pin of pins) {
      tn.clear(nuqFdbMigrationStore.objectKey(pin.kind, pin.objectId));
    }
    const range = fdb.tuple.range(["nuq-migration", 1, "team", teamId]);
    tn.clearRange(range.begin as Buffer, range.end as Buffer);
  });
}

describeIf("NuQ PG publication with durable FDB authority", () => {
  const teamId = randomUUID();
  const jobId = randomUUID();
  const conflictTeamId = randomUUID();
  const conflictJobId = randomUUID();

  beforeAll(async () => {
    config.NUQ_BACKEND = "pg";
    await makeMetricsReady();
    await getRedisConnection().del(
      `concurrency-limiter:${teamId}`,
      `nuq:pg-reservation:team:${teamId}:${jobId}`,
      `concurrency-limiter:${conflictTeamId}`,
      `nuq:pg-reservation:team:${conflictTeamId}:${conflictJobId}`,
    );
  });

  afterAll(async () => {
    await Promise.all([
      scrapeQueuePg.removeJob(jobId).catch(() => undefined),
      scrapeQueuePg.removeJob(conflictJobId).catch(() => undefined),
    ]);
    await getRedisConnection().del(
      `concurrency-limiter:${teamId}`,
      `nuq:pg-reservation:team:${teamId}:${jobId}`,
      `concurrency-limiter:${conflictTeamId}`,
      `nuq:pg-reservation:team:${conflictTeamId}:${conflictJobId}`,
    );
    await Promise.all([
      clearMigrationTeam(teamId),
      clearMigrationTeam(conflictTeamId),
    ]);
    config.NUQ_BACKEND = previousBackend;
    await nuqShutdown();
  });

  test("a pre-commit PG conflict rolls back owned Redis reservation and its prepared intent", async () => {
    const original = {
      mode: "single_urls",
      url: "https://example.com/legacy-row",
      team_id: conflictTeamId,
    } as any;
    await scrapeQueuePg.addJob(conflictJobId, original, {
      ownerId: conflictTeamId,
    });

    await expect(
      _addScrapeJobToBullMQ(
        { ...original, url: "https://example.com/incompatible" },
        conflictJobId,
      ),
    ).rejects.toBeInstanceOf(NuQPublicationConflictError);
    await expect(
      getRedisConnection().zscore(
        `concurrency-limiter:${conflictTeamId}`,
        conflictJobId,
      ),
    ).resolves.toBeNull();
    await expect(
      nuqFdbMigrationStore.inspectPin("scrape_job", conflictJobId),
    ).resolves.toMatchObject({
      backend: "pg",
      lifecycle: "terminal",
      residue: { capacity_ready_active: 0, intent_unresolved: 0 },
    });
    await expect(scrapeQueuePg.getJob(conflictJobId)).resolves.toMatchObject({
      data: { url: "https://example.com/legacy-row" },
    });
  });

  test("stable publish, incompatible retry compensation, and removal preserve one durable generation", async () => {
    const data = {
      mode: "single_urls",
      url: "https://example.com/original",
      team_id: teamId,
    } as any;

    const first = await _addScrapeJobToBullMQ(data, jobId);
    expect(first.id).toBe(jobId);
    await expect(_addScrapeJobToBullMQ(data, jobId)).resolves.toMatchObject({
      id: jobId,
    });

    const activePin = await nuqFdbMigrationStore.inspectPin(
      "scrape_job",
      jobId,
    );
    expect(activePin).toMatchObject({
      teamId,
      backend: "pg",
      generation: 1,
      lifecycle: "active",
      residue: { capacity_ready_active: 1, intent_unresolved: 0 },
    });
    expect(
      await getRedisConnection().zscore(`concurrency-limiter:${teamId}`, jobId),
    ).not.toBeNull();

    await expect(
      _addScrapeJobToBullMQ(
        { ...data, url: "https://example.com/conflict" },
        jobId,
      ),
    ).rejects.toBeInstanceOf(NuQPublicationConflictError);
    await expect(
      nuqFdbMigrationStore.inspectPin("scrape_job", jobId),
    ).resolves.toMatchObject({
      lifecycle: "active",
      residue: { capacity_ready_active: 1 },
    });
    await expect(scrapeQueuePg.getJob(jobId)).resolves.toMatchObject({
      data: { url: "https://example.com/original" },
    });

    await routedScrapeQueue.removeJob(jobId);
    await expect(scrapeQueuePg.getJob(jobId)).resolves.toBeNull();
    await expect(
      getRedisConnection().zscore(`concurrency-limiter:${teamId}`, jobId),
    ).resolves.toBeNull();
    await expect(
      nuqFdbMigrationStore.inspectPin("scrape_job", jobId),
    ).resolves.toMatchObject({
      lifecycle: "terminal",
      residue: { capacity_ready_active: 0, intent_unresolved: 0 },
    });
  });
});
