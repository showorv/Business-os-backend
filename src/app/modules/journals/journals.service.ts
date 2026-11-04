import * as Sentry from "@sentry/node";
import type { Prisma } from "../../../lib/prisma.js";
import { withBusinessScope } from "../../../lib/rls.js";
import { LedgerCode } from "../../constants/chartOfAccounts.js";
import { Permission } from "../../constants/permissions.js";
import { fromDbDate, todayInTimezone, toDbDate } from "../../utils/dates.js";
import { AppError, ErrorCode, isUniqueViolation } from "../../utils/errors.js";
import { type IdempotencyRequest, withIdempotency } from "../../utils/idempotency.js";
import { EventType, publishEvent } from "../../utils/outbox.js";
import { pageArgs, toPage } from "../../utils/pagination.js";
import { credit, debit, swapSides, totals, type JournalLineInput } from "../../utils/postingRules.js";
import type { RequestContext } from "../../utils/requestContext.js";
import { nextSequence } from "../../utils/sequences.js";
import { auditService } from "../audit/audit.service.js";
import type { FiscalActor } from "../fiscal-periods/fiscal-periods.interface.js";
import { fiscalPeriodsService } from "../fiscal-periods/fiscal-periods.service.js";
import type { LedgerActor } from "../ledger-accounts/ledger-accounts.interface.js";
import { ledgerAccountsService } from "../ledger-accounts/ledger-accounts.service.js";
import type { BusinessContext } from "../members/members.interface.js";
import type { ICreateJournalBody, IListJournalsQuery, IReverseJournalBody, PostInput, ReverseOptions } from "./journals.interface.js";

const REVERSIBLE_KINDS = ["STANDARD", "ADJUSTING"];

export const canPostToSoftClosed = (business: BusinessContext) => business.permissions.includes(Permission.BUSINESS_MANAGE);

const toEntryDto = <T extends { entryDate: Date }>(entry: T) => ({ ...entry, entryDate: fromDbDate(entry.entryDate) });

// Keeps the financial account's cached balance in step with the ledger. Updating in a fixed order
// means two transfers between the same accounts cannot deadlock each other.
const applyToAccountBalances = async (tx: Prisma.TransactionClient, businessId: string, lines: JournalLineInput[]) => {
  const netByLedger = new Map<string, bigint>();
  for (const line of lines) {
    const current = netByLedger.get(line.ledgerAccountId) ?? 0n;
    netByLedger.set(line.ledgerAccountId, current + line.debitMinor - line.creditMinor);
  }

  const backed = await tx.financialAccount.findMany({
    where: { businessId, ledgerAccountId: { in: [...netByLedger.keys()] } },
    select: { id: true, ledgerAccountId: true },
    orderBy: { id: "asc" },
  });
  for (const account of backed) {
    await tx.financialAccount.update({
      where: { id: account.id },
      data: { currentBalanceMinor: { increment: netByLedger.get(account.ledgerAccountId!)! } },
    });
  }
};

// The posting engine. This is the only place in the system that writes to the ledger, and it runs
// inside the caller's transaction, so the journal commits together with whatever caused it.
const post = async (tx: Prisma.TransactionClient, actor: LedgerActor & FiscalActor, input: PostInput) => {
  const sums = totals(input.lines);
  if (sums.debit !== sums.credit || input.lines.length < 2) {
    // Callers validate input first, so reaching here means a bug in a posting rule. The database
    // would refuse it at COMMIT anyway, but this makes sure someone hears about it.
    const error = new Error(`unbalanced journal: debit ${sums.debit} credit ${sums.credit}`);
    Sentry.captureException(error, { tags: { business_id: actor.businessId, kind: input.kind } });
    throw error;
  }

  const fiscalPeriodId = await fiscalPeriodsService.resolveForPosting(tx, actor, input.entryDate, input);

  const year = input.entryDate.getUTCFullYear();
  const sequence = await nextSequence(tx, actor.businessId, `journal:${year}`);

  const entry = await tx.journalEntry.create({
    data: {
      workspaceId: actor.workspaceId,
      businessId: actor.businessId,
      fiscalPeriodId,
      entryNo: `JE-${year}-${sequence}`,
      entryDate: input.entryDate,
      kind: input.kind,
      memo: input.memo ?? null,
      postedBy: actor.userId,
      ...(input.sourceType ? { sourceType: input.sourceType } : {}),
      ...(input.sourceId ? { sourceId: input.sourceId } : {}),
      ...(input.reversesId ? { reversesId: input.reversesId } : {}),
    },
  });

  await tx.journalLine.createMany({
    data: input.lines.map((line, index) => ({
      workspaceId: actor.workspaceId,
      businessId: actor.businessId,
      journalEntryId: entry.id,
      ledgerAccountId: line.ledgerAccountId,
      lineNo: index + 1,
      debitMinor: line.debitMinor,
      creditMinor: line.creditMinor,
      currency: actor.baseCurrency,
      baseAmountMinor: line.debitMinor - line.creditMinor,
      memo: line.memo ?? null,
    })),
  });

  await applyToAccountBalances(tx, actor.businessId, input.lines);

  // The monthly rollup needs nothing here: a trigger on journal_lines keeps it in step.
  await publishEvent(tx, actor, EventType.JOURNAL_POSTED, { entryId: entry.id, entryDate: fromDbDate(input.entryDate) });
  return entry;
};

// A correction is a new entry with debit and credit swapped. The original stays untouched.
const reverse = async (
  tx: Prisma.TransactionClient,
  actor: LedgerActor & FiscalActor,
  entryId: string,
  options: ReverseOptions,
) => {
  const original = await tx.journalEntry.findFirst({
    where: { id: entryId, businessId: actor.businessId },
    include: { lines: { orderBy: { lineNo: "asc" } }, reversedBy: { select: { id: true } } },
  });
  if (!original) throw new AppError(404, ErrorCode.NOT_FOUND);
  if (!REVERSIBLE_KINDS.includes(original.kind)) {
    throw new AppError(409, ErrorCode.JOURNAL_NOT_REVERSIBLE, { kind: original.kind });
  }
  if (original.reversedBy) throw new AppError(409, ErrorCode.JOURNAL_ALREADY_REVERSED);
  if (options.entryDate < original.entryDate) {
    throw new AppError(422, ErrorCode.REVERSAL_DATE_INVALID, { earliest: fromDbDate(original.entryDate) });
  }

  return post(tx, actor, {
    ...options,
    kind: "REVERSAL",
    reversesId: original.id,
    memo: options.memo ?? `Reversal of ${original.entryNo}`,
    ...(original.sourceType ? { sourceType: original.sourceType } : {}),
    ...(original.sourceId ? { sourceId: original.sourceId } : {}),
    lines: original.lines.map((line) =>
      swapSides({
        ledgerAccountId: line.ledgerAccountId,
        debitMinor: line.debitMinor,
        creditMinor: line.creditMinor,
        ...(line.memo ? { memo: line.memo } : {}),
      }),
    ),
  });
};

const hasPostedEntries = async (tx: Prisma.TransactionClient, businessId: string) =>
  (await tx.journalEntry.count({ where: { businessId }, take: 1 })) > 0;

// ---------------------------------------------------------------------------
// API: manual journals
// ---------------------------------------------------------------------------

const createManual = (
  business: BusinessContext,
  body: ICreateJournalBody,
  idempotency: IdempotencyRequest | null,
  context: RequestContext,
) =>
  withBusinessScope(business, (tx) =>
    withIdempotency(tx, business.userId, idempotency, 201, async () => {
      const lines = body.lines.map((line) => ({
        ledgerAccountId: line.ledgerAccountId,
        debitMinor: BigInt(line.debitMinor),
        creditMinor: BigInt(line.creditMinor),
        ...(line.memo ? { memo: line.memo } : {}),
      }));

      const sums = totals(lines);
      if (sums.debit !== sums.credit) {
        throw new AppError(422, ErrorCode.JOURNAL_UNBALANCED, { debit: String(sums.debit), credit: String(sums.credit) });
      }
      await ledgerAccountsService.assertAllUsable(tx, business.businessId, lines.map((line) => line.ledgerAccountId));

      const entry = await post(tx, business, {
        entryDate: toDbDate(body.entryDate),
        kind: body.kind,
        memo: body.memo,
        lines,
        allowSoftClosed: canPostToSoftClosed(business),
      });
      await auditService.recordForBusiness(tx, business, {
        action: "journal.posted",
        context,
        entityType: "journal_entry",
        entityId: entry.id,
        after: { entryNo: entry.entryNo, kind: entry.kind, memo: body.memo, totalMinor: sums.debit },
      });
      return toEntryDto(entry);
    }),
  );

const list = async (business: BusinessContext, query: IListJournalsQuery) => {
  const rows = await withBusinessScope(business, (tx) =>
    tx.journalEntry.findMany({
      where: {
        businessId: business.businessId,
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.ledgerAccountId ? { lines: { some: { ledgerAccountId: query.ledgerAccountId } } } : {}),
        ...(query.from || query.to
          ? {
              entryDate: {
                ...(query.from ? { gte: toDbDate(query.from) } : {}),
                ...(query.to ? { lte: toDbDate(query.to) } : {}),
              },
            }
          : {}),
      },
      orderBy: [{ entryDate: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    }),
  );
  const page = toPage(rows, query.limit);
  return { ...page, items: page.items.map(toEntryDto) };
};

const getOne = async (business: BusinessContext, journalId: string) => {
  const entry = await withBusinessScope(business, (tx) =>
    tx.journalEntry.findFirst({
      where: { id: journalId, businessId: business.businessId },
      include: {
        reversedBy: { select: { id: true, entryNo: true } },
        lines: {
          orderBy: { lineNo: "asc" },
          select: {
            id: true,
            lineNo: true,
            debitMinor: true,
            creditMinor: true,
            currency: true,
            memo: true,
            ledgerAccount: { select: { id: true, code: true, name: true, nameBn: true, type: true } },
          },
        },
      },
    }),
  );
  if (!entry) throw new AppError(404, ErrorCode.NOT_FOUND);
  return toEntryDto(entry);
};

const reverseManual = async (
  business: BusinessContext,
  journalId: string,
  body: IReverseJournalBody,
  context: RequestContext,
) => {
  try {
    return await withBusinessScope(business, async (tx) => {
      const original = await tx.journalEntry.findFirst({
        where: { id: journalId, businessId: business.businessId },
        select: { sourceType: true },
      });
      // A transaction's journal is reversed through the transaction, so the two can't disagree.
      if (original?.sourceType) throw new AppError(409, ErrorCode.JOURNAL_HAS_SOURCE, { sourceType: original.sourceType });

      const entry = await reverse(tx, business, journalId, {
        entryDate: toDbDate(body.entryDate ?? todayInTimezone(business.timezone)),
        memo: body.memo,
        allowSoftClosed: canPostToSoftClosed(business),
      });
      await auditService.recordForBusiness(tx, business, {
        action: "journal.reversed",
        context,
        entityType: "journal_entry",
        entityId: journalId,
        after: { reversalId: entry.id, reversalNo: entry.entryNo },
      });
      return toEntryDto(entry);
    });
  } catch (error) {
    // Two reversals at the same moment: the unique index lets only one through.
    throw isUniqueViolation(error) ? new AppError(409, ErrorCode.JOURNAL_ALREADY_REVERSED) : error;
  }
};

// ---------------------------------------------------------------------------
// Year-end close
// ---------------------------------------------------------------------------

// Moves the year's revenue and expense balances into Retained Earnings, so next year starts at
// zero, then closes every period in the year.
const closeYear = (business: BusinessContext, fiscalYear: number, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    const year = await fiscalPeriodsService.getYearForClosing(tx, business.businessId, fiscalYear);

    const startDay = fromDbDate(year.startDate);
    const endDay = fromDbDate(year.endDate);
    const balances = await tx.$queryRaw<{ ledger_account_id: string; net: string }[]>`
      SELECT l.ledger_account_id, SUM(l.debit_minor - l.credit_minor)::text AS net
      FROM journal_lines l
      JOIN journal_entries e ON e.id = l.journal_entry_id
      JOIN ledger_accounts a ON a.id = l.ledger_account_id
      WHERE e.business_id = ${business.businessId}::uuid
        AND e.entry_date BETWEEN ${startDay}::date AND ${endDay}::date
        AND a.type IN ('REVENUE', 'EXPENSE')
      GROUP BY l.ledger_account_id
      HAVING SUM(l.debit_minor - l.credit_minor) <> 0`;

    // A positive net is a debit balance, so it is closed with a credit, and the reverse.
    const lines = balances.map(({ ledger_account_id: id, net }) => {
      const amount = BigInt(net);
      return amount > 0n ? credit(id, amount) : debit(id, -amount);
    });
    const netProfit = -balances.reduce((sum, row) => sum + BigInt(row.net), 0n);

    let entryNo: string | null = null;
    if (lines.length > 0) {
      if (netProfit !== 0n) {
        const retained = await ledgerAccountsService.getByCode(tx, business.businessId, LedgerCode.RETAINED_EARNINGS);
        lines.push(netProfit > 0n ? credit(retained.id, netProfit) : debit(retained.id, -netProfit));
      }
      const entry = await post(tx, business, {
        entryDate: year.endDate,
        kind: "CLOSING",
        memo: `Year-end close ${fiscalYear}`,
        sourceType: "fiscal_year",
        lines,
        allowSoftClosed: true,
      });
      entryNo = entry.entryNo;
    }

    await fiscalPeriodsService.closeYearPeriods(tx, business.businessId, fiscalYear, business.userId);
    await fiscalPeriodsService.ensureYear(tx, business, fiscalYear + 1);

    await auditService.recordForBusiness(tx, business, {
      action: "fiscal_year.closed",
      context,
      entityType: "business",
      entityId: business.businessId,
      after: { fiscalYear, netProfitMinor: netProfit, closingEntryNo: entryNo },
    });
    return { fiscalYear, netProfitMinor: netProfit, closingEntryNo: entryNo };
  });

export const journalsService = {
  post,
  reverse,
  hasPostedEntries,
  createManual,
  list,
  getOne,
  reverseManual,
  closeYear,
};
