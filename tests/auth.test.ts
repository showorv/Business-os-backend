import { describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { API, api, bearer, ORIGIN, PASSWORD, refreshRequest, registerUser, toSession, uniqueEmail } from "./helpers/api.js";
import { auditActions } from "./helpers/db.js";

const login = (email: string, password = PASSWORD) => api().post(`${API}/auth/login`).send({ email, password });

describe("register", () => {
  it("creates the user, workspace, session and audit row together", async () => {
    const email = uniqueEmail();
    const res = await api().post(`${API}/auth/register`).send({ name: "Showrov", email, password: PASSWORD });

    expect(res.status).toBe(201);
    expect(res.body.data.user.email).toBe(email);
    expect(res.body.data.expiresIn).toBe(900);
    expect(JSON.stringify(res.body)).not.toContain("passwordHash");
    expect(res.body.data.refreshToken).toBeUndefined();

    const user = await prisma.user.findUniqueOrThrow({ where: { email }, include: { workspaces: true } });
    expect(user.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(user.workspaces).toHaveLength(1);
    expect(await auditActions()).toEqual(["auth.registered"]);
  });

  it("sets the refresh cookie as httpOnly, SameSite=Strict and scoped to the auth path", async () => {
    const res = await api()
      .post(`${API}/auth/register`)
      .send({ name: "A", email: uniqueEmail(), password: PASSWORD });
    const cookie = res.get("Set-Cookie")!.find((value) => value.startsWith("refresh_token="))!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/api/v1/auth");
  });

  it("treats emails as case-insensitive", async () => {
    const email = uniqueEmail();
    await registerUser(email);
    const res = await api()
      .post(`${API}/auth/register`)
      .send({ name: "Dup", email: email.toUpperCase(), password: PASSWORD });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("EMAIL_TAKEN");
  });

  it("returns field codes, not sentences, on invalid input", async () => {
    const res = await api().post(`${API}/auth/register`).send({ name: "", email: "nope", password: "short" });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("VALIDATION_FAILED");
    const fields = res.body.error.params.fields.map((item: { field: string }) => item.field);
    expect(fields).toEqual(expect.arrayContaining(["body.name", "body.email", "body.password"]));
    expect(res.body.error.message).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/Invalid|Too small/);
  });

  it("refuses passwords longer than bcrypt can hash", async () => {
    const res = await api()
      .post(`${API}/auth/register`)
      .send({ name: "A", email: uniqueEmail(), password: "a".repeat(73) });
    expect(res.status).toBe(422);
    expect(res.body.error.params.fields[0].code).toBe("PASSWORD_TOO_LONG");
  });

  it("stores Bangla names in NFC form and accepts Bangla as a locale", async () => {
    const decomposed = "কো".normalize("NFD");
    const res = await api()
      .post(`${API}/auth/register`)
      .send({ name: decomposed, email: uniqueEmail(), password: PASSWORD, locale: "bn-BD" });
    expect(res.status).toBe(201);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: res.body.data.user.id } });
    expect(user.name).toBe("কো".normalize("NFC"));
    expect(user.locale).toBe("bn-BD");
  });

  it("strips unknown keys so a client cannot set privileged fields", async () => {
    const res = await api()
      .post(`${API}/auth/register`)
      .send({ name: "A", email: uniqueEmail(), password: PASSWORD, status: "DISABLED", mfaEnabled: true, tokenVersion: 9 });
    expect(res.status).toBe(201);
    expect(res.body.data.user.status).toBe("ACTIVE");
    expect(res.body.data.user.mfaEnabled).toBe(false);
  });
});

describe("login", () => {
  it("logs in with the right password", async () => {
    const { email } = await registerUser();
    const res = await login(email);
    expect(res.status).toBe(200);
    expect(res.body.data.mfaRequired).toBe(false);
    expect(res.body.data.accessToken).toBeTruthy();
    expect(await auditActions()).toEqual(["auth.registered", "auth.login"]);
  });

  it("gives the same error for a wrong password and an unknown email", async () => {
    const { email } = await registerUser();
    const wrong = await login(email, "wrong-password-here");
    const unknown = await login("nobody@example.com");
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.code).toBe("INVALID_CREDENTIALS");
    expect(unknown.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("audits a failed login even though the request fails", async () => {
    const { email } = await registerUser();
    await login(email, "wrong-password-here");
    expect(await auditActions()).toEqual(["auth.registered", "auth.login_failed"]);
  });

  it("locks the account after 5 wrong passwords, even for the right one", async () => {
    const { email } = await registerUser();
    for (let i = 0; i < 5; i++) await login(email, "wrong-password-here");

    const res = await login(email);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("ACCOUNT_LOCKED");
    expect(Number(res.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("rate limits by IP across different accounts", async () => {
    let last;
    for (let i = 0; i < 11; i++) last = await login(`victim${i}@example.com`);
    expect(last!.status).toBe(429);
    expect(last!.body.error.code).toBe("RATE_LIMITED");
  });

  it("refuses a disabled user", async () => {
    const { email, userId } = await registerUser();
    await prisma.user.update({ where: { id: userId }, data: { status: "DISABLED" } });
    const res = await login(email);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
  });
});

describe("access token", () => {
  it("is required", async () => {
    const res = await api().get(`${API}/users/me`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("stops working as soon as the user is disabled", async () => {
    const session = await registerUser();
    await prisma.user.update({ where: { id: session.userId }, data: { status: "DISABLED" } });
    const res = await api().get(`${API}/users/me`).set("Authorization", bearer(session));
    expect(res.status).toBe(401);
  });

  it("stops working when token_version changes", async () => {
    const session = await registerUser();
    await prisma.user.update({ where: { id: session.userId }, data: { tokenVersion: { increment: 1 } } });
    const res = await api().get(`${API}/users/me`).set("Authorization", bearer(session));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("TOKEN_INVALID");
  });
});

describe("refresh rotation", () => {
  it("issues a new token pair and marks the old one as replaced", async () => {
    const session = await registerUser();
    const res = await refreshRequest(session);
    expect(res.status).toBe(200);

    const next = toSession(res, session.email);
    expect(next.refreshCookie).not.toBe(session.refreshCookie);

    const me = await api().get(`${API}/users/me`).set("Authorization", bearer(next));
    expect(me.status).toBe(200);

    const tokens = await prisma.refreshToken.findMany({ orderBy: { createdAt: "asc" } });
    expect(tokens).toHaveLength(2);
    expect(tokens[0]!.replacedById).toBe(tokens[1]!.id);
    expect(tokens[0]!.familyId).toBe(tokens[1]!.familyId);
  });

  it("stores only a hash of the refresh token", async () => {
    const session = await registerUser();
    const raw = session.refreshCookie.split("=")[1]!;
    const stored = await prisma.refreshToken.findFirstOrThrow();
    expect(stored.tokenHash).not.toBe(raw);
    expect(stored.tokenHash).toHaveLength(64);
  });

  it("on reuse: revokes the whole family, bumps token_version and audits, and that sticks", async () => {
    const session = await registerUser();
    const rotated = toSession(await refreshRequest(session), session.email);

    const replay = await refreshRequest(session);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe("REFRESH_REUSED");

    // The revocation must have committed, even though the request itself returned an error.
    const stillValid = await prisma.refreshToken.count({ where: { revokedAt: null } });
    expect(stillValid).toBe(0);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: session.userId } });
    expect(user.tokenVersion).toBe(1);
    expect(await auditActions()).toContain("auth.refresh_reused");

    // The attacker's or victim's newest token no longer works either.
    expect((await refreshRequest(rotated)).status).toBe(401);
    const me = await api().get(`${API}/users/me`).set("Authorization", bearer(rotated));
    expect(me.status).toBe(401);
  });

  it("lets exactly one of two simultaneous refreshes win", async () => {
    const session = await registerUser();
    const results = await Promise.all([refreshRequest(session), refreshRequest(session)]);
    const statuses = results.map((res) => res.status).sort();
    expect(statuses).toEqual([200, 401]);
    const losers = results.filter((res) => res.status === 401);
    expect(losers[0]!.body.error.code).toBe("REFRESH_REUSED");
  });

  it("rejects an expired refresh token", async () => {
    const session = await registerUser();
    await prisma.refreshToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await refreshRequest(session);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("REFRESH_INVALID");
  });

  it("rejects a missing cookie", async () => {
    const session = await registerUser();
    const res = await api()
      .post(`${API}/auth/refresh`)
      .set("Cookie", [session.csrfCookie])
      .set("X-CSRF-Token", session.csrfToken);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("REFRESH_INVALID");
  });
});

describe("CSRF protection on cookie routes", () => {
  it("rejects a refresh with no CSRF header", async () => {
    const session = await registerUser();
    const res = await api().post(`${API}/auth/refresh`).set("Cookie", [session.refreshCookie, session.csrfCookie]);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("CSRF_FAILED");
  });

  it("rejects a CSRF header that does not match the cookie", async () => {
    const session = await registerUser();
    const res = await api()
      .post(`${API}/auth/refresh`)
      .set("Cookie", [session.refreshCookie, session.csrfCookie])
      .set("X-CSRF-Token", "forged-value");
    expect(res.status).toBe(403);
  });

  it("rejects a foreign Origin even with a matching token", async () => {
    const session = await registerUser();
    const res = await refreshRequest(session).set("Origin", "https://evil.example");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("CSRF_FAILED");
  });

  it("accepts an allowed Origin", async () => {
    const session = await registerUser();
    const res = await refreshRequest(session).set("Origin", ORIGIN);
    expect(res.status).toBe(200);
  });
});

describe("logout and sessions", () => {
  it("logout ends the session: access and refresh both stop working", async () => {
    const session = await registerUser();
    const res = await api()
      .post(`${API}/auth/logout`)
      .set("Cookie", [session.refreshCookie, session.csrfCookie])
      .set("X-CSRF-Token", session.csrfToken);
    expect(res.status).toBe(200);

    expect((await api().get(`${API}/users/me`).set("Authorization", bearer(session))).status).toBe(401);
    const again = await refreshRequest(session);
    expect(again.status).toBe(401);
    expect(again.body.error.code).toBe("REFRESH_INVALID");
  });

  it("lists sessions and marks the current one", async () => {
    const session = await registerUser();
    await login(session.email);
    const res = await api().get(`${API}/auth/sessions`).set("Authorization", bearer(session));
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.filter((item: { current: boolean }) => item.current)).toHaveLength(1);
  });

  it("revoking another device ends only that device", async () => {
    const first = await registerUser();
    const second = toSession(await login(first.email), first.email);
    const list = await api().get(`${API}/auth/sessions`).set("Authorization", bearer(first));
    const other = list.body.data.find((item: { current: boolean }) => !item.current);

    const res = await api().delete(`${API}/auth/sessions/${other.id}`).set("Authorization", bearer(first));
    expect(res.status).toBe(200);
    expect((await api().get(`${API}/users/me`).set("Authorization", bearer(second))).status).toBe(401);
    expect((await api().get(`${API}/users/me`).set("Authorization", bearer(first))).status).toBe(200);
  });

  it("cannot revoke another user's session (404 hides that it exists)", async () => {
    const alice = await registerUser();
    const bob = await registerUser();
    const bobSessions = await api().get(`${API}/auth/sessions`).set("Authorization", bearer(bob));
    const res = await api()
      .delete(`${API}/auth/sessions/${bobSessions.body.data[0].id}`)
      .set("Authorization", bearer(alice));
    expect(res.status).toBe(404);
    expect((await api().get(`${API}/users/me`).set("Authorization", bearer(bob))).status).toBe(200);
  });

  it("logout-all ends every session", async () => {
    const first = await registerUser();
    const second = toSession(await login(first.email), first.email);
    expect((await api().post(`${API}/auth/logout-all`).set("Authorization", bearer(first))).status).toBe(200);
    expect((await api().get(`${API}/users/me`).set("Authorization", bearer(first))).status).toBe(401);
    expect((await refreshRequest(second)).status).toBe(401);
  });
});

describe("change password", () => {
  it("swaps the password and ends all sessions", async () => {
    const session = await registerUser();
    const newPassword = "a-brand-new-passphrase";
    const res = await api()
      .post(`${API}/auth/change-password`)
      .set("Authorization", bearer(session))
      .send({ currentPassword: PASSWORD, newPassword });
    expect(res.status).toBe(200);

    expect((await api().get(`${API}/users/me`).set("Authorization", bearer(session))).status).toBe(401);
    expect((await login(session.email)).status).toBe(401);
    expect((await login(session.email, newPassword)).status).toBe(200);
  });

  it("needs the current password", async () => {
    const session = await registerUser();
    const res = await api()
      .post(`${API}/auth/change-password`)
      .set("Authorization", bearer(session))
      .send({ currentPassword: "not-my-password", newPassword: "a-brand-new-passphrase" });
    expect(res.status).toBe(401);
    expect((await login(session.email)).status).toBe(200);
  });
});
