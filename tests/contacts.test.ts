import { describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { addMember, api, setupFinance, type FinanceSetup } from "./helpers/api.js";

const contacts = (f: FinanceSetup) => `${f.base}/contacts`;
const addContact = (f: FinanceSetup, body: object) => api().post(contacts(f)).set("Authorization", f.auth).send(body);
const record = (f: FinanceSetup, body: object) =>
  api()
    .post(`${f.base}/transactions`)
    .set("Authorization", f.auth)
    .send({ accountId: f.cashId, txnDate: "2026-11-01", postNow: true, ...body });

describe("contacts", () => {
  it("adds, lists by kind and search, changes and archives a contact, and audits it", async () => {
    const f = await setupFinance();
    const karim = await addContact(f, { kind: "CUSTOMER", name: "Karim Fashion", phone: "01711000000", taxId: "000123456-0101" });
    expect(karim.status).toBe(201);
    expect(karim.body.data).toMatchObject({ kind: "CUSTOMER", name: "Karim Fashion", isActive: true, totals: [] });
    await addContact(f, { kind: "SUPPLIER", name: "Dhaka Fabrics", email: "Sales@DhakaFabrics.test" });
    await addContact(f, { kind: "BOTH", name: "Bismillah Store" });

    const customers = await api().get(contacts(f)).query({ kind: "CUSTOMER" }).set("Authorization", f.auth);
    expect(customers.body.data.map((row: { name: string }) => row.name)).toEqual(["Bismillah Store", "Karim Fashion"]);
    const byPhone = await api().get(contacts(f)).query({ search: "01711" }).set("Authorization", f.auth);
    expect(byPhone.body.data.map((row: { name: string }) => row.name)).toEqual(["Karim Fashion"]);
    const byEmail = await api().get(contacts(f)).query({ search: "dhakafabrics" }).set("Authorization", f.auth);
    expect(byEmail.body.data[0].email).toBe("sales@dhakafabrics.test");

    const id = karim.body.data.id as string;
    const changed = await api().patch(`${contacts(f)}/${id}`).set("Authorization", f.auth).send({ phone: "01811000000", company: null });
    expect(changed.body.data.phone).toBe("01811000000");
    const archived = await api().patch(`${contacts(f)}/${id}`).set("Authorization", f.auth).send({ isActive: false });
    expect(archived.body.data.isActive).toBe(false);
    const active = await api().get(contacts(f)).set("Authorization", f.auth);
    expect(active.body.data).toHaveLength(2);
    const all = await api().get(contacts(f)).query({ includeArchived: "true" }).set("Authorization", f.auth);
    expect(all.body.data).toHaveLength(3);

    const actions = (await prisma.auditLog.findMany({ where: { entityType: "contact" }, orderBy: { id: "asc" } })).map((row) => row.action);
    expect(actions).toEqual(["contact.created", "contact.created", "contact.created", "contact.updated", "contact.archived"]);
  });

  it("refuses a bad email and an empty change", async () => {
    const f = await setupFinance();
    expect((await addContact(f, { kind: "CUSTOMER", name: "X", email: "not-an-email" })).status).toBe(422);
    const made = await addContact(f, { kind: "CUSTOMER", name: "Karim" });
    expect((await api().patch(`${contacts(f)}/${made.body.data.id}`).set("Authorization", f.auth).send({})).status).toBe(422);
  });

  it("totals what was received from and paid to a contact, and filters transactions by it", async () => {
    const f = await setupFinance();
    const karim = (await addContact(f, { kind: "BOTH", name: "Karim" })).body.data.id as string;
    await record(f, { type: "INCOME", categoryId: f.salesId, amountMinor: "500000", contactId: karim });
    await record(f, { type: "INCOME", categoryId: f.salesId, amountMinor: "250000", contactId: karim, txnDate: "2026-11-05" });
    await record(f, { type: "EXPENSE", categoryId: f.rentId, amountMinor: "100000", contactId: karim });
    // A refund given back counts as paid out; a draft and another contact's money don't count.
    await record(f, { type: "REFUND", categoryId: f.salesId, amountMinor: "50000", contactId: karim });
    await record(f, { type: "INCOME", categoryId: f.salesId, amountMinor: "999", contactId: karim, postNow: false });
    await record(f, { type: "INCOME", categoryId: f.salesId, amountMinor: "777" });

    const one = await api().get(`${contacts(f)}/${karim}`).set("Authorization", f.auth);
    expect(one.body.data.totals).toEqual([{ currency: "BDT", receivedMinor: "750000", paidMinor: "150000", transactions: 4, lastDate: "2026-11-05" }]);
    const list = await api().get(contacts(f)).set("Authorization", f.auth);
    expect(list.body.data[0].totals[0].receivedMinor).toBe("750000");

    const theirs = await api().get(`${f.base}/transactions`).query({ contactId: karim, limit: 50 }).set("Authorization", f.auth);
    expect(theirs.body.data).toHaveLength(5);
  });

  it("tags a posted transaction later, and refuses an archived or another business's contact", async () => {
    const f = await setupFinance();
    const other = await setupFinance();
    const karim = (await addContact(f, { kind: "CUSTOMER", name: "Karim" })).body.data.id as string;
    const old = (await addContact(f, { kind: "CUSTOMER", name: "Old shop" })).body.data.id as string;
    await api().patch(`${contacts(f)}/${old}`).set("Authorization", f.auth).send({ isActive: false });
    const foreign = (await addContact(other, { kind: "CUSTOMER", name: "Theirs" })).body.data.id as string;

    const posted = await record(f, { type: "INCOME", categoryId: f.salesId, amountMinor: "100000" });
    expect(posted.body.data.status).toBe("POSTED");
    const tag = (contactId: string | null) =>
      api().post(`${f.base}/transactions/${posted.body.data.id}/contact`).set("Authorization", f.auth).send({ contactId });
    const tagged = await tag(karim);
    expect(tagged.status).toBe(200);
    expect(tagged.body.data.contactId).toBe(karim);
    expect((await tag(old)).body.error.code).toBe("CONTACT_NOT_USABLE");
    expect((await tag(foreign)).body.error.code).toBe("CONTACT_NOT_USABLE");
    expect((await record(f, { type: "INCOME", categoryId: f.salesId, amountMinor: "1", contactId: foreign })).body.error.code).toBe("CONTACT_NOT_USABLE");
    expect((await tag(null)).body.data.contactId).toBeNull();

    // An archived contact stays on the transactions it already has.
    await tag(karim);
    await api().patch(`${contacts(f)}/${karim}`).set("Authorization", f.auth).send({ isActive: false });
    const after = await api().get(`${f.base}/transactions/${posted.body.data.id}`).set("Authorization", f.auth);
    expect(after.body.data.contactId).toBe(karim);
  });

  it("follows the money permissions: a viewer without finance.read can't see contacts", async () => {
    const f = await setupFinance();
    await addContact(f, { kind: "CUSTOMER", name: "Karim" });
    const viewer = await addMember(f.owner, f.businessId, "VIEWER");
    const auth = `Bearer ${viewer.accessToken}`;
    const read = await api().get(contacts(f)).set("Authorization", auth);
    expect(read.body.error).toMatchObject({ code: "PERMISSION_DENIED", params: { permission: "finance.read" } });
    const write = await api().post(contacts(f)).set("Authorization", auth).send({ kind: "CUSTOMER", name: "Y" });
    expect(write.status).toBe(403);
  });
});
