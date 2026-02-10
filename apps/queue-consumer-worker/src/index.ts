import {
  isRunQueueMessage,
  STATION_NAMES,
  type RunQueueMessage,
  type StationName
} from "@bob/core";

export interface Env {
  DB: D1Database;
}

interface RunExecutionRow {
  id: string;
  goal: string | null;
  status: string;
  current_station: string | null;
}

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

function isTerminalRunStatus(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

function parseForcedFailureStation(goal: string | null): StationName | null {
  if (!goal) {
    return null;
  }

  const match = goal.match(/force_fail:([a-z_]+)/i);
  if (!match) {
    return null;
  }

  const candidate = match[1]?.toLowerCase();
  return STATION_NAMES.find((station) => station === candidate) ?? null;
}

function stationExecutionId(runId: string, station: StationName): string {
  return `station_${runId}_${station}`;
}

async function claimQueuedRun(env: Env, runId: string): Promise<boolean> {
  const claimedAt = nowIso();
  const result = await env.DB.prepare(
    `UPDATE runs
     SET status = ?, started_at = COALESCE(started_at, ?), current_station = ?, failure_reason = ?
     WHERE id = ? AND status = ?`
  )
    .bind("running", claimedAt, STATION_NAMES[0], null, runId, "queued")
    .run();

  return getAffectedRowCount(result) === 1;
}

async function getRunForExecution(env: Env, runId: string): Promise<RunExecutionRow | null> {
  return (
    (await env.DB.prepare(
      `SELECT id, goal, status, current_station
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
  await env.DB.prepare(
    `UPDATE runs
     SET current_station = ?
     WHERE id = ?`
  )
    .bind(station, runId)
    .run();
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

async function markStationFailed(
  env: Env,
  runId: string,
  station: StationName,
  startedAtMs: number,
  reason: string
): Promise<void> {
  const finishedAt = nowIso();
  const durationMs = Math.max(1, Date.now() - startedAtMs);
  await env.DB.prepare(
    `UPDATE station_executions
     SET status = ?, finished_at = ?, duration_ms = ?, summary = ?
     WHERE id = ?`
  )
    .bind(
      "failed",
      finishedAt,
      durationMs,
      reason.slice(0, 500),
      stationExecutionId(runId, station)
    )
    .run();
}

async function markRunSucceeded(env: Env, runId: string): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE runs
     SET status = ?, finished_at = ?, current_station = ?, failure_reason = ?
     WHERE id = ? AND status = ?`
  )
    .bind("succeeded", nowIso(), null, null, runId, "running")
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
     SET status = ?, finished_at = ?, current_station = ?, failure_reason = ?
     WHERE id = ? AND status = ?`
  )
    .bind("failed", nowIso(), station, reason.slice(0, 500), runId, "running")
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
  station: StationName,
  forcedFailureStation: StationName | null
): Promise<{ ok: boolean; error?: string }> {
  const startedAt = nowIso();
  const startedAtMs = Date.now();

  await updateRunCurrentStation(env, runId, station);
  await markStationRunning(env, runId, station, startedAt);
  logEvent("station.started", { runId, station });

  if (forcedFailureStation === station) {
    const reason = `Station ${station} failed due to forced failure marker`;
    await markStationFailed(env, runId, station, startedAtMs, reason);
    logEvent("station.failed", { runId, station, reason });
    return { ok: false, error: reason };
  }

  await markStationSucceeded(env, runId, station, startedAtMs);
  logEvent("station.succeeded", { runId, station });
  return { ok: true };
}

async function runWorkflowSkeleton(env: Env, run: RunExecutionRow): Promise<void> {
  const forcedFailureStation = parseForcedFailureStation(run.goal);

  for (const station of STATION_NAMES) {
    const result = await executeStation(env, run.id, station, forcedFailureStation);
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

  await createCompletionArtifact(env, run.id);
  const markedSucceeded = await markRunSucceeded(env, run.id);
  if (markedSucceeded) {
    logEvent("run.succeeded", { runId: run.id });
    return;
  }

  logEvent("run.succeeded.noop", {
    runId: run.id
  });
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

  if (isTerminalRunStatus(run.status)) {
    logEvent("run.skip.terminal", {
      runId: payload.runId,
      messageId: message.id,
      status: run.status
    });
    message.ack();
    return;
  }

  if (run.status === "queued") {
    const claimed = await claimQueuedRun(env, payload.runId);
    if (!claimed) {
      const latestRun = await getRunForExecution(env, payload.runId);
      if (latestRun && isTerminalRunStatus(latestRun.status)) {
        logEvent("run.claim.contended.terminal", {
          runId: payload.runId,
          messageId: message.id,
          status: latestRun.status
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
  } else if (run.status === "running") {
    logEvent("run.resume", {
      runId: payload.runId,
      messageId: message.id
    });
  } else {
    logEvent("run.skip.unexpected_status", {
      runId: payload.runId,
      messageId: message.id,
      status: run.status
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
    if (!latestRunAfterMark || isTerminalRunStatus(latestRunAfterMark.status)) {
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

export async function handleFetch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (request.method.toUpperCase() === "GET" && url.pathname === "/healthz") {
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
