import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REQUESTED_PORT = process.env.BOB_SMOKE_PORT ? Number(process.env.BOB_SMOKE_PORT) : undefined;
const HOST = "127.0.0.1";
const PASSWORD = process.env.BOB_PASSWORD ?? "replace-me";
const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

let worker: ChildProcessByStdio<null, Readable, Readable> | undefined;
let workerStdout = "";
let workerStderr = "";
let port = REQUESTED_PORT ?? 0;

function getBaseUrl(): string {
  return `http://${HOST}:${port}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function startWorker(): ChildProcessByStdio<null, Readable, Readable> {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const child = spawn(
    command,
    [
      "dev",
      "--port",
      String(port),
      "--ip",
      HOST,
      "--local",
      "--var",
      `BOB_PASSWORD:${PASSWORD}`,
      "--show-interactive-dev-session=false",
      "--log-level",
      "warn"
    ],
    {
      cwd: PACKAGE_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    }
  );

  child.stdout.on("data", (chunk: Buffer) => {
    workerStdout += chunk.toString();
  });

  child.stderr.on("data", (chunk: Buffer) => {
    workerStderr += chunk.toString();
  });

  return child;
}

async function reserveOpenPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.once("error", (error) => {
      reject(error);
    });

    server.listen(0, HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => {
          reject(new Error("Failed to allocate an ephemeral port"));
        });
        return;
      }

      const reservedPort = address.port;
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }

        resolve(reservedPort);
      });
    });
  });
}

async function waitForServer(timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  const baseUrl = getBaseUrl();

  while (Date.now() - start < timeoutMs) {
    if (!worker || worker.exitCode !== null) {
      throw new Error(
        `Worker exited before becoming ready. Exit code: ${worker?.exitCode ?? "unknown"}`
      );
    }

    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) {
        return;
      }
    } catch {
      // Worker is still starting.
    }

    await sleep(250);
  }

  throw new Error(`Timed out waiting for worker at ${baseUrl}`);
}

async function stopWorker(): Promise<void> {
  if (!worker || worker.killed || worker.exitCode !== null) {
    return;
  }

  worker.kill("SIGINT");

  const exited = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      resolve(false);
    }, 3_000);

    worker?.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

  if (!exited && worker.exitCode === null) {
    worker.kill("SIGKILL");
  }
}

async function assertJsonResponse(
  path: string,
  init: RequestInit,
  expectedStatus: number,
  expectedBody: Record<string, unknown>
): Promise<void> {
  const response = await fetch(`${getBaseUrl()}${path}`, init);
  const text = await response.text();

  expect(response.status).toBe(expectedStatus);

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON response for ${path} but got: ${text || "<empty>"}`);
  }

  expect(json).toEqual(expectedBody);
}

describe("control worker integration", () => {
  beforeAll(async () => {
    if (!REQUESTED_PORT) {
      port = await reserveOpenPort();
    }

    worker = startWorker();
    try {
      await waitForServer();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${message}\n\nworker stdout:\n${workerStdout || "<empty>"}\n\nworker stderr:\n${workerStderr || "<empty>"}`
      );
    }
  });

  afterAll(async () => {
    await stopWorker();
  });

  it("serves /healthz without auth", async () => {
    await assertJsonResponse("/healthz", {}, 200, {
      ok: true,
      service: "control-worker"
    });
  });

  it("returns 401 for /v1/ping without auth", async () => {
    await assertJsonResponse("/v1/ping", {}, 401, {
      error: "Unauthorized"
    });
  });

  it("returns pong for /v1/ping with valid bearer auth", async () => {
    await assertJsonResponse(
      "/v1/ping",
      {
        headers: {
          Authorization: `Bearer ${PASSWORD}`
        }
      },
      200,
      {
        ok: true,
        message: "pong"
      }
    );
  });
});
