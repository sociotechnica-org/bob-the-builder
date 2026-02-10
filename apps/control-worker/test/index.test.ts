import { describe, expect, it } from "vitest";
import { handleRequest } from "../src/index";

const env = { BOB_PASSWORD: "password123" };

describe("control worker", () => {
  it("serves health endpoint without auth", async () => {
    const response = await handleRequest(new Request("https://example.com/healthz"), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, service: "control-worker" });
  });

  it("requires auth on v1 routes", async () => {
    const response = await handleRequest(new Request("https://example.com/v1/ping"), env);
    expect(response.status).toBe(401);
  });

  it("does not accept cookie auth on v1 routes", async () => {
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
    const response = await handleRequest(
      new Request("https://example.com/v1/ping", {
        headers: { authorization: "Bearer password123" }
      }),
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, message: "pong" });
  });
});
