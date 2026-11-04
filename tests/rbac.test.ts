import { describe, expect, it } from "vitest";
import { Permission, RoleKey } from "../src/app/constants/permissions.js";
import { prisma } from "../src/lib/prisma.js";
import { addMember, API, api, bearer, createBusiness, registerUser, uniqueEmail } from "./helpers/api.js";

const ALL = Object.values(Permission);
const WORK = ["tasks.read", "tasks.write", "documents.read", "documents.write", "ai.use"];

// The role table from the architecture document, section 11.3.
const EXPECTED: Record<RoleKey, string[]> = {
  OWNER: ALL,
  ADMIN: ALL,
  ACCOUNTANT: ["finance.read", "finance.write", "ledger.post", "ledger.reverse", "period.close", ...WORK],
  MANAGER: WORK,
  VIEWER: ["tasks.read", "documents.read", "ai.use"],
};

describe("seeded roles", () => {
  it("match the permission constants", async () => {
    const rows = await prisma.permission.findMany();
    expect(rows.map((row) => row.key).sort()).toEqual([...ALL].sort());
  });

  it.each(Object.keys(EXPECTED) as RoleKey[])("%s has exactly its documented permissions", async (key) => {
    const role = await prisma.role.findFirstOrThrow({
      where: { key, workspaceId: null },
      include: { permissions: true },
    });
    expect(role.permissions.map((item) => item.permissionKey).sort()).toEqual([...EXPECTED[key]].sort());
  });

  it("are served by GET /roles", async () => {
    const user = await registerUser();
    const res = await api().get(`${API}/roles`).set("Authorization", bearer(user));
    expect(res.body.data.map((role: { key: string }) => role.key)).toEqual(Object.values(RoleKey));
    expect(res.body.data[4].optionalPermissions).toEqual(["finance.read"]);
  });
});

describe("route permissions by role", () => {
  const roles = ["ADMIN", "ACCOUNTANT", "MANAGER", "VIEWER"] as const;

  it.each(roles)("%s: business.manage, members.manage and audit.read follow the table", async (roleKey) => {
    const owner = await registerUser();
    const business = await createBusiness(owner);
    const member = await addMember(owner, business.id, roleKey);
    const auth = bearer(member);
    const allowed = roleKey === "ADMIN";

    const update = await api().patch(`${API}/businesses/${business.id}`).set("Authorization", auth).send({ name: "Changed" });
    const invite = await api()
      .post(`${API}/businesses/${business.id}/invitations`)
      .set("Authorization", auth)
      .send({ email: uniqueEmail(), roleKey: "VIEWER" });
    const audit = await api().get(`${API}/businesses/${business.id}/audit`).set("Authorization", auth);

    expect(update.status).toBe(allowed ? 200 : 403);
    expect(invite.status).toBe(allowed ? 201 : 403);
    expect(audit.status).toBe(allowed ? 200 : 403);
    if (!allowed) expect(update.body.error.code).toBe("PERMISSION_DENIED");

    // Every member may read the business and its member list.
    expect((await api().get(`${API}/businesses/${business.id}`).set("Authorization", auth)).status).toBe(200);
    expect((await api().get(`${API}/businesses/${business.id}/members`).set("Authorization", auth)).status).toBe(200);
  });

  it("audits a denied permission", async () => {
    const owner = await registerUser();
    const business = await createBusiness(owner);
    const viewer = await addMember(owner, business.id, "VIEWER");
    await api().patch(`${API}/businesses/${business.id}`).set("Authorization", bearer(viewer)).send({ name: "Nope" });

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "permission.denied" } });
    expect(audit.actorUserId).toBe(viewer.userId);
    expect(audit.businessId).toBe(business.id);
    expect(audit.after).toMatchObject({ permission: "business.manage" });
  });
});
