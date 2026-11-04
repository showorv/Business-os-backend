import { describe, expect, it } from "vitest";
import { reportsService } from "../src/app/modules/reports/reports.service.js";
import { prisma } from "../src/lib/prisma.js";
import { addMember, API, api, bearer, registerUser, type Session } from "./helpers/api.js";

const asOwner = (owner: Session) => ({
  post: (path: string, body: object) => api().post(`${API}${path}`).set("Authorization", bearer(owner)).send(body),
  get: (path: string) => api().get(`${API}${path}`).set("Authorization", bearer(owner)),
});

const makeBusiness = async (owner: Session, name: string, baseCurrency = "BDT") => {
  const client = asOwner(owner);
  const res = await client.post("/businesses", { name, type: "RETAIL", baseCurrency });
  const id = res.body.data.id as string;
  const base = `/businesses/${id}`;
  await client.post(`${base}/fiscal-periods/years`, { fiscalYear: 2026 });
  const accounts = await client.get(`${base}/accounts`);
  const categories = await client.get(`${base}/categories`);
  const named = (n: string) => categories.body.data.find((c: { name: string }) => c.name === n).id as string;
  return { id, base, cashId: accounts.body.data[0].id as string, salesId: named("Sales"), rentId: named("Rent") };
};

const sell = (owner: Session, b: { base: string; cashId: string; salesId: string }, amountMinor: string, txnDate = "2026-11-05") =>
  asOwner(owner).post(`${b.base}/transactions`, { type: "INCOME", accountId: b.cashId, categoryId: b.salesId, amountMinor, txnDate, postNow: true });
const spend = (owner: Session, b: { base: string; cashId: string; rentId: string }, amountMinor: string) =>
  asOwner(owner).post(`${b.base}/transactions`, { type: "EXPENSE", accountId: b.cashId, categoryId: b.rentId, amountMinor, txnDate: "2026-11-06", postNow: true });

const RANGE = "fromMonth=2026-11&toMonth=2026-11";
const consolidated = (owner: Session, extra = "") => asOwner(owner).get(`/consolidated/dashboard?${RANGE}${extra}`);

describe("consolidated dashboard", () => {
  it("adds up every business, with a breakdown", async () => {
    const owner = await registerUser();
    const a = await makeBusiness(owner, "Shop A");
    const b = await makeBusiness(owner, "Shop B");
    await sell(owner, a, "1000");
    await sell(owner, b, "500");
    await spend(owner, b, "200");

    const res = await consolidated(owner);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      reportingCurrency: "BDT",
      asOf: "2026-11-30",
      basis: "POSTED_ACTUALS",
      totals: { revenueMinor: "1500", expensesMinor: "200", netProfitMinor: "1300", cashBalanceMinor: "1300" },
      fxRates: [],
    });
    const shopB = res.body.data.businesses.find((item: { name: string }) => item.name === "Shop B");
    expect(shopB.native).toMatchObject({ revenueMinor: "500", netProfitMinor: "300" });
  });

  it("only includes businesses the caller may read, and takes no list from the client", async () => {
    const owner = await registerUser();
    const mine = await makeBusiness(owner, "Mine");
    const theirsOwner = await registerUser();
    const theirs = await makeBusiness(theirsOwner, "Theirs");
    await sell(owner, mine, "100");
    await sell(theirsOwner, theirs, "9999");

    // A member without finance.read doesn't count it either.
    const shared = await makeBusiness(theirsOwner, "Shared");
    await sell(theirsOwner, shared, "7777");
    const invite = await asOwner(theirsOwner).post(`${shared.base}/invitations`, { email: owner.email, roleKey: "VIEWER" });
    await asOwner(owner).post("/invitations/accept", { token: invite.body.data.token });

    const res = await asOwner(owner).get(`/consolidated/dashboard?${RANGE}&businessIds=${theirs.id}&businessId=${theirs.id}`);
    expect(res.body.data.businesses.map((item: { name: string }) => item.name)).toEqual(["Mine"]);
    expect(res.body.data.totals.revenueMinor).toBe("100");
  });

  it("leaves out archived businesses unless asked", async () => {
    const owner = await registerUser();
    const a = await makeBusiness(owner, "Active");
    const b = await makeBusiness(owner, "Old");
    await sell(owner, a, "100");
    await sell(owner, b, "50");
    await asOwner(owner).post(`${b.base}/status`, { status: "ARCHIVED" });

    expect((await consolidated(owner)).body.data.totals.revenueMinor).toBe("100");
    expect((await consolidated(owner, "&includeArchived=true")).body.data.totals.revenueMinor).toBe("150");
  });

  it("is empty for someone with no businesses", async () => {
    const owner = await registerUser();
    const res = await consolidated(owner);
    expect(res.status).toBe(200);
    expect(res.body.data.businesses).toEqual([]);
    expect(res.body.data.totals.revenueMinor).toBe("0");
  });
});

describe("currency conversion", () => {
  const twoCurrencies = async () => {
    const owner = await registerUser();
    const bdt = await makeBusiness(owner, "Dhaka", "BDT");
    const usd = await makeBusiness(owner, "Delaware", "USD");
    await sell(owner, bdt, "100000");
    await sell(owner, usd, "1000");
    return { owner, bdt, usd };
  };

  it("needs a reporting currency when businesses differ, and a rate to use", async () => {
    const { owner } = await twoCurrencies();
    const noCurrency = await consolidated(owner);
    expect(noCurrency.status).toBe(422);
    expect(noCurrency.body.error.code).toBe("REPORTING_CURRENCY_REQUIRED");

    const noRate = await consolidated(owner, "&reportingCurrency=BDT");
    expect(noRate.status).toBe(422);
    expect(noRate.body.error.code).toBe("FX_RATE_MISSING");
    expect(noRate.body.error.params).toMatchObject({ fromCurrency: "USD", toCurrency: "BDT", onDate: "2026-11-30" });
  });

  it("converts at the rate on or before the period's end, and states it", async () => {
    const { owner } = await twoCurrencies();
    const rates = asOwner(owner);
    await rates.post("/exchange-rates", { fromCurrency: "USD", toCurrency: "BDT", rateDate: "2026-10-31", rate: "100" });
    await rates.post("/exchange-rates", { fromCurrency: "USD", toCurrency: "BDT", rateDate: "2026-11-30", rate: "120.5" });
    // After the period's end, so it must not be used.
    await rates.post("/exchange-rates", { fromCurrency: "USD", toCurrency: "BDT", rateDate: "2026-12-15", rate: "999" });

    const res = await consolidated(owner, "&reportingCurrency=BDT");
    expect(res.body.data.reportingCurrency).toBe("BDT");
    expect(res.body.data.totals.revenueMinor).toBe("220500");
    expect(res.body.data.fxRates).toEqual([{ fromCurrency: "USD", toCurrency: "BDT", rate: "120.500000", rateDate: "2026-11-30", inverted: false }]);

    const usd = res.body.data.businesses.find((item: { currency: string }) => item.currency === "USD");
    expect(usd.native.revenueMinor).toBe("1000");
    expect(usd.converted.revenueMinor).toBe("120500");
  });

  it("uses a rate stored the other way round", async () => {
    const { owner } = await twoCurrencies();
    await asOwner(owner).post("/exchange-rates", { fromCurrency: "USD", toCurrency: "BDT", rateDate: "2026-11-30", rate: "100" });
    const res = await consolidated(owner, "&reportingCurrency=USD");
    expect(res.body.data.totals.revenueMinor).toBe("2000");
    expect(res.body.data.fxRates[0].inverted).toBe(true);
  });

  it("rates: validated, correctable, and private to a workspace", async () => {
    const owner = await registerUser();
    const client = asOwner(owner);
    for (const body of [
      { fromCurrency: "USD", toCurrency: "USD", rateDate: "2026-11-30", rate: "1" },
      { fromCurrency: "USD", toCurrency: "BDT", rateDate: "2026-11-30", rate: "0" },
      { fromCurrency: "USD", toCurrency: "BDT", rateDate: "2026-11-30", rate: "abc" },
    ]) {
      expect((await client.post("/exchange-rates", body)).status).toBe(422);
    }

    const key = { fromCurrency: "USD", toCurrency: "BDT", rateDate: "2026-11-30" };
    await client.post("/exchange-rates", { ...key, rate: "110" });
    await client.post("/exchange-rates", { ...key, rate: "১২০" });
    const list = await client.get("/exchange-rates");
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].rate).toBe("120.000000");

    const stranger = await registerUser();
    expect((await asOwner(stranger).get("/exchange-rates")).body.data).toEqual([]);
  });
});

describe("intercompany transfers", () => {
  const twoShops = async () => {
    const owner = await registerUser();
    const a = await makeBusiness(owner, "Shop A");
    const b = await makeBusiness(owner, "Shop B");
    await sell(owner, a, "100000");
    return { owner, a, b };
  };
  const transfer = (owner: Session, a: { id: string; cashId: string }, b: { id: string; cashId: string }, amountMinor = "30000") =>
    asOwner(owner).post("/consolidated/intercompany-transfers", {
      fromBusinessId: a.id, fromAccountId: a.cashId, toBusinessId: b.id, toAccountId: b.cashId, amountMinor, transferDate: "2026-11-10",
    });

  const journalLinesFor = async (entryId: string) => {
    const lines = await prisma.journalLine.findMany({ where: { journalEntryId: entryId }, include: { ledgerAccount: true }, orderBy: { lineNo: "asc" } });
    return lines.map((line) => [line.ledgerAccount.code, line.debitMinor, line.creditMinor]);
  };

  it("posts one balanced journal in each business, against Due From and Due To", async () => {
    const { owner, a, b } = await twoShops();
    const res = await transfer(owner, a, b);
    expect(res.status).toBe(201);

    expect(await journalLinesFor(res.body.data.fromEntryId)).toEqual([["1300", 30000n, 0n], ["1100", 0n, 30000n]]);
    expect(await journalLinesFor(res.body.data.toEntryId)).toEqual([["1100", 30000n, 0n], ["2300", 0n, 30000n]]);
    expect(await reportsService.verifyBusiness(a.id)).toMatchObject({ unbalancedEntries: 0, accountsOutOfStep: 0, rollupsOutOfStep: 0 });
    expect(await reportsService.verifyBusiness(b.id)).toMatchObject({ unbalancedEntries: 0, accountsOutOfStep: 0, rollupsOutOfStep: 0 });
  });

  it("is eliminated: group revenue, profit, cash, assets and liabilities don't change", async () => {
    const { owner, a, b } = await twoShops();
    const before = (await consolidated(owner)).body.data;
    await transfer(owner, a, b);
    const after = (await consolidated(owner)).body.data;

    expect(after.totals).toEqual(before.totals);
    expect(after.eliminatedIntercompanyMinor).toBe("30000");
    // Each business on its own still shows it.
    const shopB = after.businesses.find((item: { name: string }) => item.name === "Shop B");
    expect(shopB.native).toMatchObject({ cashBalanceMinor: "30000", liabilitiesMinor: "30000", revenueMinor: "0" });
  });

  it("if one side can't post, neither does", async () => {
    const { owner, a, b } = await twoShops();
    await prisma.fiscalPeriod.updateMany({ where: { businessId: b.id, startDate: new Date("2026-11-01") }, data: { status: "CLOSED" } });
    const res = await transfer(owner, a, b);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PERIOD_CLOSED");
    expect(await prisma.journalEntry.count({ where: { sourceType: "intercompany" } })).toBe(0);
    expect(await prisma.financialAccount.findUniqueOrThrow({ where: { id: a.cashId } })).toMatchObject({ currentBalanceMinor: 100000n });
  });

  it("opposite transfers at the same moment both succeed", async () => {
    const { owner, a, b } = await twoShops();
    await sell(owner, b, "100000");
    const results = await Promise.all([transfer(owner, a, b, "10"), transfer(owner, b, a, "20")]);
    expect(results.map((res) => res.status)).toEqual([201, 201]);
  });

  it("needs ledger.post in both businesses, and refuses others' or mismatched accounts", async () => {
    const { owner, a, b } = await twoShops();
    const stranger = await registerUser();
    const theirs = await makeBusiness(stranger, "Theirs");
    expect((await transfer(owner, a, theirs)).status).toBe(404);

    const viewer = await addMember(owner, a.id, "VIEWER");
    const denied = await asOwner(viewer).post("/consolidated/intercompany-transfers", { fromBusinessId: a.id, fromAccountId: a.cashId, toBusinessId: b.id, toAccountId: b.cashId, amountMinor: "1", transferDate: "2026-11-10" });
    expect(denied.status).toBe(403);

    const wrongAccount = await asOwner(owner).post("/consolidated/intercompany-transfers", { fromBusinessId: a.id, fromAccountId: b.cashId, toBusinessId: b.id, toAccountId: b.cashId, amountMinor: "1", transferDate: "2026-11-10" });
    expect(wrongAccount.body.error.code).toBe("ACCOUNT_NOT_USABLE");

    const usd = await makeBusiness(owner, "Dollar", "USD");
    const mismatch = await transfer(owner, a, usd);
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.error.code).toBe("INTERCOMPANY_INVALID");

    const same = await transfer(owner, a, a);
    expect(same.status).toBe(422);
  });

  it("its journals can't be reversed one side at a time, and it's listed", async () => {
    const { owner, a, b } = await twoShops();
    const res = await transfer(owner, a, b);
    const reverse = await asOwner(owner).post(`${a.base}/journals/${res.body.data.fromEntryId}/reverse`, {});
    expect(reverse.status).toBe(409);
    expect(reverse.body.error.code).toBe("JOURNAL_HAS_SOURCE");

    const list = await asOwner(owner).get("/consolidated/intercompany-transfers");
    expect(list.body.data).toHaveLength(1);
    const stranger = await registerUser();
    expect((await asOwner(stranger).get("/consolidated/intercompany-transfers")).body.data).toEqual([]);
  });
});
