import { describe, expect, it } from "vitest";
import { handleQueue, type Env } from "../src/index";

interface RunRow {
  id: string;
  goal: string | null;
  status: string;
  current_station: string | null;
  started_at: string | null;
  finished_at: string | null;
  failure_reason: string | null;
}

interface StationExecutionRow {
  id: string;
  run_id: string;
  station: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  summary: string | null;
}

interface ArtifactRow {
  id: string;
  run_id: string;
  type: string;
  storage: string;
  payload: string | null;
  created_at: string;
}

class MockD1PreparedStatement {
  public constructor(
    private readonly db: MockD1Database,
    private readonly sql: string,
    private readonly params: unknown[] = []
  ) {}

  public bind(...params: unknown[]): MockD1PreparedStatement {
    return new MockD1PreparedStatement(this.db, this.sql, params);
  }

  public async run(): Promise<D1Result<never>> {
    const changes = this.db.run(this.sql, this.params);
    return {
      success: true,
      meta: {
        changes,
        duration: 0,
        last_row_id: 0,
        rows_read: 0,
        rows_written: changes,
        size_after: 0,
        changed_db: false
      } as D1Result<never>["meta"]
    } as D1Result<never>;
  }

  public async first<T = unknown>(): Promise<T | null> {
    return this.db.first(this.sql, this.params) as T | null;
  }
}

class MockD1Database {
  private readonly runs: RunRow[] = [];
  private readonly stationExecutions: StationExecutionRow[] = [];
  private readonly artifacts: ArtifactRow[] = [];
  private failNextArtifactInsert = false;
  private failedRunStatusUpdatesToFail = 0;

  public prepare(sql: string): D1PreparedStatement {
    return new MockD1PreparedStatement(this, normalizeSql(sql)) as unknown as D1PreparedStatement;
  }

  public seedRun(run: RunRow): void {
    this.runs.push(run);
  }

  public getRun(runId: string): RunRow | undefined {
    return this.runs.find((run) => run.id === runId);
  }

  public listStations(runId: string): StationExecutionRow[] {
    return this.stationExecutions.filter((row) => row.run_id === runId);
  }

  public listArtifacts(runId: string): ArtifactRow[] {
    return this.artifacts.filter((row) => row.run_id === runId);
  }

  public failOnNextArtifactInsert(): void {
    this.failNextArtifactInsert = true;
  }

  public failOnNextFailedRunStatusUpdate(count = 1): void {
    this.failedRunStatusUpdatesToFail += Math.max(1, count);
  }

  public first(sql: string, params: unknown[]): unknown {
    if (
      sql.includes("select id, goal, status, current_station, started_at from runs") &&
      sql.includes("where id = ?")
    ) {
      const runId = asString(params[0]);
      const run = this.runs.find((candidate) => candidate.id === runId);
      if (!run) {
        return null;
      }

      return {
        id: run.id,
        goal: run.goal,
        status: run.status,
        current_station: run.current_station,
        started_at: run.started_at
      };
    }

    throw new Error(`Unsupported first SQL: ${sql}`);
  }

  public run(sql: string, params: unknown[]): number {
    if (
      sql.startsWith("update runs") &&
      sql.includes("set status = ?") &&
      sql.includes("coalesce(started_at")
    ) {
      const runId = asString(params[4]);
      const expectedStatus = asString(params[5]);
      const run = this.runs.find((candidate) => candidate.id === runId);
      if (!run || run.status !== expectedStatus) {
        return 0;
      }

      run.status = asString(params[0]);
      run.started_at = run.started_at ?? asString(params[1]);
      run.current_station = asNullableString(params[2]);
      run.failure_reason = asNullableString(params[3]);
      return 1;
    }

    if (
      sql.startsWith("update runs") &&
      sql.includes("set current_station = ?") &&
      sql.includes("where id = ?")
    ) {
      const runId = asString(params[1]);
      const run = this.runs.find((candidate) => candidate.id === runId);
      if (!run) {
        return 0;
      }

      run.current_station = asNullableString(params[0]);
      return 1;
    }

    if (
      sql.startsWith("insert into station_executions") &&
      sql.includes("on conflict(id) do update set")
    ) {
      const id = asString(params[0]);
      const existing = this.stationExecutions.find((row) => row.id === id);
      if (!existing) {
        this.stationExecutions.push({
          id,
          run_id: asString(params[1]),
          station: asString(params[2]),
          status: asString(params[3]),
          started_at: asNullableString(params[4]),
          finished_at: asNullableString(params[5]),
          duration_ms: asNullableNumber(params[6]),
          summary: asNullableString(params[7])
        });
        return 1;
      }

      existing.status = asString(params[3]);
      existing.started_at = asNullableString(params[4]);
      existing.finished_at = asNullableString(params[5]);
      existing.duration_ms = asNullableNumber(params[6]);
      existing.summary = asNullableString(params[7]);
      return 1;
    }

    if (sql.startsWith("update station_executions") && sql.includes("set status = ?")) {
      const id = asString(params[4]);
      const row = this.stationExecutions.find((station) => station.id === id);
      if (!row) {
        return 0;
      }

      row.status = asString(params[0]);
      row.finished_at = asNullableString(params[1]);
      row.duration_ms = asNullableNumber(params[2]);
      row.summary = asNullableString(params[3]);
      return 1;
    }

    if (
      sql.startsWith("update runs") &&
      sql.includes("set status = ?") &&
      sql.includes("finished_at = ?") &&
      sql.includes("failure_reason = ?") &&
      sql.includes("where id = ? and status = ?")
    ) {
      const runId = asString(params[4]);
      const expectedStatus = asString(params[5]);
      const run = this.runs.find((candidate) => candidate.id === runId);
      if (!run || run.status !== expectedStatus) {
        return 0;
      }

      const nextStatus = asString(params[0]);
      if (nextStatus === "failed" && this.failedRunStatusUpdatesToFail > 0) {
        this.failedRunStatusUpdatesToFail -= 1;
        throw new Error("Simulated failed run status update error");
      }

      run.status = asString(params[0]);
      run.finished_at = asNullableString(params[1]);
      run.current_station = asNullableString(params[2]);
      run.failure_reason = asNullableString(params[3]);
      return 1;
    }

    if (sql.startsWith("insert into artifacts")) {
      if (this.failNextArtifactInsert) {
        this.failNextArtifactInsert = false;
        throw new Error("Simulated artifact insert error");
      }

      const artifactId = asString(params[0]);
      const existing = this.artifacts.find((artifact) => artifact.id === artifactId);
      if (existing) {
        return 0;
      }

      this.artifacts.push({
        id: artifactId,
        run_id: asString(params[1]),
        type: asString(params[2]),
        storage: asString(params[3]),
        payload: asNullableString(params[4]),
        created_at: asString(params[5])
      });
      return 1;
    }

    throw new Error(`Unsupported run SQL: ${sql}`);
  }
}

interface MockQueueMessage {
  id: string;
  body: unknown;
  acked: boolean;
  retries: number;
  ack: () => void;
  retry: () => void;
}

function createMessage(id: string, body: unknown): MockQueueMessage {
  return {
    id,
    body,
    acked: false,
    retries: 0,
    ack() {
      this.acked = true;
    },
    retry() {
      this.retries += 1;
    }
  };
}

function createEnv(): { env: Env; db: MockD1Database } {
  const db = new MockD1Database();
  return {
    env: {
      DB: db as unknown as D1Database
    },
    db
  };
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

function asString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error(`Expected string but got ${typeof value}`);
  }

  return value;
}

function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  return asString(value);
}

function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "number") {
    throw new Error(`Expected number but got ${typeof value}`);
  }

  return value;
}

describe("queue-consumer worker", () => {
  it("acks invalid queue messages", async () => {
    const { env, db } = createEnv();
    db.seedRun({
      id: "run_invalid",
      goal: null,
      status: "queued",
      current_station: null,
      started_at: null,
      finished_at: null,
      failure_reason: null
    });

    const invalidMessage = createMessage("msg_invalid", { nope: true });

    await handleQueue(
      {
        messages: [invalidMessage as unknown as Message<unknown>]
      } as MessageBatch<unknown>,
      env
    );

    expect(invalidMessage.acked).toBe(true);
    expect(db.getRun("run_invalid")?.status).toBe("queued");
  });

  it("claims queued runs and completes all workflow stations", async () => {
    const { env, db } = createEnv();
    db.seedRun({
      id: "run_success",
      goal: null,
      status: "queued",
      current_station: null,
      started_at: null,
      finished_at: null,
      failure_reason: null
    });

    const message = createMessage("msg_success", {
      runId: "run_success",
      repoId: "repo_1",
      issueNumber: 123,
      requestedAt: new Date().toISOString(),
      requestor: "jess",
      prMode: "draft"
    });

    await handleQueue(
      {
        messages: [message as unknown as Message<unknown>]
      } as MessageBatch<unknown>,
      env
    );

    const run = db.getRun("run_success");
    expect(message.acked).toBe(true);
    expect(run?.status).toBe("succeeded");
    expect(run?.started_at).toBeTruthy();
    expect(run?.finished_at).toBeTruthy();
    expect(run?.current_station).toBeNull();
    expect(run?.failure_reason).toBeNull();

    const stations = db.listStations("run_success");
    expect(stations).toHaveLength(5);
    expect(stations.every((station) => station.status === "succeeded")).toBe(true);

    const artifacts = db.listArtifacts("run_success");
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.type).toBe("workflow_summary");
  });

  it("retries stale running runs without replaying workflow side effects", async () => {
    const { env, db } = createEnv();
    db.seedRun({
      id: "run_duplicate",
      goal: null,
      status: "running",
      current_station: "plan",
      started_at: new Date(Date.now() - 31_000).toISOString(),
      finished_at: null,
      failure_reason: null
    });

    const message = createMessage("msg_duplicate", {
      runId: "run_duplicate",
      repoId: "repo_1",
      issueNumber: 124,
      requestedAt: new Date().toISOString(),
      requestor: "jess",
      prMode: "draft"
    });

    await handleQueue(
      {
        messages: [message as unknown as Message<unknown>]
      } as MessageBatch<unknown>,
      env
    );

    expect(message.acked).toBe(false);
    expect(message.retries).toBe(1);
    expect(db.getRun("run_duplicate")?.status).toBe("running");
    expect(db.listStations("run_duplicate")).toHaveLength(0);
    expect(db.listArtifacts("run_duplicate")).toHaveLength(0);
  });

  it("retries recent running runs to avoid duplicate concurrent execution", async () => {
    const { env, db } = createEnv();
    db.seedRun({
      id: "run_running_recent",
      goal: null,
      status: "running",
      current_station: "plan",
      started_at: new Date().toISOString(),
      finished_at: null,
      failure_reason: null
    });

    const message = createMessage("msg_running_recent", {
      runId: "run_running_recent",
      repoId: "repo_1",
      issueNumber: 999,
      requestedAt: new Date().toISOString(),
      requestor: "jess",
      prMode: "draft"
    });

    await handleQueue(
      {
        messages: [message as unknown as Message<unknown>]
      } as MessageBatch<unknown>,
      env
    );

    expect(message.acked).toBe(false);
    expect(message.retries).toBe(1);
    expect(db.getRun("run_running_recent")?.status).toBe("running");
    expect(db.listStations("run_running_recent")).toHaveLength(0);
    expect(db.listArtifacts("run_running_recent")).toHaveLength(0);
  });

  it("marks runs failed when a station is forced to fail", async () => {
    const { env, db } = createEnv();
    db.seedRun({
      id: "run_failure",
      goal: "force_fail:verify",
      status: "queued",
      current_station: null,
      started_at: null,
      finished_at: null,
      failure_reason: null
    });

    const message = createMessage("msg_failure", {
      runId: "run_failure",
      repoId: "repo_1",
      issueNumber: 125,
      requestedAt: new Date().toISOString(),
      requestor: "jess",
      prMode: "draft"
    });

    await handleQueue(
      {
        messages: [message as unknown as Message<unknown>]
      } as MessageBatch<unknown>,
      env
    );

    const run = db.getRun("run_failure");
    expect(message.acked).toBe(true);
    expect(run?.status).toBe("failed");
    expect(run?.current_station).toBe("verify");
    expect(run?.failure_reason).toContain("forced failure marker");

    const stations = db.listStations("run_failure");
    const verifyStation = stations.find((station) => station.station === "verify");
    expect(verifyStation?.status).toBe("failed");

    const createPrStation = stations.find((station) => station.station === "create_pr");
    expect(createPrStation).toBeUndefined();
  });

  it("keeps run succeeded when completion artifact creation fails", async () => {
    const { env, db } = createEnv();
    db.seedRun({
      id: "run_artifact_failure",
      goal: null,
      status: "queued",
      current_station: null,
      started_at: null,
      finished_at: null,
      failure_reason: null
    });
    db.failOnNextArtifactInsert();

    const message = createMessage("msg_artifact_failure", {
      runId: "run_artifact_failure",
      repoId: "repo_1",
      issueNumber: 126,
      requestedAt: new Date().toISOString(),
      requestor: "jess",
      prMode: "draft"
    });

    await handleQueue(
      {
        messages: [message as unknown as Message<unknown>]
      } as MessageBatch<unknown>,
      env
    );

    const run = db.getRun("run_artifact_failure");
    expect(message.acked).toBe(true);
    expect(message.retries).toBe(0);
    expect(run?.status).toBe("succeeded");
    expect(run?.current_station).toBeNull();
    expect(run?.failure_reason).toBeNull();
    expect(db.listArtifacts("run_artifact_failure")).toHaveLength(0);
  });

  it("retries queue delivery when failed status cannot be persisted", async () => {
    const { env, db } = createEnv();
    db.seedRun({
      id: "run_failed_persist_retry",
      goal: "force_fail:verify",
      status: "queued",
      current_station: null,
      started_at: null,
      finished_at: null,
      failure_reason: null
    });
    db.failOnNextFailedRunStatusUpdate(2);

    const message = createMessage("msg_failed_persist_retry", {
      runId: "run_failed_persist_retry",
      repoId: "repo_1",
      issueNumber: 127,
      requestedAt: new Date().toISOString(),
      requestor: "jess",
      prMode: "draft"
    });

    await handleQueue(
      {
        messages: [message as unknown as Message<unknown>]
      } as MessageBatch<unknown>,
      env
    );

    expect(message.acked).toBe(false);
    expect(message.retries).toBe(1);
    expect(db.getRun("run_failed_persist_retry")?.status).toBe("running");
  });
});
