import { describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import {
  addMember,
  API,
  api,
  bearer,
  createBusiness,
  enableMfa,
  registerUser,
  totpCode,
  type Session,
} from "./helpers/api.js";

const membersUrl = (businessId: string, memberId = "") =>
  `${API}/businesses/${businessId}/members${memberId ? `/${memberId}` : ""}`;

const setup = async () => {
  const owner = await registerUser();
  const business = await createBusiness(owner);
  return { owner, business };
};

const ownerMemberId = async (businessId: string, session: Session) =>
  (
    await prisma.businessMember.findFirstOrThrow({ where: { businessId, userId: session.userId } })
  ).id;

describe("members", () => {
  it("lists members with their name, email and role", async () => {
    const { owner, business } = await setup();
    const viewer = await addMember(owner, business.id, "VIEWER");

    const res = await api().get(membersUrl(business.id)).set("Authorization", bearer(viewer));
    expect(res.status).toBe(200);
    expect(res.body.data.map((item: { roleKey: string }) => item.roleKey)).toEqual(["OWNER", "VIEWER"]);
    expect(res.body.data[1].email).toBe(viewer.email);
    expect(res.body.data[1].passwordHash).toBeUndefined();
  });

  it("applies a role change on the very next request, despite the cache", async () => {
    const { owner, business } = await setup();
    const member = await addMember(owner, business.id, "VIEWER");
    const read = () => api().get(`${API}/businesses/${business.id}`).set("Authorization", bearer(member));

    expect((await read()).body.data.membership.roleKey).toBe("VIEWER");

    const res = await api()
      .patch(membersUrl(business.id, member.memberId))
      .set("Authorization", bearer(owner))
      .send({ roleKey: "ACCOUNTANT" });
    expect(res.status).toBe(200);
    expect((await read()).body.data.membership.roleKey).toBe("ACCOUNTANT");

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "member.updated" } });
    expect(audit.before).toMatchObject({ roleKey: "VIEWER" });
    expect(audit.after).toMatchObject({ roleKey: "ACCOUNTANT" });
  });

  it("removing a member ends their access at once", async () => {
    const { owner, business } = await setup();
    const member = await addMember(owner, business.id, "ACCOUNTANT");
    const read = () => api().get(`${API}/businesses/${business.id}`).set("Authorization", bearer(member));
    expect((await read()).status).toBe(200);

    const res = await api().delete(membersUrl(business.id, member.memberId)).set("Authorization", bearer(owner));
    expect(res.status).toBe(200);
    expect((await read()).status).toBe(404);

    const row = await prisma.businessMember.findUniqueOrThrow({ where: { id: member.memberId } });
    expect(row.status).toBe("REMOVED");
  });

  it("grants finance.read as an optional extra, only to roles that allow it", async () => {
    const { owner, business } = await setup();
    const viewer = await addMember(owner, business.id, "VIEWER");

    const granted = await api()
      .patch(membersUrl(business.id, viewer.memberId))
      .set("Authorization", bearer(owner))
      .send({ extraPermissions: ["finance.read"] });
    expect(granted.status).toBe(200);
    const read = await api().get(`${API}/businesses/${business.id}`).set("Authorization", bearer(viewer));
    expect(read.body.data.membership.permissions).toContain("finance.read");

    const refused = await api()
      .patch(membersUrl(business.id, viewer.memberId))
      .set("Authorization", bearer(owner))
      .send({ extraPermissions: ["ledger.post"] });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe("PERMISSION_NOT_GRANTABLE");
  });
});

describe("owner protections", () => {
  it("cannot demote or remove the last owner", async () => {
    const { owner, business } = await setup();
    const id = await ownerMemberId(business.id, owner);

    const demote = await api()
      .patch(membersUrl(business.id, id))
      .set("Authorization", bearer(owner))
      .send({ roleKey: "ADMIN" });
    expect(demote.status).toBe(409);
    expect(demote.body.error.code).toBe("LAST_OWNER");

    const remove = await api().delete(membersUrl(business.id, id)).set("Authorization", bearer(owner));
    expect(remove.status).toBe(409);
  });

  it("two owners demoting each other at once still leaves one owner", async () => {
    const { owner, business } = await setup();
    const second = await addMember(owner, business.id, "ADMIN");
    await api()
      .patch(membersUrl(business.id, second.memberId))
      .set("Authorization", bearer(owner))
      .send({ roleKey: "OWNER" });
    const ownerId = await ownerMemberId(business.id, owner);

    const results = await Promise.all([
      api().patch(membersUrl(business.id, ownerId)).set("Authorization", bearer(second)).send({ roleKey: "VIEWER" }),
      api().patch(membersUrl(business.id, second.memberId)).set("Authorization", bearer(owner)).send({ roleKey: "VIEWER" }),
    ]);

    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    const owners = await prisma.businessMember.count({
      where: { businessId: business.id, status: "ACTIVE", role: { key: "OWNER" } },
    });
    expect(owners).toBe(1);
  });

  it("an admin cannot touch an owner or create one", async () => {
    const { owner, business } = await setup();
    const admin = await addMember(owner, business.id, "ADMIN");
    const viewer = await addMember(owner, business.id, "VIEWER");
    const ownerId = await ownerMemberId(business.id, owner);

    const demote = await api().patch(membersUrl(business.id, ownerId)).set("Authorization", bearer(admin)).send({ roleKey: "VIEWER" });
    expect(demote.status).toBe(403);
    expect(demote.body.error.code).toBe("ROLE_NOT_ASSIGNABLE");

    const remove = await api().delete(membersUrl(business.id, ownerId)).set("Authorization", bearer(admin));
    expect(remove.status).toBe(403);

    const promote = await api().patch(membersUrl(business.id, viewer.memberId)).set("Authorization", bearer(admin)).send({ roleKey: "OWNER" });
    expect(promote.status).toBe(403);

    const allowed = await api().patch(membersUrl(business.id, viewer.memberId)).set("Authorization", bearer(admin)).send({ roleKey: "MANAGER" });
    expect(allowed.status).toBe(200);
  });

  it("a role change needs recent MFA when the actor has MFA on", async () => {
    const { owner, business } = await setup();
    const member = await addMember(owner, business.id, "VIEWER");
    const secret = await enableMfa(owner);

    const blocked = await api()
      .patch(membersUrl(business.id, member.memberId))
      .set("Authorization", bearer(owner))
      .send({ roleKey: "MANAGER" });
    expect(blocked.status).toBe(401);
    expect(blocked.body.error.code).toBe("MFA_REQUIRED");

    const stepUp = await api()
      .post(`${API}/auth/mfa/step-up`)
      .set("Authorization", bearer(owner))
      .send({ code: await totpCode(secret, 30) });
    const allowed = await api()
      .patch(membersUrl(business.id, member.memberId))
      .set("Authorization", `Bearer ${stepUp.body.data.accessToken}`)
      .send({ roleKey: "MANAGER" });
    expect(allowed.status).toBe(200);
  });
});
