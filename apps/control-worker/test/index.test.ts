import type { RunQueueMessage } from "@bob/core";
import { describe, expect, it } from "vitest";
import { handleRequest, type Env } from "../src/index";

interface RepoRow {
  id: string;
  owner: string;
  name: string;
  default_branch: string;
  config_path: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  repo_id: string;
  issue_number: number;
  goal: string | null;
  status: string;
  current_station: string | null;
  requestor: string;
  base_branch: string;
  work_branch: string | null;
  pr_mode: string;
  pr_url: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  failure_reason: string | null;
}

interface IdempotencyRow {
  key: string;
  request_hash: string;
  run_id: string;
  status: "pending" | "succeeded" | "failed";
  created_at: string;
  updated_at: string;
}

class MockQueue {
  public messages: RunQueueMessage[] = [];
  public failNextSend = false;

  public async send(message: RunQueueMessage): Promise<void> {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error("Queue unavailable");
    }
    this.messages.push(message);
  }
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

  public async first<T = unknown>(): Promise<T | null> {
    return this.db.first(this.sql, this.params) as T | null;
  }

  public async all<T = unknown>(): Promise<D1Result<T>> {
    return { results: this.db.all(this.sql, this.params) as T[] } as D1Result<T>;
  }

  public async run(): Promise<D1Result<never>> {
    this.db.run(this.sql, this.params);
    return { success: true } as D1Result<never>;
  }
}

class MockD1Database {
  private readonly repos: RepoRow[] = [];
  private readonly runs: RunRow[] = [];
  private readonly idempotencyKeys: IdempotencyRow[] = [];

  public prepare(sql: string): D1PreparedStatement {
    return new MockD1PreparedStatement(this, normalizeSql(sql)) as unknown as D1PreparedStatement;
  }

  public first(sql: string, params: unknown[]): unknown {
    if (sql.includes("from repos") && sql.includes("where owner = ? and name = ?")) {
      const owner = asString(params[0]);
      const name = asString(params[1]);
      return this.repos.find((repo) => repo.owner === owner && repo.name === name) ?? null;
    }

    if (sql.includes("from run_idempotency_keys") && sql.includes("where key = ?")) {
      const key = asString(params[0]);
      return this.idempotencyKeys.find((record) => record.key === key) ?? null;
    }

    if (sql.includes("from runs") && sql.includes("where runs.id = ?")) {
      const runId = asString(params[0]);
      const run = this.runs.find((row) => row.id === runId);
      if (!run) {
        return null;
      }

      return this.withRepo(run);
    }

    throw new Error(`Unsupported first SQL: ${sql}`);
  }

  public all(sql: string, params: unknown[]): unknown[] {
    if (sql.includes("from repos") && sql.includes("order by owner asc")) {
      return [...this.repos].sort((left, right) => {
        if (left.owner === right.owner) {
          return left.name.localeCompare(right.name);
        }
        return left.owner.localeCompare(right.owner);
      });
    }

    if (sql.includes("from runs") && sql.includes("order by runs.created_at desc")) {
      let statusFilter: string | null = null;
      let ownerFilter: string | null = null;
      let nameFilter: string | null = null;
      let paramIndex = 0;

      if (sql.includes("runs.status = ?")) {
        statusFilter = asString(params[paramIndex]);
        paramIndex += 1;
      }

      if (sql.includes("repos.owner = ? and repos.name = ?")) {
        ownerFilter = asString(params[paramIndex]);
        nameFilter = asString(params[paramIndex + 1]);
        paramIndex += 2;
      }

      const limit = Number(params[paramIndex]);
      const rows = this.runs
        .filter((run) => {
          if (statusFilter && run.status !== statusFilter) {
            return false;
          }
          if (ownerFilter && nameFilter) {
            const repo = this.repos.find((candidate) => candidate.id === run.repo_id);
            if (!repo || repo.owner !== ownerFilter || repo.name !== nameFilter) {
              return false;
            }
          }
          return true;
        })
        .sort((left, right) => right.created_at.localeCompare(left.created_at))
        .slice(0, limit)
        .map((run) => this.withRepo(run));

      return rows;
    }

    throw new Error(`Unsupported all SQL: ${sql}`);
  }

  public run(sql: string, params: unknown[]): void {
    if (sql.startsWith("insert into repos")) {
      const owner = asString(params[1]);
      const name = asString(params[2]);
      const existing = this.repos.find((repo) => repo.owner === owner && repo.name === name);
      if (existing) {
        throw new Error("D1_ERROR: UNIQUE constraint failed: repos.owner, repos.name");
      }

      this.repos.push({
        id: asString(params[0]),
        owner,
        name,
        default_branch: asString(params[3]),
        config_path: asString(params[4]),
        enabled: Number(params[5]),
        created_at: asString(params[6]),
        updated_at: asString(params[7])
      });
      return;
    }

    if (sql.startsWith("insert into runs")) {
      this.runs.push({
        id: asString(params[0]),
        repo_id: asString(params[1]),
        issue_number: Number(params[2]),
        goal: asNullableString(params[3]),
        status: asString(params[4]),
        current_station: asNullableString(params[5]),
        requestor: asString(params[6]),
        base_branch: asString(params[7]),
        work_branch: asNullableString(params[8]),
        pr_mode: asString(params[9]),
        pr_url: asNullableString(params[10]),
        created_at: asString(params[11]),
        started_at: asNullableString(params[12]),
        finished_at: asNullableString(params[13]),
        failure_reason: asNullableString(params[14])
      });
      return;
    }

    if (sql.startsWith("update runs")) {
      const run = this.runs.find((row) => row.id === asString(params[3]));
      if (!run) {
        return;
      }

      run.status = asString(params[0]);
      run.failure_reason = asNullableString(params[1]);
      run.finished_at = asNullableString(params[2]);
      return;
    }

    if (sql.startsWith("delete from runs where id = ?")) {
      const runId = asString(params[0]);
      const index = this.runs.findIndex((row) => row.id === runId);
      if (index >= 0) {
        this.runs.splice(index, 1);
      }
      return;
    }

    if (sql.startsWith("insert into run_idempotency_keys")) {
      const key = asString(params[0]);
      const existing = this.idempotencyKeys.find((record) => record.key === key);
      if (existing) {
        throw new Error("D1_ERROR: UNIQUE constraint failed: run_idempotency_keys.key");
      }

      this.idempotencyKeys.push({
        key,
        request_hash: asString(params[1]),
        run_id: asString(params[2]),
        status: asString(params[3]) as IdempotencyRow["status"],
        created_at: asString(params[4]),
        updated_at: asString(params[5])
      });
      return;
    }

    if (sql.startsWith("update run_idempotency_keys")) {
      const key = asString(params[2]);
      const record = this.idempotencyKeys.find((candidate) => candidate.key === key);
      if (!record) {
        return;
      }

      record.status = asString(params[0]) as IdempotencyRow["status"];
      record.updated_at = asString(params[1]);
      return;
    }

    throw new Error(`Unsupported run SQL: ${sql}`);
  }

  private withRepo(run: RunRow): Record<string, unknown> {
    const repo = this.repos.find((candidate) => candidate.id === run.repo_id);
    if (!repo) {
      throw new Error(`Repo ${run.repo_id} not found for run ${run.id}`);
    }

    return {
      ...run,
      repo_owner: repo.owner,
      repo_name: repo.name
    };
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

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: "Bearer password123",
    ...extra
  };
}

function createEnv(): { env: Env; db: MockD1Database; queue: MockQueue } {
  const db = new MockD1Database();
  const queue = new MockQueue();

  return {
    env: {
      BOB_PASSWORD: "password123",
      DB: db as unknown as D1Database,
      RUN_QUEUE: queue as unknown as Queue<RunQueueMessage>
    },
    db,
    queue
  };
}

async function parseJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function createRepo(env: Env): Promise<Response> {
  return handleRequest(
    new Request("https://example.com/v1/repos", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        owner: "sociotechnica-org",
        name: "lifebuild"
      })
    }),
    env
  );
}

describe("control worker", () => {
  it("serves health endpoint without auth", async () => {
    const { env } = createEnv();
    const response = await handleRequest(new Request("https://example.com/healthz"), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, service: "control-worker" });
  });

  it("requires auth on v1 routes", async () => {
    const { env } = createEnv();
    const response = await handleRequest(new Request("https://example.com/v1/ping"), env);
    expect(response.status).toBe(401);
  });

  it("does not accept cookie auth on v1 routes", async () => {
    const { env } = createEnv();
    const response = await handleRequest(
      new Request("https://example.com/v1/ping", {
        headers: {
          cookie: "bob_password=password123"
        }
      }),
      env
    );

    expect(response.status).toBe(401);
  });

  it("returns pong for authorized requests", async () => {
    const { env } = createEnv();
    const response = await handleRequest(
      new Request("https://example.com/v1/ping", {
        headers: authHeaders()
      }),
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, message: "pong" });
  });

  it("creates and lists repositories", async () => {
    const { env } = createEnv();

    const createResponse = await createRepo(env);
    expect(createResponse.status).toBe(201);

    const listResponse = await handleRequest(
      new Request("https://example.com/v1/repos", {
        headers: authHeaders()
      }),
      env
    );

    expect(listResponse.status).toBe(200);
    const payload = await parseJson(listResponse);
    const repos = payload.repos as Array<Record<string, unknown>>;
    expect(repos).toHaveLength(1);
    expect(repos[0]?.owner).toBe("sociotechnica-org");
    expect(repos[0]?.name).toBe("lifebuild");
  });

  it("rejects duplicate repositories with 409", async () => {
    const { env } = createEnv();

    expect((await createRepo(env)).status).toBe(201);
    const duplicateResponse = await createRepo(env);

    expect(duplicateResponse.status).toBe(409);
  });

  it("requires idempotency key when creating runs", async () => {
    const { env } = createEnv();
    await createRepo(env);

    const response = await handleRequest(
      new Request("https://example.com/v1/runs", {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({
          repo: { owner: "sociotechnica-org", name: "lifebuild" },
          issue: { number: 123 },
          requestor: "jess",
          prMode: "draft"
        })
      }),
      env
    );

    expect(response.status).toBe(400);
  });

  it("creates runs and replays duplicate requests without creating duplicates", async () => {
    const { env, queue } = createEnv();
    await createRepo(env);

    const runBody = JSON.stringify({
      repo: { owner: "sociotechnica-org", name: "lifebuild" },
      issue: { number: 123 },
      requestor: "jess",
      prMode: "draft"
    });

    const createResponse = await handleRequest(
      new Request("https://example.com/v1/runs", {
        method: "POST",
        headers: authHeaders({
          "content-type": "application/json",
          "idempotency-key": "run-123"
        }),
        body: runBody
      }),
      env
    );
    expect(createResponse.status).toBe(202);

    const createPayload = await parseJson(createResponse);
    const run = createPayload.run as Record<string, unknown>;
    expect(typeof run.id).toBe("string");
    expect(run.status).toBe("queued");
    expect(queue.messages).toHaveLength(1);

    const replayResponse = await handleRequest(
      new Request("https://example.com/v1/runs", {
        method: "POST",
        headers: authHeaders({
          "content-type": "application/json",
          "idempotency-key": "run-123"
        }),
        body: runBody
      }),
      env
    );
    expect(replayResponse.status).toBe(200);
    expect(queue.messages).toHaveLength(1);

    const listResponse = await handleRequest(
      new Request("https://example.com/v1/runs", {
        headers: authHeaders()
      }),
      env
    );
    expect(listResponse.status).toBe(200);

    const listPayload = await parseJson(listResponse);
    const runs = listPayload.runs as Array<Record<string, unknown>>;
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(run.id);

    const runResponse = await handleRequest(
      new Request(`https://example.com/v1/runs/${run.id as string}`, {
        headers: authHeaders()
      }),
      env
    );
    expect(runResponse.status).toBe(200);
  });

  it("rejects idempotency key reuse with a different payload", async () => {
    const { env } = createEnv();
    await createRepo(env);

    const baseHeaders = authHeaders({
      "content-type": "application/json",
      "idempotency-key": "run-abc"
    });

    const firstResponse = await handleRequest(
      new Request("https://example.com/v1/runs", {
        method: "POST",
        headers: baseHeaders,
        body: JSON.stringify({
          repo: { owner: "sociotechnica-org", name: "lifebuild" },
          issue: { number: 123 },
          requestor: "jess",
          prMode: "draft"
        })
      }),
      env
    );

    expect(firstResponse.status).toBe(202);

    const secondResponse = await handleRequest(
      new Request("https://example.com/v1/runs", {
        method: "POST",
        headers: baseHeaders,
        body: JSON.stringify({
          repo: { owner: "sociotechnica-org", name: "lifebuild" },
          issue: { number: 124 },
          requestor: "jess",
          prMode: "draft"
        })
      }),
      env
    );

    expect(secondResponse.status).toBe(409);
  });

  it("retries queue publish with the same idempotency key after transient queue failure", async () => {
    const { env, queue } = createEnv();
    await createRepo(env);

    queue.failNextSend = true;

    const runBody = JSON.stringify({
      repo: { owner: "sociotechnica-org", name: "lifebuild" },
      issue: { number: 222 },
      requestor: "jess",
      prMode: "draft"
    });

    const failedResponse = await handleRequest(
      new Request("https://example.com/v1/runs", {
        method: "POST",
        headers: authHeaders({
          "content-type": "application/json",
          "idempotency-key": "retry-key"
        }),
        body: runBody
      }),
      env
    );

    expect(failedResponse.status).toBe(503);
    const failedPayload = await parseJson(failedResponse);
    const failedRun = failedPayload.run as Record<string, unknown>;
    expect(failedRun.status).toBe("failed");
    expect(failedRun.failureReason).toBe("queue_publish_failed");

    const retryResponse = await handleRequest(
      new Request("https://example.com/v1/runs", {
        method: "POST",
        headers: authHeaders({
          "content-type": "application/json",
          "idempotency-key": "retry-key"
        }),
        body: runBody
      }),
      env
    );

    expect(retryResponse.status).toBe(202);
    expect(queue.messages).toHaveLength(1);
    const retryPayload = await parseJson(retryResponse);
    const idempotency = retryPayload.idempotency as Record<string, unknown>;
    expect(idempotency.requeued).toBe(true);
  });
});
