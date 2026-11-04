import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendEmail } from "../src/lib/mailer.js";
import { prisma } from "../src/lib/prisma.js";
import { API, api, bearer, PASSWORD, registerUser, toSession } from "./helpers/api.js";
import { notificationsFor, sendPendingDeliveries } from "./helpers/delivery.js";

vi.mock("../src/lib/mailer.js", () => ({ emailEnabled: () => true, sendEmail: vi.fn(async () => {}) }));

const mockedEmail = vi.mocked(sendEmail);
beforeEach(() => {
  mockedEmail.mockClear();
});

const A = `${API}/auth`;
const NEW_PASSWORD = "a-brand-new-password";

const forgot = (email: string) => api().post(`${A}/password/forgot`).send({ email });
const reset = (token: string, password = NEW_PASSWORD) => api().post(`${A}/password/reset`).send({ token, password });
const login = (email: string, password: string) => api().post(`${A}/login`).send({ email, password });

const emailedToken = async () => {
  await sendPendingDeliveries();
  const email = mockedEmail.mock.calls.at(-1)![0];
  return decodeURIComponent(/token=([^\s"&]+)/.exec(email.text)![1]!);
};

describe("forgot password", () => {
  it("answers the same with or without an account", async () => {
    const user = await registerUser();
    const known = await forgot(user.email);
    const unknown = await forgot("nobody@example.com");
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(known.body.data).toEqual(unknown.body.data);
    await sendPendingDeliveries();
    expect(mockedEmail).toHaveBeenCalledTimes(1);
    expect(mockedEmail.mock.calls[0]![0].to).toBe(user.email);
  });

  it("stores no readable token, and stays out of the in-app list", async () => {
    const user = await registerUser();
    await forgot(user.email);
    const token = await emailedToken();

    const stored = await prisma.passwordResetToken.findFirstOrThrow({ where: { userId: user.userId } });
    expect(stored.tokenHash).not.toBe(token);
    const [notification] = await notificationsFor(user.userId, "auth.password_reset");
    expect(JSON.stringify(notification!.params)).not.toContain(token);
    expect((await api().get(`${API}/notifications`).set("Authorization", bearer(user))).body.data.items).toHaveLength(0);
  });

  it("asking twice quickly sends one email", async () => {
    const user = await registerUser();
    await forgot(user.email);
    await forgot(user.email);
    await sendPendingDeliveries();
    expect(mockedEmail).toHaveBeenCalledTimes(1);
  });
});

describe("resetting", () => {
  it("changes the password, signs out everywhere, and emails a notice", async () => {
    const user = await registerUser();
    await forgot(user.email);
    const token = await emailedToken();

    const res = await reset(token);
    expect(res.status).toBe(200);
    expect((await login(user.email, PASSWORD)).status).toBe(401);
    expect((await login(user.email, NEW_PASSWORD)).status).toBe(200);
    expect((await api().get(`${API}/users/me`).set("Authorization", bearer(user))).status).toBe(401);

    await sendPendingDeliveries();
    expect(mockedEmail.mock.calls.at(-1)![0].subject).toContain("password was changed");
  });

  it("a link works only once", async () => {
    const user = await registerUser();
    await forgot(user.email);
    const token = await emailedToken();
    expect((await reset(token)).status).toBe(200);
    const again = await reset(token, "another-long-password");
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe("PASSWORD_RESET_INVALID");
  });

  it("two requests at once can't both use it", async () => {
    const user = await registerUser();
    await forgot(user.email);
    const token = await emailedToken();
    const results = await Promise.all([reset(token), reset(token, "another-long-password")]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
  });

  it("an expired link or made-up token is refused", async () => {
    const user = await registerUser();
    await forgot(user.email);
    const token = await emailedToken();
    await prisma.passwordResetToken.updateMany({ where: { userId: user.userId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await reset(token)).status).toBe(400);
    expect((await reset("made-up")).status).toBe(400);
  });

  it("asking again kills the earlier link", async () => {
    const user = await registerUser();
    await forgot(user.email);
    const first = await emailedToken();
    await prisma.passwordResetToken.updateMany({ where: { userId: user.userId }, data: { createdAt: new Date(Date.now() - 5 * 60 * 1000) } });
    await forgot(user.email);
    const second = await emailedToken();
    expect(second).not.toBe(first);
    expect((await reset(first)).status).toBe(400);
    expect((await reset(second)).status).toBe(200);
  });

  it("a short new password is refused, and doesn't use up the link", async () => {
    const user = await registerUser();
    await forgot(user.email);
    const token = await emailedToken();
    expect((await reset(token, "short")).status).toBe(422);
    expect((await reset(token)).status).toBe(200);
  });

  it("a disabled account can't be reset", async () => {
    const user = await registerUser();
    await forgot(user.email);
    const token = await emailedToken();
    await prisma.user.update({ where: { id: user.userId }, data: { status: "DISABLED" } });
    expect((await reset(token)).status).toBe(400);
  });

  it("the restricted role can't read reset tokens", async () => {
    const user = await registerUser();
    await forgot(user.email);
    const { withRls } = await import("../src/lib/rls.js");
    await expect(withRls({ userId: user.userId, businessIds: [] }, (tx) => tx.passwordResetToken.findMany())).rejects.toThrow();
  });
});

describe("security emails", () => {
  it("a lockout emails the owner once", async () => {
    const user = await registerUser();
    for (let attempt = 0; attempt < 6; attempt += 1) await login(user.email, "wrong-password-here");
    await sendPendingDeliveries();
    const subjects = mockedEmail.mock.calls.map(([email]) => email.subject);
    expect(subjects.filter((subject) => subject.includes("locked"))).toHaveLength(1);
  });

  it("guessing at an unknown email sends nothing", async () => {
    for (let attempt = 0; attempt < 6; attempt += 1) await login("nobody@example.com", "wrong-password-here");
    await sendPendingDeliveries();
    expect(mockedEmail).not.toHaveBeenCalled();
  });

  it("re-using a refresh token emails an alert", async () => {
    const email = "reuse@example.com";
    const registered = await api().post(`${A}/register`).send({ name: "Reuse", email, password: PASSWORD });
    const session = toSession(registered, email);
    const refresh = () => api().post(`${A}/refresh`).set("Cookie", [session.refreshCookie, session.csrfCookie]).set("X-CSRF-Token", session.csrfToken);
    expect((await refresh()).status).toBe(200);
    expect((await refresh()).status).toBe(401);
    await sendPendingDeliveries();
    expect(mockedEmail.mock.calls.at(-1)![0].subject).toContain("Suspicious");
  });

  it("changing your password emails a notice", async () => {
    const user = await registerUser();
    await api().post(`${A}/change-password`).set("Authorization", bearer(user)).send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    await sendPendingDeliveries();
    expect(mockedEmail.mock.calls.at(-1)![0].subject).toContain("password was changed");
  });
});
