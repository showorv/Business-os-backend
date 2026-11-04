// The Phase 4 gate. Instead of hand-picked examples, these generate random inputs and check that the
// rules of accounting hold for all of them.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { reportsService } from "../src/app/modules/reports/reports.service.js";
import { redis } from "../src/lib/redis.js";
import { buildTransactionLines, swapSides, totals, type PostingInput } from "../src/app/utils/postingRules.js";
import { api, setupFinance } from "./helpers/api.js";

const amount = fc.bigInt({ min: 1n, max: 999_999_999_999_999n });

const postingInput: fc.Arbitrary<PostingInput> = fc.record({
  type: fc.constantFrom("INCOME", "EXPENSE", "TRANSFER", "REFUND", "ADJUSTMENT"),
  amountMinor: amount,
  feeMinor: fc.oneof(fc.constant(0n), amount),
  categoryType: fc.constantFrom("INCOME", "EXPENSE"),
}).map((value) => ({
  ...value,
  accountLedgerId: "cash",
  toAccountLedgerId: "bank",
  categoryLedgerId: value.categoryType === "INCOME" ? "revenue" : "expense",
  salesReturnsLedgerId: "returns",
  bankChargesLedgerId: "charges",
}));

const PROFIT_ACCOUNTS = ["revenue", "expense", "returns", "charges"];

describe("posting rules, for any input", () => {
  it("debits always equal credits, and every line has exactly one positive side", () => {
    fc.assert(
      fc.property(postingInput, (input) => {
        const lines = buildTransactionLines(input);
        const sums = totals(lines);
        expect(sums.debit).toBe(sums.credit);
        expect(lines.length).toBeGreaterThanOrEqual(2);
        for (const line of lines) {
          expect(line.debitMinor === 0n).not.toBe(line.creditMinor === 0n);
          expect(line.debitMinor >= 0n && line.creditMinor >= 0n).toBe(true);
        }
      }),
      { numRuns: 2000 },
    );
  });

  it("a transfer touches no profit account, apart from its fee", () => {
    fc.assert(
      fc.property(postingInput, (input) => {
        const lines = buildTransactionLines({ ...input, type: "TRANSFER" });
        const profitLines = lines.filter((line) => PROFIT_ACCOUNTS.includes(line.ledgerAccountId));
        if (input.feeMinor === 0n) {
          expect(profitLines).toEqual([]);
        } else {
          expect(profitLines).toHaveLength(1);
          expect(profitLines[0]).toMatchObject({ ledgerAccountId: "charges", debitMinor: input.feeMinor });
        }
      }),
      { numRuns: 1000 },
    );
  });

  it("a reversal cancels the original to exactly zero on every account", () => {
    fc.assert(
      fc.property(postingInput, (input) => {
        const lines = buildTransactionLines(input);
        const net = new Map<string, bigint>();
        for (const line of [...lines, ...lines.map(swapSides)]) {
          net.set(line.ledgerAccountId, (net.get(line.ledgerAccountId) ?? 0n) + line.debitMinor - line.creditMinor);
        }
        expect([...net.values()].every((value) => value === 0n)).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });
});

type Action =
  | { kind: "INCOME" | "EXPENSE" | "REFUND"; amount: bigint; day: number; onBank: boolean }
  | { kind: "TRANSFER"; amount: bigint; fee: bigint; day: number; toBank: boolean }
  | { kind: "REVERSE_LAST" };

const action: fc.Arbitrary<Action> = fc.oneof(
  fc.record({
    kind: fc.constantFrom("INCOME", "EXPENSE", "REFUND") as fc.Arbitrary<"INCOME" | "EXPENSE" | "REFUND">,
    amount: fc.bigInt({ min: 1n, max: 10_000_000_000n }),
    day: fc.integer({ min: 1, max: 28 }),
    onBank: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant("TRANSFER" as const),
    amount: fc.bigInt({ min: 1n, max: 10_000_000_000n }),
    fee: fc.oneof(fc.constant(0n), fc.bigInt({ min: 1n, max: 100_000n })),
    day: fc.integer({ min: 1, max: 28 }),
    toBank: fc.boolean(),
  }),
  fc.constant({ kind: "REVERSE_LAST" as const }),
);

const FROM = "2026-11-01";
const TO = "2026-11-30";

describe("the whole ledger, for any sequence of transactions", () => {
  it("stays balanced, profit excludes transfers, and balances match the ledger", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(action, { minLength: 1, maxLength: 12 }), async (actions) => {
        // Each run registers a user, and would otherwise hit the sign-up rate limit.
        await redis.flushdb();
        const f = await setupFinance();
        const send = (path: string, body: object) => api().post(`${f.base}/${path}`).set("Authorization", f.auth).send(body);

        // Track what the answer should be, independently of the code under test.
        let expectedProfit = 0n;
        let expectedCash = 0n;
        const reversible: { id: string; profit: bigint; cash: bigint }[] = [];

        for (const step of actions) {
          if (step.kind === "REVERSE_LAST") {
            const last = reversible.pop();
            if (!last) continue;
            const res = await send(`transactions/${last.id}/reverse`, { entryDate: TO });
            expect(res.status).toBe(200);
            expectedProfit -= last.profit;
            expectedCash -= last.cash;
            continue;
          }

          const txnDate = `2026-11-${String(step.day).padStart(2, "0")}`;
          let body: object;
          let profit: bigint;
          let cash: bigint;

          if (step.kind === "TRANSFER") {
            body = {
              type: "TRANSFER",
              accountId: step.toBank ? f.cashId : f.bankId,
              toAccountId: step.toBank ? f.bankId : f.cashId,
              amountMinor: String(step.amount),
              feeMinor: String(step.fee),
            };
            profit = -step.fee;
            cash = -step.fee;
          } else {
            const accountId = step.onBank ? f.bankId : f.cashId;
            const categoryId = step.kind === "EXPENSE" ? f.rentId : f.salesId;
            body = { type: step.kind, accountId, categoryId, amountMinor: String(step.amount) };
            profit = step.kind === "INCOME" ? step.amount : -step.amount;
            cash = profit;
          }

          const res = await send("transactions", { ...body, txnDate, postNow: true });
          expect(res.status).toBe(201);
          reversible.push({ id: res.body.data.id, profit, cash });
          expectedProfit += profit;
          expectedCash += cash;
        }

        const read = async (path: string) => (await api().get(`${f.base}/reports/${path}`).set("Authorization", f.auth)).body.data;
        const [trial, pnl, sheet, flow] = await Promise.all([
          read(`trial-balance?asOf=${TO}`),
          read(`profit-and-loss?from=${FROM}&to=${TO}`),
          read(`balance-sheet?asOf=${TO}`),
          read(`cash-flow?from=${FROM}&to=${TO}`),
        ]);

        // Σ debit = Σ credit
        expect(trial.balanced).toBe(true);
        // Assets = Liabilities + Equity
        expect(sheet.balanced).toBe(true);
        // Transfers ≠ P&L: only real income, spending and fees move profit.
        expect(BigInt(pnl.netProfitMinor)).toBe(expectedProfit);
        // The cash flow statement ties to the cash we expected.
        expect(flow.balanced).toBe(true);
        expect(BigInt(flow.endingCashMinor)).toBe(expectedCash);
        // With only cash movements here, profit and cash change match.
        expect(BigInt(flow.netChangeMinor)).toBe(expectedProfit);
        // Cached balances equal the ledger.
        expect(await reportsService.verifyBusiness(f.businessId)).toMatchObject({ unbalancedEntries: 0, accountsOutOfStep: 0 });
      }),
      { numRuns: 15 },
    );
  }, 120_000);
});
