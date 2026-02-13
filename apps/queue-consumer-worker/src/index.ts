import {
  isRunQueueMessage,
  isRunStatus,
  isTerminalRunStatus,
  STATION_NAMES,
  type RunQueueMessage,
  type RunStatus,
  type StationName
} from "@bob/core";

export interface Env {
  DB: D1Database;
  LOCAL_QUEUE_SHARED_SECRET?: string;
}

interface RunExecutionRow {
  id: string;
  status: string;
  current_station: string | null;
  started_at: string | null;
  heartbeat_at: string | null;
}

const RUN_RESUME_STALE_MS = 30_000;
const RUN_HEARTBEAT_INTERVAL_MS = 5_000;
const LOCAL_QUEUE_CONSUME_PATH = "/__queue/consume";
const LOCAL_QUEUE_SECRET_HEADER = "x-bob-local-queue-secret";

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status });
}

function nowIso(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getAffectedRowCount(result: D1Result<unknown>): number {
  return typeof result.meta?.changes === "number" ? result.meta.changes : 0;
}

function logEvent(event: string, payload: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({
      event,
      ...payload
    })
  );
}

function asStationName(value: string | null): StationName | null {
  if (!value) {
    return null;
  }

  return STATION_NAMES.find((station) => station === value) ?? null;
}

function parseRunStatus(status: string): RunStatus | null {
  return isRunStatus(status) ? status : null;
}

function shouldResumeRunningRun(run: RunExecutionRow): boolean {
  if (run.status !== "running") {
    return false;
  }

  const lastHeartbeat = run.heartbeat_at ?? run.started_at;
  if (!lastHeartbeat) {
    return true;
  }

  const heartbeatAt = Date.parse(lastHeartbeat);
  if (Number.isNaN(heartbeatAt)) {
    return true;
  }

  return Date.now() - heartbeatAt >= RUN_RESUME_STALE_MS;
}

function stationExecutionId(runId: string, station: StationName): string {
  return `station_${runId}_${station}`;
}

async function claimQueuedRun(env: Env, runId: string): Promise<boolean> {
  const claimedAt = nowIso();
  const result = await env.DB.prepare(
    `UPDATE runs
     SET status = ?, started_at = COALESCE(started_at, ?), current_station = ?, heartbeat_at = ?, failure_reason = ?
     WHERE id = ? AND status = ?`
  )
    .bind("running", claimedAt, STATION_NAMES[0], claimedAt, null, runId, "queued")
    .run();

  return getAffectedRowCount(result) === 1;
}

async function claimStaleRunningRun(env: Env, run: RunExecutionRow): Promise<boolean> {
  const resumedAt = nowIso();

  if (run.heartbeat_at) {
    const result = await env.DB.prepare(
      `UPDATE runs
       SET heartbeat_at = ?
       WHERE id = ? AND status = ? AND heartbeat_at = ?`
    )
      .bind(resumedAt, run.id, "running", run.heartbeat_at)
      .run();
    return getAffectedRowCount(result) === 1;
  }

  if (run.started_at) {
    const result = await env.DB.prepare(
      `UPDATE runs
       SET heartbeat_at = ?
       WHERE id = ? AND status = ? AND heartbeat_at IS NULL AND started_at = ?`
    )
      .bind(resumedAt, run.id, "running", run.started_at)
      .run();
    return getAffectedRowCount(result) === 1;
  }

  const result = await env.DB.prepare(
    `UPDATE runs
     SET heartbeat_at = ?
     WHERE id = ? AND status = ? AND heartbeat_at IS NULL AND started_at IS NULL`
  )
    .bind(resumedAt, run.id, "running")
    .run();
  return getAffectedRowCount(result) === 1;
}

async function getRunForExecution(env: Env, runId: string): Promise<RunExecutionRow | null> {
  return (
    (await env.DB.prepare(
      `SELECT id, status, current_station, started_at, heartbeat_at
       FROM runs
       WHERE id = ?
       LIMIT 1`
    )
      .bind(runId)
      .first<RunExecutionRow>()) ?? null
  );
}

async function updateRunCurrentStation(
  env: Env,
  runId: string,
  station: StationName
): Promise<void> {
  const heartbeatAt = nowIso();
  await env.DB.prepare(
    `UPDATE runs
     SET current_station = ?, heartbeat_at = ?
     WHERE id = ? AND status = ?`
  )
    .bind(station, heartbeatAt, runId, "running")
    .run();
}

function startRunHeartbeatLoop(env: Env, runId: string, station: StationName): () => void {
  const timer = setInterval(() => {
    void updateRunCurrentStation(env, runId, station).catch((error) => {
      logEvent("run.heartbeat.error", {
        runId,
        station,
        error: errorMessage(error)
      });
    });
  }, RUN_HEARTBEAT_INTERVAL_MS);

  return () => clearInterval(timer);
}

async function markStationRunning(
  env: Env,
  runId: string,
  station: StationName,
  startedAt: string
): Promise<void> {
  const id = stationExecutionId(runId, station);
  await env.DB.prepare(
    `INSERT INTO station_executions (
      id,
      run_id,
      station,
      status,
      started_at,
      finished_at,
      duration_ms,
      summary
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      started_at = excluded.started_at,
      finished_at = excluded.finished_at,
      duration_ms = excluded.duration_ms,
      summary = excluded.summary`
  )
    .bind(id, runId, station, "running", startedAt, null, null, null)
    .run();
}

async function markStationSucceeded(
  env: Env,
  runId: string,
  station: StationName,
  startedAtMs: number
): Promise<void> {
  const finishedAt = nowIso();
  const durationMs = Math.max(1, Date.now() - startedAtMs);
  await env.DB.prepare(
    `UPDATE station_executions
     SET status = ?, finished_at = ?, duration_ms = ?, summary = ?
     WHERE id = ?`
  )
    .bind(
      "succeeded",
      finishedAt,
      durationMs,
      `${station} completed via workflow skeleton`,
      stationExecutionId(runId, station)
    )
    .run();
}

async function markRunSucceeded(env: Env, runId: string): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE runs
     SET status = ?, finished_at = ?, current_station = ?, failure_reason = ?, heartbeat_at = ?
     WHERE id = ? AND status = ?`
  )
    .bind("succeeded", nowIso(), null, null, nowIso(), runId, "running")
    .run();

  return getAffectedRowCount(result) === 1;
}

async function markRunFailed(
  env: Env,
  runId: string,
  station: StationName,
  reason: string
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE runs
     SET status = ?, finished_at = ?, current_station = ?, failure_reason = ?, heartbeat_at = ?
     WHERE id = ? AND status = ?`
  )
    .bind("failed", nowIso(), station, reason.slice(0, 500), nowIso(), runId, "running")
    .run();

  return getAffectedRowCount(result) === 1;
}

async function createCompletionArtifact(env: Env, runId: string): Promise<void> {
  const artifactId = `artifact_${runId}_workflow_summary`;
  await env.DB.prepare(
    `INSERT INTO artifacts (id, run_id, type, storage, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`
  )
    .bind(
      artifactId,
      runId,
      "workflow_summary",
      "inline",
      JSON.stringify({
        message: "Workflow skeleton completed successfully",
        stations: STATION_NAMES
      }),
      nowIso()
    )
    .run();
}

async function executeStation(
  env: Env,
  runId: string,
  station: StationName
): Promise<{ ok: boolean; error?: string }> {
  const startedAt = nowIso();
  const startedAtMs = Date.now();

  await updateRunCurrentStation(env, runId, station);
  await markStationRunning(env, runId, station, startedAt);
  logEvent("station.started", { runId, station });

  const stopHeartbeatLoop = startRunHeartbeatLoop(env, runId, station);
  try {
    await markStationSucceeded(env, runId, station, startedAtMs);
    logEvent("station.succeeded", { runId, station });
  } finally {
    stopHeartbeatLoop();
  }

  return { ok: true };
}

async function runWorkflowSkeleton(env: Env, run: RunExecutionRow): Promise<void> {
  for (const station of STATION_NAMES) {
    const result = await executeStation(env, run.id, station);
    if (!result.ok) {
      await markRunFailed(env, run.id, station, result.error ?? `Station ${station} failed`);
      logEvent("run.failed", {
        runId: run.id,
        station,
        reason: result.error ?? "Unknown station failure"
      });
      return;
    }
  }

  const markedSucceeded = await markRunSucceeded(env, run.id);
  if (!markedSucceeded) {
    logEvent("run.succeeded.noop", {
      runId: run.id
    });
    return;
  }

  try {
    await createCompletionArtifact(env, run.id);
  } catch (error) {
    logEvent("run.succeeded.artifact_error", {
      runId: run.id,
      error: errorMessage(error)
    });
  }

  logEvent("run.succeeded", { runId: run.id });
}

async function processQueueMessage(env: Env, message: Message<unknown>): Promise<void> {
  if (!isRunQueueMessage(message.body)) {
    logEvent("queue.message.invalid", {
      messageId: message.id
    });
    message.ack();
    return;
  }

  const payload: RunQueueMessage = message.body;
  const run = await getRunForExecution(env, payload.runId);
  if (!run) {
    logEvent("run.missing", { runId: payload.runId, messageId: message.id });
    message.ack();
    return;
  }

  const runStatus = parseRunStatus(run.status);
  if (!runStatus) {
    logEvent("run.skip.invalid_status", {
      runId: payload.runId,
      messageId: message.id,
      status: run.status
    });
    message.ack();
    return;
  }

  if (isTerminalRunStatus(runStatus)) {
    logEvent("run.skip.terminal", {
      runId: payload.runId,
      messageId: message.id,
      status: runStatus
    });
    message.ack();
    return;
  }

  if (runStatus === "queued") {
    const claimed = await claimQueuedRun(env, payload.runId);
    if (!claimed) {
      const latestRun = await getRunForExecution(env, payload.runId);
      const latestStatus = latestRun ? parseRunStatus(latestRun.status) : null;
      if (latestStatus && isTerminalRunStatus(latestStatus)) {
        logEvent("run.claim.contended.terminal", {
          runId: payload.runId,
          messageId: message.id,
          status: latestStatus
        });
        message.ack();
        return;
      }

      logEvent("run.claim.contended.retry", {
        runId: payload.runId,
        messageId: message.id
      });
      message.retry();
      return;
    }

    logEvent("run.claimed", { runId: payload.runId, messageId: message.id });
  } else if (runStatus === "running") {
    if (!shouldResumeRunningRun(run)) {
      logEvent("run.defer.running", {
        runId: payload.runId,
        messageId: message.id
      });
      message.retry();
      return;
    }

    const claimedResume = await claimStaleRunningRun(env, run);
    if (!claimedResume) {
      logEvent("run.resume.claim_contended", {
        runId: payload.runId,
        messageId: message.id
      });
      message.retry();
      return;
    }

    logEvent("run.resume.stale_running", {
      runId: payload.runId,
      messageId: message.id
    });
  } else {
    logEvent("run.skip.unexpected_status", {
      runId: payload.runId,
      messageId: message.id,
      status: runStatus
    });
    message.ack();
    return;
  }

  try {
    await runWorkflowSkeleton(env, run);
    message.ack();
  } catch (error) {
    const reason = `Workflow execution error: ${errorMessage(error)}`.slice(0, 500);
    const latestRun = await getRunForExecution(env, payload.runId);
    const failureStation = asStationName(latestRun?.current_station ?? null) ?? STATION_NAMES[0];
    let markedFailed = false;

    try {
      markedFailed = await markRunFailed(env, payload.runId, failureStation, reason);
      if (!markedFailed) {
        logEvent("run.failed.mark_skipped", {
          runId: payload.runId,
          status: latestRun?.status ?? null
        });
      }
    } catch (markError) {
      logEvent("run.failed.mark_error", {
        runId: payload.runId,
        error: errorMessage(markError)
      });
    }

    logEvent("run.failed.unexpected", {
      runId: payload.runId,
      error: errorMessage(error)
    });

    if (markedFailed) {
      message.ack();
      return;
    }

    const latestRunAfterMark = await getRunForExecution(env, payload.runId);
    const latestStatusAfterMark = latestRunAfterMark
      ? parseRunStatus(latestRunAfterMark.status)
      : null;
    if (
      !latestRunAfterMark ||
      (latestStatusAfterMark && isTerminalRunStatus(latestStatusAfterMark))
    ) {
      message.ack();
      return;
    }

    message.retry();
  }
}

export async function handleQueue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  logEvent("queue.batch.received", {
    size: batch.messages.length
  });

  for (const message of batch.messages) {
    await processQueueMessage(env, message);
  }
}

export async function handleFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  if (method === "POST" && url.pathname === LOCAL_QUEUE_CONSUME_PATH) {
    const localQueueSecret = env.LOCAL_QUEUE_SHARED_SECRET?.trim();
    if (!localQueueSecret) {
      logEvent("local_queue.consume.secret_missing");
      return json(503, { error: "Local queue consume endpoint is disabled" });
    }

    const providedSecret = request.headers.get(LOCAL_QUEUE_SECRET_HEADER);
    if (providedSecret !== localQueueSecret) {
      return json(401, { error: "Unauthorized local queue dispatch" });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: "Request body must be valid JSON" });
    }

    let wasAcked = false;
    let shouldRetry = false;
    const syntheticMessage = {
      id: `local_${crypto.randomUUID()}`,
      body,
      ack() {
        wasAcked = true;
      },
      retry() {
        shouldRetry = true;
      }
    } satisfies Pick<Message<unknown>, "id" | "body" | "ack" | "retry">;

    await processQueueMessage(env, syntheticMessage as unknown as Message<unknown>);
    if (shouldRetry) {
      return json(503, { ok: false, outcome: "retry" });
    }

    return json(202, { ok: true, outcome: wasAcked ? "ack" : "none" });
  }

  if (method === "GET" && url.pathname === "/healthz") {
    return json(200, {
      ok: true,
      service: "queue-consumer-worker"
    });
  }

  return json(404, { error: "Not found" });
}

export default {
  fetch: handleFetch,
  queue: handleQueue
} satisfies ExportedHandler<Env>;
