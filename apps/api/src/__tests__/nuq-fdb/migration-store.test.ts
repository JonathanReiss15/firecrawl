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
    await initialize(teamId);
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
    expect(
      Object.values((await store.inspectGeneration(teamId, 1)).residue),
    ).toEqual(Array(MIGRATION_RESIDUE_COUNTERS.length).fill(0));
    await expect(store.inspectPin("scrape_job", objectId)).resolves.toEqual(
      terminal,
    );
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
