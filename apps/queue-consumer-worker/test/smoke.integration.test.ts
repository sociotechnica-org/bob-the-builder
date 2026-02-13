import { describe, expect, it } from "vitest";
import { handleFetch, handleQueue, type Env } from "../src/index";

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

  public seedRun(run: RunRow): void {
    this.runs.push(run);
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
    if (sql.startsWith("update runs") && sql.includes("coalesce(started_at")) {
      const runId = asString(params[4]);
      const run = this.runs.find((candidate) => candidate.id === runId);
      if (!run || run.status !== "queued") {
        return 0;
      }

      run.status = "running";
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

    if (sql.startsWith("update station_executions")) {
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
      sql.includes("where id = ? and status = ?")
    ) {
      const runId = asString(params[4]);
      const expectedStatus = asString(params[5]);
      const run = this.runs.find((candidate) => candidate.id === runId);
      if (!run || run.status !== expectedStatus) {
        return 0;
      }

      run.status = asString(params[0]);
      run.finished_at = asNullableString(params[1]);
      run.current_station = asNullableString(params[2]);
      run.failure_reason = asNullableString(params[3]);
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

function createEnv(): { env: Env; db: MockD1Database } {
  const db = new MockD1Database();
  return {
    env: {
      DB: db as unknown as D1Database
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
