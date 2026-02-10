import { describe, expect, it } from "vitest";
import {
  canTransitionRunStatus,
  canTransitionStationStatus,
  isPrMode,
  isRunQueueMessage,
  isRunStatus,
  isStationName,
  isTerminalRunStatus
} from "../src/index";

describe("run status contracts", () => {
  it("allows queued to running", () => {
    expect(canTransitionRunStatus("queued", "running")).toBe(true);
  });

  it("disallows terminal run transitions", () => {
    expect(canTransitionRunStatus("succeeded", "running")).toBe(false);
    expect(isTerminalRunStatus("failed")).toBe(true);
  });

  it("exposes type guards", () => {
    expect(isRunStatus("queued")).toBe(true);
    expect(isRunStatus("other")).toBe(false);
    expect(isPrMode("draft")).toBe(true);
    expect(isPrMode("invalid")).toBe(false);
    expect(isStationName("verify")).toBe(true);
  });
});

describe("station status contracts", () => {
  it("allows pending to running", () => {
    expect(canTransitionStationStatus("pending", "running")).toBe(true);
  });

  it("disallows completed station transitions", () => {
    expect(canTransitionStationStatus("succeeded", "failed")).toBe(false);
  });
});

describe("run queue message contracts", () => {
  it("accepts valid queue messages", () => {
    expect(
      isRunQueueMessage({
        runId: "run_123",
        repoId: "repo_123",
        issueNumber: 7,
        requestedAt: "2026-02-10T00:00:00.000Z",
        prMode: "draft",
        requestor: "jess"
      })
    ).toBe(true);
  });

  it("rejects malformed queue messages", () => {
    expect(
      isRunQueueMessage({
        runId: "run_123",
        repoId: "repo_123",
        issueNumber: "7",
        requestedAt: "2026-02-10T00:00:00.000Z",
        prMode: "draft",
        requestor: "jess"
      })
    ).toBe(false);
  });
});
