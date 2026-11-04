import { describe, expect, it } from "vitest";
import { businessesService } from "../src/app/modules/businesses/businesses.service.js";
import { prisma } from "../src/lib/prisma.js";
import { addMember, API, api, bearer, createBusiness, registerUser, setupFinance } from "./helpers/api.js";

describe("new business setup", () => {
  it("creates a Cash account and bilingual categories in the same transaction", async () => {
    const owner = await registerUser();
    const business = await createBusiness(owner);

    const accounts = await prisma.financialAccount.findMany({ where: { businessId: business.id } });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ name: "Cash", type: "CASH", currency: "BDT", openingBalanceMinor: 0n });

    const categories = await prisma.category.findMany({ where: { businessId: business.id } });
    expect(categories.map((item) => item.name)).toEqual(expect.arrayContaining(["Sales", "Purchases", "Rent"]));
    expect(categories.every((item) => item.isSystem && item.nameBn)).toBe(true);
  });

  it("starts each business type with its own categories", async () => {
    const owner = await registerUser();
    const res = await api().post(`${API}/businesses`).set("Authorization", bearer(owner)).send({ name: "Studio", type: "AGENCY" });
    const categories = await prisma.category.findMany({ where: { businessId: res.body.data.id } });
    const names = categories.map((item) => item.name);
    expect(names).toContain("Service Income");
    expect(names).toContain("Contractors");
    expect(names).not.toContain("Purchases");
  });

  it("repairing an older business is safe to repeat", async () => {
    const owner = await registerUser();
    const created = await createBusiness(owner);
    const business = await prisma.business.findUniqueOrThrow({ where: { id: created.id } });
    await prisma.financialAccount.deleteMany({ where: { businessId: created.id } });
    await prisma.category.deleteMany({ where: { businessId: created.id } });

    await prisma.$transaction((tx) => businessesService.provision(tx, business));
    const accountCount = await prisma.financialAccount.count({ where: { businessId: created.id } });
    const categoryCount = await prisma.category.count({ where: { businessId: created.id } });
    expect(accountCount).toBe(1);
    expect(categoryCount).toBeGreaterThan(0);

    await prisma.$transaction((tx) => businessesService.provision(tx, business));
    expect(await prisma.financialAccount.count({ where: { businessId: created.id } })).toBe(accountCount);
    expect(await prisma.category.count({ where: { businessId: created.id } })).toBe(categoryCount);
  });
});

describe("financial accounts", () => {
  it("creates an account, returning money as a string and a plain date", async () => {
    const { base, auth } = await setupFinance();
    const res = await api().post(`${base}/accounts`).set("Authorization", auth).send({
      name: "bKash Wallet",
      type: "BKASH",
      openingBalanceMinor: "9007199254740993",
      openingDate: "2026-07-01",
      accountNumber: "017 1234 5678",
    });

    expect(res.status).toBe(201);
    // Above Number.MAX_SAFE_INTEGER: this only survives if it is never a JS number.
    expect(res.body.data.openingBalanceMinor).toBe("9007199254740993");
    expect(res.body.data.currentBalanceMinor).toBe("9007199254740993");
    expect(res.body.data.openingDate).toBe("2026-07-01");
    expect(res.body.data.currency).toBe("BDT");
  });

  it("never stores the full account number", async () => {
    const { base, auth } = await setupFinance();
    const res = await api().post(`${base}/accounts`).set("Authorization", auth).send({
      name: "DBBL",
      type: "BANK",
      accountNumber: "1234-5678-9012",
    });
    expect(res.body.data.maskedNumber).toBe("****9012");
    expect(res.body.data.accountNumber).toBeUndefined();

    const stored = JSON.stringify(
      await prisma.financialAccount.findUniqueOrThrow({ where: { id: res.body.data.id } }),
      (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    );
    expect(stored).not.toContain("5678");
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "account.created" } });
    expect(JSON.stringify(audit.after)).not.toContain("5678");
  });

  it("accepts Bangla digits for the amount and date", async () => {
    const { base, auth } = await setupFinance();
    const res = await api().post(`${base}/accounts`).set("Authorization", auth).send({
      name: "Nagad",
      type: "NAGAD",
      openingBalanceMinor: "১২৫০০০",
      openingDate: "২০২৬-০৭-০১",
    });
    expect(res.status).toBe(201);
    expect(res.body.data.openingBalanceMinor).toBe("125000");
    expect(res.body.data.openingDate).toBe("2026-07-01");
  });

  it("rejects floats, negatives, impossible dates and unknown currencies", async () => {
    const { base, auth } = await setupFinance();
    for (const body of [
      { openingBalanceMinor: "10.50" },
      { openingBalanceMinor: "-5" },
      { openingBalanceMinor: 100 },
      { openingDate: "2026-02-30" },
      { currency: "XXQ" },
    ]) {
      const res = await api().post(`${base}/accounts`).set("Authorization", auth).send({ name: "Bad", type: "BANK", ...body });
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
  });

  it("refuses a duplicate name, in any letter case", async () => {
    const { base, auth } = await setupFinance();
    const res = await api().post(`${base}/accounts`).set("Authorization", auth).send({ name: "CITY BANK", type: "BANK" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("NAME_TAKEN");
  });

  it("deactivated accounts leave the default list and can come back", async () => {
    const { base, auth, bankId } = await setupFinance();
    const off = await api().patch(`${base}/accounts/${bankId}`).set("Authorization", auth).send({ isActive: false });
    expect(off.status).toBe(200);

    const active = await api().get(`${base}/accounts`).set("Authorization", auth);
    expect(active.body.data.map((item: { id: string }) => item.id)).not.toContain(bankId);
    const all = await api().get(`${base}/accounts?includeInactive=true`).set("Authorization", auth);
    expect(all.body.data.map((item: { id: string }) => item.id)).toContain(bankId);

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "account.updated" } });
    expect(audit.before).toEqual({ isActive: true });
    expect(audit.after).toEqual({ isActive: false });
  });

  it("cannot edit the opening balance, or delete an account", async () => {
    const { base, auth, bankId } = await setupFinance();
    const res = await api().patch(`${base}/accounts/${bankId}`).set("Authorization", auth).send({ name: "Renamed", openingBalanceMinor: "999" });
    expect(res.body.data.openingBalanceMinor).toBe("0");
    expect((await api().delete(`${base}/accounts/${bankId}`).set("Authorization", auth)).status).toBe(404);
  });
});

describe("categories", () => {
  it("creates, filters and renames", async () => {
    const { base, auth } = await setupFinance();
    const created = await api().post(`${base}/categories`).set("Authorization", auth).send({ type: "EXPENSE", name: "Internet", nameBn: "ইন্টারনেট" });
    expect(created.status).toBe(201);
    expect(created.body.data.isSystem).toBe(false);

    const income = await api().get(`${base}/categories?type=INCOME`).set("Authorization", auth);
    expect(income.body.data.every((item: { type: string }) => item.type === "INCOME")).toBe(true);

    const renamed = await api().patch(`${base}/categories/${created.body.data.id}`).set("Authorization", auth).send({ name: "Broadband" });
    expect(renamed.body.data.name).toBe("Broadband");
  });

  it("lets the same name exist under income and expense, but not twice under one", async () => {
    const { base, auth } = await setupFinance();
    const other = await api().post(`${base}/categories`).set("Authorization", auth).send({ type: "INCOME", name: "Rent" });
    expect(other.status).toBe(201);
    const dup = await api().post(`${base}/categories`).set("Authorization", auth).send({ type: "EXPENSE", name: "rent" });
    expect(dup.status).toBe(409);
  });
});

describe("finance permissions", () => {
  it.each([
    ["VIEWER", false, false],
    ["MANAGER", false, false],
    ["ACCOUNTANT", true, true],
    ["ADMIN", true, true],
  ])("%s: read %s, write %s", async (roleKey, canRead, canWrite) => {
    const { owner, businessId, base } = await setupFinance();
    const member = await addMember(owner, businessId, roleKey);
    const auth = bearer(member);

    for (const path of ["accounts", "categories", "transactions"]) {
      const read = await api().get(`${base}/${path}`).set("Authorization", auth);
      expect(read.status, path).toBe(canRead ? 200 : 403);
    }
    const write = await api().post(`${base}/accounts`).set("Authorization", auth).send({ name: `${roleKey} acct`, type: "CUSTOM" });
    expect(write.status).toBe(canWrite ? 201 : 403);
  });

  it("the optional finance.read lets a viewer read but not write", async () => {
    const { owner, businessId, base } = await setupFinance();
    const viewer = await addMember(owner, businessId, "VIEWER");
    await api()
      .patch(`${base}/members/${viewer.memberId}`)
      .set("Authorization", bearer(owner))
      .send({ extraPermissions: ["finance.read"] });

    expect((await api().get(`${base}/accounts`).set("Authorization", bearer(viewer))).status).toBe(200);
    const write = await api().post(`${base}/accounts`).set("Authorization", bearer(viewer)).send({ name: "No", type: "CUSTOM" });
    expect(write.status).toBe(403);
  });

  it("an inactive business is read-only here too", async () => {
    const { auth, base } = await setupFinance();
    await api().post(`${base}/status`).set("Authorization", auth).send({ status: "INACTIVE" });
    const res = await api().post(`${base}/accounts`).set("Authorization", auth).send({ name: "No", type: "CUSTOM" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("BUSINESS_NOT_ACTIVE");
    expect((await api().get(`${base}/accounts`).set("Authorization", auth)).status).toBe(200);
  });
});
