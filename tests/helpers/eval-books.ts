import { todayInTimezone } from "../../src/app/utils/dates.js";
import { api, createBusiness, registerUser, runPendingEvents, setupFinance, type FinanceSetup } from "./api.js";
import type { EvalIds } from "../../evaluation/questions.js";


const post = (f: FinanceSetup, path: string, body: object) =>
  api().post(`${f.base}${path}`).set("Authorization", f.auth).send(body).then((res) => {
    if (res.status >= 300) throw new Error(`${path} failed: ${JSON.stringify(res.body)}`);
    return res;
  });

// Known books, so every answer can be checked to the paisa.
//   October:  revenue 3,00,000  expenses 50,000  profit 2,50,000
//   November: revenue 5,00,000  expenses 75,000  profit 4,25,000
//   Bank 6,55,000 + Cash 20,000 = 6,75,000
export const seedEvalBooks = async (): Promise<{ f: FinanceSetup; ids: EvalIds }> => {
  const f = await setupFinance();
  const categories = (await api().get(`${f.base}/categories`).set("Authorization", f.auth)).body.data as { id: string; name: string }[];
  const utilities = categories.find((category) => category.name === "Utilities")!.id;

  const txn = (type: string, categoryId: string, amountMinor: string, txnDate: string) =>
    post(f, "/transactions", { postNow: true, type, accountId: f.bankId, categoryId, amountMinor, txnDate });

  await txn("INCOME", f.salesId, "30000000", "2026-10-10");
  await txn("EXPENSE", f.rentId, "5000000", "2026-10-12");
  await txn("INCOME", f.salesId, "50000000", "2026-11-03");
  await txn("EXPENSE", f.rentId, "6000000", "2026-11-04");
  await txn("EXPENSE", utilities, "1500000", "2026-11-05");
  await post(f, "/transactions", { postNow: true, type: "TRANSFER", accountId: f.bankId, toAccountId: f.cashId, amountMinor: "2000000", txnDate: "2026-11-06" });

  await post(f, "/budgets", { name: "November", startMonth: "2026-11", endMonth: "2026-11", lines: [{ categoryId: f.rentId, amountMinor: "10000000", alertPercent: 90 }] });
  await post(f, "/goals", { name: "Revenue target", metric: "REVENUE", targetMinor: "100000000", startMonth: "2026-11", endMonth: "2026-11" });
  await post(f, "/tasks", { title: "File VAT return", dueAt: "2026-01-15T04:00:00.000Z" });
  await post(f, "/tasks", { title: "Renew trade license", dueAt: "2030-01-15T04:00:00.000Z" });
  await post(f, "/recurring-schedules", { name: "Office rent", rrule: "FREQ=MONTHLY", startDate: todayInTimezone("Asia/Dhaka"), accountId: f.bankId, categoryId: f.rentId, amountMinor: "6000000" });
  await runPendingEvents();

  const stranger = await registerUser();
  const other = await createBusiness(stranger, "Someone else's shop");

  return { f, ids: { businessId: f.businessId, otherBusinessId: other.id, bankId: f.bankId, rentId: f.rentId, salesId: f.salesId } };
};

export const LEASE_TEXT = `Lease Agreement

This lease agreement ends on 30 June 2027. The monthly rent is BDT 30,000.
The tenant pays a security deposit equal to three months of rent.
Either side may end the lease with a notice period of 60 days.`;
