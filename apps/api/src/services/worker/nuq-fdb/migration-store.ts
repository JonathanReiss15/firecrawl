import type { Transaction } from "foundationdb";
import { getFdb, getNuqFdbDatabase } from "./client";
import { encodeI64 } from "./keyspace";

export type MigrationBackend = "pg" | "fdb";
export type MigrationPhase =
  | "PG_ONLY"
  | "DRAINING_TO_FDB"
  | "FDB_ONLY"
  | "DRAINING_TO_PG"
  | "ERROR";
export type MigrationGenerationStatus = "open" | "draining" | "closed";
export type MigrationObjectKind =
  | "scrape_job"
  | "group"
  | "external_holder"
  | "crawl_finished"
  | "sweeper_task"
  | "cross_store_intent";
export type MigrationObjectLifecycle = "prepared" | "active" | "terminal";

export const MIGRATION_RESIDUE_COUNTERS = [
  "capacity_team_pending",
  "capacity_key_pending",
  "capacity_crawl_pending",
  "capacity_delayed",
  "capacity_ready_active",
  "capacity_external_holders",
  "control_groups",
  "control_crawl_finished",
  "control_sweeper_tasks",
  "intent_unresolved",
] as const;

export type MigrationResidueCounter =
  (typeof MIGRATION_RESIDUE_COUNTERS)[number];
export type MigrationResidue = Record<MigrationResidueCounter, number>;

export type MigrationGeneration = {
  schemaVersion: 1;
  teamId: string;
  backend: MigrationBackend;
  generation: number;
  status: MigrationGenerationStatus;
};

export type MigrationTeamState = {
  schemaVersion: 1;
  teamId: string;
  revision: number;
  maxGeneration: number;
  activeBackend: MigrationBackend;
  activeGeneration: number;
  phase: MigrationPhase;
  targetBackend?: MigrationBackend;
  targetGeneration?: number;
  transitionOperationId?: string;
};

export type MigrationObjectPin = {
  schemaVersion: 1;
  teamId: string;
  kind: MigrationObjectKind;
  objectId: string;
  backend: MigrationBackend;
  generation: number;
  lifecycle: MigrationObjectLifecycle;
  revision: number;
  admission: "new-root" | "pinned-continuation" | "legacy-backfill";
  sourceKind?: MigrationObjectKind;
  sourceObjectId?: string;
  initialResidue: MigrationResidue;
  residue: MigrationResidue;
};

export type MigrationPinAdmission =
  | { type: "new-root" }
  | {
      type: "pinned-continuation";
      source: { kind: MigrationObjectKind; objectId: string };
    }
  | {
      // Explicit interpretation for an object known to predate control-plane
      // initialization. Never infer this from Redis or today's rollout flag.
      type: "legacy-backfill";
      backend: MigrationBackend;
      generation: number;
      terminal?: boolean;
    };

export type PreparePinnedObjectInput = {
  teamId: string;
  kind: MigrationObjectKind;
  objectId: string;
  admission: MigrationPinAdmission;
  requiredBackend?: MigrationBackend;
  residue?: Partial<MigrationResidue>;
};

export type TransitionObjectResidueInput = {
  teamId: string;
  kind: MigrationObjectKind;
  objectId: string;
  operationId: string;
  fromLifecycle: MigrationObjectLifecycle;
  toLifecycle: MigrationObjectLifecycle;
  residue: Partial<MigrationResidue>;
};

export type CompletePinnedObjectInput = {
  teamId: string;
  kind: MigrationObjectKind;
  objectId: string;
  operationId: string;
  fromLifecycle: "prepared" | "active";
};

export type MigrationSteadyResolution =
  | { status: "legacy-uninitialized" }
  | { status: "steady"; state: MigrationTeamState }
  | { status: "transition-required"; state: MigrationTeamState }
  | { status: "transitioning"; state: MigrationTeamState }
  | { status: "cancel-required"; state: MigrationTeamState };

export class MigrationStoreError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(`${code}: ${message}`);
    this.name = this.constructor.name;
  }
}

export class MigrationCorruptionError extends MigrationStoreError {
  constructor(record: string, detail: string) {
    super("NUQ_MIGRATION_CORRUPT", `${record}: ${detail}`);
  }
}

export class MigrationCasError extends MigrationStoreError {
  constructor(expected: number, actual: number) {
    super(
      "NUQ_MIGRATION_CAS_MISMATCH",
      `expected revision ${expected}, found ${actual}`,
      true,
    );
  }
}

export class MigrationInProgressError extends MigrationStoreError {
  constructor(teamId: string) {
    super(
      "NUQ_MIGRATION_IN_PROGRESS",
      `new root admission is closed for team ${teamId}`,
      true,
    );
  }
}

export class MigrationStaleGenerationError extends MigrationStoreError {
  constructor(teamId: string, backend: MigrationBackend, generation: number) {
    super(
      "NUQ_MIGRATION_STALE_GENERATION",
      `generation ${backend}/${generation} is not open or draining for team ${teamId}`,
      true,
    );
  }
}

export class MigrationResidueNotEmptyError extends MigrationStoreError {
  constructor(teamId: string, generation: number, residue: MigrationResidue) {
    const nonzero = Object.entries(residue)
      .filter(([, value]) => value !== 0)
      .map(([name, value]) => `${name}=${value}`)
      .join(",");
    super(
      "NUQ_MIGRATION_RESIDUE_NOT_EMPTY",
      `team ${teamId} generation ${generation} has residue ${nonzero}`,
      true,
    );
  }
}

export class MigrationLegacyStateError extends MigrationStoreError {
  constructor(teamId: string) {
    super(
      "NUQ_MIGRATION_LEGACY_UNINITIALIZED",
      `team ${teamId} must be explicitly initialized with its legacy backend`,
    );
  }
}

export class MigrationOperationConflictError extends MigrationStoreError {
  constructor(operationId: string) {
    super(
      "NUQ_MIGRATION_OPERATION_CONFLICT",
      `operation ${operationId} was already used with different input`,
    );
  }
}

const BACKENDS: readonly MigrationBackend[] = ["pg", "fdb"];
const PHASES: readonly MigrationPhase[] = [
  "PG_ONLY",
  "DRAINING_TO_FDB",
  "FDB_ONLY",
  "DRAINING_TO_PG",
  "ERROR",
];
const GENERATION_STATUSES: readonly MigrationGenerationStatus[] = [
  "open",
  "draining",
  "closed",
];
const OBJECT_KINDS: readonly MigrationObjectKind[] = [
  "scrape_job",
  "group",
  "external_holder",
  "crawl_finished",
  "sweeper_task",
  "cross_store_intent",
];
const OBJECT_LIFECYCLES: readonly MigrationObjectLifecycle[] = [
  "prepared",
  "active",
  "terminal",
];

function assertNonempty(value: string, name: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new MigrationStoreError(
      "NUQ_MIGRATION_INVALID_ARGUMENT",
      `${name} must be non-empty`,
    );
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function encodeJson(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function parseJson(value: Buffer | undefined | null, record: string): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value.toString("utf8"));
  } catch {
    throw new MigrationCorruptionError(record, "invalid JSON");
  }
}

function normalizeResidue(
  input: Partial<MigrationResidue> | undefined,
  record = "residue input",
): MigrationResidue {
  const source = input ?? {};
  for (const key of Object.keys(source)) {
    if (!(MIGRATION_RESIDUE_COUNTERS as readonly string[]).includes(key)) {
      throw new MigrationStoreError(
        "NUQ_MIGRATION_INVALID_ARGUMENT",
        `${record} contains unknown counter ${key}`,
      );
    }
  }
  return Object.fromEntries(
    MIGRATION_RESIDUE_COUNTERS.map(counter => {
      const value = source[counter] ?? 0;
      if (!isNonnegativeInteger(value)) {
        throw new MigrationStoreError(
          "NUQ_MIGRATION_INVALID_ARGUMENT",
          `${record}.${counter} must be a nonnegative safe integer`,
        );
      }
      return [counter, value];
    }),
  ) as MigrationResidue;
}

function validateStoredResidue(
  value: unknown,
  record: string,
): MigrationResidue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MigrationCorruptionError(record, "invalid residue");
  }
  const keys = Object.keys(value);
  if (
    keys.length !== MIGRATION_RESIDUE_COUNTERS.length ||
    keys.some(
      key => !(MIGRATION_RESIDUE_COUNTERS as readonly string[]).includes(key),
    )
  ) {
    throw new MigrationCorruptionError(record, "invalid residue counters");
  }
  const residue = value as Record<string, unknown>;
  for (const counter of MIGRATION_RESIDUE_COUNTERS) {
    if (!isNonnegativeInteger(residue[counter])) {
      throw new MigrationCorruptionError(record, `invalid counter ${counter}`);
    }
  }
  return residue as MigrationResidue;
}

function validateTeamState(value: unknown, record: string): MigrationTeamState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MigrationCorruptionError(record, "invalid team state");
  }
  const state = value as Record<string, unknown>;
  if (
    state.schemaVersion !== 1 ||
    typeof state.teamId !== "string" ||
    !isPositiveInteger(state.revision) ||
    !isPositiveInteger(state.maxGeneration) ||
    !BACKENDS.includes(state.activeBackend as MigrationBackend) ||
    !isPositiveInteger(state.activeGeneration) ||
    state.activeGeneration > state.maxGeneration ||
    !PHASES.includes(state.phase as MigrationPhase)
  ) {
    throw new MigrationCorruptionError(record, "invalid team state fields");
  }
  const transitioning =
    state.phase === "DRAINING_TO_FDB" || state.phase === "DRAINING_TO_PG";
  if (transitioning) {
    if (
      !BACKENDS.includes(state.targetBackend as MigrationBackend) ||
      !isPositiveInteger(state.targetGeneration) ||
      typeof state.transitionOperationId !== "string" ||
      state.transitionOperationId.length === 0 ||
      state.targetBackend === state.activeBackend ||
      state.targetGeneration !== state.maxGeneration ||
      state.targetGeneration <= state.activeGeneration
    ) {
      throw new MigrationCorruptionError(record, "invalid transition fields");
    }
  } else if (
    state.targetBackend !== undefined ||
    state.targetGeneration !== undefined ||
    state.transitionOperationId !== undefined
  ) {
    throw new MigrationCorruptionError(record, "unexpected transition fields");
  }
  if (
    (state.phase === "PG_ONLY" && state.activeBackend !== "pg") ||
    (state.phase === "FDB_ONLY" && state.activeBackend !== "fdb") ||
    (state.phase === "DRAINING_TO_FDB" && state.targetBackend !== "fdb") ||
    (state.phase === "DRAINING_TO_PG" && state.targetBackend !== "pg")
  ) {
    throw new MigrationCorruptionError(record, "phase/backend mismatch");
  }
  return state as MigrationTeamState;
}

function validateGeneration(
  value: unknown,
  record: string,
): MigrationGeneration {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MigrationCorruptionError(record, "invalid generation");
  }
  const generation = value as Record<string, unknown>;
  if (
    generation.schemaVersion !== 1 ||
    typeof generation.teamId !== "string" ||
    !BACKENDS.includes(generation.backend as MigrationBackend) ||
    !isPositiveInteger(generation.generation) ||
    !GENERATION_STATUSES.includes(
      generation.status as MigrationGenerationStatus,
    )
  ) {
    throw new MigrationCorruptionError(record, "invalid generation fields");
  }
  return generation as MigrationGeneration;
}

function validatePin(value: unknown, record: string): MigrationObjectPin {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MigrationCorruptionError(record, "invalid object pin");
  }
  const pin = value as Record<string, unknown>;
  if (
    pin.schemaVersion !== 1 ||
    typeof pin.teamId !== "string" ||
    !OBJECT_KINDS.includes(pin.kind as MigrationObjectKind) ||
    typeof pin.objectId !== "string" ||
    !BACKENDS.includes(pin.backend as MigrationBackend) ||
    !isPositiveInteger(pin.generation) ||
    !OBJECT_LIFECYCLES.includes(pin.lifecycle as MigrationObjectLifecycle) ||
    !isPositiveInteger(pin.revision) ||
    (pin.admission !== "new-root" &&
      pin.admission !== "pinned-continuation" &&
      pin.admission !== "legacy-backfill")
  ) {
    throw new MigrationCorruptionError(record, "invalid object pin fields");
  }
  if (
    ((pin.admission === "new-root" || pin.admission === "legacy-backfill") &&
      (pin.sourceKind !== undefined || pin.sourceObjectId !== undefined)) ||
    (pin.admission === "pinned-continuation" &&
      (!OBJECT_KINDS.includes(pin.sourceKind as MigrationObjectKind) ||
        typeof pin.sourceObjectId !== "string" ||
        pin.sourceObjectId.length === 0))
  ) {
    throw new MigrationCorruptionError(record, "invalid source pin fields");
  }
  const initialResidue = validateStoredResidue(
    pin.initialResidue,
    `${record}.initialResidue`,
  );
  const residue = validateStoredResidue(pin.residue, `${record}.residue`);
  return { ...(pin as MigrationObjectPin), initialResidue, residue };
}

function decodeCounter(
  value: Buffer | undefined | null,
  record: string,
): number {
  if (!value) return 0;
  if (value.length !== 8) {
    throw new MigrationCorruptionError(record, "counter must be 8 bytes");
  }
  const decoded = Number(value.readBigInt64LE());
  if (!isNonnegativeInteger(decoded)) {
    throw new MigrationCorruptionError(
      record,
      "counter must be a nonnegative safe integer",
    );
  }
  return decoded;
}

function stablePhase(backend: MigrationBackend): MigrationPhase {
  return backend === "pg" ? "PG_ONLY" : "FDB_ONLY";
}

function drainingPhase(target: MigrationBackend): MigrationPhase {
  return target === "pg" ? "DRAINING_TO_PG" : "DRAINING_TO_FDB";
}

function nextRevision(state: MigrationTeamState): number {
  const revision = state.revision + 1;
  if (!Number.isSafeInteger(revision)) {
    throw new MigrationCorruptionError(
      `team ${state.teamId}`,
      "revision exhausted safe integer range",
    );
  }
  return revision;
}

function residueEqual(a: MigrationResidue, b: MigrationResidue): boolean {
  return MIGRATION_RESIDUE_COUNTERS.every(counter => a[counter] === b[counter]);
}

type ControlOperation = {
  schemaVersion: 1;
  kind: "initialize" | "begin";
  operationId: string;
  backend: MigrationBackend;
  outcome: "completed" | "pending" | "cancelled";
  state: MigrationTeamState;
};

type ObjectOperation = {
  schemaVersion: 1;
  operationId: string;
  teamId: string;
  kind: MigrationObjectKind;
  objectId: string;
  fromLifecycle: MigrationObjectLifecycle;
  toLifecycle: MigrationObjectLifecycle;
  residue: MigrationResidue;
  result: MigrationObjectPin;
};

function validateControlOperation(
  value: unknown,
  record: string,
): ControlOperation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MigrationCorruptionError(record, "invalid control operation");
  }
  const op = value as Record<string, unknown>;
  if (
    op.schemaVersion !== 1 ||
    (op.kind !== "initialize" && op.kind !== "begin") ||
    typeof op.operationId !== "string" ||
    !BACKENDS.includes(op.backend as MigrationBackend) ||
    (op.outcome !== "completed" &&
      op.outcome !== "pending" &&
      op.outcome !== "cancelled")
  ) {
    throw new MigrationCorruptionError(
      record,
      "invalid control operation fields",
    );
  }
  const decoded = {
    ...(op as ControlOperation),
    state: validateTeamState(op.state, `${record}.state`),
  };
  const steady =
    decoded.state.phase === "PG_ONLY" || decoded.state.phase === "FDB_ONLY";
  if (
    (decoded.kind === "initialize" &&
      (decoded.outcome !== "completed" ||
        !steady ||
        decoded.state.activeBackend !== decoded.backend)) ||
    (decoded.kind === "begin" &&
      decoded.outcome === "pending" &&
      (decoded.state.transitionOperationId !== decoded.operationId ||
        decoded.state.targetBackend !== decoded.backend)) ||
    (decoded.kind === "begin" &&
      decoded.outcome === "completed" &&
      (!steady || decoded.state.activeBackend !== decoded.backend)) ||
    (decoded.kind === "begin" &&
      decoded.outcome === "cancelled" &&
      (!steady || decoded.state.activeBackend === decoded.backend))
  ) {
    throw new MigrationCorruptionError(record, "operation/state mismatch");
  }
  return decoded;
}

function validateObjectOperation(
  value: unknown,
  record: string,
): ObjectOperation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MigrationCorruptionError(record, "invalid object operation");
  }
  const op = value as Record<string, unknown>;
  if (
    op.schemaVersion !== 1 ||
    typeof op.operationId !== "string" ||
    typeof op.teamId !== "string" ||
    !OBJECT_KINDS.includes(op.kind as MigrationObjectKind) ||
    typeof op.objectId !== "string" ||
    !OBJECT_LIFECYCLES.includes(op.fromLifecycle as MigrationObjectLifecycle) ||
    !OBJECT_LIFECYCLES.includes(op.toLifecycle as MigrationObjectLifecycle)
  ) {
    throw new MigrationCorruptionError(
      record,
      "invalid object operation fields",
    );
  }
  const decoded = {
    ...(op as ObjectOperation),
    residue: validateStoredResidue(op.residue, `${record}.residue`),
    result: validatePin(op.result, `${record}.result`),
  };
  if (
    decoded.result.teamId !== decoded.teamId ||
    decoded.result.kind !== decoded.kind ||
    decoded.result.objectId !== decoded.objectId ||
    decoded.result.lifecycle !== decoded.toLifecycle ||
    !residueEqual(decoded.result.residue, decoded.residue)
  ) {
    throw new MigrationCorruptionError(record, "operation/result mismatch");
  }
  return decoded;
}

export class NuqFdbMigrationStore {
  private get db() {
    return getNuqFdbDatabase();
  }

  // This prefix is deliberately global and disjoint from every queue's
  // ("nuq", queueName) subspace.
  public pack(parts: any[]): Buffer {
    return getFdb().tuple.pack(["nuq-migration", 1, ...parts]) as Buffer;
  }

  public teamStateKey(teamId: string): Buffer {
    return this.pack(["team", teamId, "state"]);
  }

  public generationKey(teamId: string, generation: number): Buffer {
    return this.pack(["team", teamId, "generation", generation]);
  }

  public residueKey(
    teamId: string,
    generation: number,
    counter: MigrationResidueCounter,
  ): Buffer {
    return this.pack(["team", teamId, "residue", generation, counter]);
  }

  public objectKey(kind: MigrationObjectKind, objectId: string): Buffer {
    return this.pack(["object", kind, objectId]);
  }

  private teamObjectKey(
    teamId: string,
    kind: MigrationObjectKind,
    objectId: string,
  ): Buffer {
    return this.pack(["team", teamId, "object", kind, objectId]);
  }

  private controlOperationKey(teamId: string, operationId: string): Buffer {
    return this.pack(["team", teamId, "control-operation", operationId]);
  }

  private objectOperationKey(
    teamId: string,
    kind: MigrationObjectKind,
    objectId: string,
    operationId: string,
  ): Buffer {
    return this.pack([
      "team",
      teamId,
      "object-operation",
      kind,
      objectId,
      operationId,
    ]);
  }

  private async readState(
    tn: Transaction,
    teamId: string,
  ): Promise<MigrationTeamState | null> {
    const value = await tn.get(this.teamStateKey(teamId));
    if (!value) return null;
    const state = validateTeamState(
      value && parseJson(value, `team ${teamId}`),
      `team ${teamId}`,
    );
    if (state.teamId !== teamId) {
      throw new MigrationCorruptionError(`team ${teamId}`, "team id mismatch");
    }
    return state;
  }

  private async readGeneration(
    tn: Transaction,
    teamId: string,
    generation: number,
  ): Promise<MigrationGeneration | null> {
    const record = `team ${teamId} generation ${generation}`;
    const value = await tn.get(this.generationKey(teamId, generation));
    if (!value) return null;
    const decoded = validateGeneration(parseJson(value, record), record);
    if (decoded.teamId !== teamId || decoded.generation !== generation) {
      throw new MigrationCorruptionError(record, "identity mismatch");
    }
    return decoded;
  }

  private async requireGeneration(
    tn: Transaction,
    teamId: string,
    generation: number,
  ): Promise<MigrationGeneration> {
    const value = await this.readGeneration(tn, teamId, generation);
    if (!value) {
      throw new MigrationCorruptionError(
        `team ${teamId} generation ${generation}`,
        "missing generation record",
      );
    }
    return value;
  }

  private async readResidue(
    tn: Transaction,
    teamId: string,
    generation: number,
  ): Promise<MigrationResidue> {
    const values = await Promise.all(
      MIGRATION_RESIDUE_COUNTERS.map(counter =>
        tn.get(this.residueKey(teamId, generation, counter)),
      ),
    );
    return Object.fromEntries(
      MIGRATION_RESIDUE_COUNTERS.map((counter, index) => [
        counter,
        decodeCounter(
          values[index],
          `team ${teamId} generation ${generation} residue ${counter}`,
        ),
      ]),
    ) as MigrationResidue;
  }

  private async applyResidueDelta(
    tn: Transaction,
    teamId: string,
    generation: number,
    from: MigrationResidue,
    to: MigrationResidue,
  ): Promise<void> {
    const current = await this.readResidue(tn, teamId, generation);
    for (const counter of MIGRATION_RESIDUE_COUNTERS) {
      const delta = to[counter] - from[counter];
      if (!Number.isSafeInteger(delta)) {
        throw new MigrationStoreError(
          "NUQ_MIGRATION_INVALID_ARGUMENT",
          `counter delta for ${counter} is not a safe integer`,
        );
      }
      if (!isNonnegativeInteger(current[counter] + delta)) {
        throw new MigrationCorruptionError(
          `team ${teamId} generation ${generation} residue ${counter}`,
          "pin delta would make counter negative or overflow",
        );
      }
      if (delta !== 0) {
        tn.add(this.residueKey(teamId, generation, counter), encodeI64(delta));
      }
    }
  }

  private async validateTopology(
    tn: Transaction,
    state: MigrationTeamState,
  ): Promise<void> {
    if (state.phase === "ERROR") return;
    const source = await this.requireGeneration(
      tn,
      state.teamId,
      state.activeGeneration,
    );
    if (source.backend !== state.activeBackend) {
      throw new MigrationCorruptionError(
        `team ${state.teamId}`,
        "active generation backend mismatch",
      );
    }
    if (state.phase === "PG_ONLY" || state.phase === "FDB_ONLY") {
      if (source.status !== "open") {
        throw new MigrationCorruptionError(
          `team ${state.teamId}`,
          "steady generation is not open",
        );
      }
      return;
    }
    const target = await this.requireGeneration(
      tn,
      state.teamId,
      state.targetGeneration!,
    );
    if (
      source.status !== "draining" ||
      target.status !== "closed" ||
      target.backend !== state.targetBackend
    ) {
      throw new MigrationCorruptionError(
        `team ${state.teamId}`,
        "transition generation topology mismatch",
      );
    }
  }

  public async inspectState(
    teamId: string,
  ): Promise<MigrationTeamState | null> {
    assertNonempty(teamId, "teamId");
    return await this.db.doTn(async tn => {
      const state = await this.readState(tn, teamId);
      if (state) await this.validateTopology(tn, state);
      return state;
    });
  }

  public async inspectGeneration(
    teamId: string,
    generation: number,
  ): Promise<{ generation: MigrationGeneration; residue: MigrationResidue }> {
    assertNonempty(teamId, "teamId");
    if (!isPositiveInteger(generation)) {
      throw new MigrationStoreError(
        "NUQ_MIGRATION_INVALID_ARGUMENT",
        "generation must be a positive safe integer",
      );
    }
    return await this.db.doTn(async tn => ({
      generation: await this.requireGeneration(tn, teamId, generation),
      residue: await this.readResidue(tn, teamId, generation),
    }));
  }

  public async inspectTeamPins(teamId: string): Promise<MigrationObjectPin[]> {
    assertNonempty(teamId, "teamId");
    return await this.db.doTn(async tn => {
      const range = getFdb().tuple.range([
        "nuq-migration",
        1,
        "team",
        teamId,
        "object",
      ]);
      const rows = await tn
        .snapshot()
        .getRangeAll(range.begin as Buffer, range.end as Buffer);
      return rows.map(([, value]) => {
        const pin = validatePin(
          parseJson(value as Buffer, `team ${teamId} object index`),
          `team ${teamId} object index`,
        );
        if (pin.teamId !== teamId) {
          throw new MigrationCorruptionError(
            `team ${teamId} object index`,
            "team id mismatch",
          );
        }
        return pin;
      });
    });
  }

  public async inspectPin(
    kind: MigrationObjectKind,
    objectId: string,
  ): Promise<MigrationObjectPin | null> {
    assertNonempty(objectId, "objectId");
    return await this.db.doTn(async tn =>
      this.inspectPinInTxn(tn, kind, objectId),
    );
  }

  public async inspectPinInTxn(
    tn: Transaction,
    kind: MigrationObjectKind,
    objectId: string,
  ): Promise<MigrationObjectPin | null> {
    const record = `object ${kind}/${objectId}`;
    const value = await tn.get(this.objectKey(kind, objectId));
    if (!value) return null;
    const pin = validatePin(parseJson(value, record), record);
    if (pin.kind !== kind || pin.objectId !== objectId) {
      throw new MigrationCorruptionError(record, "identity mismatch");
    }
    return pin;
  }

  public async validatePinnedObjectInTxn(
    tn: Transaction,
    input: {
      teamId: string;
      kind: MigrationObjectKind;
      objectId: string;
      backend?: MigrationBackend;
      generation?: number;
    },
  ): Promise<MigrationObjectPin> {
    const { teamId, kind, objectId } = input;
    const record = `object ${kind}/${objectId}`;
    const pin = await this.inspectPinInTxn(tn, kind, objectId);
    if (!pin) {
      throw new MigrationStoreError(
        "NUQ_MIGRATION_PIN_NOT_FOUND",
        `${kind}/${objectId} has no durable pin`,
      );
    }
    if (
      pin.teamId !== teamId ||
      (input.backend !== undefined && pin.backend !== input.backend) ||
      (input.generation !== undefined && pin.generation !== input.generation)
    ) {
      throw new MigrationCorruptionError(record, "pin expectation mismatch");
    }
    if (pin.lifecycle === "terminal") {
      throw new MigrationStaleGenerationError(
        teamId,
        pin.backend,
        pin.generation,
      );
    }
    const indexedRaw = await tn.get(this.teamObjectKey(teamId, kind, objectId));
    if (!indexedRaw) {
      throw new MigrationCorruptionError(record, "missing team pin index");
    }
    const indexed = validatePin(
      parseJson(indexedRaw, `${record} team index`),
      `${record} team index`,
    );
    if (JSON.stringify(indexed) !== JSON.stringify(pin)) {
      throw new MigrationCorruptionError(record, "team pin index mismatch");
    }
    const generation = await this.requireGeneration(tn, teamId, pin.generation);
    if (
      generation.backend !== pin.backend ||
      (generation.status !== "open" && generation.status !== "draining")
    ) {
      throw new MigrationStaleGenerationError(
        teamId,
        pin.backend,
        pin.generation,
      );
    }
    return pin;
  }

  public async resolveSteady(
    teamId: string,
    desiredBackend: MigrationBackend,
  ): Promise<MigrationSteadyResolution> {
    assertNonempty(teamId, "teamId");
    return await this.db.doTn(async tn => {
      const state = await this.readState(tn, teamId);
      if (!state) return { status: "legacy-uninitialized" } as const;
      await this.validateTopology(tn, state);
      if (state.phase === "ERROR") {
        throw new MigrationCorruptionError(
          `team ${teamId}`,
          "team is in ERROR phase",
        );
      }
      if (state.phase === "PG_ONLY" || state.phase === "FDB_ONLY") {
        return state.activeBackend === desiredBackend
          ? ({ status: "steady", state } as const)
          : ({ status: "transition-required", state } as const);
      }
      return state.targetBackend === desiredBackend
        ? ({ status: "transitioning", state } as const)
        : ({ status: "cancel-required", state } as const);
    });
  }

  // Legacy state is never guessed from Redis or today's flag. A caller must
  // explicitly name the authoritative backend once.
  public async initializeLegacyTeam(
    teamId: string,
    backend: MigrationBackend,
    operationId: string,
    options?: { ifAbsent?: boolean },
  ): Promise<MigrationTeamState> {
    assertNonempty(teamId, "teamId");
    assertNonempty(operationId, "operationId");
    return await this.db.doTn(async tn => {
      const opKey = this.controlOperationKey(teamId, operationId);
      const rawOp = await tn.get(opKey);
      if (rawOp) {
        const op = validateControlOperation(
          parseJson(rawOp, `control operation ${operationId}`),
          `control operation ${operationId}`,
        );
        if (op.operationId !== operationId || op.state.teamId !== teamId) {
          throw new MigrationCorruptionError(
            `control operation ${operationId}`,
            "identity mismatch",
          );
        }
        if (op.kind !== "initialize" || op.backend !== backend) {
          throw new MigrationOperationConflictError(operationId);
        }
        return op.state;
      }
      const existing = await this.readState(tn, teamId);
      if (existing) {
        await this.validateTopology(tn, existing);
        if (options?.ifAbsent) return existing;
        throw new MigrationStoreError(
          "NUQ_MIGRATION_ALREADY_INITIALIZED",
          `team ${teamId} is already initialized`,
        );
      }
      const state: MigrationTeamState = {
        schemaVersion: 1,
        teamId,
        revision: 1,
        maxGeneration: 1,
        activeBackend: backend,
        activeGeneration: 1,
        phase: stablePhase(backend),
      };
      const generation: MigrationGeneration = {
        schemaVersion: 1,
        teamId,
        backend,
        generation: 1,
        status: "open",
      };
      const op: ControlOperation = {
        schemaVersion: 1,
        kind: "initialize",
        operationId,
        backend,
        outcome: "completed",
        state,
      };
      tn.set(this.teamStateKey(teamId), encodeJson(state));
      tn.set(this.generationKey(teamId, 1), encodeJson(generation));
      tn.set(opKey, encodeJson(op));
      return state;
    });
  }

  public async beginTransition(input: {
    teamId: string;
    targetBackend: MigrationBackend;
    operationId: string;
    expectedRevision?: number;
  }): Promise<MigrationTeamState> {
    const { teamId, targetBackend, operationId, expectedRevision } = input;
    assertNonempty(teamId, "teamId");
    assertNonempty(operationId, "operationId");
    return await this.db.doTn(async tn => {
      const opKey = this.controlOperationKey(teamId, operationId);
      const rawOp = await tn.get(opKey);
      if (rawOp) {
        const op = validateControlOperation(
          parseJson(rawOp, `control operation ${operationId}`),
          `control operation ${operationId}`,
        );
        if (op.operationId !== operationId || op.state.teamId !== teamId) {
          throw new MigrationCorruptionError(
            `control operation ${operationId}`,
            "identity mismatch",
          );
        }
        if (op.kind !== "begin" || op.backend !== targetBackend) {
          throw new MigrationOperationConflictError(operationId);
        }
        return op.state;
      }
      const state = await this.readState(tn, teamId);
      if (!state) throw new MigrationLegacyStateError(teamId);
      if (
        expectedRevision !== undefined &&
        state.revision !== expectedRevision
      ) {
        throw new MigrationCasError(expectedRevision, state.revision);
      }
      if (state.phase !== "PG_ONLY" && state.phase !== "FDB_ONLY") {
        throw new MigrationInProgressError(teamId);
      }
      await this.validateTopology(tn, state);
      if (state.activeBackend === targetBackend) {
        const op: ControlOperation = {
          schemaVersion: 1,
          kind: "begin",
          operationId,
          backend: targetBackend,
          outcome: "completed",
          state,
        };
        tn.set(opKey, encodeJson(op));
        return state;
      }

      const source = await this.requireGeneration(
        tn,
        teamId,
        state.activeGeneration,
      );
      if (source.status !== "open" || source.backend !== state.activeBackend) {
        throw new MigrationCorruptionError(
          `team ${teamId} generation ${source.generation}`,
          "active generation is not open",
        );
      }
      const targetGeneration = state.maxGeneration + 1;
      if (!Number.isSafeInteger(targetGeneration)) {
        throw new MigrationCorruptionError(
          `team ${teamId}`,
          "generation exhausted safe integer range",
        );
      }
      if (await this.readGeneration(tn, teamId, targetGeneration)) {
        throw new MigrationCorruptionError(
          `team ${teamId} generation ${targetGeneration}`,
          "generation was previously allocated beyond maxGeneration",
        );
      }
      const drainingSource: MigrationGeneration = {
        ...source,
        status: "draining",
      };
      const target: MigrationGeneration = {
        schemaVersion: 1,
        teamId,
        backend: targetBackend,
        generation: targetGeneration,
        // A target remains closed until the source reaches exact zero. If the
        // transition is cancelled this generation stays closed forever.
        status: "closed",
      };
      const next: MigrationTeamState = {
        ...state,
        revision: nextRevision(state),
        maxGeneration: targetGeneration,
        phase: drainingPhase(targetBackend),
        targetBackend,
        targetGeneration,
        transitionOperationId: operationId,
      };
      const op: ControlOperation = {
        schemaVersion: 1,
        kind: "begin",
        operationId,
        backend: targetBackend,
        outcome: "pending",
        state: next,
      };
      tn.set(
        this.generationKey(teamId, source.generation),
        encodeJson(drainingSource),
      );
      tn.set(this.generationKey(teamId, targetGeneration), encodeJson(target));
      tn.set(this.teamStateKey(teamId), encodeJson(next));
      tn.set(opKey, encodeJson(op));
      return next;
    });
  }

  public async cancelTransition(input: {
    teamId: string;
    transitionOperationId: string;
    expectedRevision?: number;
  }): Promise<MigrationTeamState> {
    const { teamId, transitionOperationId, expectedRevision } = input;
    assertNonempty(teamId, "teamId");
    assertNonempty(transitionOperationId, "transitionOperationId");
    return await this.db.doTn(async tn => {
      const opKey = this.controlOperationKey(teamId, transitionOperationId);
      const rawOp = await tn.get(opKey);
      if (!rawOp) {
        throw new MigrationOperationConflictError(transitionOperationId);
      }
      const op = validateControlOperation(
        parseJson(rawOp, `control operation ${transitionOperationId}`),
        `control operation ${transitionOperationId}`,
      );
      if (
        op.operationId !== transitionOperationId ||
        op.state.teamId !== teamId
      ) {
        throw new MigrationCorruptionError(
          `control operation ${transitionOperationId}`,
          "identity mismatch",
        );
      }
      if (op.kind !== "begin") {
        throw new MigrationOperationConflictError(transitionOperationId);
      }
      if (op.outcome === "cancelled") return op.state;
      if (op.outcome === "completed") {
        throw new MigrationStoreError(
          "NUQ_MIGRATION_ALREADY_SEALED",
          `transition ${transitionOperationId} is already sealed`,
        );
      }
      const state = await this.readState(tn, teamId);
      if (!state) throw new MigrationLegacyStateError(teamId);
      if (
        expectedRevision !== undefined &&
        state.revision !== expectedRevision
      ) {
        throw new MigrationCasError(expectedRevision, state.revision);
      }
      if (state.transitionOperationId !== transitionOperationId) {
        throw new MigrationOperationConflictError(transitionOperationId);
      }
      const source = await this.requireGeneration(
        tn,
        teamId,
        state.activeGeneration,
      );
      const target = await this.requireGeneration(
        tn,
        teamId,
        state.targetGeneration!,
      );
      const targetResidue = await this.readResidue(
        tn,
        teamId,
        target.generation,
      );
      if (
        source.status !== "draining" ||
        source.backend !== state.activeBackend ||
        target.status !== "closed" ||
        target.backend !== state.targetBackend ||
        Object.values(targetResidue).some(value => value !== 0)
      ) {
        throw new MigrationCorruptionError(
          `team ${teamId}`,
          "transition generations cannot be cancelled",
        );
      }
      const reopened: MigrationGeneration = { ...source, status: "open" };
      const next: MigrationTeamState = {
        schemaVersion: 1,
        teamId,
        revision: nextRevision(state),
        maxGeneration: state.maxGeneration,
        activeBackend: state.activeBackend,
        activeGeneration: state.activeGeneration,
        phase: stablePhase(state.activeBackend),
      };
      const cancelledOp: ControlOperation = {
        ...op,
        outcome: "cancelled",
        state: next,
      };
      tn.set(
        this.generationKey(teamId, source.generation),
        encodeJson(reopened),
      );
      tn.set(this.teamStateKey(teamId), encodeJson(next));
      tn.set(opKey, encodeJson(cancelledOp));
      return next;
    });
  }

  public async preparePinnedObject(
    input: PreparePinnedObjectInput,
  ): Promise<MigrationObjectPin> {
    return (await this.preparePinnedObjects([input]))[0];
  }

  public async preparePinnedObjects(
    inputs: readonly PreparePinnedObjectInput[],
  ): Promise<MigrationObjectPin[]> {
    return await this.db.doTn(async tn => {
      const pins: MigrationObjectPin[] = [];
      for (const input of inputs) {
        pins.push(await this.preparePinnedObjectInTxn(tn, input));
      }
      return pins;
    });
  }

  // Transaction-scoped hook for queue/group/slot/sweeper code. The caller can
  // validate and account for a generation in the same FDB transaction as the
  // mutation that creates residue. An existing object ID is an idempotent
  // replay and may already be active/terminal, so the composing mutation must
  // also reconcile by its stable object ID rather than blindly recreate work.
  public async preparePinnedObjectInTxn(
    tn: Transaction,
    input: PreparePinnedObjectInput,
  ): Promise<MigrationObjectPin> {
    const { teamId, kind, objectId, admission, requiredBackend } = input;
    assertNonempty(teamId, "teamId");
    assertNonempty(objectId, "objectId");
    const initialResidue = normalizeResidue(input.residue);
    const key = this.objectKey(kind, objectId);
    const indexKey = this.teamObjectKey(teamId, kind, objectId);
    const rawPin = await tn.get(key);
    const rawIndex = await tn.get(indexKey);
    if (rawPin) {
      const record = `object ${kind}/${objectId}`;
      const pin = validatePin(parseJson(rawPin, record), record);
      const expectedAdmission = admission.type;
      if (
        pin.teamId !== teamId ||
        pin.kind !== kind ||
        pin.objectId !== objectId ||
        pin.admission !== expectedAdmission ||
        !residueEqual(pin.initialResidue, initialResidue) ||
        (requiredBackend !== undefined && pin.backend !== requiredBackend) ||
        (admission.type === "pinned-continuation" &&
          (pin.sourceKind !== admission.source.kind ||
            pin.sourceObjectId !== admission.source.objectId)) ||
        (admission.type === "legacy-backfill" &&
          (pin.backend !== admission.backend ||
            pin.generation !== admission.generation ||
            (pin.lifecycle === "terminal") !== (admission.terminal === true)))
      ) {
        throw new MigrationOperationConflictError(`${kind}/${objectId}`);
      }
      if (!rawIndex) {
        throw new MigrationCorruptionError(record, "missing team pin index");
      }
      const indexed = validatePin(
        parseJson(rawIndex, `${record} team index`),
        `${record} team index`,
      );
      if (JSON.stringify(indexed) !== JSON.stringify(pin)) {
        throw new MigrationCorruptionError(record, "team pin index mismatch");
      }
      return pin;
    }
    if (rawIndex) {
      throw new MigrationCorruptionError(
        `object ${kind}/${objectId}`,
        "orphaned team pin index",
      );
    }
    const state = await this.readState(tn, teamId);
    if (!state) throw new MigrationLegacyStateError(teamId);
    let backend: MigrationBackend;
    let generationNumber: number;
    if (admission.type === "new-root") {
      if (state.phase !== "PG_ONLY" && state.phase !== "FDB_ONLY") {
        throw new MigrationInProgressError(teamId);
      }
      backend = state.activeBackend;
      generationNumber = state.activeGeneration;
    } else if (admission.type === "legacy-backfill") {
      backend = admission.backend;
      generationNumber = admission.generation;
      if (
        admission.terminal !== true &&
        (state.activeBackend !== backend ||
          state.activeGeneration !== generationNumber)
      ) {
        throw new MigrationStaleGenerationError(
          teamId,
          backend,
          generationNumber,
        );
      }
    } else {
      assertNonempty(admission.source.objectId, "admission.source.objectId");
      const sourceRecord = `source object ${admission.source.kind}/${admission.source.objectId}`;
      const sourceRaw = await tn.get(
        this.objectKey(admission.source.kind, admission.source.objectId),
      );
      if (!sourceRaw) {
        throw new MigrationStoreError(
          "NUQ_MIGRATION_SOURCE_PIN_NOT_FOUND",
          `${admission.source.kind}/${admission.source.objectId} has no durable source pin`,
        );
      }
      const sourcePin = validatePin(
        parseJson(sourceRaw, sourceRecord),
        sourceRecord,
      );
      if (
        sourcePin.teamId !== teamId ||
        sourcePin.kind !== admission.source.kind ||
        sourcePin.objectId !== admission.source.objectId
      ) {
        throw new MigrationCorruptionError(sourceRecord, "identity mismatch");
      }
      if (sourcePin.lifecycle === "terminal") {
        throw new MigrationStaleGenerationError(
          teamId,
          sourcePin.backend,
          sourcePin.generation,
        );
      }
      const sourceIndexRaw = await tn.get(
        this.teamObjectKey(
          teamId,
          admission.source.kind,
          admission.source.objectId,
        ),
      );
      if (!sourceIndexRaw) {
        throw new MigrationCorruptionError(
          sourceRecord,
          "missing team pin index",
        );
      }
      const sourceIndexed = validatePin(
        parseJson(sourceIndexRaw, `${sourceRecord} team index`),
        `${sourceRecord} team index`,
      );
      if (JSON.stringify(sourceIndexed) !== JSON.stringify(sourcePin)) {
        throw new MigrationCorruptionError(
          sourceRecord,
          "team pin index mismatch",
        );
      }
      backend = sourcePin.backend;
      generationNumber = sourcePin.generation;
    }
    if (requiredBackend !== undefined && backend !== requiredBackend) {
      throw new MigrationStaleGenerationError(
        teamId,
        requiredBackend,
        generationNumber,
      );
    }
    const generation = await this.requireGeneration(
      tn,
      teamId,
      generationNumber,
    );
    const terminalLegacyBackfill =
      admission.type === "legacy-backfill" && admission.terminal === true;
    if (
      terminalLegacyBackfill &&
      Object.values(initialResidue).some(value => value !== 0)
    ) {
      throw new MigrationStoreError(
        "NUQ_MIGRATION_INVALID_ARGUMENT",
        "terminal legacy backfill cannot carry residue",
      );
    }
    const allowed =
      generation.backend === backend &&
      (terminalLegacyBackfill ||
        (admission.type === "new-root"
          ? generation.status === "open"
          : generation.status === "open" || generation.status === "draining"));
    if (!allowed) {
      throw new MigrationStaleGenerationError(
        teamId,
        backend,
        generationNumber,
      );
    }
    const pin: MigrationObjectPin = {
      schemaVersion: 1,
      teamId,
      kind,
      objectId,
      backend,
      generation: generationNumber,
      lifecycle: terminalLegacyBackfill ? "terminal" : "prepared",
      revision: 1,
      admission: admission.type,
      sourceKind:
        admission.type === "pinned-continuation"
          ? admission.source.kind
          : undefined,
      sourceObjectId:
        admission.type === "pinned-continuation"
          ? admission.source.objectId
          : undefined,
      initialResidue,
      residue: initialResidue,
    };
    await this.applyResidueDelta(
      tn,
      teamId,
      generationNumber,
      normalizeResidue(undefined),
      initialResidue,
    );
    const encoded = encodeJson(pin);
    tn.set(key, encoded);
    tn.set(indexKey, encoded);
    return pin;
  }

  public async transitionObjectResidue(
    input: TransitionObjectResidueInput,
  ): Promise<MigrationObjectPin> {
    return await this.db.doTn(async tn =>
      this.transitionObjectResidueInTxn(tn, input),
    );
  }

  public async transitionObjectResidueInTxn(
    tn: Transaction,
    input: TransitionObjectResidueInput,
  ): Promise<MigrationObjectPin> {
    const { teamId, kind, objectId, operationId, fromLifecycle, toLifecycle } =
      input;
    assertNonempty(teamId, "teamId");
    assertNonempty(objectId, "objectId");
    assertNonempty(operationId, "operationId");
    const residue = normalizeResidue(input.residue);
    const operationKey = this.objectOperationKey(
      teamId,
      kind,
      objectId,
      operationId,
    );
    const rawOperation = await tn.get(operationKey);
    if (rawOperation) {
      const op = validateObjectOperation(
        parseJson(rawOperation, `object operation ${operationId}`),
        `object operation ${operationId}`,
      );
      if (
        op.operationId !== operationId ||
        op.teamId !== teamId ||
        op.kind !== kind ||
        op.objectId !== objectId ||
        op.fromLifecycle !== fromLifecycle ||
        op.toLifecycle !== toLifecycle ||
        !residueEqual(op.residue, residue)
      ) {
        throw new MigrationOperationConflictError(operationId);
      }
      return op.result;
    }
    const key = this.objectKey(kind, objectId);
    const record = `object ${kind}/${objectId}`;
    const rawPin = await tn.get(key);
    if (!rawPin) {
      throw new MigrationStoreError(
        "NUQ_MIGRATION_PIN_NOT_FOUND",
        `${kind}/${objectId} has no durable pin`,
      );
    }
    const pin = validatePin(parseJson(rawPin, record), record);
    if (
      pin.teamId !== teamId ||
      pin.kind !== kind ||
      pin.objectId !== objectId
    ) {
      throw new MigrationCorruptionError(record, "identity mismatch");
    }
    if (pin.lifecycle !== fromLifecycle) {
      throw new MigrationStoreError(
        "NUQ_MIGRATION_LIFECYCLE_MISMATCH",
        `${kind}/${objectId} expected ${fromLifecycle}, found ${pin.lifecycle}`,
      );
    }
    if (pin.lifecycle === "terminal" && toLifecycle !== "terminal") {
      throw new MigrationStoreError(
        "NUQ_MIGRATION_LIFECYCLE_MISMATCH",
        `${kind}/${objectId} tombstone cannot be reopened`,
      );
    }
    const generation = await this.requireGeneration(tn, teamId, pin.generation);
    if (generation.backend !== pin.backend) {
      throw new MigrationCorruptionError(
        record,
        "pin backend does not match generation",
      );
    }
    if (generation.status === "closed") {
      throw new MigrationStaleGenerationError(
        teamId,
        pin.backend,
        pin.generation,
      );
    }
    const rawIndex = await tn.get(this.teamObjectKey(teamId, kind, objectId));
    if (!rawIndex) {
      throw new MigrationCorruptionError(record, "missing team pin index");
    }
    const indexed = validatePin(
      parseJson(rawIndex, `${record} team index`),
      `${record} team index`,
    );
    if (JSON.stringify(indexed) !== JSON.stringify(pin)) {
      throw new MigrationCorruptionError(record, "team pin index mismatch");
    }
    await this.applyResidueDelta(
      tn,
      teamId,
      pin.generation,
      pin.residue,
      residue,
    );
    const revision = pin.revision + 1;
    if (!Number.isSafeInteger(revision)) {
      throw new MigrationCorruptionError(record, "pin revision exhausted");
    }
    const next: MigrationObjectPin = {
      ...pin,
      lifecycle: toLifecycle,
      revision,
      residue,
    };
    const encoded = encodeJson(next);
    tn.set(key, encoded);
    tn.set(this.teamObjectKey(teamId, kind, objectId), encoded);
    const op: ObjectOperation = {
      schemaVersion: 1,
      operationId,
      teamId,
      kind,
      objectId,
      fromLifecycle,
      toLifecycle,
      residue,
      result: next,
    };
    tn.set(operationKey, encodeJson(op));
    return next;
  }

  public async completePinnedObject(
    input: CompletePinnedObjectInput,
  ): Promise<MigrationObjectPin> {
    return await this.transitionObjectResidue({
      ...input,
      toLifecycle: "terminal",
      residue: {},
    });
  }

  public async completePinnedObjectInTxn(
    tn: Transaction,
    input: CompletePinnedObjectInput,
  ): Promise<MigrationObjectPin> {
    return await this.transitionObjectResidueInTxn(tn, {
      ...input,
      toLifecycle: "terminal",
      residue: {},
    });
  }

  public async finalSeal(input: {
    teamId: string;
    transitionOperationId: string;
    expectedRevision?: number;
  }): Promise<MigrationTeamState> {
    const { teamId, transitionOperationId, expectedRevision } = input;
    assertNonempty(teamId, "teamId");
    assertNonempty(transitionOperationId, "transitionOperationId");
    return await this.db.doTn(async tn => {
      const opKey = this.controlOperationKey(teamId, transitionOperationId);
      const rawOp = await tn.get(opKey);
      if (!rawOp) {
        throw new MigrationOperationConflictError(transitionOperationId);
      }
      const op = validateControlOperation(
        parseJson(rawOp, `control operation ${transitionOperationId}`),
        `control operation ${transitionOperationId}`,
      );
      if (
        op.operationId !== transitionOperationId ||
        op.state.teamId !== teamId
      ) {
        throw new MigrationCorruptionError(
          `control operation ${transitionOperationId}`,
          "identity mismatch",
        );
      }
      if (op.kind !== "begin") {
        throw new MigrationOperationConflictError(transitionOperationId);
      }
      if (op.outcome === "completed") return op.state;
      if (op.outcome === "cancelled") {
        throw new MigrationStoreError(
          "NUQ_MIGRATION_TRANSITION_CANCELLED",
          `transition ${transitionOperationId} was cancelled`,
        );
      }
      const state = await this.readState(tn, teamId);
      if (!state) throw new MigrationLegacyStateError(teamId);
      if (
        expectedRevision !== undefined &&
        state.revision !== expectedRevision
      ) {
        throw new MigrationCasError(expectedRevision, state.revision);
      }
      if (state.transitionOperationId !== transitionOperationId) {
        throw new MigrationOperationConflictError(transitionOperationId);
      }
      const source = await this.requireGeneration(
        tn,
        teamId,
        state.activeGeneration,
      );
      const target = await this.requireGeneration(
        tn,
        teamId,
        state.targetGeneration!,
      );
      if (
        source.status !== "draining" ||
        source.backend !== state.activeBackend ||
        target.status !== "closed" ||
        target.backend !== state.targetBackend
      ) {
        throw new MigrationCorruptionError(
          `team ${teamId}`,
          "transition generation state mismatch",
        );
      }
      const sourceResidue = await this.readResidue(
        tn,
        teamId,
        source.generation,
      );
      if (Object.values(sourceResidue).some(value => value !== 0)) {
        throw new MigrationResidueNotEmptyError(
          teamId,
          source.generation,
          sourceResidue,
        );
      }
      const targetResidue = await this.readResidue(
        tn,
        teamId,
        target.generation,
      );
      if (Object.values(targetResidue).some(value => value !== 0)) {
        throw new MigrationCorruptionError(
          `team ${teamId} generation ${target.generation}`,
          "closed target has residue",
        );
      }
      const closedSource: MigrationGeneration = {
        ...source,
        status: "closed",
      };
      const openTarget: MigrationGeneration = { ...target, status: "open" };
      const next: MigrationTeamState = {
        schemaVersion: 1,
        teamId,
        revision: nextRevision(state),
        maxGeneration: state.maxGeneration,
        activeBackend: target.backend,
        activeGeneration: target.generation,
        phase: stablePhase(target.backend),
      };
      const completedOp: ControlOperation = {
        ...op,
        outcome: "completed",
        state: next,
      };
      tn.set(
        this.generationKey(teamId, source.generation),
        encodeJson(closedSource),
      );
      tn.set(
        this.generationKey(teamId, target.generation),
        encodeJson(openTarget),
      );
      tn.set(this.teamStateKey(teamId), encodeJson(next));
      tn.set(opKey, encodeJson(completedOp));
      return next;
    });
  }
}

export const nuqFdbMigrationStore = new NuqFdbMigrationStore();
