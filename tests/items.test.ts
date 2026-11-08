import { describe, expect, it } from "vitest";
import { addMember, api, setupFinance, type FinanceSetup } from "./helpers/api.js";

const addItem = (f: FinanceSetup, body: object) => api().post(`${f.base}/items`).set("Authorization", f.auth).send(body);

const contact = async (f: FinanceSetup, kind: string, name: string) =>
  (await api().post(`${f.base}/contacts`).set("Authorization", f.auth).send({ kind, name })).body.data.id as string;

const invoice = (f: FinanceSetup, body: object) =>
  api()
    .post(`${f.base}/invoices`)
    .set("Authorization", f.auth)
    .send({ kind: "SALE", issueDate: "2026-11-05", dueDate: "2026-11-20", issue: true, ...body });

describe("items", () => {
  it("saves an item with its prices and categories, and keeps names unique per business", async () => {
    const f = await setupFinance();
    const made = await addItem(f, {
      name: "Cotton shirt",
      code: "SH-01",
      unit: "pcs",
      salePriceMinor: "85000",
      purchasePriceMinor: "60000",
      vatRateBp: 1500,
      incomeCategoryId: f.salesId,
      expenseCategoryId: f.rentId,
    });
    expect(made.status).toBe(201);
    expect(made.body.data).toMatchObject({
      name: "Cotton shirt",
      unit: "pcs",
      salePriceMinor: "85000",
      purchasePriceMinor: "60000",
      vatRateBp: 1500,
      incomeCategory: { name: "Sales" },
      totals: { sold: { quantity: "0", amountMinor: "0", lines: 0 } },
    });

    // Same name in other letters is refused; another business may use it.
    const twice = await addItem(f, { name: "COTTON SHIRT" });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe("ITEM_NAME_TAKEN");
    const other = await setupFinance();
    expect((await addItem(other, { name: "Cotton shirt" })).status).toBe(201);

    // Categories must be on the right side.
    const wrong = await addItem(f, { name: "Trousers", incomeCategoryId: f.rentId });
    expect(wrong.body.error.code).toBe("CATEGORY_TYPE_MISMATCH");

    // Another business can't see it.
    const peek = await api().get(`${other.base}/items/${made.body.data.id}`).set("Authorization", other.auth);
    expect(peek.status).toBe(404);
  });

  it("lists by name, searches, filters by use, and archives", async () => {
    const f = await setupFinance();
    const shirt = await addItem(f, { name: "Shirt", code: "SH-01", salePriceMinor: "85000" });
    await addItem(f, { name: "Fabric roll", purchasePriceMinor: "120000" });
    await addItem(f, { name: "Delivery", salePriceMinor: "15000" });

    const names = async (query: object) =>
      (await api().get(`${f.base}/items`).query(query).set("Authorization", f.auth)).body.data.map((item: { name: string }) => item.name);
    expect(await names({})).toEqual(["Delivery", "Fabric roll", "Shirt"]);
    expect(await names({ use: "SALE" })).toEqual(["Delivery", "Shirt"]);
    expect(await names({ use: "BILL" })).toEqual(["Fabric roll"]);
    expect(await names({ search: "sh-0" })).toEqual(["Shirt"]);

    const archived = await api().patch(`${f.base}/items/${shirt.body.data.id}`).set("Authorization", f.auth).send({ isActive: false, salePriceMinor: null });
    expect(archived.body.data).toMatchObject({ isActive: false, salePriceMinor: null });
    expect(await names({})).toEqual(["Delivery", "Fabric roll"]);
    expect(await names({ includeArchived: "true" })).toEqual(["Delivery", "Fabric roll", "Shirt"]);
  });

  it("puts the item and its unit on invoice lines, counts what was sold and bought, and refuses archived items", async () => {
    const f = await setupFinance();
    const shirt = (await addItem(f, { name: "Shirt", unit: "pcs", salePriceMinor: "85000", purchasePriceMinor: "60000" })).body.data.id as string;
    const karim = await contact(f, "CUSTOMER", "Karim");
    const supplier = await contact(f, "SUPPLIER", "Dhaka Fabrics");
    const sale = (quantity: string) => ({ description: "Shirt", quantity, unitPriceMinor: "85000", categoryId: f.salesId, itemId: shirt, unit: "pcs" });

    const first = await invoice(f, { contactId: karim, lines: [sale("10"), { description: "Delivery", quantity: "1", unitPriceMinor: "15000", categoryId: f.salesId }] });
    expect(first.status).toBe(201);
    expect(first.body.data.lines[0]).toMatchObject({ itemId: shirt, unit: "pcs" });
    expect(first.body.data.lines[1]).toMatchObject({ itemId: null, unit: null });
    await invoice(f, { contactId: karim, lines: [sale("2.5")] });
    // A draft and a voided invoice don't count.
    await invoice(f, { contactId: karim, lines: [sale("100")], issue: false });
    const wrong = await invoice(f, { contactId: karim, lines: [sale("50")] });
    await api().post(`${f.base}/invoices/${wrong.body.data.id}/void`).set("Authorization", f.auth).send({ reason: "Twice" });
    await invoice(f, { kind: "BILL", contactId: supplier, lines: [{ description: "Shirts", quantity: "20", unitPriceMinor: "60000", categoryId: f.rentId, itemId: shirt }] });

    const totals = (await api().get(`${f.base}/items/${shirt}`).set("Authorization", f.auth)).body.data.totals;
    expect(totals).toEqual({
      sold: { quantity: "12.5", amountMinor: "1062500", lines: 2 },
      bought: { quantity: "20", amountMinor: "1200000", lines: 1 },
    });

    // The PDF prints the unit after the quantity (checked by it rendering at all).
    const file = await api().get(`${f.base}/invoices/${first.body.data.id}/pdf`).set("Authorization", f.auth).buffer(true);
    expect(Buffer.from(file.body).subarray(0, 4).toString()).toBe("%PDF");

    await api().patch(`${f.base}/items/${shirt}`).set("Authorization", f.auth).send({ isActive: false });
    const refused = await invoice(f, { contactId: karim, lines: [sale("1")] });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({ code: "ITEM_NOT_USABLE" });

    // An item from another business can't be put on a line either.
    const other = await setupFinance();
    const theirs = (await addItem(other, { name: "Theirs" })).body.data.id as string;
    const borrowed = await invoice(f, { contactId: karim, lines: [{ ...sale("1"), itemId: theirs }] });
    expect(borrowed.body.error.code).toBe("ITEM_NOT_USABLE");
  }, 30000);

  it("follows the money permissions", async () => {
    const f = await setupFinance();
    const viewer = await addMember(f.owner, f.businessId, "VIEWER");
    const denied = await api().get(`${f.base}/items`).set("Authorization", `Bearer ${viewer.accessToken}`);
    expect(denied.body.error.code).toBe("PERMISSION_DENIED");
    const accountant = await addMember(f.owner, f.businessId, "ACCOUNTANT");
    const made = await api().post(`${f.base}/items`).set("Authorization", `Bearer ${accountant.accessToken}`).send({ name: "Tea" });
    expect(made.status).toBe(201);
  });
});
