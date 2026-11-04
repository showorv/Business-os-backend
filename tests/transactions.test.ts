import { describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { api, setupFinance, uploadDocument, type FinanceSetup } from "./helpers/api.js";

const post = (f: FinanceSetup, body: object) => api().post(`${f.base}/transactions`).set("Authorization", f.auth).send(body);

const expense = (f: FinanceSetup, extra: object = {}) => ({
  type: "EXPENSE",
  accountId: f.cashId,
  categoryId: f.rentId,
  amountMinor: "3000000",
  txnDate: "2026-11-01",
  ...extra,
});

describe("create", () => {
  it("creates a draft with a number, in the account's currency, and audits it", async () => {
    const f = await setupFinance();
    const res = await post(f, expense(f, { description: "নভেম্বরের ভাড়া" }));

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      status: "DRAFT",
      number: "TXN-2026-000001",
      currency: "BDT",
      amountMinor: "3000000",
      feeMinor: "0",
      txnDate: "2026-11-01",
      source: "MANUAL",
      possibleDuplicate: false,
    });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "transaction.created" } });
    expect(audit.entityId).toBe(res.body.data.id);
    expect(audit.after).toMatchObject({ amountMinor: "3000000" });
  });

  it("keeps large amounts exact", async () => {
    const f = await setupFinance();
    const res = await post(f, expense(f, { amountMinor: "999999999999999999" }));
    expect(res.status).toBe(201);
    expect(res.body.data.amountMinor).toBe("999999999999999999");
  });

  it("accepts Bangla digits", async () => {
    const f = await setupFinance();
    const res = await post(f, expense(f, { amountMinor: "৫০০০", txnDate: "২০২৬-১১-০১" }));
    expect(res.body.data.amountMinor).toBe("5000");
    expect(res.body.data.txnDate).toBe("2026-11-01");
  });

  it("gives every simultaneous request its own number", async () => {
    const f = await setupFinance();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) => post(f, expense(f, { amountMinor: String(1000 + index) }))),
    );
    expect(results.every((res) => res.status === 201)).toBe(true);
    const numbers = results.map((res) => res.body.data.number);
    expect(new Set(numbers).size).toBe(10);
    expect([...numbers].sort().at(-1)).toBe("TXN-2026-000010");
  });

  it("numbers each year separately and uses the business's prefix", async () => {
    const f = await setupFinance();
    await api().patch(f.base).set("Authorization", f.auth).send({ settings: { transactionPrefix: "ACME" } });
    const res = await post(f, expense(f, { txnDate: "2025-12-31" }));
    expect(res.body.data.number).toBe("ACME-2025-000001");
  });

  it("rejects zero and malformed amounts", async () => {
    const f = await setupFinance();
    for (const amountMinor of ["0", "-1", "10.5", "abc", 500]) {
      const res = await post(f, expense(f, { amountMinor }));
      expect(res.status, String(amountMinor)).toBe(422);
    }
  });
});

describe("business rules", () => {
  const code = async (f: FinanceSetup, body: object) => {
    const res = await post(f, body);
    expect(res.status).toBe(422);
    return res.body.error.code;
  };

  it("category must match the transaction type", async () => {
    const f = await setupFinance();
    expect(await code(f, expense(f, { categoryId: f.salesId }))).toBe("CATEGORY_TYPE_MISMATCH");
    expect(await code(f, { ...expense(f), type: "INCOME" })).toBe("CATEGORY_TYPE_MISMATCH");
    expect(await code(f, { ...expense(f), type: "REFUND" })).toBe("CATEGORY_TYPE_MISMATCH");
    expect((await post(f, { ...expense(f), type: "REFUND", categoryId: f.salesId })).status).toBe(201);
  });

  it("income, expense and refund need a category; adjustment does not", async () => {
    const f = await setupFinance();
    expect(await code(f, expense(f, { categoryId: undefined }))).toBe("CATEGORY_REQUIRED");
    const adjustment = await post(f, { type: "ADJUSTMENT", accountId: f.cashId, amountMinor: "100", txnDate: "2026-11-01" });
    expect(adjustment.status).toBe(201);
  });

  it("a transfer needs two different accounts and has no category", async () => {
    const f = await setupFinance();
    const transfer = { type: "TRANSFER", accountId: f.bankId, amountMinor: "1000000", txnDate: "2026-11-01" };

    expect(await code(f, transfer)).toBe("TRANSFER_ACCOUNTS_INVALID");
    expect(await code(f, { ...transfer, toAccountId: f.bankId })).toBe("TRANSFER_ACCOUNTS_INVALID");
    expect(await code(f, { ...transfer, toAccountId: f.cashId, categoryId: f.rentId })).toBe("CATEGORY_NOT_ALLOWED");

    const ok = await post(f, { ...transfer, toAccountId: f.cashId, feeMinor: "18500" });
    expect(ok.status).toBe(201);
    expect(ok.body.data.feeMinor).toBe("18500");
  });

  it("only a transfer can have a destination or a fee", async () => {
    const f = await setupFinance();
    expect(await code(f, expense(f, { toAccountId: f.bankId }))).toBe("TRANSFER_ACCOUNTS_INVALID");
    expect(await code(f, expense(f, { feeMinor: "100" }))).toBe("FEE_NOT_ALLOWED");
  });

  it("the database also refuses an invalid transfer, if the code ever misses it", async () => {
    const f = await setupFinance();
    const created = await post(f, { type: "TRANSFER", accountId: f.bankId, toAccountId: f.cashId, amountMinor: "100", txnDate: "2026-11-01" });
    await expect(
      prisma.transaction.update({ where: { id: created.body.data.id }, data: { toAccountId: f.bankId } }),
    ).rejects.toThrow();
    await expect(
      prisma.transaction.update({ where: { id: created.body.data.id }, data: { amountMinor: 0n } }),
    ).rejects.toThrow();
  });

  it("refuses inactive accounts and categories", async () => {
    const f = await setupFinance();
    await api().patch(`${f.base}/accounts/${f.bankId}`).set("Authorization", f.auth).send({ isActive: false });
    await api().patch(`${f.base}/categories/${f.rentId}`).set("Authorization", f.auth).send({ isActive: false });

    expect(await code(f, expense(f, { accountId: f.bankId, categoryId: f.salesId, type: "INCOME" }))).toBe("ACCOUNT_NOT_USABLE");
    expect(await code(f, expense(f))).toBe("CATEGORY_NOT_USABLE");
  });

  it("the currency must match the account, and a transfer stays in one currency", async () => {
    const f = await setupFinance();
    expect(await code(f, expense(f, { currency: "USD" }))).toBe("CURRENCY_MISMATCH");

    const usd = await api().post(`${f.base}/accounts`).set("Authorization", f.auth).send({ name: "USD", type: "BANK", currency: "USD" });
    const res = await post(f, { type: "TRANSFER", accountId: f.bankId, toAccountId: usd.body.data.id, amountMinor: "100", txnDate: "2026-11-01" });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("CURRENCY_MISMATCH");
  });

  it("every id must belong to this business", async () => {
    const mine = await setupFinance();
    const theirs = await setupFinance();
    const theirDoc = await uploadDocument(theirs.base, theirs.auth);

    expect(await code(mine, expense(mine, { accountId: theirs.cashId }))).toBe("ACCOUNT_NOT_USABLE");
    expect(await code(mine, expense(mine, { categoryId: theirs.rentId }))).toBe("CATEGORY_NOT_USABLE");
    expect(await code(mine, { type: "TRANSFER", accountId: mine.cashId, toAccountId: theirs.cashId, amountMinor: "100", txnDate: "2026-11-01" })).toBe("ACCOUNT_NOT_USABLE");

    const mineTxn = await post(mine, expense(mine));
    const attach = await api()
      .post(`${mine.base}/transactions/${mineTxn.body.data.id}/attachments`)
      .set("Authorization", mine.auth)
      .send({ documentId: theirDoc.id });
    expect(attach.status).toBe(422);
    expect(attach.body.error.code).toBe("DOCUMENT_NOT_READY");

    const theirTxn = await post(theirs, expense(theirs));
    expect((await api().get(`${mine.base}/transactions/${theirTxn.body.data.id}`).set("Authorization", mine.auth)).status).toBe(404);
    expect((await api().post(`${mine.base}/transactions/${theirTxn.body.data.id}/void`).set("Authorization", mine.auth)).status).toBe(404);
  });
});

describe("idempotency", () => {
  const withKey = (f: FinanceSetup, key: string, body: object) =>
    api().post(`${f.base}/transactions`).set("Authorization", f.auth).set("Idempotency-Key", key).send(body);

  it("a retry returns the first result and creates nothing new", async () => {
    const f = await setupFinance();
    const first = await withKey(f, "retry-key-001", expense(f));
    const retry = await withKey(f, "retry-key-001", expense(f));

    expect(retry.status).toBe(201);
    expect(retry.body.data).toEqual(first.body.data);
    expect(retry.get("Idempotency-Replayed")).toBe("true");
    expect(first.get("Idempotency-Replayed")).toBeUndefined();
    expect(await prisma.transaction.count()).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "transaction.created" } })).toBe(1);
  });

  it("simultaneous retries still create only one", async () => {
    const f = await setupFinance();
    const results = await Promise.all(Array.from({ length: 5 }, () => withKey(f, "race-key-001", expense(f))));
    expect(results.every((res) => res.status === 201)).toBe(true);
    expect(new Set(results.map((res) => res.body.data.id)).size).toBe(1);
    expect(await prisma.transaction.count()).toBe(1);
  });

  it("the same key with a different body is an error", async () => {
    const f = await setupFinance();
    await withKey(f, "reuse-key-001", expense(f));
    const res = await withKey(f, "reuse-key-001", expense(f, { amountMinor: "1" }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("a failed request does not use up its key", async () => {
    const f = await setupFinance();
    const failed = await withKey(f, "fail-key-0001", expense(f, { categoryId: f.salesId }));
    expect(failed.status).toBe(422);
    expect(await prisma.idempotencyKey.count()).toBe(0);
  });

  it("keys belong to one user", async () => {
    const a = await setupFinance();
    const b = await setupFinance();
    const first = await withKey(a, "shared-key-01", expense(a));
    const second = await withKey(b, "shared-key-01", expense(b));
    expect(second.status).toBe(201);
    expect(second.get("Idempotency-Replayed")).toBeUndefined();
    expect(second.body.data.id).not.toBe(first.body.data.id);
  });

  it("an expired key can be used again", async () => {
    const f = await setupFinance();
    const first = await withKey(f, "old-key-00001", expense(f));
    await prisma.idempotencyKey.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const again = await withKey(f, "old-key-00001", expense(f));
    expect(again.status).toBe(201);
    expect(again.body.data.id).not.toBe(first.body.data.id);
  });

  it("rejects a malformed key", async () => {
    const f = await setupFinance();
    const res = await withKey(f, "bad key!", expense(f));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("IDEMPOTENCY_KEY_INVALID");
  });
});

describe("duplicate detection", () => {
  it("flags the same account and amount within 2 days, and points at the original", async () => {
    const f = await setupFinance();
    const first = await post(f, expense(f));
    const second = await post(f, expense(f, { txnDate: "2026-11-03" }));
    expect(second.status).toBe(201);
    expect(second.body.data.possibleDuplicate).toBe(true);
    expect(second.body.data.duplicateOfId).toBe(first.body.data.id);
  });

  it.each([
    ["3 days apart", { txnDate: "2026-11-04" }],
    ["a different amount", { amountMinor: "1" }],
  ])("does not flag %s", async (_name, change) => {
    const f = await setupFinance();
    await post(f, expense(f));
    const res = await post(f, expense(f, change));
    expect(res.body.data.possibleDuplicate).toBe(false);
  });

  it("does not flag a different account or a conflicting reference", async () => {
    const f = await setupFinance();
    await post(f, expense(f, { referenceNo: "INV-1" }));
    expect((await post(f, expense(f, { referenceNo: "INV-2" }))).body.data.possibleDuplicate).toBe(false);
    expect((await post(f, expense(f, { accountId: f.bankId }))).body.data.possibleDuplicate).toBe(false);
    expect((await post(f, expense(f, { referenceNo: "INV-1" }))).body.data.possibleDuplicate).toBe(true);
  });

  it("ignores voided transactions", async () => {
    const f = await setupFinance();
    const first = await post(f, expense(f));
    await api().post(`${f.base}/transactions/${first.body.data.id}/void`).set("Authorization", f.auth);
    expect((await post(f, expense(f))).body.data.possibleDuplicate).toBe(false);
  });

  it("the user can dismiss a flag, and it stays dismissed after an unrelated edit", async () => {
    const f = await setupFinance();
    await post(f, expense(f));
    const flagged = await post(f, expense(f));
    const url = `${f.base}/transactions/${flagged.body.data.id}`;

    const dismissed = await api().post(`${url}/dismiss-duplicate`).set("Authorization", f.auth);
    expect(dismissed.body.data.possibleDuplicate).toBe(false);

    const edited = await api().patch(url).set("Authorization", f.auth).send({ description: "Second rent" });
    expect(edited.body.data.possibleDuplicate).toBe(false);

    const list = await api().get(`${f.base}/transactions?possibleDuplicate=true`).set("Authorization", f.auth);
    expect(list.body.data).toHaveLength(0);
  });

  it("re-checks when an edit changes the amount", async () => {
    const f = await setupFinance();
    await post(f, expense(f));
    const other = await post(f, expense(f, { amountMinor: "1" }));
    const res = await api().patch(`${f.base}/transactions/${other.body.data.id}`).set("Authorization", f.auth).send({ amountMinor: "3000000" });
    expect(res.body.data.possibleDuplicate).toBe(true);
  });
});

describe("edit and void", () => {
  it("applies the same rules on update, and audits the change", async () => {
    const f = await setupFinance();
    const created = await post(f, expense(f));
    const url = `${f.base}/transactions/${created.body.data.id}`;

    const bad = await api().patch(url).set("Authorization", f.auth).send({ categoryId: f.salesId });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("CATEGORY_TYPE_MISMATCH");

    const ok = await api().patch(url).set("Authorization", f.auth).send({ amountMinor: "2500000", description: null, referenceNo: "R-1" });
    expect(ok.status).toBe(200);
    expect(ok.body.data.amountMinor).toBe("2500000");

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "transaction.updated" } });
    expect(audit.before).toMatchObject({ amountMinor: "3000000" });
    expect(audit.after).toMatchObject({ amountMinor: "2500000", referenceNo: "R-1" });
  });

  it("cannot change the type, status or number through an edit", async () => {
    const f = await setupFinance();
    const created = await post(f, expense(f));
    const res = await api()
      .patch(`${f.base}/transactions/${created.body.data.id}`)
      .set("Authorization", f.auth)
      .send({ description: "x", type: "INCOME", status: "POSTED", number: "HACK" });
    expect(res.body.data).toMatchObject({ type: "EXPENSE", status: "DRAFT", number: created.body.data.number });
  });

  it("a voided draft is kept but can no longer change", async () => {
    const f = await setupFinance();
    const created = await post(f, expense(f));
    const url = `${f.base}/transactions/${created.body.data.id}`;

    const voided = await api().post(`${url}/void`).set("Authorization", f.auth);
    expect(voided.body.data.status).toBe("VOID");

    const edit = await api().patch(url).set("Authorization", f.auth).send({ description: "x" });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe("TRANSACTION_NOT_EDITABLE");
    expect((await api().post(`${url}/void`).set("Authorization", f.auth)).status).toBe(409);
    expect((await api().get(url).set("Authorization", f.auth)).status).toBe(200);
    expect((await api().delete(url).set("Authorization", f.auth)).status).toBe(404);
  });

  it("a posted transaction cannot be edited or voided", async () => {
    const f = await setupFinance();
    const created = await post(f, expense(f));
    await prisma.transaction.update({ where: { id: created.body.data.id }, data: { status: "POSTED" } });
    const url = `${f.base}/transactions/${created.body.data.id}`;
    expect((await api().patch(url).set("Authorization", f.auth).send({ description: "x" })).status).toBe(409);
    expect((await api().post(`${url}/void`).set("Authorization", f.auth)).status).toBe(409);
  });
});

describe("list", () => {
  it("sorts by date, filters, and pages without gaps", async () => {
    const f = await setupFinance();
    for (const [index, date] of ["2026-11-01", "2026-11-05", "2026-11-03"].entries()) {
      await post(f, expense(f, { txnDate: date, amountMinor: String(index + 1) }));
    }
    await post(f, { type: "INCOME", accountId: f.bankId, categoryId: f.salesId, amountMinor: "9", txnDate: "2026-10-01" });

    const page1 = await api().get(`${f.base}/transactions?limit=2`).set("Authorization", f.auth);
    expect(page1.body.data.map((item: { txnDate: string }) => item.txnDate)).toEqual(["2026-11-05", "2026-11-03"]);
    const page2 = await api().get(`${f.base}/transactions?limit=2&cursor=${page1.body.meta.nextCursor}`).set("Authorization", f.auth);
    expect(page2.body.data.map((item: { txnDate: string }) => item.txnDate)).toEqual(["2026-11-01", "2026-10-01"]);
    expect(page2.body.meta.nextCursor).toBeNull();

    const get = (query: string) => api().get(`${f.base}/transactions?${query}`).set("Authorization", f.auth);
    expect((await get("type=INCOME")).body.data).toHaveLength(1);
    expect((await get(`accountId=${f.bankId}`)).body.data).toHaveLength(1);
    expect((await get(`categoryId=${f.rentId}`)).body.data).toHaveLength(3);
    expect((await get("from=2026-11-02&to=2026-11-04")).body.data).toHaveLength(1);
    expect((await get("status=DRAFT")).body.data).toHaveLength(4);
    expect((await get("status=POSTED")).body.data).toHaveLength(0);
  });
});

describe("attachments", () => {
  it("attaches a document, lists it, and detaches it", async () => {
    const f = await setupFinance();
    const txn = await post(f, expense(f));
    const document = await uploadDocument(f.base, f.auth);
    const url = `${f.base}/transactions/${txn.body.data.id}`;

    const attached = await api().post(`${url}/attachments`).set("Authorization", f.auth).send({ documentId: document.id });
    expect(attached.status).toBe(200);
    // Attaching again is harmless.
    expect((await api().post(`${url}/attachments`).set("Authorization", f.auth).send({ documentId: document.id })).status).toBe(200);

    const read = await api().get(url).set("Authorization", f.auth);
    expect(read.body.data.attachments.map((item: { documentId: string }) => item.documentId)).toEqual([document.id]);

    // A document in use cannot be deleted.
    const blocked = await api().delete(`${f.base}/documents/${document.id}`).set("Authorization", f.auth);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("DOCUMENT_IN_USE");

    expect((await api().delete(`${url}/attachments/${document.id}`).set("Authorization", f.auth)).status).toBe(200);
    expect((await api().delete(`${url}/attachments/${document.id}`).set("Authorization", f.auth)).status).toBe(404);
    expect((await api().delete(`${f.base}/documents/${document.id}`).set("Authorization", f.auth)).status).toBe(200);
  });
});
