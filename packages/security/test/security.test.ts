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
    const invalidSameLength = new Request("https://example.com/v1/ping", {
      headers: { authorization: "Bearer s3cr3X" }
    });

    const missingResponse = requirePassword(missing, env);
    const invalidResponse = requirePassword(invalid, env);
    const invalidSameLengthResponse = requirePassword(invalidSameLength, env);

    expect(missingResponse?.status).toBe(401);
    expect(invalidResponse?.status).toBe(401);
    expect(invalidSameLengthResponse?.status).toBe(401);
    await expect(invalidResponse?.json()).resolves.toEqual({ error: "Unauthorized" });
    await expect(invalidSameLengthResponse?.json()).resolves.toEqual({ error: "Unauthorized" });
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

  it("pads mismatched lengths before timing-safe compare", () => {
    const originalCrypto = globalThis.crypto;
    const calls: Array<{ leftLength: number; rightLength: number }> = [];

    const fakeSubtle = {
      timingSafeEqual(left: BufferSource, right: BufferSource): boolean {
        calls.push({
          leftLength: left.byteLength,
          rightLength: right.byteLength
        });
        return true;
      }
    } as unknown as SubtleCrypto;

    const fakeCrypto = { subtle: fakeSubtle } as unknown as Crypto;
    Object.defineProperty(globalThis, "crypto", {
      value: fakeCrypto,
      configurable: true
    });

    try {
      const request = new Request("https://example.com/v1/ping", {
        headers: { authorization: "Bearer x" }
      });

      const response = requirePassword(request, env);
      expect(response?.status).toBe(401);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({
        leftLength: env.BOB_PASSWORD.length,
        rightLength: env.BOB_PASSWORD.length
      });
    } finally {
      Object.defineProperty(globalThis, "crypto", {
        value: originalCrypto,
        configurable: true
      });
    }
  });
});

describe("unauthorizedResponse", () => {
  it("returns 401 json", async () => {
    const response = unauthorizedResponse();
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });
});
