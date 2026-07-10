import { randomUUID } from "crypto";
import { vi } from "vitest";
import { config } from "../../config";
import {
  MIGRATION_RESIDUE_COUNTERS,
  NuqFdbMigrationStore,
} from "../../services/worker/nuq-fdb";
import {
  getFdb,
  getNuqFdbDatabase,
} from "../../services/worker/nuq-fdb/client";
import { encodeI64 } from "../../services/worker/nuq-fdb/keyspace";
import { reconcilePgResidueFence } from "../../services/worker/nuq-migration-control";

// These tests intentionally exercise transaction conflicts and atomic ADDs on
// a real FoundationDB cluster. They are skipped in ordinary PG-only runs.
const describeIf = config.FDB_CLUSTER_FILE ? describe : describe.skip;

const RUN = randomUUID();
const store = new NuqFdbMigrationStore();
const teams = new Set<string>();
const objects: Array<{ kind: "scrape_job" | "group"; id: string }> = [];

function team(): string {
  const id = `${RUN}-${randomUUID()}`;
  teams.add(id);
  return id;
}

function object(kind: "scrape_job" | "group" = "scrape_job") {
  const id = `${RUN}-${randomUUID()}`;
  objects.push({ kind, id });
  return id;
}

async function initialize(teamId: string, backend: "pg" | "fdb" = "pg") {
  return await store.initializeLegacyTeam(teamId, backend, randomUUID());
}

async function begin(
  teamId: string,
  operationId = randomUUID(),
  expectedRevision?: number,
) {
  return await store.beginTransition({
    teamId,
    targetBackend: "fdb",
    operationId,
    expectedRevision,
  });
}

describeIf("NuQ global FDB migration control plane", () => {
  afterAll(async () => {
    const fdb = getFdb();
    const db = getNuqFdbDatabase();
    for (const teamId of teams) {
      const range = fdb.tuple.range(["nuq-migration", 1, "team", teamId]);
      await db.doTn(async tn =>
        tn.clearRange(range.begin as Buffer, range.end as Buffer),
      );
    }
    for (const item of objects) {
      await db.doTn(async tn => tn.clear(store.objectKey(item.kind, item.id)));
    }
    // GC indexes are global by design; test identities are run-qualified.
    const gcRange = fdb.tuple.range(["nuq-migration", 1, "gc"]);
    const gcRows = await db.doTn(async tn =>
      tn.snapshot().getRangeAll(gcRange.begin as Buffer, gcRange.end as Buffer),
    );
    await db.doTn(async tn => {
      const dueCountRange = fdb.tuple.range([
        "nuq-migration",
        1,
        "gc",
        "due-count",
      ]);
      tn.clearRange(dueCountRange.begin as Buffer, dueCountRange.end as Buffer);
      for (const [key] of gcRows) {
        const parts = fdb.tuple.unpack(key as Buffer);
        if (parts.some(part => String(part).includes(RUN))) {
          tn.clear(key as Buffer);
          continue;
        }
        const category = String(parts[3]);
        const partition = Number(parts[4]);
        const dueAt = Number(parts[5]);
        if (
          (category === "pin" ||
            category === "control" ||
            category === "generation") &&
          Number.isSafeInteger(partition) &&
          Number.isSafeInteger(dueAt)
        ) {
          let node = BigInt(dueAt) + 1n;
          while (node <= 1n << 53n) {
            tn.add(
              store.pack([
                "gc",
                "due-count",
                category,
                partition,
                node.toString(),
              ]),
              encodeI64(1),
            );
            node += node & -node;
          }
        }
      }
    });
  });

  test("legacy teams require explicit authority and steady resolution is durable", async () => {
    const teamId = team();

    await expect(store.resolveSteady(teamId, "fdb")).resolves.toEqual({
      status: "legacy-uninitialized",
    });
    await expect(
      store.beginTransition({
        teamId,
        targetBackend: "fdb",
        operationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "NUQ_MIGRATION_LEGACY_UNINITIALIZED" });

    const operationId = randomUUID();
    const initialized = await store.initializeLegacyTeam(
      teamId,
      "pg",
      operationId,
    );
    expect(initialized).toMatchObject({
      revision: 1,
      maxGeneration: 1,
      activeBackend: "pg",
      activeGeneration: 1,
      phase: "PG_ONLY",
    });
    await expect(
      store.initializeLegacyTeam(teamId, "pg", operationId),
    ).resolves.toEqual(initialized);
    await expect(
      store.initializeLegacyTeam(teamId, "fdb", randomUUID(), {
        ifAbsent: true,
      }),
    ).resolves.toEqual(initialized);
    await expect(store.resolveSteady(teamId, "pg")).resolves.toMatchObject({
      status: "steady",
    });
    await expect(store.resolveSteady(teamId, "fdb")).resolves.toMatchObject({
      status: "transition-required",
    });
  });

  test("initialize-if-absent replay returns current durable state after migration", async () => {
    const teamId = team();
    const initializeOperationId = randomUUID();
    await store.initializeLegacyTeam(teamId, "pg", initializeOperationId);
    const transitionOperationId = randomUUID();
    await begin(teamId, transitionOperationId);
    const sealed = await store.finalSeal({
      teamId,
      transitionOperationId,
    });

    await expect(
      store.initializeLegacyTeam(teamId, "pg", initializeOperationId, {
        ifAbsent: true,
      }),
    ).resolves.toEqual(sealed);
    await expect(
      store.initializeLegacyTeam(teamId, "pg", initializeOperationId),
    ).resolves.toMatchObject({ revision: 1, activeBackend: "pg" });
  });

  test("revision CAS admits exactly one racing transition", async () => {
    const teamId = team();
    await initialize(teamId);

    const results = await Promise.allSettled([
      begin(teamId, randomUUID(), 1),
      begin(teamId, randomUUID(), 1),
    ]);
    expect(
      results.filter(result => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected");
    expect(rejected).toMatchObject({
      reason: { code: "NUQ_MIGRATION_CAS_MISMATCH", retryable: true },
    });
    await expect(store.inspectState(teamId)).resolves.toMatchObject({
      revision: 2,
      maxGeneration: 2,
      phase: "DRAINING_TO_FDB",
    });
  });

  test("flag flaps burn target generations and never reuse them", async () => {
    const teamId = team();
    await initialize(teamId);

    const firstOp = randomUUID();
    const first = await begin(teamId, firstOp);
    expect(first.targetGeneration).toBe(2);
    const firstCancel = await store.cancelTransition({
      teamId,
      transitionOperationId: firstOp,
      expectedRevision: first.revision,
    });
    await expect(
      store.cancelTransition({ teamId, transitionOperationId: firstOp }),
    ).resolves.toEqual(firstCancel);

    const secondOp = randomUUID();
    const second = await begin(teamId, secondOp);
    expect(second.targetGeneration).toBe(3);
    await store.cancelTransition({
      teamId,
      transitionOperationId: secondOp,
    });

    const third = await begin(teamId);
    expect(third).toMatchObject({ maxGeneration: 4, targetGeneration: 4 });
    await expect(store.inspectGeneration(teamId, 2)).resolves.toMatchObject({
      generation: { status: "closed", backend: "fdb" },
    });
    await expect(store.inspectGeneration(teamId, 3)).resolves.toMatchObject({
      generation: { status: "closed", backend: "fdb" },
    });
  });

  test("FDB to PG transitions use the same closed-target seal protocol", async () => {
    const teamId = team();
    await initialize(teamId, "fdb");
    const operationId = randomUUID();
    const draining = await store.beginTransition({
      teamId,
      targetBackend: "pg",
      operationId,
      expectedRevision: 1,
    });
    expect(draining).toMatchObject({
      phase: "DRAINING_TO_PG",
      activeBackend: "fdb",
      targetBackend: "pg",
      targetGeneration: 2,
    });
    const sealed = await store.finalSeal({
      teamId,
      transitionOperationId: operationId,
      expectedRevision: draining.revision,
    });
    expect(sealed).toMatchObject({
      phase: "PG_ONLY",
      activeBackend: "pg",
      activeGeneration: 2,
    });
    await expect(store.inspectGeneration(teamId, 1)).resolves.toMatchObject({
      generation: { backend: "fdb", status: "closed" },
    });
    await expect(store.inspectGeneration(teamId, 2)).resolves.toMatchObject({
      generation: { backend: "pg", status: "open" },
    });
  });

  test("new roots stop while draining, pinned continuations drain, and sealed generations reject stale work", async () => {
    const teamId = team();
    const rootId = object("group");
    const childId = object();
    const lateId = object();
    const dormantId = object();
    await initialize(teamId);
    await store.preparePinnedObject({
      teamId,
      kind: "scrape_job",
      objectId: dormantId,
      admission: { type: "new-root" },
    });
    await store.preparePinnedObject({
      teamId,
      kind: "group",
      objectId: rootId,
      admission: { type: "new-root" },
      residue: { control_groups: 1 },
    });
    const operationId = randomUUID();
    const transition = await begin(teamId, operationId);

    await expect(
      store.preparePinnedObject({
        teamId,
        kind: "scrape_job",
        objectId: lateId,
        admission: { type: "new-root" },
      }),
    ).rejects.toMatchObject({
      code: "NUQ_MIGRATION_IN_PROGRESS",
      retryable: true,
    });
    await store.preparePinnedObject({
      teamId,
      kind: "scrape_job",
      objectId: childId,
      admission: {
        type: "pinned-continuation",
        source: { kind: "group", objectId: rootId },
      },
      residue: { capacity_ready_active: 1 },
    });
    await expect(
      store.finalSeal({ teamId, transitionOperationId: operationId }),
    ).rejects.toMatchObject({ code: "NUQ_MIGRATION_RESIDUE_NOT_EMPTY" });

    await store.completePinnedObject({
      teamId,
      kind: "scrape_job",
      objectId: childId,
      operationId: randomUUID(),
      fromLifecycle: "prepared",
    });
    await store.completePinnedObject({
      teamId,
      kind: "group",
      objectId: rootId,
      operationId: randomUUID(),
      fromLifecycle: "prepared",
    });
    await store.finalSeal({
      teamId,
      transitionOperationId: operationId,
      expectedRevision: transition.revision,
    });

    await expect(
      store.preparePinnedObject({
        teamId,
        kind: "scrape_job",
        objectId: object(),
        admission: {
          type: "pinned-continuation",
          source: { kind: "group", objectId: rootId },
        },
      }),
    ).rejects.toMatchObject({
      code: "NUQ_MIGRATION_STALE_GENERATION",
      retryable: true,
    });
    await expect(
      store.transitionObjectResidue({
        teamId,
        kind: "scrape_job",
        objectId: dormantId,
        operationId: randomUUID(),
        fromLifecycle: "prepared",
        toLifecycle: "active",
        residue: { capacity_ready_active: 1 },
      }),
    ).rejects.toMatchObject({
      code: "NUQ_MIGRATION_STALE_GENERATION",
      retryable: true,
    });
  });

  test("legacy objects require explicit backend and generation backfill", async () => {
    const teamId = team();
    const groupId = object("group");
    const childId = object();
    await initialize(teamId);
    await begin(teamId);

    await expect(
      store.preparePinnedObject({
        teamId,
        kind: "group",
        objectId: groupId,
        admission: { type: "legacy-backfill", backend: "fdb", generation: 1 },
      }),
    ).rejects.toMatchObject({ code: "NUQ_MIGRATION_STALE_GENERATION" });

    const group = await store.preparePinnedObject({
      teamId,
      kind: "group",
      objectId: groupId,
      admission: { type: "legacy-backfill", backend: "pg", generation: 1 },
      residue: { control_groups: 1 },
    });
    expect(group).toMatchObject({
      admission: "legacy-backfill",
      backend: "pg",
      generation: 1,
    });
    await expect(
      store.preparePinnedObject({
        teamId,
        kind: "scrape_job",
        objectId: childId,
        admission: {
          type: "pinned-continuation",
          source: { kind: "group", objectId: groupId },
        },
      }),
    ).resolves.toMatchObject({ backend: "pg", generation: 1 });
  });

  test("terminal legacy rows allocate bounded closed backend history without changing authority", async () => {
    const teamId = team();
    const objectId = object();
    await initialize(teamId, "pg");
    await expect(
      store.ensureTerminalLegacyGeneration(teamId, "fdb"),
    ).resolves.toBe(2);
    await expect(
      store.ensureTerminalLegacyGeneration(teamId, "fdb"),
    ).resolves.toBe(2);
    await expect(store.inspectState(teamId)).resolves.toMatchObject({
      activeBackend: "pg",
      activeGeneration: 1,
      maxGeneration: 2,
    });
    await expect(store.inspectGeneration(teamId, 2)).resolves.toMatchObject({
      generation: { backend: "fdb", status: "closed" },
    });
    await expect(
      store.preparePinnedObject({
        teamId,
        kind: "scrape_job",
        objectId,
        admission: {
          type: "legacy-backfill",
          backend: "fdb",
          generation: 2,
          terminal: true,
        },
        residue: {},
      }),
    ).resolves.toMatchObject({
      backend: "fdb",
      generation: 2,
      lifecycle: "terminal",
    });
    await expect(
      getNuqFdbDatabase().doTn(async tn =>
        store.reconcileManagedObjectInTxn(tn, {
          teamId,
          kind: "scrape_job",
          objectId,
          residue: {},
          terminal: true,
        }),
      ),
    ).resolves.toMatchObject({ lifecycle: "terminal", generation: 2 });
  });

  test("runtime rows adopt legacy pins but existing new-root pins still require generations", async () => {
    const teamId = team();
    const newRootId = object();
    const legacyId = object();
    const implicitLegacyId = object();
    await initialize(teamId, "fdb");
    await store.preparePinnedObject({
      teamId,
      kind: "scrape_job",
      objectId: newRootId,
      admission: { type: "new-root" },
      residue: { capacity_ready_active: 1 },
    });
    await store.preparePinnedObject({
      teamId,
      kind: "scrape_job",
      objectId: legacyId,
      admission: { type: "legacy-backfill", backend: "fdb", generation: 1 },
      residue: { capacity_ready_active: 1 },
    });

    await expect(
      getNuqFdbDatabase().doTn(async tn =>
        store.reconcileManagedObjectInTxn(tn, {
          teamId,
          kind: "scrape_job",
          objectId: newRootId,
          residue: { capacity_ready_active: 1 },
        }),
      ),
    ).rejects.toMatchObject({ code: "NUQ_MIGRATION_RUNTIME_PIN_MISSING" });
    await expect(
      getNuqFdbDatabase().doTn(async tn =>
        store.reconcileManagedObjectInTxn(tn, {
          teamId,
          kind: "scrape_job",
          objectId: legacyId,
          residue: { capacity_ready_active: 1 },
        }),
      ),
    ).resolves.toMatchObject({
      admission: "legacy-backfill",
      lifecycle: "active",
    });
    await expect(
      getNuqFdbDatabase().doTn(async tn =>
        store.reconcileManagedObjectInTxn(tn, {
          teamId,
          kind: "scrape_job",
          objectId: implicitLegacyId,
          residue: { capacity_ready_active: 1 },
        }),
      ),
    ).resolves.toMatchObject({
      admission: "legacy-backfill",
      lifecycle: "active",
      residue: { capacity_ready_active: 1 },
    });
  });

  test("a concurrent residue increment and final seal cannot both win", async () => {
    const teamId = team();
    const pinId = object();
    const sourceId = object("group");
    await initialize(teamId);
    await store.preparePinnedObject({
      teamId,
      kind: "group",
      objectId: sourceId,
      admission: { type: "new-root" },
    });
    const transitionOperationId = randomUUID();
    await begin(teamId, transitionOperationId);

    const [prepareResult, sealResult] = await Promise.allSettled([
      store.preparePinnedObject({
        teamId,
        kind: "scrape_job",
        objectId: pinId,
        admission: {
          type: "pinned-continuation",
          source: { kind: "group", objectId: sourceId },
        },
        residue: { capacity_team_pending: 1 },
      }),
      store.finalSeal({ teamId, transitionOperationId }),
    ]);

    expect(
      prepareResult.status === "fulfilled" && sealResult.status === "fulfilled",
    ).toBe(false);
    const source = await store.inspectGeneration(teamId, 1);
    if (sealResult.status === "fulfilled") {
      expect(prepareResult).toMatchObject({
        status: "rejected",
        reason: { code: "NUQ_MIGRATION_STALE_GENERATION" },
      });
      expect(source).toMatchObject({
        generation: { status: "closed" },
        residue: { capacity_team_pending: 0 },
      });
    } else {
      expect(prepareResult.status).toBe("fulfilled");
      expect(sealResult).toMatchObject({
        reason: { code: "NUQ_MIGRATION_RESIDUE_NOT_EMPTY" },
      });
      expect(source).toMatchObject({
        generation: { status: "draining" },
        residue: { capacity_team_pending: 1 },
      });
      await store.completePinnedObject({
        teamId,
        kind: "scrape_job",
        objectId: pinId,
        operationId: randomUUID(),
        fromLifecycle: "prepared",
      });
      await store.finalSeal({ teamId, transitionOperationId });
    }
  });

  test("pin revision CAS rejects delayed reorder but exact commit replay wins", async () => {
    const teamId = team();
    const objectId = object();
    await initialize(teamId, "fdb");
    const prepared = await store.preparePinnedObject({
      teamId,
      kind: "scrape_job",
      objectId,
      admission: { type: "new-root" },
    });
    const firstOperationId = randomUUID();
    const first = await store.transitionObjectResidue({
      teamId,
      kind: "scrape_job",
      objectId,
      operationId: firstOperationId,
      fromLifecycle: "prepared",
      toLifecycle: "prepared",
      residue: { intent_unresolved: 1 },
      expectedRevision: prepared.revision,
    });
    await expect(
      store.transitionObjectResidue({
        teamId,
        kind: "scrape_job",
        objectId,
        operationId: firstOperationId,
        fromLifecycle: "prepared",
        toLifecycle: "prepared",
        residue: { intent_unresolved: 1 },
        expectedRevision: prepared.revision,
      }),
    ).resolves.toEqual(first);
    const second = await store.transitionObjectResidue({
      teamId,
      kind: "scrape_job",
      objectId,
      operationId: randomUUID(),
      fromLifecycle: "prepared",
      toLifecycle: "prepared",
      residue: {},
      expectedRevision: first.revision,
    });
    const newest = await store.transitionObjectResidue({
      teamId,
      kind: "scrape_job",
      objectId,
      operationId: randomUUID(),
      fromLifecycle: "prepared",
      toLifecycle: "prepared",
      residue: { intent_unresolved: 1 },
      expectedRevision: second.revision,
    });

    await expect(
      store.transitionObjectResidue({
        teamId,
        kind: "scrape_job",
        objectId,
        operationId: randomUUID(),
        fromLifecycle: "prepared",
        toLifecycle: "prepared",
        residue: {},
        expectedRevision: second.revision,
      }),
    ).rejects.toMatchObject({
      code: "NUQ_MIGRATION_CAS_MISMATCH",
      retryable: true,
    });
    await expect(store.inspectPin("scrape_job", objectId)).resolves.toEqual(
      newest,
    );
  });

  test("source residue A-B-A reorder rejects the delayed observation", async () => {
    const teamId = team();
    await initialize(teamId, "pg");
    await reconcilePgResidueFence(store, {
      teamId,
      total: 1,
      observationId: "A-initial",
    });

    const originalTransition = store.transitionObjectResidue.bind(store);
    let releaseDelayed!: () => void;
    const delayedGate = new Promise<void>(resolve => {
      releaseDelayed = resolve;
    });
    let captured!: () => void;
    const capturedInput = new Promise<void>(resolve => {
      captured = resolve;
    });
    const transitionSpy = vi
      .spyOn(store, "transitionObjectResidue")
      .mockImplementationOnce(async input => {
        captured();
        await delayedGate;
        return await originalTransition(input);
      });
    const delayed = reconcilePgResidueFence(store, {
      teamId,
      total: 0,
      observationId: "B-delayed",
    });
    await capturedInput;
    try {
      await reconcilePgResidueFence(store, {
        teamId,
        total: 0,
        observationId: "B-current",
      });
      const newest = await reconcilePgResidueFence(store, {
        teamId,
        total: 1,
        observationId: "A-newest",
      });
      releaseDelayed();
      await expect(delayed).rejects.toMatchObject({
        code: "NUQ_MIGRATION_CAS_MISMATCH",
      });
      await expect(
        store.inspectPin("cross_store_intent", newest.objectId),
      ).resolves.toMatchObject({
        revision: newest.revision,
        residue: { intent_unresolved: 1 },
      });
    } finally {
      releaseDelayed();
      transitionSpy.mockRestore();
      await getNuqFdbDatabase().doTn(async tn =>
        tn.clear(
          store.objectKey(
            "cross_store_intent",
            `pg-residue/${teamId}/generation/1`,
          ),
        ),
      );
    }
  });

  test("independent residue counters commit without cross-counter conflicts", async () => {
    const teamId = team();
    const firstObjectId = object();
    const secondObjectId = object();
    await initialize(teamId, "fdb");
    await Promise.all([
      store.preparePinnedObject({
        teamId,
        kind: "scrape_job",
        objectId: firstObjectId,
        admission: { type: "new-root" },
      }),
      store.preparePinnedObject({
        teamId,
        kind: "scrape_job",
        objectId: secondObjectId,
        admission: { type: "new-root" },
      }),
    ]);

    const db = getNuqFdbDatabase();
    const firstTn = db.rawCreateTransaction();
    const secondTn = db.rawCreateTransaction();
    try {
      await Promise.all([
        store.transitionObjectResidueInTxn(firstTn, {
          teamId,
          kind: "scrape_job",
          objectId: firstObjectId,
          operationId: randomUUID(),
          fromLifecycle: "prepared",
          toLifecycle: "active",
          residue: { capacity_ready_active: 1 },
          expectedRevision: 1,
        }),
        store.transitionObjectResidueInTxn(secondTn, {
          teamId,
          kind: "scrape_job",
          objectId: secondObjectId,
          operationId: randomUUID(),
          fromLifecycle: "prepared",
          toLifecycle: "active",
          residue: { control_groups: 1 },
          expectedRevision: 1,
        }),
      ]);
      await Promise.all([firstTn.rawCommit(), secondTn.rawCommit()]);
    } finally {
      firstTn.rawCancel();
      secondTn.rawCancel();
    }
    await expect(store.inspectGeneration(teamId, 1)).resolves.toMatchObject({
      residue: { capacity_ready_active: 1, control_groups: 1 },
    });
  });

  test("transaction-scoped hooks compose accounting with caller mutations", async () => {
    const teamId = team();
    const objectId = object();
    const marker = store.pack(["team", teamId, "test-caller-mutation"]);
    await initialize(teamId);

    await getNuqFdbDatabase().doTn(async tn => {
      await store.preparePinnedObjectInTxn(tn, {
        teamId,
        kind: "scrape_job",
        objectId,
        admission: { type: "new-root" },
        residue: { intent_unresolved: 1 },
      });
      tn.set(marker, Buffer.from("published"));
    });
    await expect(
      getNuqFdbDatabase().doTn(async tn => (await tn.get(marker))?.toString()),
    ).resolves.toBe("published");
    expect((await store.inspectGeneration(teamId, 1)).residue).toMatchObject({
      intent_unresolved: 1,
    });

    await getNuqFdbDatabase().doTn(async tn => {
      await store.completePinnedObjectInTxn(tn, {
        teamId,
        kind: "scrape_job",
        objectId,
        operationId: randomUUID(),
        fromLifecycle: "prepared",
      });
      tn.clear(marker);
    });
    expect((await store.inspectGeneration(teamId, 1)).residue).toMatchObject({
      intent_unresolved: 0,
    });
  });

  test("pin preparation and residue transitions are exact-once across every counter class", async () => {
    const teamId = team();
    const objectId = object();
    await initialize(teamId, "fdb");
    const initial = Object.fromEntries(
      MIGRATION_RESIDUE_COUNTERS.map(counter => [counter, 1]),
    );
    const prepared = await store.preparePinnedObject({
      teamId,
      kind: "scrape_job",
      objectId,
      admission: { type: "new-root" },
      residue: initial,
    });
    await expect(
      store.preparePinnedObject({
        teamId,
        kind: "scrape_job",
        objectId,
        admission: { type: "new-root" },
        residue: initial,
      }),
    ).resolves.toEqual(prepared);
    expect((await store.inspectGeneration(teamId, 1)).residue).toEqual(initial);

    const activeResidue = {
      capacity_ready_active: 2,
      control_groups: 1,
      intent_unresolved: 3,
    };
    const transitionOperationId = randomUUID();
    const active = await store.transitionObjectResidue({
      teamId,
      kind: "scrape_job",
      objectId,
      operationId: transitionOperationId,
      fromLifecycle: "prepared",
      toLifecycle: "active",
      residue: activeResidue,
    });
    await expect(
      store.transitionObjectResidue({
        teamId,
        kind: "scrape_job",
        objectId,
        operationId: transitionOperationId,
        fromLifecycle: "prepared",
        toLifecycle: "active",
        residue: activeResidue,
      }),
    ).resolves.toEqual(active);
    expect((await store.inspectGeneration(teamId, 1)).residue).toMatchObject(
      activeResidue,
    );

    // An untagged runtime mutation may commit between an operation's unknown
    // outcome and its retry. It must retain the one bounded token and replay
    // the historical operation result without restoring stale residue.
    const reconciledResidue = {
      capacity_ready_active: 1,
      control_groups: 1,
    };
    await getNuqFdbDatabase().doTn(async tn => {
      await store.reconcileManagedObjectInTxn(tn, {
        teamId,
        kind: "scrape_job",
        objectId,
        recordPin: {
          backend: active.backend,
          generation: active.generation,
        },
        residue: reconciledResidue,
      });
    });
    await expect(
      store.transitionObjectResidue({
        teamId,
        kind: "scrape_job",
        objectId,
        operationId: transitionOperationId,
        fromLifecycle: "prepared",
        toLifecycle: "active",
        residue: activeResidue,
      }),
    ).resolves.toEqual(active);
    expect((await store.inspectGeneration(teamId, 1)).residue).toMatchObject(
      reconciledResidue,
    );

    const completionOperationId = randomUUID();
    const terminal = await store.completePinnedObject({
      teamId,
      kind: "scrape_job",
      objectId,
      operationId: completionOperationId,
      fromLifecycle: "active",
    });
    await expect(
      store.completePinnedObject({
        teamId,
        kind: "scrape_job",
        objectId,
        operationId: completionOperationId,
        fromLifecycle: "active",
      }),
    ).resolves.toEqual(terminal);
    expect(terminal.lifecycle).toBe("terminal");
    expect(terminal.lastOperation).toMatchObject({
      operationId: completionOperationId,
      fromLifecycle: "active",
      toLifecycle: "terminal",
      resultRevision: terminal.revision,
    });
    const operationRange = getFdb().tuple.range([
      "nuq-migration",
      1,
      "team",
      teamId,
      "object-operation",
    ]);
    await expect(
      getNuqFdbDatabase().doTn(async tn =>
        tn
          .snapshot()
          .getRangeAll(
            operationRange.begin as Buffer,
            operationRange.end as Buffer,
          ),
      ),
    ).resolves.toHaveLength(0);
    expect(
      Object.values((await store.inspectGeneration(teamId, 1)).residue),
    ).toEqual(Array(MIGRATION_RESIDUE_COUNTERS.length).fill(0));
    await expect(store.inspectPin("scrape_job", objectId)).resolves.toEqual(
      terminal,
    );
  });

  test("terminal tombstones leave the paged team index bounded to active pins", async () => {
    const teamId = team();
    const objectIds = [object(), object(), object()];
    await initialize(teamId, "fdb");
    await Promise.all(
      objectIds.map(objectId =>
        store.preparePinnedObject({
          teamId,
          kind: "scrape_job",
          objectId,
          admission: { type: "new-root" },
        }),
      ),
    );
    const terminal = await store.completePinnedObject({
      teamId,
      kind: "scrape_job",
      objectId: objectIds[1],
      operationId: randomUUID(),
      fromLifecycle: "prepared",
    });

    const indexed: string[] = [];
    let cursor: { kind: "scrape_job"; objectId: string } | undefined;
    do {
      const page = await store.inspectTeamPinsPage(teamId, {
        limit: 1,
        cursor,
      });
      indexed.push(...page.pins.map(pin => pin.objectId));
      cursor = page.nextCursor as typeof cursor;
    } while (cursor);
    expect(indexed.sort()).toEqual(
      objectIds.filter(objectId => objectId !== terminal.objectId).sort(),
    );
    await expect(
      store.inspectPin("scrape_job", terminal.objectId),
    ).resolves.toEqual(terminal);
    await expect(
      getNuqFdbDatabase().doTn(async tn =>
        tn.get(
          store.pack([
            "team",
            teamId,
            "object",
            "scrape_job",
            terminal.objectId,
          ]),
        ),
      ),
    ).resolves.toBeUndefined();
  });

  test("legacy object-operation rows replay once into the bounded pin token", async () => {
    const teamId = team();
    const objectId = object();
    await initialize(teamId, "fdb");
    await store.preparePinnedObject({
      teamId,
      kind: "scrape_job",
      objectId,
      admission: { type: "new-root" },
      residue: { capacity_ready_active: 1 },
    });
    const operationId = randomUUID();
    const active = await store.transitionObjectResidue({
      teamId,
      kind: "scrape_job",
      objectId,
      operationId,
      fromLifecycle: "prepared",
      toLifecycle: "active",
      residue: { capacity_ready_active: 1 },
    });
    const { lastOperation: _boundedToken, ...legacyResult } = active;
    const legacyOperationKey = store.pack([
      "team",
      teamId,
      "object-operation",
      "scrape_job",
      objectId,
      operationId,
    ]);
    await getNuqFdbDatabase().doTn(async tn => {
      const encoded = Buffer.from(JSON.stringify(legacyResult));
      tn.set(store.objectKey("scrape_job", objectId), encoded);
      tn.set(
        store.pack(["team", teamId, "object", "scrape_job", objectId]),
        encoded,
      );
      tn.set(
        legacyOperationKey,
        Buffer.from(
          JSON.stringify({
            schemaVersion: 1,
            operationId,
            teamId,
            kind: "scrape_job",
            objectId,
            fromLifecycle: "prepared",
            toLifecycle: "active",
            residue: active.residue,
            result: legacyResult,
          }),
        ),
      );
    });

    await expect(
      store.transitionObjectResidue({
        teamId,
        kind: "scrape_job",
        objectId,
        operationId,
        fromLifecycle: "prepared",
        toLifecycle: "active",
        residue: { capacity_ready_active: 1 },
      }),
    ).resolves.toEqual(legacyResult);
    await expect(
      store.inspectPin("scrape_job", objectId),
    ).resolves.toMatchObject({
      lastOperation: {
        operationId,
        resultRevision: legacyResult.revision,
      },
    });
    await expect(
      getNuqFdbDatabase().doTn(async tn => tn.get(legacyOperationKey)),
    ).resolves.toBeUndefined();
  });

  test("stable transition operation ids replay after no-op, cancel, and final seal", async () => {
    const teamId = team();
    await initialize(teamId);
    const noOpOperationId = randomUUID();
    const noOp = await store.beginTransition({
      teamId,
      targetBackend: "pg",
      operationId: noOpOperationId,
    });
    const cancelledOperationId = randomUUID();
    const begun = await begin(teamId, cancelledOperationId);
    await expect(begin(teamId, cancelledOperationId)).resolves.toEqual(begun);
    const cancelled = await store.cancelTransition({
      teamId,
      transitionOperationId: cancelledOperationId,
    });
    await expect(
      store.cancelTransition({
        teamId,
        transitionOperationId: cancelledOperationId,
      }),
    ).resolves.toEqual(cancelled);
    await expect(begin(teamId, cancelledOperationId)).resolves.toEqual(
      cancelled,
    );

    const sealedOperationId = randomUUID();
    const second = await begin(teamId, sealedOperationId);
    await expect(begin(teamId, sealedOperationId)).resolves.toEqual(second);
    const sealed = await store.finalSeal({
      teamId,
      transitionOperationId: sealedOperationId,
    });
    await expect(
      store.finalSeal({
        teamId,
        transitionOperationId: sealedOperationId,
      }),
    ).resolves.toEqual(sealed);
    await expect(begin(teamId, sealedOperationId)).resolves.toEqual(sealed);
    await expect(
      store.beginTransition({
        teamId,
        targetBackend: "pg",
        operationId: noOpOperationId,
      }),
    ).resolves.toEqual(noOp);
    await expect(store.inspectState(teamId)).resolves.toEqual(sealed);
    await expect(
      store.beginTransition({
        teamId,
        targetBackend: "pg",
        operationId: sealedOperationId,
      }),
    ).rejects.toMatchObject({ code: "NUQ_MIGRATION_OPERATION_CONFLICT" });
  });

  test("ambiguous committed control operation reconciles by stable id", async () => {
    const teamId = team();
    await initialize(teamId);
    const operationId = randomUUID();
    const db = getNuqFdbDatabase();
    const originalDoTn = db.doTn.bind(db);
    let discardedCommittedResult = false;
    const doTn = vi.spyOn(db, "doTn").mockImplementation(async (body, opts) => {
      const result = await originalDoTn(body, opts);
      if (!discardedCommittedResult) {
        discardedCommittedResult = true;
        const error = new Error("commit_unknown_result") as Error & {
          code: number;
        };
        error.code = 1021;
        throw error;
      }
      return result;
    });
    try {
      await expect(begin(teamId, operationId)).rejects.toMatchObject({
        code: 1021,
      });
      await expect(begin(teamId, operationId)).resolves.toMatchObject({
        transitionOperationId: operationId,
        targetGeneration: 2,
      });
      await expect(store.inspectState(teamId)).resolves.toMatchObject({
        revision: 2,
        maxGeneration: 2,
      });
    } finally {
      doTn.mockRestore();
    }
  });

  test("bounded terminal GC retains canonical rows and resumes its durable cursor", async () => {
    const base = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(base);
    try {
      clock.mockReturnValue(base + 46 * 24 * 60 * 60 * 1000);
      const baselineDue = (await store.inspectGcBacklog()).pin.due;
      clock.mockReturnValue(base);
      const teamId = team();
      await initialize(teamId, "fdb");
      const ids = Array.from({ length: 150 }, () => object());
      await store.preparePinnedObjects(
        ids.map(objectId => ({
          teamId,
          kind: "scrape_job" as const,
          objectId,
          admission: { type: "new-root" as const },
        })),
      );
      for (const objectId of ids) {
        await store.completePinnedObject({
          teamId,
          kind: "scrape_job",
          objectId,
          operationId: randomUUID(),
          fromLifecycle: "prepared",
        });
      }

      const retainedId = ids[0];
      const runtimeKey = store.pack(["test-runtime", retainedId]);
      await getNuqFdbDatabase().doTn(async tn =>
        tn.set(runtimeKey, Buffer.from("live")),
      );
      clock.mockReturnValue(base + 46 * 24 * 60 * 60 * 1000);
      const authority = {
        pgObjectExists: vi.fn(async (_pin: { objectId: string }) => false),
        fdbReferenceExistsInTxn: vi.fn(
          async (
            tn: import("foundationdb").Transaction,
            pin: { objectId: string },
          ) =>
            Boolean(
              pin.objectId === retainedId ? await tn.get(runtimeKey) : false,
            ),
        ),
      };

      await expect(store.inspectGcBacklog()).resolves.toMatchObject({
        pin: {
          due: baselineDue + 150,
          oldestOverdueMs: expect.any(Number),
        },
      });

      const firstStore = new NuqFdbMigrationStore();
      const first = await firstStore.sweepTerminalPins(authority, { limit: 7 });
      const restartedStore = new NuqFdbMigrationStore();
      const second = await restartedStore.sweepTerminalPins(authority, {
        limit: 7,
      });
      expect(first?.read).toBeLessThanOrEqual(7);
      expect(second?.read).toBeLessThanOrEqual(7);
      expect(second?.partition).not.toBe(first?.partition);

      const concurrentClaims = await Promise.all(
        Array.from({ length: 32 }, () =>
          restartedStore.sweepTerminalPins(authority, { limit: 1 }),
        ),
      );
      expect(
        new Set(concurrentClaims.map(result => result?.partition)).size,
      ).toBe(32);
      expect(concurrentClaims.every(result => (result?.read ?? 0) <= 1)).toBe(
        true,
      );

      for (let pass = 0; pass < 3; pass++) {
        for (let partition = 0; partition < 32; partition++) {
          const result = await restartedStore.sweepTerminalPins(authority);
          expect(result?.read ?? 0).toBeLessThanOrEqual(100);
        }
      }
      await expect(
        store.inspectPin("scrape_job", retainedId),
      ).resolves.toMatchObject({ lifecycle: "terminal" });
      for (const objectId of ids.slice(1)) {
        await expect(
          store.inspectPin("scrape_job", objectId),
        ).resolves.toBeNull();
      }
      await getNuqFdbDatabase().doTn(async tn => tn.clear(runtimeKey));
      clock.mockReturnValue(
        base + 46 * 24 * 60 * 60 * 1000 + 2 * 60 * 60 * 1000,
      );
      for (let partition = 0; partition < 32; partition++) {
        await restartedStore.sweepTerminalPins(authority);
      }
      await expect(
        store.inspectPin("scrape_job", retainedId),
      ).resolves.toBeNull();
      expect(
        authority.pgObjectExists.mock.calls.some(([pin]) =>
          ids.includes(pin.objectId),
        ),
      ).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  test("PG canonical check is followed by FDB CAS and marker loss cannot authorize early GC", async () => {
    const base = 1_850_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(base);
    try {
      const teamId = team();
      const objectId = object();
      await initialize(teamId, "pg");
      await store.preparePinnedObject({
        teamId,
        kind: "scrape_job",
        objectId,
        admission: { type: "new-root" },
      });
      await store.completePinnedObject({
        teamId,
        kind: "scrape_job",
        objectId,
        operationId: randomUUID(),
        fromLifecycle: "prepared",
      });
      let pgPresent = true;
      const authority = {
        pgObjectExists: vi.fn(async () => pgPresent),
        fdbReferenceExistsInTxn: vi.fn(async () => false),
      };
      clock.mockReturnValue(base + 46 * 24 * 60 * 60 * 1000);
      for (let partition = 0; partition < 32; partition++) {
        await store.sweepTerminalPins(authority);
      }
      await expect(
        store.inspectPin("scrape_job", objectId),
      ).resolves.toMatchObject({ lifecycle: "terminal" });
      expect(authority.pgObjectExists).toHaveBeenCalled();
      expect(authority.fdbReferenceExistsInTxn).toHaveBeenCalled();

      // This models a lost Redis routing hint: it is not part of the authority
      // contract. Only the bounded PG adapter becoming empty permits removal.
      pgPresent = false;
      clock.mockReturnValue(
        base + 46 * 24 * 60 * 60 * 1000 + 2 * 60 * 60 * 1000,
      );
      for (let partition = 0; partition < 32; partition++) {
        await store.sweepTerminalPins(authority);
      }
      await expect(
        store.inspectPin("scrape_job", objectId),
      ).resolves.toBeNull();
    } finally {
      clock.mockRestore();
    }
  });

  test("sealed history waits for pins and GC removes controls before generations", async () => {
    const base = 1_900_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(base);
    try {
      const teamId = team();
      const pinId = object();
      await initialize(teamId, "pg");
      await store.preparePinnedObject({
        teamId,
        kind: "scrape_job",
        objectId: pinId,
        admission: { type: "new-root" },
      });
      await store.completePinnedObject({
        teamId,
        kind: "scrape_job",
        objectId: pinId,
        operationId: randomUUID(),
        fromLifecycle: "prepared",
      });
      const transitionOperationId = randomUUID();
      await begin(teamId, transitionOperationId);
      const fdb = getFdb();
      const generationGcRange = fdb.tuple.range([
        "nuq-migration",
        1,
        "gc",
        "generation",
      ]);
      const targetGcEntry = await getNuqFdbDatabase().doTn(async tn => {
        const rows = await tn
          .snapshot()
          .getRangeAll(
            generationGcRange.begin as Buffer,
            generationGcRange.end as Buffer,
          );
        return rows.find(([key]) => {
          const parts = fdb.tuple.unpack(key as Buffer).map(String);
          return parts.includes(teamId) && parts.includes("2");
        }) as [Buffer, Buffer] | undefined;
      });
      expect(targetGcEntry).toBeDefined();
      await store.finalSeal({ teamId, transitionOperationId });
      // Simulate a delayed writer restoring the target's now-stale closed
      // generation entry. The open generation/version CAS must make it a no-op.
      await getNuqFdbDatabase().doTn(async tn =>
        tn.set(targetGcEntry![0], targetGcEntry![1]),
      );
      clock.mockReturnValue(base + 46 * 24 * 60 * 60 * 1000);

      let staleGenerationEntries = 0;
      for (let partition = 0; partition < 32; partition++) {
        staleGenerationEntries +=
          (await store.sweepClosedGenerations())?.stale ?? 0;
      }
      expect(staleGenerationEntries).toBeGreaterThan(0);
      await expect(
        store.inspectGenerationIfPresent(teamId, 1),
      ).resolves.not.toBeNull();

      const authority = {
        pgObjectExists: async () => false,
        fdbReferenceExistsInTxn: async () => false,
      };
      for (let partition = 0; partition < 32; partition++) {
        await store.sweepTerminalPins(authority);
        await store.sweepControlHistory();
      }
      clock.mockReturnValue(
        base + 46 * 24 * 60 * 60 * 1000 + 2 * 60 * 60 * 1000,
      );
      for (let partition = 0; partition < 32; partition++) {
        await store.sweepClosedGenerations();
      }
      await expect(
        store.inspectGenerationIfPresent(teamId, 1),
      ).resolves.toBeNull();
      await expect(
        store.inspectGenerationIfPresent(teamId, 2),
      ).resolves.toMatchObject({ generation: { status: "open" } });
    } finally {
      clock.mockRestore();
    }
  });

  test("counter-local deltas preserve underflow checks and final-seal corruption detection", async () => {
    const teamId = team();
    const objectId = object();
    await initialize(teamId, "fdb");
    const prepared = await store.preparePinnedObject({
      teamId,
      kind: "scrape_job",
      objectId,
      admission: { type: "new-root" },
    });
    await getNuqFdbDatabase().doTn(async tn =>
      tn.set(
        store.residueKey(teamId, 1, "capacity_external_holders"),
        Buffer.from([1]),
      ),
    );
    const active = await store.transitionObjectResidue({
      teamId,
      kind: "scrape_job",
      objectId,
      operationId: randomUUID(),
      fromLifecycle: "prepared",
      toLifecycle: "active",
      residue: { capacity_ready_active: 1 },
      expectedRevision: prepared.revision,
    });
    await store.completePinnedObject({
      teamId,
      kind: "scrape_job",
      objectId,
      operationId: randomUUID(),
      fromLifecycle: "active",
    });
    const transitionOperationId = randomUUID();
    await store.beginTransition({
      teamId,
      targetBackend: "pg",
      operationId: transitionOperationId,
    });
    await expect(
      store.finalSeal({ teamId, transitionOperationId }),
    ).rejects.toMatchObject({ code: "NUQ_MIGRATION_CORRUPT" });

    const underflowTeam = team();
    const underflowObject = object();
    await initialize(underflowTeam, "fdb");
    await store.preparePinnedObject({
      teamId: underflowTeam,
      kind: "scrape_job",
      objectId: underflowObject,
      admission: { type: "new-root" },
      residue: { capacity_ready_active: 1 },
    });
    await getNuqFdbDatabase().doTn(async tn =>
      tn.clear(store.residueKey(underflowTeam, 1, "capacity_ready_active")),
    );
    await expect(
      store.completePinnedObject({
        teamId: underflowTeam,
        kind: "scrape_job",
        objectId: underflowObject,
        operationId: randomUUID(),
        fromLifecycle: "prepared",
      }),
    ).rejects.toMatchObject({
      code: "NUQ_MIGRATION_CORRUPT",
      message: expect.stringContaining("negative or overflow"),
    });
    expect(active.residue.capacity_ready_active).toBe(1);
  });

  test("malformed state and counters fail with deterministic corruption errors", async () => {
    const corruptStateTeam = team();
    await getNuqFdbDatabase().doTn(async tn =>
      tn.set(store.teamStateKey(corruptStateTeam), Buffer.from("not-json")),
    );
    await expect(store.inspectState(corruptStateTeam)).rejects.toMatchObject({
      code: "NUQ_MIGRATION_CORRUPT",
      message: expect.stringContaining("invalid JSON"),
    });

    const corruptCounterTeam = team();
    await initialize(corruptCounterTeam);
    await getNuqFdbDatabase().doTn(async tn =>
      tn.set(
        store.residueKey(corruptCounterTeam, 1, "capacity_external_holders"),
        Buffer.from([1]),
      ),
    );
    await expect(
      store.inspectGeneration(corruptCounterTeam, 1),
    ).rejects.toMatchObject({
      code: "NUQ_MIGRATION_CORRUPT",
      message: expect.stringContaining("counter must be 8 bytes"),
    });

    const corruptOperationTeam = team();
    await initialize(corruptOperationTeam);
    const operationId = randomUUID();
    await begin(corruptOperationTeam, operationId);
    const operationKey = store.pack([
      "team",
      corruptOperationTeam,
      "control-operation",
      operationId,
    ]);
    await getNuqFdbDatabase().doTn(async tn => {
      const raw = await tn.get(operationKey);
      const operation = JSON.parse(raw!.toString("utf8"));
      operation.backend = "pg";
      tn.set(operationKey, Buffer.from(JSON.stringify(operation)));
    });
    await expect(
      store.beginTransition({
        teamId: corruptOperationTeam,
        targetBackend: "fdb",
        operationId,
      }),
    ).rejects.toMatchObject({
      code: "NUQ_MIGRATION_CORRUPT",
      message: expect.stringContaining("operation/state mismatch"),
    });

    const corruptIndexTeam = team();
    const corruptIndexObject = object();
    await initialize(corruptIndexTeam);
    await store.preparePinnedObject({
      teamId: corruptIndexTeam,
      kind: "scrape_job",
      objectId: corruptIndexObject,
      admission: { type: "new-root" },
      residue: { capacity_ready_active: 1 },
    });
    await getNuqFdbDatabase().doTn(async tn =>
      tn.set(
        store.pack([
          "team",
          corruptIndexTeam,
          "object",
          "scrape_job",
          corruptIndexObject,
        ]),
        Buffer.from("not-json"),
      ),
    );
    await expect(
      store.completePinnedObject({
        teamId: corruptIndexTeam,
        kind: "scrape_job",
        objectId: corruptIndexObject,
        operationId: randomUUID(),
        fromLifecycle: "prepared",
      }),
    ).rejects.toMatchObject({
      code: "NUQ_MIGRATION_CORRUPT",
      message: expect.stringContaining("invalid JSON"),
    });
  });
});
