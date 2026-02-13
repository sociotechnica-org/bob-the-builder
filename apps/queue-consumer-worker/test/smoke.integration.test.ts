import { describe, expect, it } from "vitest";
import { handleFetch, handleQueue, type Env } from "../src/index";

interface RunRow {
  id: string;
  goal: string | null;
  status: string;
  current_station: string | null;
  started_at: string | null;
  heartbeat_at: string | null;
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

  public prepare(sql: string): D1PreparedStatement {
    return new MockD1PreparedStatement(this, normalizeSql(sql)) as unknown as D1PreparedStatement;
  }

  public seedRun(run: Omit<RunRow, "heartbeat_at"> & { heartbeat_at?: string | null }): void {
    this.runs.push({
      ...run,
      heartbeat_at: run.heartbeat_at ?? null
    });
  }

  public getRun(runId: string): RunRow | undefined {
    return this.runs.find((run) => run.id === runId);
  }

  public stationCount(runId: string): number {
    return this.stationExecutions.filter((station) => station.run_id === runId).length;
  }

  public artifactCount(runId: string): number {
    return this.artifacts.filter((artifact) => artifact.run_id === runId).length;
  }

  public first(sql: string, params: unknown[]): unknown {
    if (
      sql.includes("select id, status, current_station, started_at, heartbeat_at from runs") &&
      sql.includes("where id = ?")
    ) {
      const runId = asString(params[0]);
      const run = this.runs.find((candidate) => candidate.id === runId);
      if (!run) {
        return null;
      }

      return {
        id: run.id,
        status: run.status,
        current_station: run.current_station,
        started_at: run.started_at,
        heartbeat_at: run.heartbeat_at
      };
    }

    if (sql.includes("select status from station_executions") && sql.includes("where id = ?")) {
      const stationExecutionId = asString(params[0]);
      const row = this.stationExecutions.find((candidate) => candidate.id === stationExecutionId);
      return row ? { status: row.status } : null;
    }

    throw new Error(`Unsupported first SQL: ${sql}`);
  }

  public run(sql: string, params: unknown[]): number {
    if (sql.startsWith("update runs") && sql.includes("coalesce(started_at")) {
      const runId = asString(params[5]);
      const run = this.runs.find((candidate) => candidate.id === runId);
      if (!run || run.status !== "queued") {
        return 0;
      }

      run.status = "running";
      run.started_at = run.started_at ?? asString(params[1]);
      run.current_station = asNullableString(params[2]);
      run.heartbeat_at = asNullableString(params[3]);
      run.failure_reason = asNullableString(params[4]);
      return 1;
    }

    if (
      sql.startsWith("update runs") &&
      sql.includes("set current_station = ?") &&
      sql.includes("heartbeat_at = ?") &&
      sql.includes("where id = ? and status = ?")
    ) {
      const runId = asString(params[2]);
      const run = this.runs.find((candidate) => candidate.id === runId);
      if (!run || run.status !== "running") {
        return 0;
      }

      run.current_station = asNullableString(params[0]);
      run.heartbeat_at = asNullableString(params[1]);
      return 1;
    }

    if (sql.startsWith("insert into station_executions")) {
      const id = asString(params[0]);
      const existing = this.stationExecutions.find((row) => row.id === id);
      if (existing) {
        existing.status = asString(params[3]);
        existing.started_at = asNullableString(params[4]);
        existing.finished_at = asNullableString(params[5]);
        existing.duration_ms = asNullableNumber(params[6]);
        existing.summary = asNullableString(params[7]);
        return 1;
      }

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

    if (sql.startsWith("update station_executions") && sql.includes("duration_ms = ?")) {
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
      sql.startsWith("update station_executions") &&
      sql.includes("where id = ? and status = ?")
    ) {
      const id = asString(params[3]);
      const expectedStatus = asString(params[4]);
      const row = this.stationExecutions.find((station) => station.id === id);
      if (!row || row.status !== expectedStatus) {
        return 0;
      }

      row.status = asString(params[0]);
      row.finished_at = asNullableString(params[1]);
      row.summary = asNullableString(params[2]);
      return 1;
    }

    if (
      sql.startsWith("update runs") &&
      sql.includes("set status = ?") &&
      sql.includes("finished_at = ?") &&
      sql.includes("heartbeat_at = ?") &&
      sql.includes("where id = ? and status = ?")
    ) {
      const runId = asString(params[5]);
      const expectedStatus = asString(params[6]);
      const run = this.runs.find((candidate) => candidate.id === runId);
      if (!run || run.status !== expectedStatus) {
        return 0;
      }

      run.status = asString(params[0]);
      run.finished_at = asNullableString(params[1]);
      run.current_station = asNullableString(params[2]);
      run.failure_reason = asNullableString(params[3]);
      run.heartbeat_at = asNullableString(params[4]);
      return 1;
    }

    if (
      sql.startsWith("update runs") &&
      sql.includes("set heartbeat_at = ?") &&
      sql.includes("where id = ? and status = ? and heartbeat_at = ?")
    ) {
      const runId = asString(params[1]);
      const run = this.runs.find((candidate) => candidate.id === runId);
      if (!run || run.status !== "running" || run.heartbeat_at !== asString(params[3])) {
        return 0;
      }

      run.heartbeat_at = asString(params[0]);
      return 1;
    }

    if (
      sql.startsWith("update runs") &&
      sql.includes("set heartbeat_at = ?") &&
      sql.includes("where id = ? and status = ? and heartbeat_at is null and started_at = ?")
    ) {
      const runId = asString(params[1]);
      const run = this.runs.find((candidate) => candidate.id === runId);
      if (
        !run ||
        run.status !== "running" ||
        run.heartbeat_at !== null ||
        run.started_at !== asString(params[3])
      ) {
        return 0;
      }

      run.heartbeat_at = asString(params[0]);
      return 1;
    }

    if (
      sql.startsWith("update runs") &&
      sql.includes("set heartbeat_at = ?") &&
      sql.includes("where id = ? and status = ? and heartbeat_at is null and started_at is null")
    ) {
      const runId = asString(params[1]);
      const run = this.runs.find((candidate) => candidate.id === runId);
      if (
        !run ||
        run.status !== "running" ||
        run.heartbeat_at !== null ||
        run.started_at !== null
      ) {
        return 0;
      }

      run.heartbeat_at = asString(params[0]);
      return 1;
    }

    if (sql.startsWith("insert into artifacts")) {
      this.artifacts.push({
        id: asString(params[0]),
        run_id: asString(params[1])
      });
      return 1;
    }

    throw new Error(`Unsupported SQL: ${sql}`);
  }
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

function createEnv(localQueueSecret?: string): { env: Env; db: MockD1Database } {
  const db = new MockD1Database();
  return {
    env: {
      DB: db as unknown as D1Database,
      LOCAL_QUEUE_SHARED_SECRET: localQueueSecret
    },
    db
  };
}

describe("queue-consumer smoke", () => {
  it("serves /healthz", async () => {
    const response = await handleFetch(new Request("https://example.com/healthz"), {
      DB: {} as D1Database
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "queue-consumer-worker"
    });
  });

  it("rejects /__queue/consume when shared secret is not configured", async () => {
    const { env } = createEnv();
    const response = await handleFetch(
      new Request("https://example.com/__queue/consume", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          runId: "run_missing",
          repoId: "repo_1",
          issueNumber: 1,
          requestedAt: new Date().toISOString(),
          requestor: "smoke",
          prMode: "draft"
        })
      }),
      env
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Local queue consume endpoint is disabled"
    });
  });

  it("requires matching shared secret for /__queue/consume", async () => {
    const { env } = createEnv("local-secret");
    const requestBody = JSON.stringify({
      runId: "run_missing",
      repoId: "repo_1",
      issueNumber: 1,
      requestedAt: new Date().toISOString(),
      requestor: "smoke",
      prMode: "draft"
    });

    const unauthorized = await handleFetch(
      new Request("https://example.com/__queue/consume", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: requestBody
      }),
      env
    );

    expect(unauthorized.status).toBe(401);
    await expect(unauthorized.json()).resolves.toEqual({
      error: "Unauthorized local queue dispatch"
    });
  });

  it("accepts authenticated /__queue/consume dispatches", async () => {
    const { env, db } = createEnv("local-secret");
    db.seedRun({
      id: "run_via_local_consume",
      goal: null,
      status: "queued",
      current_station: null,
      started_at: null,
      finished_at: null,
      failure_reason: null
    });

    const response = await handleFetch(
      new Request("https://example.com/__queue/consume", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bob-local-queue-secret": "local-secret"
        },
        body: JSON.stringify({
          runId: "run_via_local_consume",
          repoId: "repo_1",
          issueNumber: 1,
          requestedAt: new Date().toISOString(),
          requestor: "smoke",
          prMode: "draft"
        })
      }),
      env
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      outcome: "ack"
    });
    expect(db.getRun("run_via_local_consume")?.status).toBe("succeeded");
    expect(db.stationCount("run_via_local_consume")).toBe(5);
    expect(db.artifactCount("run_via_local_consume")).toBe(1);
  });

  it("processes a queued run to terminal status", async () => {
    const { env, db } = createEnv();
    db.seedRun({
      id: "run_smoke",
      goal: null,
      status: "queued",
      current_station: null,
      started_at: null,
      finished_at: null,
      failure_reason: null
    });

    let acked = false;
    await handleQueue(
      {
        messages: [
          {
            id: "msg_smoke",
            body: {
              runId: "run_smoke",
              repoId: "repo_1",
              issueNumber: 5,
              requestedAt: new Date().toISOString(),
              requestor: "smoke",
              prMode: "draft"
            },
            ack() {
              acked = true;
            },
            retry() {
              throw new Error("retry should not be called in smoke path");
            }
          } as unknown as Message<unknown>
        ]
      } as MessageBatch<unknown>,
      env
    );

    const run = db.getRun("run_smoke");
    expect(acked).toBe(true);
    expect(run?.status).toBe("succeeded");
    expect(db.stationCount("run_smoke")).toBe(5);
    expect(db.artifactCount("run_smoke")).toBe(1);
  });
});
