import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import { decryptSecret, encryptSecret } from "../src/app/utils/crypto.js";
import { redactPaths } from "../src/lib/logger.js";
import { redis } from "../src/lib/redis.js";
import { API, api, ORIGIN, PASSWORD, registerUser } from "./helpers/api.js";

describe("health", () => {
  it("reports live and ready", async () => {
    expect((await api().get("/health")).status).toBe(200);
    const ready = await api().get("/health/ready");
    expect(ready.status).toBe(200);
    expect(ready.body.data).toEqual({ database: true, redis: true, storage: true });
  });
});

describe("middleware pipeline", () => {
  it("sets security headers and hides Express", async () => {
    const res = await api().get(`${API}/users/me`);
    expect(res.get("X-Powered-By")).toBeUndefined();
    expect(res.get("Content-Security-Policy")).toBeTruthy();
    expect(res.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("generates a request id and keeps a safe client one", async () => {
    expect((await api().get("/health")).get("X-Request-Id")).toBeTruthy();
    const kept = await api().get("/health").set("X-Request-Id", "client-supplied-id");
    expect(kept.get("X-Request-Id")).toBe("client-supplied-id");
    const replaced = await api().get("/health").set("X-Request-Id", "bad id\twith junk");
    expect(replaced.get("X-Request-Id")).not.toContain("junk");
  });

  it("returns coded errors for unknown routes, bad JSON and huge bodies", async () => {
    const missing = await api().get(`${API}/nope`);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("NOT_FOUND");
    expect(missing.body.error.requestId).toBeTruthy();

    const badJson = await api().post(`${API}/auth/login`).set("Content-Type", "application/json").send("{oops");
    expect(badJson.status).toBe(400);
    expect(badJson.body.error.code).toBe("INVALID_JSON");

    const huge = await api().post(`${API}/auth/login`).send({ email: "a@b.co", password: "x".repeat(1024 * 1024 + 1) });
    expect(huge.status).toBe(413);
    expect(huge.body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("allows only listed origins through CORS", async () => {
    const allowed = await api().options(`${API}/auth/login`).set("Origin", ORIGIN).set("Access-Control-Request-Method", "POST");
    expect(allowed.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(allowed.get("Access-Control-Allow-Credentials")).toBe("true");
    const denied = await api().options(`${API}/auth/login`).set("Origin", "https://evil.example").set("Access-Control-Request-Method", "POST");
    expect(denied.get("Access-Control-Allow-Origin")).toBeUndefined();
  });
});

describe("Redis outage", () => {
  it("keeps login working and reports not ready", async () => {
    const { email } = await registerUser();
    const down = () => Promise.reject(new Error("redis down"));
    const spies = (["eval", "get", "ttl", "incr", "del", "ping"] as const).map((command) =>
      vi.spyOn(redis, command).mockImplementation(down as never),
    );
    try {
      const login = await api().post(`${API}/auth/login`).send({ email, password: PASSWORD });
      expect(login.status).toBe(200);
      const wrong = await api().post(`${API}/auth/login`).send({ email, password: "wrong-password-here" });
      expect(wrong.status).toBe(401);
      expect((await api().get("/health/ready")).status).toBe(503);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });
});

describe("OpenAPI", () => {
  it("documents every route", async () => {
    const res = await api().get("/api/docs/openapi.json");
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining(["/api/v1/auth/login", "/api/v1/auth/mfa/verify", "/api/v1/users/me", "/api/v1/audit/me", "/api/v1/businesses/{businessId}/members/{memberId}"]),
    );
  });
});

describe("log redaction", () => {
  it("removes secrets from log lines", () => {
    const lines: string[] = [];
    const log = pino(
      { redact: { paths: redactPaths, censor: "[REDACTED]" } },
      { write: (line: string) => void lines.push(line) },
    );
    log.info({
      password: "hunter2",
      token: "abc",
      body: { password: "hunter2", code: "123456", refreshToken: "r" },
      req: { headers: { authorization: "Bearer x", cookie: "refresh_token=y" } },
    });
    log.error({ err: { code: "P2028" } });
    const output = lines.join("");
    expect(output).toContain("P2028");
    for (const secret of ["hunter2", "123456", "Bearer x", "refresh_token=y"]) {
      expect(output).not.toContain(secret);
    }
  });
});

describe("secret encryption", () => {
  it("round-trips, and fails for another owner or altered data", () => {
    const stored = encryptSecret("JBSWY3DP", "user-a");
    expect(stored).not.toContain("JBSWY3DP");
    expect(decryptSecret(stored, "user-a")).toBe("JBSWY3DP");
    expect(() => decryptSecret(stored, "user-b")).toThrow();
    const parts = stored.split(":");
    parts[3] = Buffer.from("tampered").toString("base64");
    expect(() => decryptSecret(parts.join(":"), "user-a")).toThrow();
  });
});
