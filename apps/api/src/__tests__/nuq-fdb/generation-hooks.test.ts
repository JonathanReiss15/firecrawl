import { randomUUID } from "crypto";
import { config } from "../../config";
import {
  MIGRATION_RESIDUE_COUNTERS,
  externalSlotMigrationObjectId,
  NuQFdbJobGroup,
  NuQFdbQueue,
  NuqFdbExternalSlots,
  NuqFdbMigrationStore,
  NuqFdbSweeper,
} from "../../services/worker/nuq-fdb";
import {
  getFdb,
  getNuqFdbDatabase,
} from "../../services/worker/nuq-fdb/client";

const describeIf = config.FDB_CLUSTER_FILE ? describe : describe.skip;
const run = randomUUID();
const store = new NuqFdbMigrationStore();
const db = getNuqFdbDatabase();
const fdb = getFdb();

const queueName = `generation-hooks-${run}`;
const finishedQueueName = `${queueName}-finished`;
const queue = new NuQFdbQueue<any, any>(queueName, {
  hasGroups: true,
  finishedQueueName,
});
const finishedQueue = new NuQFdbQueue<any, any>(finishedQueueName, {
  hasGroups: false,
  migrationObjectKind: "crawl_finished",
});
const groups = new NuQFdbJobGroup(queue.ks, queue.groupOps!);
const slots = new NuqFdbExternalSlots(queue.ks);
const teams = new Set<string>();

const unlimited = {
  teamLimit: null,
  queueCap: Number.MAX_SAFE_INTEGER,
};

async function managedTeam() {
  const teamId = randomUUID();
  teams.add(teamId);
  await store.initializeLegacyTeam(teamId, "fdb", randomUUID());
  return teamId;
}

async function prepareJob(teamId: string, id: string, groupId?: string) {
  return await store.preparePinnedObject({
    teamId,
    kind: "scrape_job",
    objectId: id,
    admission: groupId
      ? {
          type: "pinned-continuation",
          source: { kind: "group", objectId: groupId },
        }
      : { type: "new-root" },
    requiredBackend: "fdb",
    residue: { intent_unresolved: 1 },
  });
}

async function prepareGroup(teamId: string, id: string) {
  return await store.preparePinnedObject({
    teamId,
    kind: "group",
    objectId: id,
    admission: { type: "new-root" },
    requiredBackend: "fdb",
    residue: { intent_unresolved: 1 },
  });
}

async function residue(teamId: string, generation = 1) {
  return (await store.inspectGeneration(teamId, generation)).residue;
}

async function forceSealCorruptResidueForStaleGenerationTest(teamId: string) {
  await db.doTn(async tn => {
    for (const counter of MIGRATION_RESIDUE_COUNTERS) {
      tn.clear(store.residueKey(teamId, 1, counter));
    }
  });
  const transition = await store.beginTransition({
    teamId,
    targetBackend: "pg",
    operationId: randomUUID(),
  });
  await store.finalSeal({
    teamId,
    transitionOperationId: transition.transitionOperationId!,
  });
}

describeIf("NuQ FDB transaction-scoped migration generation hooks", () => {
  afterAll(async () => {
    for (const name of [queueName, finishedQueueName]) {
      const range = fdb.tuple.range(["nuq", name]);
      await db.doTn(async tn =>
        tn.clearRange(range.begin as Buffer, range.end as Buffer),
      );
    }
    for (const teamId of teams) {
      const range = fdb.tuple.range(["nuq-migration", 1, "team", teamId]);
      await db.doTn(async tn =>
        tn.clearRange(range.begin as Buffer, range.end as Buffer),
      );
    }
  });

  test("unmanaged legacy teams remain compatible while managed missing pins fail closed", async () => {
    const legacyTeam = randomUUID();
    const legacyId = randomUUID();
    const legacy = await queue.addJob(
      legacyId,
      {},
      { ownerId: legacyTeam },
      unlimited,
    );
    expect(legacy.migrationGeneration).toBeUndefined();
    await queue.beginMetricCounterBackfill();
    while (!(await queue.backfillMetricCounts(100))) {
      // bounded pages
    }
    const metricControl = await queue.getMetricCounterBackfillStatus();
    expect(metricControl?.phase).toBe("ready");
    await db.doTn(async tn => {
      tn.clear(queue.ks.ownerLiveJob(legacyTeam, legacyId));
      tn.clear(queue.ks.ownerLiveBackfillCursor(metricControl!.generation));
      tn.clear(queue.ks.ownerLiveBackfillReady(metricControl!.generation));
    });
    await expect(queue.hasReadyOrActiveJobForOwner(legacyTeam)).resolves.toBe(
      true,
    );
    await queue.removeJob(legacyId);

    const teamId = await managedTeam();
    await expect(
      queue.addJob(randomUUID(), {}, { ownerId: teamId }, unlimited),
    ).rejects.toMatchObject({ code: "NUQ_MIGRATION_PIN_NOT_FOUND" });
  });

  test("existing pre-protocol jobs and external holders adopt the source generation while draining", async () => {
    const teamId = randomUUID();
    teams.add(teamId);
    const id = randomUUID();
    const holderId = randomUUID();
    await queue.addJob(id, {}, { ownerId: teamId }, unlimited);
    await slots.acquire(teamId, holderId, 60_000);
    await store.initializeLegacyTeam(teamId, "fdb", randomUUID());
    await store.beginTransition({
      teamId,
      targetBackend: "pg",
      operationId: randomUUID(),
    });

    const active = await queue.getJobToProcess();
    expect(active?.id).toBe(id);
    await expect(store.inspectPin("scrape_job", id)).resolves.toMatchObject({
      admission: "legacy-backfill",
      backend: "fdb",
      generation: 1,
      lifecycle: "active",
    });
    await queue.jobFinish(id, active!.lock!, {});
    await expect(store.inspectPin("scrape_job", id)).resolves.toMatchObject({
      lifecycle: "terminal",
    });

    await slots.acquire(teamId, holderId, 120_000);
    const externalObjectId = externalSlotMigrationObjectId(teamId, holderId);
    await expect(
      store.inspectPin("external_holder", externalObjectId),
    ).resolves.toMatchObject({
      admission: "legacy-backfill",
      lifecycle: "active",
      residue: { capacity_external_holders: 1 },
    });
    await slots.release(teamId, holderId);
    await expect(
      store.inspectPin("external_holder", externalObjectId),
    ).resolves.toMatchObject({ lifecycle: "terminal" });
  });

  test("ready/active residue is exact and terminal drain remains allowed", async () => {
    const teamId = await managedTeam();
    const id = randomUUID();
    await prepareJob(teamId, id);

    const added = await queue.addJob(id, {}, { ownerId: teamId }, unlimited);
    expect(added).toMatchObject({
      migrationBackend: "fdb",
      migrationGeneration: 1,
      status: "queued",
    });
    expect(await residue(teamId)).toMatchObject({
      capacity_ready_active: 1,
      intent_unresolved: 0,
    });
    await expect(store.inspectPin("scrape_job", id)).resolves.toMatchObject({
      lifecycle: "active",
      residue: { capacity_ready_active: 1 },
    });

    const transition = await store.beginTransition({
      teamId,
      targetBackend: "pg",
      operationId: randomUUID(),
    });
    const active = await queue.getJobToProcess();
    expect(active?.id).toBe(id);
    expect(await queue.jobFinish(id, active!.lock!, {})).toBe(true);
    expect(await residue(teamId)).toMatchObject({
      capacity_ready_active: 0,
    });
    await expect(
      store.finalSeal({
        teamId,
        transitionOperationId: transition.transitionOperationId!,
      }),
    ).resolves.toMatchObject({ activeBackend: "pg", activeGeneration: 2 });
  });

  test("team and key pending counters transition exactly through promotion", async () => {
    const teamId = await managedTeam();
    const blocker = randomUUID();
    const teamPending = randomUUID();
    const keyPending = randomUUID();
    for (const id of [blocker, teamPending, keyPending]) {
      await prepareJob(teamId, id);
    }

    await queue.addJob(
      blocker,
      {},
      { ownerId: teamId },
      {
        teamLimit: 1,
        queueCap: 10,
        key: { id: "key-a", limit: 1 },
      },
    );
    await queue.addJob(
      teamPending,
      {},
      { ownerId: teamId },
      {
        teamLimit: 1,
        queueCap: 10,
        key: { id: "key-b", limit: 1 },
      },
    );
    await queue.addJob(
      keyPending,
      {},
      { ownerId: teamId },
      {
        teamLimit: 1,
        queueCap: 10,
        key: { id: "key-a", limit: 1 },
      },
    );
    expect(await residue(teamId)).toMatchObject({
      capacity_ready_active: 1,
      capacity_team_pending: 1,
      capacity_key_pending: 1,
    });

    await queue.removeJobs([blocker, teamPending, keyPending]);
    expect(
      Object.values(await residue(teamId)).every(value => value === 0),
    ).toBe(true);
  });

  test("crawl-pending and delayed residue transition atomically through sweeper promotion", async () => {
    const teamId = await managedTeam();
    const gid = randomUUID();
    const firstId = randomUUID();
    const delayedId = randomUUID();
    await prepareGroup(teamId, gid);
    await groups.addGroup(gid, teamId, undefined, {
      maxConcurrency: 1,
      delaySeconds: 1,
    });
    for (const id of [firstId, delayedId]) await prepareJob(teamId, id, gid);
    await queue.addJobs(
      [firstId, delayedId].map(id => ({
        id,
        data: { mode: "single_urls" },
        options: { ownerId: teamId, groupId: gid },
      })),
      { teamLimit: 10, queueCap: 10 },
    );
    expect(await residue(teamId)).toMatchObject({
      capacity_ready_active: 1,
      capacity_crawl_pending: 1,
      capacity_delayed: 0,
    });

    const first = await queue.getJobToProcess();
    expect(first?.id).toBe(firstId);
    await queue.jobFinish(firstId, first!.lock!, {});
    expect(await residue(teamId)).toMatchObject({
      capacity_ready_active: 0,
      capacity_crawl_pending: 0,
      capacity_delayed: 1,
    });

    await new Promise(resolve => setTimeout(resolve, 1_100));
    const sweeper = new NuqFdbSweeper([queue, finishedQueue], []);
    await sweeper.sweepOnce();
    expect(await residue(teamId)).toMatchObject({
      capacity_ready_active: 1,
      capacity_delayed: 0,
    });
    const delayed = await queue.getJobToProcess();
    expect(delayed?.id).toBe(delayedId);
    await queue.jobFinish(delayedId, delayed!.lock!, {});
    const finished = await finishedQueue.getJobToProcess();
    await finishedQueue.jobFinish(finished!.id, finished!.lock!, {});
    expect(
      Object.values(await residue(teamId)).every(value => value === 0),
    ).toBe(true);
  });

  test("external holders and group/crawl_finished controls are exact", async () => {
    const teamId = await managedTeam();
    const holderId = randomUUID();
    const externalObjectId = externalSlotMigrationObjectId(teamId, holderId);
    await store.preparePinnedObject({
      teamId,
      kind: "external_holder",
      objectId: externalObjectId,
      admission: { type: "new-root" },
      requiredBackend: "fdb",
      residue: { intent_unresolved: 1 },
    });
    await slots.acquire(teamId, holderId, 60_000);
    await expect(
      store.inspectPin("external_holder", externalObjectId),
    ).resolves.toMatchObject({ lifecycle: "active" });
    expect(await residue(teamId)).toMatchObject({
      capacity_external_holders: 1,
      intent_unresolved: 0,
    });
    await slots.acquire(teamId, holderId, 120_000);
    expect((await residue(teamId)).capacity_external_holders).toBe(1);
    await slots.release(teamId, holderId);
    expect((await residue(teamId)).capacity_external_holders).toBe(0);

    const gid = randomUUID();
    const child = randomUUID();
    await prepareGroup(teamId, gid);
    await groups.addGroup(gid, teamId);
    await expect(store.inspectPin("group", gid)).resolves.toMatchObject({
      lifecycle: "active",
    });
    expect((await residue(teamId)).control_groups).toBe(1);
    await prepareJob(teamId, child, gid);
    await queue.addJob(
      child,
      { mode: "single_urls" },
      { ownerId: teamId, groupId: gid },
      unlimited,
    );
    const active = await queue.getJobToProcess();
    await queue.jobFinish(child, active!.lock!, {});

    const afterChild = await residue(teamId);
    expect(afterChild.control_groups).toBe(0);
    expect(afterChild.control_crawl_finished).toBe(1);
    const finished = await finishedQueue.getJobToProcess();
    expect(finished).toMatchObject({
      migrationBackend: "fdb",
      migrationGeneration: 1,
    });
    await expect(
      store.inspectPin("crawl_finished", finished!.id),
    ).resolves.toMatchObject({ lifecycle: "active" });
    await finishedQueue.jobFinish(finished!.id, finished!.lock!, {});
    expect((await residue(teamId)).control_crawl_finished).toBe(0);
  });

  test("a live enqueue transaction and final seal cannot both commit", async () => {
    const teamId = await managedTeam();
    const id = randomUUID();
    await store.preparePinnedObject({
      teamId,
      kind: "scrape_job",
      objectId: id,
      admission: { type: "new-root" },
      requiredBackend: "fdb",
      residue: {},
    });
    const transition = await store.beginTransition({
      teamId,
      targetBackend: "pg",
      operationId: randomUUID(),
    });

    const results = await Promise.allSettled([
      queue.addJob(id, {}, { ownerId: teamId }, unlimited),
      store.finalSeal({
        teamId,
        transitionOperationId: transition.transitionOperationId!,
      }),
    ]);
    expect(
      results.filter(result => result.status === "fulfilled"),
    ).toHaveLength(1);
    if (results[0].status === "fulfilled") {
      expect(results[1]).toMatchObject({
        status: "rejected",
        reason: { code: "NUQ_MIGRATION_RESIDUE_NOT_EMPTY" },
      });
      await queue.removeJob(id);
      await expect(
        store.finalSeal({
          teamId,
          transitionOperationId: transition.transitionOperationId!,
        }),
      ).resolves.toMatchObject({ activeBackend: "pg" });
    } else {
      expect(results[0].reason).toMatchObject({
        code: "NUQ_MIGRATION_STALE_GENERATION",
      });
      expect(results[1]).toMatchObject({ status: "fulfilled" });
    }
  });

  test("sealed generations reject enqueue and active finish mutations", async () => {
    const enqueueTeam = await managedTeam();
    const enqueueId = randomUUID();
    await prepareJob(enqueueTeam, enqueueId);
    await forceSealCorruptResidueForStaleGenerationTest(enqueueTeam);
    await expect(
      queue.addJob(enqueueId, {}, { ownerId: enqueueTeam }, unlimited),
    ).rejects.toMatchObject({ code: "NUQ_MIGRATION_STALE_GENERATION" });

    const finishTeam = await managedTeam();
    const finishId = randomUUID();
    await prepareJob(finishTeam, finishId);
    await queue.addJob(finishId, {}, { ownerId: finishTeam }, unlimited);
    const active = await queue.getJobToProcess();
    expect(active?.id).toBe(finishId);
    await forceSealCorruptResidueForStaleGenerationTest(finishTeam);
    await expect(
      queue.jobFinish(finishId, active!.lock!, {}),
    ).rejects.toMatchObject({ code: "NUQ_MIGRATION_STALE_GENERATION" });
  });

  test("sealed generations reject external renewal and group control", async () => {
    const externalTeam = await managedTeam();
    const holderId = randomUUID();
    await store.preparePinnedObject({
      teamId: externalTeam,
      kind: "external_holder",
      objectId: externalSlotMigrationObjectId(externalTeam, holderId),
      admission: { type: "new-root" },
      requiredBackend: "fdb",
      residue: { intent_unresolved: 1 },
    });
    await slots.acquire(externalTeam, holderId, 60_000);
    await forceSealCorruptResidueForStaleGenerationTest(externalTeam);
    await expect(
      slots.acquire(externalTeam, holderId, 60_000),
    ).rejects.toMatchObject({ code: "NUQ_MIGRATION_STALE_GENERATION" });

    const groupTeam = await managedTeam();
    const gid = randomUUID();
    await prepareGroup(groupTeam, gid);
    await groups.addGroup(gid, groupTeam);
    await forceSealCorruptResidueForStaleGenerationTest(groupTeam);
    await expect(groups.cancelGroup(gid)).rejects.toMatchObject({
      code: "NUQ_MIGRATION_STALE_GENERATION",
    });
  });

  test("sealed generations reject delayed sweeper promotion", async () => {
    const teamId = await managedTeam();
    const gid = randomUUID();
    const firstId = randomUUID();
    const delayedId = randomUUID();
    await prepareGroup(teamId, gid);
    await groups.addGroup(gid, teamId, undefined, {
      maxConcurrency: 1,
      delaySeconds: 1,
    });
    for (const id of [firstId, delayedId]) await prepareJob(teamId, id, gid);
    await queue.addJobs(
      [firstId, delayedId].map(id => ({
        id,
        data: { mode: "single_urls" },
        options: { ownerId: teamId, groupId: gid },
      })),
      { teamLimit: 10, queueCap: 10 },
    );
    const first = await queue.getJobToProcess();
    await queue.jobFinish(first!.id, first!.lock!, {});
    expect((await residue(teamId)).capacity_delayed).toBe(1);

    await forceSealCorruptResidueForStaleGenerationTest(teamId);
    await new Promise(resolve => setTimeout(resolve, 1_100));
    const sweeper = new NuqFdbSweeper([queue, finishedQueue], []);
    await expect(sweeper.sweepOnce()).rejects.toMatchObject({
      code: "NUQ_MIGRATION_STALE_GENERATION",
    });
  });

  test("group cancellation hands control to a pinned sweeper task", async () => {
    const teamId = await managedTeam();
    const gid = randomUUID();
    await prepareGroup(teamId, gid);
    await groups.addGroup(gid, teamId);
    await groups.cancelGroup(gid);
    expect(await residue(teamId)).toMatchObject({
      control_groups: 0,
      control_sweeper_tasks: 1,
    });
    await expect(
      store.inspectPin("sweeper_task", `group-cancel/${gid}`),
    ).resolves.toMatchObject({ lifecycle: "active" });
  });
});
