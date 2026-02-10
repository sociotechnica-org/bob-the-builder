import { spawn } from "node:child_process";

const PORT = Number(process.env.BOB_SMOKE_PORT ?? 8788);
const HOST = "127.0.0.1";
const BASE_URL = `http://${HOST}:${PORT}`;
const PASSWORD = process.env.BOB_PASSWORD ?? "replace-me";

const child = spawn(
  process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  [
    "--filter",
    "@bob/control-worker",
    "dev",
    "--port",
    String(PORT),
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
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env
  }
);

let stdout = "";
let stderr = "";

child.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});

child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

child.on("error", (error) => {
  console.error("Failed to start worker dev server:", error);
  process.exitCode = 1;
});

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForServer(timeoutMs = 20_000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${BASE_URL}/healthz`);
      if (response.ok) {
        return;
      }
    } catch {
      // Wait for server startup.
    }

    await sleep(250);
  }

  throw new Error(`Timed out waiting for worker at ${BASE_URL}`);
}

async function parseBody(response) {
  const text = await response.text();

  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
}

async function assertRequest(name, path, init, expectedStatus, expectedBody) {
  const response = await fetch(`${BASE_URL}${path}`, init);
  const body = await parseBody(response);

  if (response.status !== expectedStatus) {
    throw new Error(
      `${name}: expected status ${expectedStatus}, got ${response.status}. Body: ${body.text || "<empty>"}`
    );
  }

  if (!body.json) {
    throw new Error(
      `${name}: expected JSON body ${JSON.stringify(expectedBody)}, got non-JSON response: ${body.text}`
    );
  }

  if (JSON.stringify(body.json) !== JSON.stringify(expectedBody)) {
    throw new Error(
      `${name}: expected body ${JSON.stringify(expectedBody)}, got ${JSON.stringify(body.json)}`
    );
  }
}

async function stopWorker() {
  if (child.killed) {
    return;
  }

  child.kill("SIGINT");

  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(false);
    }, 3_000);

    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

  if (!exited) {
    child.kill("SIGKILL");
  }
}

async function main() {
  try {
    await waitForServer();

    await assertRequest("healthz", "/healthz", {}, 200, {
      ok: true,
      service: "control-worker"
    });

    await assertRequest("unauthorized ping", "/v1/ping", {}, 401, {
      error: "Unauthorized"
    });

    await assertRequest(
      "authorized ping",
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

    console.log(`Control-worker smoke test passed at ${BASE_URL}`);
  } finally {
    await stopWorker();
  }
}

main().catch((error) => {
  console.error("Control-worker smoke test failed.");
  console.error(error instanceof Error ? error.message : error);

  if (stdout.trim()) {
    console.error("\nWorker stdout:");
    console.error(stdout);
  }

  if (stderr.trim()) {
    console.error("\nWorker stderr:");
    console.error(stderr);
  }

  process.exit(1);
});
