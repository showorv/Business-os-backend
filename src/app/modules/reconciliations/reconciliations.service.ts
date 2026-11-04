import type { Prisma } from "../../../lib/prisma.js";
import { withBusinessScope } from "../../../lib/rls.js";
import { LedgerCode } from "../../constants/chartOfAccounts.js";
import { Permission } from "../../constants/permissions.js";
import { fromDbDate, toDbDate } from "../../utils/dates.js";
import { AppError, ErrorCode, isUniqueViolation } from "../../utils/errors.js";
import { credit, debit } from "../../utils/postingRules.js";
import type { RequestContext } from "../../utils/requestContext.js";
import { accountsService } from "../accounts/accounts.service.js";
import { auditService } from "../audit/audit.service.js";
import { canPostToSoftClosed, journalsService } from "../journals/journals.service.js";
import { ledgerAccountsService } from "../ledger-accounts/ledger-accounts.service.js";
import type { BusinessContext } from "../members/members.interface.js";
import type { ICreateReconciliationBody, IListReconciliationsQuery } from "./reconciliations.interface.js";

// A reconciliation compares a bank statement with the books:
//   cleared balance = every journal line matched to a statement so far, for this account
//   difference      = statement balance - cleared balance
// It can only close at zero, or with an approved adjustment for what's left.

const toDto = <T extends { statementDate: Date }>(reconciliation: T) => ({
  ...reconciliation,
  statementDate: fromDbDate(reconciliation.statementDate),
});

const findOrThrow = async (tx: Prisma.TransactionClient, businessId: string, reconciliationId: string) => {
  const reconciliation = await tx.reconciliation.findFirst({
    where: { id: reconciliationId, businessId },
    include: { financialAccount: { select: { id: true, ledgerAccountId: true, name: true } } },
  });
  if (!reconciliation) throw new AppError(404, ErrorCode.NOT_FOUND);
  return reconciliation;
};

const assertOpen = (status: string) => {
  if (status !== "OPEN") throw new AppError(409, ErrorCode.RECONCILIATION_CLOSED);
};

const balancesFor = async (
  tx: Prisma.TransactionClient,
  businessId: string,
  ledgerAccountId: string,
  statementDate: Date,
  statementBalance: bigint,
) => {
  const statementDay = fromDbDate(statementDate);
  const [row] = await tx.$queryRaw<{ cleared: string; book: string }[]>`
    SELECT
      COALESCE(SUM(l.debit_minor - l.credit_minor) FILTER (WHERE r.journal_line_id IS NOT NULL), 0)::text AS cleared,
      COALESCE(SUM(l.debit_minor - l.credit_minor), 0)::text AS book
    FROM journal_lines l
    JOIN journal_entries e ON e.id = l.journal_entry_id
    LEFT JOIN reconciliation_lines r ON r.journal_line_id = l.id
    WHERE l.business_id = ${businessId}::uuid
      AND l.ledger_account_id = ${ledgerAccountId}::uuid
      AND e.entry_date <= ${statementDay}::date`;
  const clearedMinor = BigInt(row!.cleared);
  return { clearedMinor, bookBalanceMinor: BigInt(row!.book), differenceMinor: statementBalance - clearedMinor };
};

const create = async (business: BusinessContext, body: ICreateReconciliationBody, context: RequestContext) => {
  try {
    const reconciliation = await withBusinessScope(business, async (tx) => {
      const account = await accountsService.getUsable(tx, business.businessId, body.financialAccountId);
      accountsService.ledgerIdOf(account);

      const created = await tx.reconciliation.create({
        data: {
          workspaceId: business.workspaceId,
          businessId: business.businessId,
          financialAccountId: account.id,
          statementDate: toDbDate(body.statementDate),
          statementBalanceMinor: BigInt(body.statementBalanceMinor),
          createdBy: business.userId,
        },
      });
      await auditService.recordForBusiness(tx, business, {
        action: "reconciliation.started",
        context,
        entityType: "reconciliation",
        entityId: created.id,
        after: { accountName: account.name, statementDate: body.statementDate, statementBalanceMinor: body.statementBalanceMinor },
      });
      return created;
    });
    return toDto(reconciliation);
  } catch (error) {
    throw isUniqueViolation(error) ? new AppError(409, ErrorCode.RECONCILIATION_ALREADY_OPEN) : error;
  }
};

const list = async (business: BusinessContext, query: IListReconciliationsQuery) => {
  const rows = await withBusinessScope(business, (tx) =>
    tx.reconciliation.findMany({
      where: {
        businessId: business.businessId,
        ...(query.financialAccountId ? { financialAccountId: query.financialAccountId } : {}),
      },
      orderBy: { id: "desc" },
      take: 100,
    }),
  );
  return rows.map(toDto);
};

const UNMATCHED_LINE_LIMIT = 500;

// The working view: the current difference, and the lines still waiting to be matched.
const getOne = (business: BusinessContext, reconciliationId: string) =>
  withBusinessScope(business, async (tx) => {
    const reconciliation = await findOrThrow(tx, business.businessId, reconciliationId);
    const ledgerAccountId = reconciliation.financialAccount.ledgerAccountId!;

    const balances = await balancesFor(
      tx,
      business.businessId,
      ledgerAccountId,
      reconciliation.statementDate,
      reconciliation.statementBalanceMinor,
    );
    const unmatchedLines = await tx.journalLine.findMany({
      where: {
        businessId: business.businessId,
        ledgerAccountId,
        reconciliation: null,
        entry: { entryDate: { lte: reconciliation.statementDate } },
      },
      take: UNMATCHED_LINE_LIMIT,
      orderBy: { id: "asc" },
      select: {
        id: true,
        debitMinor: true,
        creditMinor: true,
        memo: true,
        entry: { select: { entryNo: true, entryDate: true, memo: true } },
      },
    });

    return {
      ...toDto(reconciliation),
      ...balances,
      unmatchedLines: unmatchedLines.map(({ entry, ...line }) => ({
        ...line,
        entryNo: entry.entryNo,
        entryDate: fromDbDate(entry.entryDate),
        entryMemo: entry.memo,
      })),
    };
  });

const matchLines = (business: BusinessContext, reconciliationId: string, journalLineIds: string[]) =>
  withBusinessScope(business, async (tx) => {
    const reconciliation = await findOrThrow(tx, business.businessId, reconciliationId);
    assertOpen(reconciliation.status);

    // Every line must be on this account, dated on or before the statement, and not already matched.
    const usable = await tx.journalLine.count({
      where: {
        id: { in: journalLineIds },
        businessId: business.businessId,
        ledgerAccountId: reconciliation.financialAccount.ledgerAccountId!,
        reconciliation: null,
        entry: { entryDate: { lte: reconciliation.statementDate } },
      },
    });
    const requested = new Set(journalLineIds).size;
    if (usable !== requested) throw new AppError(422, ErrorCode.JOURNAL_LINE_NOT_MATCHABLE, { requested, usable });

    await tx.reconciliationLine.createMany({
      data: journalLineIds.map((journalLineId) => ({ reconciliationId, journalLineId, businessId: business.businessId })),
      skipDuplicates: true,
    });
    return balancesFor(
      tx,
      business.businessId,
      reconciliation.financialAccount.ledgerAccountId!,
      reconciliation.statementDate,
      reconciliation.statementBalanceMinor,
    );
  });

const unmatchLine = (business: BusinessContext, reconciliationId: string, journalLineId: string) =>
  withBusinessScope(business, async (tx) => {
    const reconciliation = await findOrThrow(tx, business.businessId, reconciliationId);
    assertOpen(reconciliation.status);
    const { count } = await tx.reconciliationLine.deleteMany({ where: { reconciliationId, journalLineId } });
    if (count === 0) throw new AppError(404, ErrorCode.NOT_FOUND);
  });

// A positive difference means the bank has more than the books: Dr the account, Cr adjustments.
const postAdjustment = async (
  tx: Prisma.TransactionClient,
  business: BusinessContext,
  reconciliation: { id: string; statementDate: Date; financialAccount: { name: string; ledgerAccountId: string | null } },
  difference: bigint,
) => {
  const bankLedgerId = reconciliation.financialAccount.ledgerAccountId!;
  const adjustments = await ledgerAccountsService.getByCode(tx, business.businessId, LedgerCode.RECONCILIATION_ADJUSTMENT);
  const amount = difference > 0n ? difference : -difference;

  const entry = await journalsService.post(tx, business, {
    entryDate: reconciliation.statementDate,
    kind: "ADJUSTING",
    memo: `Reconciliation adjustment: ${reconciliation.financialAccount.name}`,
    sourceType: "reconciliation",
    sourceId: reconciliation.id,
    allowSoftClosed: canPostToSoftClosed(business),
    lines:
      difference > 0n
        ? [debit(bankLedgerId, amount), credit(adjustments.id, amount)]
        : [debit(adjustments.id, amount), credit(bankLedgerId, amount)],
  });

  // The adjustment's own bank line counts as matched, which is what brings the difference to zero.
  const bankLine = await tx.journalLine.findFirstOrThrow({
    where: { journalEntryId: entry.id, ledgerAccountId: bankLedgerId },
    select: { id: true },
  });
  await tx.reconciliationLine.create({
    data: { reconciliationId: reconciliation.id, journalLineId: bankLine.id, businessId: business.businessId },
  });
  return entry;
};

const close = (business: BusinessContext, reconciliationId: string, adjust: boolean, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    const reconciliation = await findOrThrow(tx, business.businessId, reconciliationId);
    assertOpen(reconciliation.status);
    const ledgerAccountId = reconciliation.financialAccount.ledgerAccountId!;

    const before = await balancesFor(
      tx,
      business.businessId,
      ledgerAccountId,
      reconciliation.statementDate,
      reconciliation.statementBalanceMinor,
    );

    let adjustmentEntryId: string | null = null;
    if (before.differenceMinor !== 0n) {
      if (!adjust) {
        throw new AppError(409, ErrorCode.RECONCILIATION_DIFFERENCE, { differenceMinor: String(before.differenceMinor) });
      }
      // Writing off a difference is an approval, not just a posting.
      if (!business.permissions.includes(Permission.TRANSACTIONS_APPROVE)) {
        throw new AppError(403, ErrorCode.PERMISSION_DENIED, { permission: Permission.TRANSACTIONS_APPROVE });
      }
      adjustmentEntryId = (await postAdjustment(tx, business, reconciliation, before.differenceMinor)).id;
    }

    const after = await balancesFor(
      tx,
      business.businessId,
      ledgerAccountId,
      reconciliation.statementDate,
      reconciliation.statementBalanceMinor,
    );
    const closed = await tx.reconciliation.update({
      where: { id: reconciliationId },
      data: {
        status: "CLOSED",
        bookBalanceMinor: after.bookBalanceMinor,
        // The difference found before any adjustment, so the record shows what was written off.
        differenceMinor: before.differenceMinor,
        adjustmentEntryId,
        closedAt: new Date(),
        closedBy: business.userId,
      },
    });
    await auditService.recordForBusiness(tx, business, {
      action: "reconciliation.closed",
      context,
      entityType: "reconciliation",
      entityId: reconciliationId,
      after: { differenceMinor: before.differenceMinor, adjustmentEntryId },
    });
    return toDto(closed);
  });

export const reconciliationsService = { create, list, getOne, matchLines, unmatchLine, close };
