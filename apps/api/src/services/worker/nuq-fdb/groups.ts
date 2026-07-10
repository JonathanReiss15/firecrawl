import { randomUUID } from "crypto";
import type { Transaction } from "foundationdb";
import { Logger } from "winston";
import { logger as _logger } from "../../../lib/logger";
import { getNuqFdbDatabase } from "./client";
import {
  NuqFdbKeyspace,
  GroupMeta,
  JobMeta,
  QueueEntry,
  encodeJson,
  decodeJson,
  decodeI64,
  normalizeOwnerId,
} from "./keyspace";
import {
  ONE,
  MINUS_ONE,
  EMPTY,
  TxContext,
  newTxContext,
  uvSuffix,
  pushReady,
  setStatusQueued,
  setGroupJobIndex,
  bumpGroupStatusCount,
  alignQueueMetricStatus,
  reconcileJobMigrationInTxn,
  runtimeMigrationPin,
  stampMigrationPin,
} from "./ops";
import { nuqFdbMigrationStore } from "./migration-store";

export type NuQFdbGroupStatus = "active" | "completed" | "cancelled";

export type NuQFdbJobGroupInstance = {
  id: string;
  status: NuQFdbGroupStatus;
  createdAt: Date;
  ownerId: string;
  ttl: number;
  expiresAt?: Date;
  maxConcurrency?: number;
  delaySeconds?: number;
  migrationBackend?: "pg" | "fdb";
  migrationGeneration?: number;
};

const DEFAULT_GROUP_TTL_MS = 86400000;
// A group that is never populated, abandoned by its producer, or otherwise
// never reaches normal completion must not live forever. This deadline is
// independent of the post-completion retention TTL.
export const ACTIVE_GROUP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function groupSweepTaskId(gid: string): string {
  return `group-cancel/${gid}`;
}

export async function prepareGroupSweepTaskInTxn(
  tn: Transaction,
  gid: string,
  group: GroupMeta,
): Promise<import("./migration-store").MigrationObjectPin | null> {
  const groupPin = await nuqFdbMigrationStore.validateManagedObjectInTxn(tn, {
    teamId: group.o,
    kind: "group",
    objectId: gid,
    recordPin: runtimeMigrationPin(group),
  });
  if (!groupPin) return null;
  const taskPin = await nuqFdbMigrationStore.preparePinnedObjectInTxn(tn, {
    teamId: group.o,
    kind: "sweeper_task",
    objectId: groupSweepTaskId(gid),
    admission: {
      type: "pinned-continuation",
      source: { kind: "group", objectId: gid },
    },
    requiredBackend: "fdb",
    residue: { control_sweeper_tasks: 1 },
  });
  return await nuqFdbMigrationStore.reconcileManagedObjectInTxn(tn, {
    teamId: group.o,
    kind: "sweeper_task",
    objectId: groupSweepTaskId(gid),
    recordPin: {
      backend: taskPin.backend,
      generation: taskPin.generation,
    },
    residue: { control_sweeper_tasks: 1 },
  });
}

export class NuqFdbGroupOps {
  constructor(
    public readonly ks: NuqFdbKeyspace,
    public readonly finishedKs: NuqFdbKeyspace | null,
  ) {}

  // Group accounting for a job reaching a terminal state. Must run in the same
  // transaction as the status transition. The blind task-key set is the
  // race-free backstop for finish detection; the inline completion attempt
  // covers the common small-crawl case instantly.
  public async terminalAccounting(
    tn: Transaction,
    gid: string,
    id: string,
    prevStatus: string,
    outcome: "completed" | "failed",
    countable: boolean,
    now: number,
    txc: TxContext,
  ): Promise<void> {
    setGroupJobIndex(tn, this.ks, gid, id, countable, outcome);
    if (countable) {
      bumpGroupStatusCount(tn, this.ks, gid, prevStatus, -1);
      bumpGroupStatusCount(tn, this.ks, gid, outcome, 1);
      if (outcome === "completed") {
        tn.setVersionstampSuffixedKey(
          this.ks.groupDonePrefix(gid),
          Buffer.from(id, "utf8"),
          uvSuffix(txc),
        );
      }
    }

    const remSnap = decodeI64(
      await tn.snapshot().get(this.ks.groupRemaining(gid)),
    );
    tn.set(this.ks.taskGroupFinish(gid), EMPTY);
    if (remSnap <= 5) {
      // near the end: read for real (conflicts with concurrent finishers, but
      // contention is bounded to the last few jobs of the group)
      const remReal = decodeI64(await tn.get(this.ks.groupRemaining(gid)));
      tn.add(this.ks.groupRemaining(gid), MINUS_ONE);
      if (remReal - 1 <= 0) {
        await this.tryCompleteGroup(tn, gid, now, txc);
      }
    } else {
      tn.add(this.ks.groupRemaining(gid), MINUS_ONE);
    }
  }

  // Completes a drained group: flips status, schedules TTL cleanup, and emits
  // the crawl-finished job. The normal read of group meta serializes
  // concurrent completers; exactly one transaction performs the emit.
  public async tryCompleteGroup(
    tn: Transaction,
    gid: string,
    now: number,
    txc: TxContext,
  ): Promise<boolean> {
    // A multi-transaction enqueue holds this barrier from reservation through
    // its final publish, so an empty prefix of the batch cannot finish the
    // group while later chunks are still invisible.
    const ingests = decodeI64(await tn.get(this.ks.groupIngestCount(gid)));
    if (ingests > 0) return false;
    const gMeta = decodeJson<GroupMeta>(await tn.get(this.ks.groupMeta(gid)));
    if (!gMeta || gMeta.s === "completed") {
      tn.clear(this.ks.taskGroupFinish(gid));
      return false;
    }
    const continuationPin =
      gMeta.s === "cancelled"
        ? await nuqFdbMigrationStore.validateManagedObjectInTxn(tn, {
            teamId: gMeta.o,
            kind: "sweeper_task",
            objectId: groupSweepTaskId(gid),
            recordPin: runtimeMigrationPin(gMeta),
          })
        : await nuqFdbMigrationStore.validateManagedObjectInTxn(tn, {
            teamId: gMeta.o,
            kind: "group",
            objectId: gid,
            recordPin: runtimeMigrationPin(gMeta),
          });
    const expiresAt = now + gMeta.t;
    const expiryGeneration = randomUUID();
    const updated: GroupMeta = {
      ...gMeta,
      s: "completed",
      x: expiresAt,
      eg: expiryGeneration,
    };
    tn.set(this.ks.groupMeta(gid), encodeJson(updated));
    if (gMeta.a !== undefined && gMeta.eg) {
      tn.clear(this.ks.groupExpiry(gMeta.a, gid, gMeta.eg));
    }
    tn.set(this.ks.groupExpiry(expiresAt, gid, expiryGeneration), EMPTY);
    tn.clear(this.ks.ongoingGroup(gMeta.o, gid));
    tn.clear(this.ks.taskGroupFinish(gid));

    if (this.finishedKs) {
      const fid = randomUUID();
      const finishedPin = continuationPin
        ? await nuqFdbMigrationStore.preparePinnedObjectInTxn(tn, {
            teamId: gMeta.o,
            kind: "crawl_finished",
            objectId: fid,
            admission: {
              type: "pinned-continuation",
              source: {
                kind: gMeta.s === "cancelled" ? "sweeper_task" : "group",
                objectId: gMeta.s === "cancelled" ? groupSweepTaskId(gid) : gid,
              },
            },
            requiredBackend: "fdb",
            residue: { control_crawl_finished: 1 },
          })
        : null;
      const meta: JobMeta = stampMigrationPin(
        { c: now, p: 0, o: gMeta.o, g: gid, f: 0, dc: 1 },
        finishedPin,
      );
      tn.set(this.finishedKs.jobMeta(fid), encodeJson(meta));
      tn.set(this.finishedKs.jobData(fid, 0), encodeJson({}));
      const entry: QueueEntry = stampMigrationPin(
        {
          i: fid,
          o: gMeta.o,
          g: gid,
          p: 0,
          f: 0,
          c: now,
        },
        finishedPin,
      );
      pushReady(tn, this.finishedKs, entry, txc);
      await reconcileJobMigrationInTxn(tn, this.finishedKs, entry, {
        control_crawl_finished: 1,
      });
      setStatusQueued(tn, this.finishedKs, fid);
      await alignQueueMetricStatus(tn, this.finishedKs, fid);
      // pointer for group TTL cleanup to find the finished job's records
      tn.set(this.ks.groupFinishedJob(gid), Buffer.from(fid, "utf8"));
    }
    if (gMeta.s === "cancelled") {
      await nuqFdbMigrationStore.reconcileManagedObjectInTxn(tn, {
        teamId: gMeta.o,
        kind: "sweeper_task",
        objectId: groupSweepTaskId(gid),
        recordPin: runtimeMigrationPin(gMeta),
        residue: {},
        terminal: true,
      });
    } else {
      await nuqFdbMigrationStore.reconcileManagedObjectInTxn(tn, {
        teamId: gMeta.o,
        kind: "group",
        objectId: gid,
        recordPin: runtimeMigrationPin(gMeta),
        residue: {},
        terminal: true,
      });
    }
    return true;
  }
}

export class NuQFdbJobGroup {
  constructor(
    public readonly ks: NuqFdbKeyspace,
    public readonly groupOps: NuqFdbGroupOps,
  ) {}

  private get db() {
    return getNuqFdbDatabase();
  }

  private toInstance(id: string, g: GroupMeta): NuQFdbJobGroupInstance {
    return {
      id,
      status: g.s,
      createdAt: new Date(g.c),
      ownerId: g.o,
      ttl: g.t,
      expiresAt: g.x !== undefined ? new Date(g.x) : undefined,
      maxConcurrency: g.m,
      delaySeconds: g.d,
      migrationBackend: g.mb,
      migrationGeneration: g.mg,
    };
  }

  public async addGroup(
    id: string,
    ownerId: string,
    ttl?: number,
    opts?: { maxConcurrency?: number; delaySeconds?: number },
    logger: Logger = _logger,
  ): Promise<NuQFdbJobGroupInstance> {
    const owner = normalizeOwnerId(ownerId);
    if (owner === null) throw new Error("Group owner is required");
    return await this.db.doTn(async tn => {
      const existingBuf = await tn.get(this.ks.groupMeta(id));
      const existing = decodeJson<GroupMeta>(existingBuf);
      if (existing) {
        await nuqFdbMigrationStore.validateManagedObjectInTxn(tn, {
          teamId: owner,
          kind: "group",
          objectId: id,
          recordPin: runtimeMigrationPin(existing),
        });
        return this.toInstance(id, existing);
      }
      const now = Date.now();
      const abandonmentDeadline = now + ACTIVE_GROUP_MAX_AGE_MS;
      const expiryGeneration = randomUUID();
      const pin = await nuqFdbMigrationStore.reconcileManagedObjectInTxn(tn, {
        teamId: owner,
        kind: "group",
        objectId: id,
        allowMissingRecordPin: true,
        residue: { control_groups: 1 },
      });
      const g: GroupMeta = stampMigrationPin(
        {
          o: owner,
          c: now,
          t: ttl ?? DEFAULT_GROUP_TTL_MS,
          s: "active",
          m: opts?.maxConcurrency,
          d: opts?.delaySeconds,
          a: abandonmentDeadline,
          eg: expiryGeneration,
        },
        pin,
      );
      tn.set(this.ks.groupMeta(id), encodeJson(g));
      tn.set(
        this.ks.groupExpiry(abandonmentDeadline, id, expiryGeneration),
        EMPTY,
      );
      tn.set(this.ks.ongoingGroup(owner, id), encodeJson({ c: now }));
      return this.toInstance(id, g);
    });
  }

  public async getGroup(
    id: string,
    logger: Logger = _logger,
  ): Promise<NuQFdbJobGroupInstance | null> {
    return await this.db.doTn(async tn => {
      const g = decodeJson<GroupMeta>(await tn.get(this.ks.groupMeta(id)));
      return g ? this.toInstance(id, g) : null;
    });
  }

  public async getOngoingByOwner(
    ownerId: string,
    logger: Logger = _logger,
  ): Promise<NuQFdbJobGroupInstance[]> {
    const owner = normalizeOwnerId(ownerId);
    if (owner === null) return [];
    return await this.db.doTn(async tn => {
      const r = this.ks.ongoingGroupRange(owner);
      const rows = await tn.snapshot().getRangeAll(r.begin, r.end);
      const out: NuQFdbJobGroupInstance[] = [];
      for (const [key] of rows) {
        const gid = this.ks.unpackId(key as Buffer);
        const g = decodeJson<GroupMeta>(
          await tn.snapshot().get(this.ks.groupMeta(gid)),
        );
        if (g && g.s === "active") out.push(this.toInstance(gid, g));
      }
      return out;
    });
  }

  // O(1) cancellation: flips the group status and leaves the heavy lifting to
  // the sweeper (pending entries) and take-side diversion (ready entries).
  public async cancelGroup(
    id: string,
    logger: Logger = _logger,
  ): Promise<boolean> {
    return await this.db.doTn(async tn => {
      const g = decodeJson<GroupMeta>(await tn.get(this.ks.groupMeta(id)));
      if (!g || g.s !== "active") return false;
      await prepareGroupSweepTaskInTxn(tn, id, g);
      await nuqFdbMigrationStore.reconcileManagedObjectInTxn(tn, {
        teamId: g.o,
        kind: "group",
        objectId: id,
        recordPin: runtimeMigrationPin(g),
        residue: {},
        terminal: true,
      });
      tn.set(
        this.ks.groupMeta(id),
        encodeJson({ ...g, s: "cancelled" } satisfies GroupMeta),
      );
      tn.set(this.ks.taskGroupCancel(id), EMPTY);
      tn.clear(this.ks.ongoingGroup(g.o, id));
      return true;
    });
  }
}
