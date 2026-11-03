import { describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { API, api, bearer, registerUser } from "./helpers/api.js";

describe("users", () => {
  it("returns my profile without secrets", async () => {
    const session = await registerUser();
    const res = await api().get(`${API}/users/me`).set("Authorization", bearer(session));
    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe(session.email);
    expect(res.body.data.locale).toBe("en");
    expect(res.body.data.digitStyle).toBe("latin");
    expect(res.body.data.passwordHash).toBeUndefined();
    expect(res.body.data.tokenVersion).toBeUndefined();
  });

  it("updates language and digit style and audits before and after", async () => {
    const session = await registerUser();
    const res = await api()
      .patch(`${API}/users/me`)
      .set("Authorization", bearer(session))
      .send({ locale: "bn-BD", digitStyle: "bangla" });
    expect(res.status).toBe(200);
    expect(res.body.data.locale).toBe("bn-BD");

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "user.updated" } });
    expect(audit.before).toEqual({ locale: "en", digitStyle: "latin" });
    expect(audit.after).toEqual({ locale: "bn-BD", digitStyle: "bangla" });
    expect(audit.ip).toBeTruthy();
    expect(audit.requestId).toBeTruthy();
  });

  it("ignores fields a user must not set, and rejects an empty update", async () => {
    const session = await registerUser();
    const stripped = await api()
      .patch(`${API}/users/me`)
      .set("Authorization", bearer(session))
      .send({ status: "DISABLED", email: "x@example.com" });
    expect(stripped.status).toBe(422);
    expect(stripped.body.error.params.fields[0].code).toBe("NO_FIELDS_TO_UPDATE");
  });

  it("rejects an unsupported locale", async () => {
    const session = await registerUser();
    const res = await api().patch(`${API}/users/me`).set("Authorization", bearer(session)).send({ locale: "fr" });
    expect(res.status).toBe(422);
  });
});
