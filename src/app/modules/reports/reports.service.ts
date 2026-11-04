import type { Prisma } from "../../../lib/prisma.js";
import { prisma } from "../../../lib/prisma.js";
import { withBusinessScope } from "../../../lib/rls.js";
import type { BusinessContext } from "../members/members.interface.js";
import type { AccountTotalRow, LedgerCheck } from "./reports.interface.js";

// Every report reads journals only, never the transactions table, so drafts can't appear in them.
// SUM()::text keeps totals exact: a large sum could overflow a number on the way out.

interface TotalsFilter {
  from?: string;
  to: string;
  excludeClosing?: boolean;
}

const accountTotals = (tx: Prisma.TransactionClient, businessId: string, filter: TotalsFilter) =>
  tx.$queryRaw<AccountTotalRow[]>`
    SELECT a.id, a.code, a.name, a.name_bn, a.type::text AS type, a.normal_balance::text AS normal_balance,
      COALESCE(SUM(l.debit_minor), 0)::text AS debit,
      COALESCE(SUM(l.credit_minor), 0)::text AS credit
    FROM ledger_accounts a
    JOIN journal_lines l ON l.ledger_account_id = a.id
    JOIN journal_entries e ON e.id = l.journal_entry_id
    WHERE a.business_id = ${businessId}::uuid
      AND e.entry_date <= ${filter.to}::date
      AND (${filter.from ?? null}::date IS NULL OR e.entry_date >= ${filter.from ?? null}::date)
      AND (${filter.excludeClosing ?? false}::boolean = false OR e.kind::text <> 'CLOSING')
    GROUP BY a.id
    ORDER BY a.code`;

// Positive means the account's normal side for its section: revenue and liabilities on the credit
// side, assets and expenses on the debit side. A contra account shows as a negative.
const debitNet = (row: AccountTotalRow) => BigInt(row.debit) - BigInt(row.credit);
const creditNet = (row: AccountTotalRow) => BigInt(row.credit) - BigInt(row.debit);

const toLine = (row: AccountTotalRow, amountMinor: bigint) => ({
  ledgerAccountId: row.id,
  code: row.code,
  name: row.name,
  nameBn: row.name_bn,
  amountMinor,
});

const section = (rows: AccountTotalRow[], type: AccountTotalRow["type"], net: (row: AccountTotalRow) => bigint) => {
  const items = rows
    .filter((row) => row.type === type)
    .map((row) => toLine(row, net(row)))
    .filter((line) => line.amountMinor !== 0n);
  return { items, totalMinor: items.reduce((sum, line) => sum + line.amountMinor, 0n) };
};

// Every figure states what it is: which dates, which currency, and that it is posted actuals.
const provenance = (business: BusinessContext) => ({ currency: business.baseCurrency, basis: "POSTED_ACTUALS" as const });

const trialBalance = async (business: BusinessContext, asOf: string) => {
  const rows = await withBusinessScope(business, (tx) => accountTotals(tx, business.businessId, { to: asOf }));

  const items = rows
    .map((row) => {
      const net = debitNet(row);
      return {
        ...toLine(row, net),
        type: row.type,
        debitBalanceMinor: net > 0n ? net : 0n,
        creditBalanceMinor: net < 0n ? -net : 0n,
      };
    })
    .filter((item) => item.amountMinor !== 0n)
    .map(({ amountMinor: _amountMinor, ...item }) => item);

  const totalDebitMinor = items.reduce((sum, item) => sum + item.debitBalanceMinor, 0n);
  const totalCreditMinor = items.reduce((sum, item) => sum + item.creditBalanceMinor, 0n);
  return { ...provenance(business), asOf, items, totalDebitMinor, totalCreditMinor, balanced: totalDebitMinor === totalCreditMinor };
};

// Leaves out closing entries, otherwise the year-end close would wipe a closed year's profit.
const profitAndLoss = async (business: BusinessContext, from: string, to: string) => {
  const rows = await withBusinessScope(business, (tx) => accountTotals(tx, business.businessId, { from, to, excludeClosing: true }));
  const revenue = section(rows, "REVENUE", creditNet);
  const expenses = section(rows, "EXPENSE", debitNet);
  return { ...provenance(business), from, to, revenue, expenses, netProfitMinor: revenue.totalMinor - expenses.totalMinor };
};

// Assets = Liabilities + Equity. Profit not yet closed into Retained Earnings is shown under equity.
const balanceSheet = async (business: BusinessContext, asOf: string) => {
  const rows = await withBusinessScope(business, (tx) => accountTotals(tx, business.businessId, { to: asOf }));

  const assets = section(rows, "ASSET", debitNet);
  const liabilities = section(rows, "LIABILITY", creditNet);
  const equity = section(rows, "EQUITY", creditNet);
  const unclosedProfitMinor = section(rows, "REVENUE", creditNet).totalMinor - section(rows, "EXPENSE", debitNet).totalMinor;
  const totalEquityMinor = equity.totalMinor + unclosedProfitMinor;

  return {
    ...provenance(business),
    asOf,
    assets,
    liabilities,
    equity: { ...equity, unclosedProfitMinor, totalMinor: totalEquityMinor },
    balanced: assets.totalMinor === liabilities.totalMinor + totalEquityMinor,
  };
};

// Direct method. In an entry that touches cash, each non-cash line is a cash movement: its credit
// is money in and its debit is money out, classified by that line's account. Cash-to-cash transfers
// have no non-cash line, so they vanish (except a fee), which is exactly right.
const cashFlow = async (business: BusinessContext, from: string, to: string) => {
  const { flows, balances } = await withBusinessScope(business, async (tx) => ({
    flows: await tx.$queryRaw<
      { ledger_account_id: string; code: string; name: string; name_bn: string | null; class: string; net: string }[]
    >`
      SELECT a.id AS ledger_account_id, a.code, a.name, a.name_bn, a.cash_flow_class::text AS class,
        SUM(l.credit_minor - l.debit_minor)::text AS net
      FROM journal_lines l
      JOIN journal_entries e ON e.id = l.journal_entry_id
      JOIN ledger_accounts a ON a.id = l.ledger_account_id
      WHERE e.business_id = ${business.businessId}::uuid
        AND e.entry_date BETWEEN ${from}::date AND ${to}::date
        AND e.kind::text NOT IN ('OPENING', 'CLOSING')
        AND NOT EXISTS (SELECT 1 FROM financial_accounts f WHERE f.ledger_account_id = a.id)
        AND EXISTS (
          SELECT 1 FROM journal_lines cash
          JOIN financial_accounts f ON f.ledger_account_id = cash.ledger_account_id
          WHERE cash.journal_entry_id = e.id
        )
      GROUP BY a.id
      HAVING SUM(l.credit_minor - l.debit_minor) <> 0
      ORDER BY a.code`,
    balances: await tx.$queryRaw<{ before: string; opening: string; closing: string }[]>`
      SELECT
        COALESCE(SUM(l.debit_minor - l.credit_minor) FILTER (WHERE e.entry_date < ${from}::date), 0)::text AS before,
        COALESCE(SUM(l.debit_minor - l.credit_minor) FILTER (
          WHERE e.entry_date BETWEEN ${from}::date AND ${to}::date AND e.kind::text = 'OPENING'
        ), 0)::text AS opening,
        COALESCE(SUM(l.debit_minor - l.credit_minor) FILTER (WHERE e.entry_date <= ${to}::date), 0)::text AS closing
      FROM journal_lines l
      JOIN journal_entries e ON e.id = l.journal_entry_id
      JOIN financial_accounts f ON f.ledger_account_id = l.ledger_account_id
      WHERE e.business_id = ${business.businessId}::uuid`,
  }));

  const activity = (name: string) => {
    const items = flows
      .filter((flow) => flow.class === name)
      .map((flow) => ({
        ledgerAccountId: flow.ledger_account_id,
        code: flow.code,
        name: flow.name,
        nameBn: flow.name_bn,
        amountMinor: BigInt(flow.net),
      }));
    return { items, totalMinor: items.reduce((sum, item) => sum + item.amountMinor, 0n) };
  };

  const operating = activity("OPERATING");
  const investing = activity("INVESTING");
  const financing = activity("FINANCING");
  const netChangeMinor = operating.totalMinor + investing.totalMinor + financing.totalMinor;

  const row = balances[0]!;
  const beginningCashMinor = BigInt(row.before);
  const openingBalancesMinor = BigInt(row.opening);
  const endingCashMinor = BigInt(row.closing);

  return {
    ...provenance(business),
    from,
    to,
    beginningCashMinor,
    // Accounts added during this period, with a starting balance.
    openingBalancesMinor,
    operating,
    investing,
    financing,
    netChangeMinor,
    endingCashMinor,
    balanced: beginningCashMinor + openingBalancesMinor + netChangeMinor === endingCashMinor,
  };
};

// For `npm run ledger:verify`. Uses the normal connection because it checks every business.
const verifyBusiness = async (businessId: string): Promise<LedgerCheck> => {
  const [unbalanced] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*) AS count FROM (
      SELECT e.id FROM journal_entries e JOIN journal_lines l ON l.journal_entry_id = e.id
      WHERE e.business_id = ${businessId}::uuid
      GROUP BY e.id HAVING SUM(l.debit_minor) <> SUM(l.credit_minor)
    ) bad`;
  const [outOfStep] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*) AS count FROM financial_accounts f
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0) AS balance
      FROM journal_lines l WHERE l.ledger_account_id = f.ledger_account_id
    ) ledger ON true
    WHERE f.business_id = ${businessId}::uuid AND f.current_balance_minor <> ledger.balance`;
  return { businessId, unbalancedEntries: Number(unbalanced!.count), accountsOutOfStep: Number(outOfStep!.count) };
};

export const reportsService = { trialBalance, profitAndLoss, balanceSheet, cashFlow, verifyBusiness };
