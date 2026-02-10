import { describe, expect, it } from "vitest";
import {
  extractBearerToken,
  getCookieValue,
  requirePassword,
  unauthorizedResponse
} from "../src/index";

const env = { BOB_PASSWORD: "s3cr3t" };

describe("extractBearerToken", () => {
  it("extracts a valid bearer token", () => {
    expect(extractBearerToken("Bearer s3cr3t")).toBe("s3cr3t");
  });

  it("rejects malformed or missing headers", () => {
    expect(extractBearerToken(null)).toBeNull();
    expect(extractBearerToken("Basic abc")).toBeNull();
    expect(extractBearerToken("Bearer")).toBeNull();
    expect(extractBearerToken("Bearer one two")).toBeNull();
  });
});

describe("getCookieValue", () => {
  it("extracts cookie values by name", () => {
    expect(getCookieValue("a=1; bob_password=s3cr3t", "bob_password")).toBe("s3cr3t");
  });

  it("returns null when cookie is absent", () => {
    expect(getCookieValue("a=1", "bob_password")).toBeNull();
  });

  it("returns null for malformed percent-encoding", () => {
    expect(getCookieValue("bob_password=%ZZ", "bob_password")).toBeNull();
  });
});

describe("requirePassword", () => {
  it("accepts a correct bearer token", () => {
    const request = new Request("https://example.com/v1/ping", {
      headers: { authorization: "Bearer s3cr3t" }
    });

    expect(requirePassword(request, env)).toBeNull();
  });

  it("rejects missing or invalid tokens", async () => {
    const missing = new Request("https://example.com/v1/ping");
    const invalid = new Request("https://example.com/v1/ping", {
      headers: { authorization: "Bearer wrong" }
    });

    const missingResponse = requirePassword(missing, env);
    const invalidResponse = requirePassword(invalid, env);

    expect(missingResponse?.status).toBe(401);
    expect(invalidResponse?.status).toBe(401);
    await expect(invalidResponse?.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("supports cookie fallback when enabled", () => {
    const request = new Request("https://example.com/v1/ping", {
      headers: { cookie: "bob_password=s3cr3t" }
    });

    expect(requirePassword(request, env, { allowCookie: true })).toBeNull();
  });

  it("rejects malformed cookie values without throwing", async () => {
    const request = new Request("https://example.com/v1/ping", {
      headers: { cookie: "bob_password=%ZZ" }
    });

    const response = requirePassword(request, env, { allowCookie: true });
    expect(response?.status).toBe(401);
    await expect(response?.json()).resolves.toEqual({ error: "Unauthorized" });
  });
});

describe("unauthorizedResponse", () => {
  it("returns 401 json", async () => {
    const response = unauthorizedResponse();
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });
});
