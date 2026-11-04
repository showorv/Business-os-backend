import { describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { addMember, API, api, bearer, createBusiness, registerUser } from "./helpers/api.js";

const url = (id = "") => `${API}/businesses${id ? `/${id}` : ""}`;

describe("create business", () => {
  it("creates the business, owner membership and audit row together, with defaults", async () => {
    const owner = await registerUser();
    const res = await api().post(url()).set("Authorization", bearer(owner)).send({ name: "Acme", type: "RETAIL" });

    expect(res.status).toBe(201);
    expect(res.body.data.baseCurrency).toBe("BDT");
    expect(res.body.data.timezone).toBe("Asia/Dhaka");
    expect(res.body.data.fiscalYearStartMonth).toBe(7);
    expect(res.body.data.settings.version).toBe(1);
    expect(res.body.data.status).toBe("ACTIVE");

    const member = await prisma.businessMember.findFirstOrThrow({ include: { role: true } });
    expect(member.userId).toBe(owner.userId);
    expect(member.role.key).toBe("OWNER");
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "business.created" } });
    expect(audit.businessId).toBe(res.body.data.id);
  });

  it("rejects bad currency, timezone, month and settings with coded errors", async () => {
    const owner = await registerUser();
    const res = await api().post(url()).set("Authorization", bearer(owner)).send({
      name: "Acme",
      type: "RETAIL",
      baseCurrency: "XXQ",
      timezone: "Mars/Olympus",
      fiscalYearStartMonth: 13,
      settings: { weekStart: "friday" },
    });
    expect(res.status).toBe(422);
    const fields = res.body.error.params.fields as { field: string; code: string }[];
    expect(fields.find((item) => item.field === "body.baseCurrency")?.code).toBe("UNSUPPORTED_CURRENCY");
    expect(fields.find((item) => item.field === "body.timezone")?.code).toBe("UNSUPPORTED_TIMEZONE");
    expect(fields.map((item) => item.field)).toEqual(
      expect.arrayContaining(["body.fiscalYearStartMonth", "body.settings.weekStart"]),
    );
  });

  it("needs a login", async () => {
    const res = await api().post(url()).send({ name: "Acme", type: "RETAIL" });
    expect(res.status).toBe(401);
  });
});

describe("list and read", () => {
  it("lists only my businesses, with my role", async () => {
    const alice = await registerUser();
    const bob = await registerUser();
    const mine = await createBusiness(alice, "Alice Shop");
    await createBusiness(bob, "Bob Shop");

    const res = await api().get(url()).set("Authorization", bearer(alice));
    expect(res.body.data.map((item: { id: string }) => item.id)).toEqual([mine.id]);
    expect(res.body.data[0].roleKey).toBe("OWNER");
  });

  it("returns my role and permissions with a business", async () => {
    const owner = await registerUser();
    const business = await createBusiness(owner);
    const viewer = await addMember(owner, business.id, "VIEWER");

    const res = await api().get(url(business.id)).set("Authorization", bearer(viewer));
    expect(res.status).toBe(200);
    expect(res.body.data.membership.roleKey).toBe("VIEWER");
    expect(res.body.data.membership.permissions.sort()).toEqual(["ai.use", "documents.read", "tasks.read"]);
  });
});

describe("update", () => {
  it("merges settings and audits before and after", async () => {
    const owner = await registerUser();
    const business = await createBusiness(owner);
    const res = await api()
      .patch(url(business.id))
      .set("Authorization", bearer(owner))
      .send({ name: "New Name", settings: { locale: "bn-BD", approvalThresholdMinor: "৫০০০০" } });

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe("New Name");
    expect(res.body.data.settings.locale).toBe("bn-BD");
    expect(res.body.data.settings.approvalThresholdMinor).toBe("50000");
    expect(res.body.data.settings.transactionPrefix).toBe("TXN");

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "business.updated" } });
    expect(audit.before).toMatchObject({ name: "Acme Traders" });
    expect(audit.after).toMatchObject({ name: "New Name" });
  });

  it("ignores a type change, since type only picks the starting templates", async () => {
    const owner = await registerUser();
    const business = await createBusiness(owner);
    const res = await api().patch(url(business.id)).set("Authorization", bearer(owner)).send({ type: "AGENCY", name: "X" });
    expect(res.body.data.type).toBe("RETAIL");
  });
});

describe("lifecycle", () => {
  const setStatus = (token: string, id: string, status: string) =>
    api().post(`${url(id)}/status`).set("Authorization", token).send({ status });

  it("inactive is read-only and can be reactivated", async () => {
    const owner = await registerUser();
    const auth = bearer(owner);
    const business = await createBusiness(owner);

    expect((await setStatus(auth, business.id, "INACTIVE")).status).toBe(200);
    expect((await api().get(url(business.id)).set("Authorization", auth)).status).toBe(200);

    const blocked = await api().patch(url(business.id)).set("Authorization", auth).send({ name: "Nope" });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("BUSINESS_NOT_ACTIVE");

    expect((await setStatus(auth, business.id, "ACTIVE")).status).toBe(200);
    expect((await api().patch(url(business.id)).set("Authorization", auth).send({ name: "Yes" })).status).toBe(200);
  });

  it("archived is hidden from the switcher but stays readable", async () => {
    const owner = await registerUser();
    const auth = bearer(owner);
    const business = await createBusiness(owner);
    await setStatus(auth, business.id, "ARCHIVED");

    expect((await api().get(url()).set("Authorization", auth)).body.data).toHaveLength(0);
    expect((await api().get(`${url()}?includeArchived=true`).set("Authorization", auth)).body.data).toHaveLength(1);
    expect((await api().get(url(business.id)).set("Authorization", auth)).status).toBe(200);
  });

  it("refuses transitions that are not allowed", async () => {
    const owner = await registerUser();
    const auth = bearer(owner);
    const business = await createBusiness(owner);
    await setStatus(auth, business.id, "ARCHIVED");

    const res = await setStatus(auth, business.id, "INACTIVE");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INVALID_STATUS_CHANGE");
    expect(res.body.error.params).toEqual({ from: "ARCHIVED", to: "INACTIVE" });
  });

  it("has no way to hard-delete a business", async () => {
    const owner = await registerUser();
    const business = await createBusiness(owner);
    const res = await api().delete(url(business.id)).set("Authorization", bearer(owner));
    expect(res.status).toBe(404);
    expect(await prisma.business.count()).toBe(1);
  });
});
