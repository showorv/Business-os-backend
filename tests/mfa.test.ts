import jwt from "jsonwebtoken";
import { describe, expect, it, vi } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { env } from "../src/app/config/env.config.js";
import { normalizeDigits } from "../src/app/utils/normalize.js";
import { API, api, bearer, enableMfa, PASSWORD, registerUser, toSession, totpCode } from "./helpers/api.js";
import { auditActions } from "./helpers/db.js";

const login = (email: string) => api().post(`${API}/auth/login`).send({ email, password: PASSWORD });
const toBangla = (digits: string) => digits.replace(/\d/g, (digit) => String.fromCharCode(0x09e6 + Number(digit)));

describe("MFA setup", () => {
  it("encrypts the secret at rest and returns an otpauth URI", async () => {
    const session = await registerUser();
    const res = await api()
      .post(`${API}/auth/mfa/setup`)
      .set("Authorization", bearer(session))
      .send({ password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.otpauthUri).toContain("otpauth://totp/");

    const factor = await prisma.mfaFactor.findFirstOrThrow();
    expect(factor.encryptedSecret).not.toContain(res.body.data.secret);
    expect(factor.encryptedSecret.startsWith("v1:")).toBe(true);
  });

  it("is not enabled until a code confirms it", async () => {
    const session = await registerUser();
    await api().post(`${API}/auth/mfa/setup`).set("Authorization", bearer(session)).send({ password: PASSWORD });
    expect((await login(session.email)).body.data.mfaRequired).toBe(false);
  });

  it("needs the password, so a stolen access token cannot enrol its own device", async () => {
    const session = await registerUser();
    const res = await api()
      .post(`${API}/auth/mfa/setup`)
      .set("Authorization", bearer(session))
      .send({ password: "wrong-password-here" });
    expect(res.status).toBe(401);
    expect(await prisma.mfaFactor.count()).toBe(0);
  });

  it("rejects a wrong confirmation code", async () => {
    const session = await registerUser();
    await api().post(`${API}/auth/mfa/setup`).set("Authorization", bearer(session)).send({ password: PASSWORD });
    const res = await api().post(`${API}/auth/mfa/confirm`).set("Authorization", bearer(session)).send({ code: "000000" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("MFA_INVALID_CODE");
  });
});

describe("MFA login", () => {
  it("returns a challenge instead of tokens, then a code completes the login", async () => {
    const session = await registerUser();
    const secret = await enableMfa(session);

    const challenge = await login(session.email);
    expect(challenge.status).toBe(200);
    expect(challenge.body.data.mfaRequired).toBe(true);
    expect(challenge.body.data.accessToken).toBeUndefined();
    expect(challenge.get("Set-Cookie")).toBeUndefined();

    const res = await api()
      .post(`${API}/auth/mfa/verify`)
      .send({ challengeToken: challenge.body.data.challengeToken, code: await totpCode(secret, 30) });
    expect(res.status).toBe(200);

    const me = await api().get(`${API}/users/me`).set("Authorization", bearer(toSession(res, session.email)));
    expect(me.body.data.mfaEnabled).toBe(true);
    expect(await auditActions()).toEqual(expect.arrayContaining(["auth.mfa_enabled", "auth.login"]));
  });

  it("accepts a code typed with Bangla digits", async () => {
    const session = await registerUser();
    const secret = await enableMfa(session);
    const challenge = await login(session.email);
    const res = await api()
      .post(`${API}/auth/mfa/verify`)
      .send({ challengeToken: challenge.body.data.challengeToken, code: toBangla(await totpCode(secret, 30)) });
    expect(res.status).toBe(200);
  });

  it("refuses the same code twice", async () => {
    const session = await registerUser();
    const secret = await enableMfa(session);
    const code = await totpCode(secret, 30);

    const first = await login(session.email);
    const accepted = await api()
      .post(`${API}/auth/mfa/verify`)
      .send({ challengeToken: first.body.data.challengeToken, code });
    expect(accepted.status).toBe(200);

    const second = await login(session.email);
    const replay = await api()
      .post(`${API}/auth/mfa/verify`)
      .send({ challengeToken: second.body.data.challengeToken, code });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe("MFA_INVALID_CODE");
  });

  it("lets only one of two simultaneous requests use a code", async () => {
    const session = await registerUser();
    const secret = await enableMfa(session);
    const code = await totpCode(secret, 30);
    const { challengeToken } = (await login(session.email)).body.data;

    const results = await Promise.all([
      api().post(`${API}/auth/mfa/verify`).send({ challengeToken, code }),
      api().post(`${API}/auth/mfa/verify`).send({ challengeToken, code }),
    ]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 401]);
  });

  it("locks after 5 wrong codes", async () => {
    const session = await registerUser();
    const secret = await enableMfa(session);
    const { challengeToken } = (await login(session.email)).body.data;

    for (let i = 0; i < 5; i++) {
      const wrong = await api().post(`${API}/auth/mfa/verify`).send({ challengeToken, code: "000000" });
      expect(wrong.body.error.code).toBe("MFA_INVALID_CODE");
    }
    const res = await api()
      .post(`${API}/auth/mfa/verify`)
      .send({ challengeToken, code: await totpCode(secret, 30) });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("ACCOUNT_LOCKED");
  });

  it("does not accept a challenge token as an access token, or the reverse", async () => {
    const session = await registerUser();
    await enableMfa(session);
    const { challengeToken } = (await login(session.email)).body.data;

    const asAccess = await api().get(`${API}/users/me`).set("Authorization", `Bearer ${challengeToken}`);
    expect(asAccess.status).toBe(401);

    const asChallenge = await api()
      .post(`${API}/auth/mfa/verify`)
      .send({ challengeToken: session.accessToken, code: "123456" });
    expect(asChallenge.status).toBe(401);
    expect(asChallenge.body.error.code).toBe("MFA_CHALLENGE_INVALID");
  });

  it("rejects forged tokens: alg=none and the wrong secret", async () => {
    const session = await registerUser();
    const claims = jwt.decode(session.accessToken) as jwt.JwtPayload;

    const none = jwt.sign(claims, "", { algorithm: "none" });
    const forged = jwt.sign(claims, "some-other-secret-some-other-secret-012");
    for (const token of [none, forged]) {
      const res = await api().get(`${API}/users/me`).set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("TOKEN_INVALID");
    }
    expect(env.JWT_ACCESS_SECRET).not.toBe("some-other-secret-some-other-secret-012");
  });
});

describe("step-up for sensitive actions", () => {
  const changePassword = (session: { accessToken: string }) =>
    api()
      .post(`${API}/auth/change-password`)
      .set("Authorization", bearer(session))
      .send({ currentPassword: PASSWORD, newPassword: "a-brand-new-passphrase" });

  it("blocks a sensitive action until MFA is proven, then allows it", async () => {
    const session = await registerUser();
    const secret = await enableMfa(session);

    const blocked = await changePassword(session);
    expect(blocked.status).toBe(401);
    expect(blocked.body.error.code).toBe("MFA_REQUIRED");

    const stepUp = await api()
      .post(`${API}/auth/mfa/step-up`)
      .set("Authorization", bearer(session))
      .send({ code: await totpCode(secret, 30) });
    expect(stepUp.status).toBe(200);

    expect((await changePassword({ accessToken: stepUp.body.data.accessToken })).status).toBe(200);
  });

  it("expires 10 minutes after the MFA proof", async () => {
    const session = await registerUser();
    const secret = await enableMfa(session);
    const stepUp = await api()
      .post(`${API}/auth/mfa/step-up`)
      .set("Authorization", bearer(session))
      .send({ code: await totpCode(secret, 30) });

    vi.useFakeTimers({ now: Date.now() + 11 * 60 * 1000, toFake: ["Date"] });
    try {
      const res = await changePassword({ accessToken: stepUp.body.data.accessToken });
      expect(res.body.error.code).toBe("MFA_REQUIRED");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("disable MFA", () => {
  it("needs both password and code", async () => {
    const session = await registerUser();
    const secret = await enableMfa(session);
    const auth = bearer(session);

    const noCode = await api()
      .post(`${API}/auth/mfa/disable`)
      .set("Authorization", auth)
      .send({ password: PASSWORD, code: "000000" });
    expect(noCode.status).toBe(401);

    const ok = await api()
      .post(`${API}/auth/mfa/disable`)
      .set("Authorization", auth)
      .send({ password: PASSWORD, code: await totpCode(secret, 30) });
    expect(ok.status).toBe(200);
    expect((await login(session.email)).body.data.mfaRequired).toBe(false);
    expect(await prisma.mfaFactor.count()).toBe(0);
  });
});

describe("digit normalization", () => {
  it("maps every Bangla digit", () => {
    expect(normalizeDigits("০১২৩৪৫৬৭৮৯")).toBe("0123456789");
    expect(normalizeDigits("abc১২")).toBe("abc12");
  });
});
