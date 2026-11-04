import { describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { addMember, API, api, bearer, createBusiness, registerUser, uniqueEmail, type Session } from "./helpers/api.js";

const invitationsUrl = (businessId: string) => `${API}/businesses/${businessId}/invitations`;
const accept = (session: Session, token: string) =>
  api().post(`${API}/invitations/accept`).set("Authorization", bearer(session)).send({ token });

const invite = (owner: Session, businessId: string, email: string, roleKey = "VIEWER") =>
  api().post(invitationsUrl(businessId)).set("Authorization", bearer(owner)).send({ email, roleKey });

const setup = async () => {
  const owner = await registerUser();
  const business = await createBusiness(owner);
  return { owner, business };
};

describe("invitations", () => {
  it("stores only a hash, expires in 7 days, and the token works once", async () => {
    const { owner, business } = await setup();
    const guest = await registerUser();
    const res = await invite(owner, business.id, guest.email);
    expect(res.status).toBe(201);

    const row = await prisma.invitation.findFirstOrThrow();
    expect(row.tokenHash).not.toBe(res.body.data.token);
    const days = (row.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7);

    const first = await accept(guest, res.body.data.token);
    expect(first.status).toBe(200);
    const member = await prisma.businessMember.findUniqueOrThrow({
      where: { id: first.body.data.memberId },
      include: { role: true },
    });
    expect(member.role.key).toBe("VIEWER");

    const second = await accept(guest, res.body.data.token);
    expect(second.status).toBe(404);
    expect(second.body.error.code).toBe("INVITATION_INVALID");
  });

  it("does not make the invited business the guest's default workspace", async () => {
    const { owner, business } = await setup();
    const guest = await registerUser();
    const res = await invite(owner, business.id, guest.email);
    await accept(guest, res.body.data.token);

    const workspaces = await prisma.userWorkspace.findMany({ where: { userId: guest.userId } });
    expect(workspaces).toHaveLength(2);
    expect(workspaces.find((item) => item.workspaceId === business.workspaceId)?.isDefault).toBe(false);
  });

  it("a stolen token is useless on an account with a different email", async () => {
    const { owner, business } = await setup();
    const res = await invite(owner, business.id, uniqueEmail());
    const thief = await registerUser();

    const stolen = await accept(thief, res.body.data.token);
    expect(stolen.status).toBe(403);
    expect(stolen.body.error.code).toBe("INVITATION_EMAIL_MISMATCH");
    expect(await prisma.businessMember.count({ where: { userId: thief.userId } })).toBe(0);
  });

  it("refuses expired, revoked and unknown tokens", async () => {
    const { owner, business } = await setup();
    const guest = await registerUser();

    const expired = await invite(owner, business.id, guest.email);
    await prisma.invitation.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await accept(guest, expired.body.data.token)).status).toBe(404);

    const revoked = await invite(owner, business.id, guest.email);
    const del = await api()
      .delete(`${invitationsUrl(business.id)}/${revoked.body.data.id}`)
      .set("Authorization", bearer(owner));
    expect(del.status).toBe(200);
    expect((await accept(guest, revoked.body.data.token)).status).toBe(404);

    expect((await accept(guest, "not-a-real-token")).status).toBe(404);
  });

  it("re-inviting replaces the older invitation", async () => {
    const { owner, business } = await setup();
    const guest = await registerUser();
    const first = await invite(owner, business.id, guest.email, "VIEWER");
    const second = await invite(owner, business.id, guest.email, "MANAGER");

    expect((await accept(guest, first.body.data.token)).status).toBe(404);
    expect((await accept(guest, second.body.data.token)).status).toBe(200);
  });

  it("cannot invite an existing member, or anyone as OWNER", async () => {
    const { owner, business } = await setup();
    const member = await addMember(owner, business.id, "VIEWER");

    const existing = await invite(owner, business.id, member.email);
    expect(existing.status).toBe(409);
    expect(existing.body.error.code).toBe("ALREADY_MEMBER");

    expect((await invite(owner, business.id, uniqueEmail(), "OWNER")).status).toBe(422);
  });

  it("a removed member can be invited back", async () => {
    const { owner, business } = await setup();
    const member = await addMember(owner, business.id, "ACCOUNTANT");
    await api()
      .delete(`${API}/businesses/${business.id}/members/${member.memberId}`)
      .set("Authorization", bearer(owner));

    const again = await invite(owner, business.id, member.email, "VIEWER");
    const res = await accept(member, again.body.data.token);
    expect(res.status).toBe(200);
    expect(res.body.data.memberId).toBe(member.memberId);
  });

  it("cannot be accepted or created while the business is inactive", async () => {
    const { owner, business } = await setup();
    const guest = await registerUser();
    const res = await invite(owner, business.id, guest.email);
    await api().post(`${API}/businesses/${business.id}/status`).set("Authorization", bearer(owner)).send({ status: "INACTIVE" });

    const accepted = await accept(guest, res.body.data.token);
    expect(accepted.status).toBe(409);
    expect(accepted.body.error.code).toBe("BUSINESS_NOT_ACTIVE");
    expect((await invite(owner, business.id, uniqueEmail())).status).toBe(409);
  });

  it("lists pending invitations without the token", async () => {
    const { owner, business } = await setup();
    await invite(owner, business.id, uniqueEmail(), "MANAGER");
    const res = await api().get(invitationsUrl(business.id)).set("Authorization", bearer(owner));
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].roleKey).toBe("MANAGER");
    expect(res.body.data[0].token).toBeUndefined();
    expect(res.body.data[0].tokenHash).toBeUndefined();
  });
});
