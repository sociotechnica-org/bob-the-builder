export const RUN_STATUSES = ["queued", "running", "succeeded", "failed", "canceled"] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "canceled"] as const;

export type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number];

export const STATION_NAMES = ["intake", "plan", "implement", "verify", "create_pr"] as const;

export type StationName = (typeof STATION_NAMES)[number];

export const STATION_EXECUTION_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped"
] as const;

export type StationExecutionStatus = (typeof STATION_EXECUTION_STATUSES)[number];

export const PR_MODES = ["draft", "ready"] as const;

export type PrMode = (typeof PR_MODES)[number];

export interface RunQueueMessage {
  runId: string;
  repoId: string;
  issueNumber: number;
  requestedAt: string;
  prMode: PrMode;
  requestor: string;
}

const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ["running", "canceled"],
  running: ["succeeded", "failed", "canceled"],
  succeeded: [],
  failed: [],
  canceled: []
};

const STATION_TRANSITIONS: Readonly<
  Record<StationExecutionStatus, readonly StationExecutionStatus[]>
> = {
  pending: ["running", "skipped"],
  running: ["succeeded", "failed", "skipped"],
  succeeded: [],
  failed: [],
  skipped: []
};

export function isRunStatus(value: string): value is RunStatus {
  return RUN_STATUSES.includes(value as RunStatus);
}

export function isTerminalRunStatus(status: RunStatus): status is TerminalRunStatus {
  return TERMINAL_RUN_STATUSES.includes(status as TerminalRunStatus);
}

export function canTransitionRunStatus(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function isStationName(value: string): value is StationName {
  return STATION_NAMES.includes(value as StationName);
}

export function isStationExecutionStatus(value: string): value is StationExecutionStatus {
  return STATION_EXECUTION_STATUSES.includes(value as StationExecutionStatus);
}

export function canTransitionStationStatus(
  from: StationExecutionStatus,
  to: StationExecutionStatus
): boolean {
  return STATION_TRANSITIONS[from].includes(to);
}

export function isPrMode(value: string): value is PrMode {
  return PR_MODES.includes(value as PrMode);
}

export function isRunQueueMessage(value: unknown): value is RunQueueMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<RunQueueMessage>;
  return (
    typeof candidate.runId === "string" &&
    typeof candidate.repoId === "string" &&
    Number.isInteger(candidate.issueNumber) &&
    typeof candidate.requestedAt === "string" &&
    typeof candidate.requestor === "string" &&
    typeof candidate.prMode === "string" &&
    isPrMode(candidate.prMode)
  );
}
