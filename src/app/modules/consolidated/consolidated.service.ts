import { randomUUID } from "node:crypto";
import type { Prisma } from "../../../lib/prisma.js";
import { withRls } from "../../../lib/rls.js";
import { LedgerCode } from "../../constants/chartOfAccounts.js";
import { Permission } from "../../constants/permissions.js";
import { dateToMonth, fromDbDate, lastDayOfMonth, toDbDate } from "../../utils/dates.js";
import { AppError, ErrorCode } from "../../utils/errors.js";
import { convertMinor } from "../../utils/money.js";
import { credit, debit } from "../../utils/postingRules.js";
import type { RequestContext } from "../../utils/requestContext.js";
import { accountsService } from "../accounts/accounts.service.js";
import type { BusinessFigures } from "../analytics/analytics.interface.js";
import { assertMonthRange, figuresFor } from "../analytics/analytics.service.js";
import { auditService } from "../audit/audit.service.js";
import type { AuthContext } from "../auth/auth.interface.js";
import { exchangeRatesService } from "../exchange-rates/exchange-rates.service.js";
import { canPostToSoftClosed, journalsService } from "../journals/journals.service.js";
import { ledgerAccountsService } from "../ledger-accounts/ledger-accounts.service.js";
import type { BusinessContext } from "../members/members.interface.js";
import { membersService } from "../members/members.service.js";
import type { IConsolidatedQuery, ICreateTransferBody } from "./consolidated.interface.js";

const zeroFigures = (): BusinessFigures => ({
  revenueMinor: 0n,
  expensesMinor: 0n,
  netProfitMinor: 0n,
  cashBalanceMinor: 0n,
  receivableMinor: 0n,
  payableMinor: 0n,
  assetsMinor: 0n,
  liabilitiesMinor: 0n,
});

const FIGURE_KEYS = Object.keys(zeroFigures()) as (keyof BusinessFigures)[];

const mapFigures = (figures: BusinessFigures, change: (amount: bigint) => bigint) =>
  Object.fromEntries(FIGURE_KEYS.map((key) => [key, change(figures[key])])) as unknown as BusinessFigures;

const chooseReportingCurrency = (requested: string | undefined, currencies: string[]) => {
  if (requested) return requested;
  const unique = [...new Set(currencies)];
  if (unique.length > 1) throw new AppError(422, ErrorCode.REPORTING_CURRENCY_REQUIRED, { currencies: unique });
  return unique[0]!;
};

const dashboard = async (auth: AuthContext, query: IConsolidatedQuery) => {
  assertMonthRange(query.fromMonth, query.toMonth);

  const businesses = await membersService.listBusinessesWithPermission(auth.userId, Permission.FINANCE_READ, query.includeArchived);
  const businessIds = businesses.map((business) => business.id);
  const asOf = lastDayOfMonth(query.toMonth);

  if (businesses.length === 0) {
    return { reportingCurrency: query.reportingCurrency ?? null, asOf, fromMonth: query.fromMonth, toMonth: query.toMonth, businesses: [], totals: zeroFigures(), fxRates: [], eliminatedIntercompanyMinor: 0n, basis: "POSTED_ACTUALS" as const };
  }

  const reportingCurrency = chooseReportingCurrency(query.reportingCurrency, businesses.map((business) => business.baseCurrency));

  return withRls({ userId: auth.userId, workspaceId: auth.workspaceId, businessIds }, async (tx) => {
    const figures = await figuresFor(tx, businessIds, query.fromMonth, query.toMonth);

    // One rate per currency for the whole view: the one at the period's end, stated in the response.
    const rates = new Map<string, Awaited<ReturnType<typeof exchangeRatesService.resolve>>>();
    for (const currency of new Set(businesses.map((business) => business.baseCurrency))) {
      rates.set(currency, await exchangeRatesService.resolve(tx, auth.workspaceId, currency, reportingCurrency, asOf));
    }
    const toReporting = (amount: bigint, currency: string) => {
      const rate = rates.get(currency)!;
      return convertMinor(amount, rate.rate, currency, reportingCurrency, rate.inverted);
    };

    const totals = zeroFigures();
    const breakdown = businesses.map((business) => {
      const native = figures.get(business.id)!;
      const converted = mapFigures(native, (amount) => toReporting(amount, business.baseCurrency));
      for (const key of FIGURE_KEYS) totals[key] += converted[key];
      return { businessId: business.id, name: business.name, status: business.status, currency: business.baseCurrency, native, converted };
    });

    // Money between two of your own businesses is an asset in one and a debt in the other, so as a
    // group it nets out. Only pairs where you can see both sides can be removed.
    const transfers = await tx.intercompanyTransfer.findMany({
      where: {
        fromBusinessId: { in: businessIds },
        toBusinessId: { in: businessIds },
        transferDate: { lte: toDbDate(asOf) },
      },
      select: { amountMinor: true, currency: true },
    });
    const eliminatedIntercompanyMinor = transfers.reduce((sum, transfer) => sum + toReporting(transfer.amountMinor, transfer.currency), 0n);
    totals.assetsMinor -= eliminatedIntercompanyMinor;
    totals.liabilitiesMinor -= eliminatedIntercompanyMinor;

    return {
      reportingCurrency,
      asOf,
      fromMonth: query.fromMonth,
      toMonth: query.toMonth,
      basis: "POSTED_ACTUALS" as const,
      totals,
      eliminatedIntercompanyMinor,
      fxRates: [...rates.entries()]
        .filter(([currency]) => currency !== reportingCurrency)
        .map(([fromCurrency, rate]) => ({ fromCurrency, toCurrency: reportingCurrency, ...rate })),
      businesses: breakdown,
    };
  });
};

const contextOrThrow = async (userId: string, businessId: string) => {
  const business = await membersService.resolveContext(userId, businessId);
  if (!business) throw new AppError(404, ErrorCode.NOT_FOUND);
  if (!business.permissions.includes(Permission.LEDGER_POST)) {
    throw new AppError(403, ErrorCode.PERMISSION_DENIED, { permission: Permission.LEDGER_POST });
  }
  if (business.businessStatus !== "ACTIVE") {
    throw new AppError(409, ErrorCode.BUSINESS_NOT_ACTIVE, { status: business.businessStatus });
  }
  return business;
};

const baseAccount = async (tx: Prisma.TransactionClient, business: BusinessContext, accountId: string) => {
  const account = await accountsService.getUsable(tx, business.businessId, accountId);
  if (account.currency !== business.baseCurrency) {
    throw new AppError(422, ErrorCode.FOREIGN_CURRENCY_NOT_SUPPORTED, { currency: account.currency });
  }
  return accountsService.ledgerIdOf(account);
};

// One transfer, two sets of books, one database transaction: both journals post, or neither.
//   Paying business:   Dr 1300 Due From Other Businesses   Cr its bank
//   Receiving business: Dr its bank                         Cr 2300 Due To Other Businesses
// Neither side touches revenue or expense.
const createTransfer = async (auth: AuthContext, body: ICreateTransferBody, context: RequestContext) => {
  const from = await contextOrThrow(auth.userId, body.fromBusinessId);
  const to = await contextOrThrow(auth.userId, body.toBusinessId);
  if (from.baseCurrency !== to.baseCurrency) {
    throw new AppError(422, ErrorCode.INTERCOMPANY_INVALID, { from: from.baseCurrency, to: to.baseCurrency });
  }

  const amount = BigInt(body.amountMinor);
  const entryDate = toDbDate(body.transferDate);
  const groupId = randomUUID();
  const memo = body.memo ?? `Transfer ${from.businessId} to ${to.businessId}`;

  const transfer = await withRls({ userId: auth.userId, businessIds: [from.businessId, to.businessId] }, async (tx) => {
    const fromBank = await baseAccount(tx, from, body.fromAccountId);
    const toBank = await baseAccount(tx, to, body.toAccountId);
    const dueFrom = await ledgerAccountsService.getByCode(tx, from.businessId, LedgerCode.DUE_FROM_BUSINESSES);
    const dueTo = await ledgerAccountsService.getByCode(tx, to.businessId, LedgerCode.DUE_TO_BUSINESSES);

    const sides = [
      { business: from, lines: [debit(dueFrom.id, amount), credit(fromBank, amount)] },
      { business: to, lines: [debit(toBank, amount), credit(dueTo.id, amount)] },
    ];
    // Always the same order, so two opposite transfers at once can't deadlock on the audit locks.
    const ordered = [...sides].sort((a, b) => (a.business.businessId < b.business.businessId ? -1 : 1));

    const entryIds = new Map<string, string>();
    for (const side of ordered) {
      const entry = await journalsService.post(tx, side.business, {
        entryDate,
        kind: "STANDARD",
        memo,
        sourceType: "intercompany",
        sourceId: groupId,
        allowSoftClosed: canPostToSoftClosed(side.business),
        lines: side.lines,
      });
      entryIds.set(side.business.businessId, entry.id);
    }

    const created = await tx.intercompanyTransfer.create({
      data: {
        id: groupId,
        fromBusinessId: from.businessId,
        toBusinessId: to.businessId,
        fromEntryId: entryIds.get(from.businessId)!,
        toEntryId: entryIds.get(to.businessId)!,
        amountMinor: amount,
        currency: from.baseCurrency,
        transferDate: entryDate,
        memo: body.memo ?? null,
        createdBy: auth.userId,
      },
    });

    for (const side of ordered) {
      await auditService.recordForBusiness(tx, side.business, {
        action: "intercompany.transferred",
        context,
        entityType: "intercompany_transfer",
        entityId: created.id,
        after: { fromBusinessId: from.businessId, toBusinessId: to.businessId, amountMinor: amount },
      });
    }
    return created;
  });

  return { ...transfer, transferDate: fromDbDate(transfer.transferDate) };
};

const listTransfers = async (auth: AuthContext) => {
  const businesses = await membersService.listBusinessesWithPermission(auth.userId, Permission.FINANCE_READ, true);
  const businessIds = businesses.map((business) => business.id);

  const rows = await withRls({ userId: auth.userId, businessIds }, (tx) =>
    tx.intercompanyTransfer.findMany({ orderBy: { id: "desc" }, take: 200 }),
  );
  return rows.map((row) => ({ ...row, transferDate: fromDbDate(row.transferDate), month: dateToMonth(row.transferDate) }));
};

export const consolidatedService = { dashboard, createTransfer, listTransfers };
