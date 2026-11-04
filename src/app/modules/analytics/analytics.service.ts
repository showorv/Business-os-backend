import type { Prisma } from "../../../lib/prisma.js";
import { withBusinessScope } from "../../../lib/rls.js";
import { LedgerCode } from "../../constants/chartOfAccounts.js";
import { dateToMonth, lastDayOfMonth, monthsBetween, todayInTimezone, toDbDate } from "../../utils/dates.js";
import { AppError, ErrorCode } from "../../utils/errors.js";
import { percentOf } from "../../utils/money.js";
import { fiscalYearOf } from "../fiscal-periods/fiscal-periods.service.js";
import type { BusinessContext } from "../members/members.interface.js";
import type { BusinessFigures, ICompareQuery, IDashboardQuery } from "./analytics.interface.js";

// Dashboards read monthly rollups, so they stay fast as journals grow. Revenue and liabilities are
// credit-normal, and assets and expenses debit-normal, so each figure below is positive when normal.

const MAX_MONTHS = 60;
const TOP_EXPENSES = 10;

export const assertMonthRange = (from: string, to: string) => {
  if (from > to || monthsBetween(from, to).length > MAX_MONTHS) {
    throw new AppError(422, ErrorCode.INVALID_MONTH_RANGE, { from, to, maxMonths: MAX_MONTHS });
  }
};

// Fiscal year to date, when the client doesn't ask for a range.
const defaultRange = (business: BusinessContext) => {
  const today = toDbDate(todayInTimezone(business.timezone));
  const year = fiscalYearOf(today, business.fiscalYearStartMonth);
  return {
    fromMonth: `${year}-${String(business.fiscalYearStartMonth).padStart(2, "0")}`,
    toMonth: dateToMonth(today),
  };
};

// Revenue and expenses for a month range, per business.
export const profitByBusiness = async (tx: Prisma.TransactionClient, businessIds: string[], from: string, to: string) => {
  const rows = await tx.$queryRaw<{ business_id: string; revenue: string; expenses: string }[]>`
    SELECT r.business_id,
      COALESCE(SUM(r.credit_minor - r.debit_minor) FILTER (WHERE a.type = 'REVENUE'), 0)::text AS revenue,
      COALESCE(SUM(r.debit_minor - r.credit_minor) FILTER (WHERE a.type = 'EXPENSE'), 0)::text AS expenses
    FROM ledger_monthly_rollups r
    JOIN ledger_accounts a ON a.id = r.ledger_account_id
    WHERE r.business_id = ANY(${businessIds}::uuid[])
      AND r.month BETWEEN ${`${from}-01`}::date AND ${`${to}-01`}::date
    GROUP BY r.business_id`;
  return new Map(rows.map((row) => [row.business_id, { revenue: BigInt(row.revenue), expenses: BigInt(row.expenses) }]));
};

// Balances at the end of a month, per business. Balances add up every month so far.
export const balancesByBusiness = async (tx: Prisma.TransactionClient, businessIds: string[], asOfMonth: string) => {
  const rows = await tx.$queryRaw<
    { business_id: string; cash: string; receivable: string; payable: string; assets: string; liabilities: string }[]
  >`
    SELECT r.business_id,
      COALESCE(SUM(r.debit_minor - r.credit_minor) FILTER (WHERE f.id IS NOT NULL), 0)::text AS cash,
      COALESCE(SUM(r.debit_minor - r.credit_minor) FILTER (WHERE a.code = ${LedgerCode.ACCOUNTS_RECEIVABLE}), 0)::text AS receivable,
      COALESCE(SUM(r.credit_minor - r.debit_minor) FILTER (WHERE a.code = ${LedgerCode.ACCOUNTS_PAYABLE}), 0)::text AS payable,
      COALESCE(SUM(r.debit_minor - r.credit_minor) FILTER (WHERE a.type = 'ASSET'), 0)::text AS assets,
      COALESCE(SUM(r.credit_minor - r.debit_minor) FILTER (WHERE a.type = 'LIABILITY'), 0)::text AS liabilities
    FROM ledger_monthly_rollups r
    JOIN ledger_accounts a ON a.id = r.ledger_account_id
    LEFT JOIN financial_accounts f ON f.ledger_account_id = a.id
    WHERE r.business_id = ANY(${businessIds}::uuid[])
      AND r.month <= ${`${asOfMonth}-01`}::date
    GROUP BY r.business_id`;
  return new Map(rows.map((row) => [row.business_id, row]));
};

export const figuresFor = async (
  tx: Prisma.TransactionClient,
  businessIds: string[],
  from: string,
  to: string,
): Promise<Map<string, BusinessFigures>> => {
  const profit = await profitByBusiness(tx, businessIds, from, to);
  const balances = await balancesByBusiness(tx, businessIds, to);

  return new Map(
    businessIds.map((id) => {
      const earned = profit.get(id);
      const held = balances.get(id);
      const revenueMinor = earned?.revenue ?? 0n;
      const expensesMinor = earned?.expenses ?? 0n;
      return [
        id,
        {
          revenueMinor,
          expensesMinor,
          netProfitMinor: revenueMinor - expensesMinor,
          cashBalanceMinor: BigInt(held?.cash ?? 0),
          receivableMinor: BigInt(held?.receivable ?? 0),
          payableMinor: BigInt(held?.payable ?? 0),
          assetsMinor: BigInt(held?.assets ?? 0),
          liabilitiesMinor: BigInt(held?.liabilities ?? 0),
        },
      ];
    }),
  );
};

const monthlyTrend = async (tx: Prisma.TransactionClient, businessId: string, from: string, to: string) => {
  const rows = await tx.$queryRaw<{ month: Date; revenue: string; expenses: string }[]>`
    SELECT r.month,
      COALESCE(SUM(r.credit_minor - r.debit_minor) FILTER (WHERE a.type = 'REVENUE'), 0)::text AS revenue,
      COALESCE(SUM(r.debit_minor - r.credit_minor) FILTER (WHERE a.type = 'EXPENSE'), 0)::text AS expenses
    FROM ledger_monthly_rollups r
    JOIN ledger_accounts a ON a.id = r.ledger_account_id
    WHERE r.business_id = ${businessId}::uuid
      AND r.month BETWEEN ${`${from}-01`}::date AND ${`${to}-01`}::date
    GROUP BY r.month`;
  const byMonth = new Map(rows.map((row) => [dateToMonth(row.month), row]));

  // Months with no activity still appear, so a chart has no gaps.
  return monthsBetween(from, to).map((month) => {
    const row = byMonth.get(month);
    const revenueMinor = BigInt(row?.revenue ?? 0);
    const expensesMinor = BigInt(row?.expenses ?? 0);
    return { month, revenueMinor, expensesMinor, netProfitMinor: revenueMinor - expensesMinor };
  });
};

const topExpenses = async (tx: Prisma.TransactionClient, businessId: string, from: string, to: string, total: bigint) => {
  const rows = await tx.$queryRaw<{ id: string; code: string; name: string; name_bn: string | null; amount: string }[]>`
    SELECT a.id, a.code, a.name, a.name_bn, SUM(r.debit_minor - r.credit_minor)::text AS amount
    FROM ledger_monthly_rollups r
    JOIN ledger_accounts a ON a.id = r.ledger_account_id
    WHERE r.business_id = ${businessId}::uuid AND a.type = 'EXPENSE'
      AND r.month BETWEEN ${`${from}-01`}::date AND ${`${to}-01`}::date
    GROUP BY a.id
    HAVING SUM(r.debit_minor - r.credit_minor) <> 0
    ORDER BY SUM(r.debit_minor - r.credit_minor) DESC
    LIMIT ${TOP_EXPENSES}`;
  return rows.map((row) => ({
    ledgerAccountId: row.id,
    code: row.code,
    name: row.name,
    nameBn: row.name_bn,
    amountMinor: BigInt(row.amount),
    sharePercent: percentOf(BigInt(row.amount), total),
  }));
};

const dashboard = (business: BusinessContext, query: IDashboardQuery) => {
  const fallback = defaultRange(business);
  const fromMonth = query.fromMonth ?? fallback.fromMonth;
  const toMonth = query.toMonth ?? fallback.toMonth;
  assertMonthRange(fromMonth, toMonth);

  return withBusinessScope(business, async (tx) => {
    const figures = (await figuresFor(tx, [business.businessId], fromMonth, toMonth)).get(business.businessId)!;
    const accounts = await tx.financialAccount.findMany({
      where: { businessId: business.businessId, isActive: true },
      orderBy: { id: "asc" },
      select: { id: true, name: true, type: true, currency: true, currentBalanceMinor: true },
    });

    return {
      currency: business.baseCurrency,
      basis: "POSTED_ACTUALS" as const,
      fromMonth,
      toMonth,
      asOf: lastDayOfMonth(toMonth),
      revenueMinor: figures.revenueMinor,
      expensesMinor: figures.expensesMinor,
      netProfitMinor: figures.netProfitMinor,
      // Profit and cash differ whenever invoices or bills are unpaid, so both are always shown.
      cashBalanceMinor: figures.cashBalanceMinor,
      receivableMinor: figures.receivableMinor,
      payableMinor: figures.payableMinor,
      trend: await monthlyTrend(tx, business.businessId, fromMonth, toMonth),
      topExpenses: await topExpenses(tx, business.businessId, fromMonth, toMonth, figures.expensesMinor),
      accounts,
    };
  });
};

const METRICS = {
  REVENUE: (value: { revenue: bigint; expenses: bigint }) => value.revenue,
  EXPENSES: (value: { revenue: bigint; expenses: bigint }) => value.expenses,
  NET_PROFIT: (value: { revenue: bigint; expenses: bigint }) => value.revenue - value.expenses,
};

const compare = (business: BusinessContext, query: ICompareQuery) => {
  assertMonthRange(query.fromMonth, query.toMonth);
  assertMonthRange(query.compareFromMonth, query.compareToMonth);

  return withBusinessScope(business, async (tx) => {
    const valueOf = async (from: string, to: string) => {
      const row = (await profitByBusiness(tx, [business.businessId], from, to)).get(business.businessId);
      return METRICS[query.metric](row ?? { revenue: 0n, expenses: 0n });
    };
    const currentMinor = await valueOf(query.fromMonth, query.toMonth);
    const comparedToMinor = await valueOf(query.compareFromMonth, query.compareToMonth);
    const changeMinor = currentMinor - comparedToMinor;

    return {
      currency: business.baseCurrency,
      basis: "POSTED_ACTUALS" as const,
      metric: query.metric,
      current: { fromMonth: query.fromMonth, toMonth: query.toMonth, amountMinor: currentMinor },
      comparedTo: { fromMonth: query.compareFromMonth, toMonth: query.compareToMonth, amountMinor: comparedToMinor },
      changeMinor,
      // Against the size of the old figure, so a drop from a loss still reads the right way.
      changePercent: percentOf(changeMinor, comparedToMinor < 0n ? -comparedToMinor : comparedToMinor),
    };
  });
};

export const analyticsService = { dashboard, compare };

