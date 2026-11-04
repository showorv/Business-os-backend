import type { Prisma } from "../../../lib/prisma.js";
import { prisma } from "../../../lib/prisma.js";
import { withBusinessScope } from "../../../lib/rls.js";
import { Permission } from "../../constants/permissions.js";
import type { CanonicalLine } from "../../integrations/adapter.js";
import { fromDbDate, toDbDate } from "../../utils/dates.js";
import { AppError, ErrorCode } from "../../utils/errors.js";
import { pageArgs, toPage } from "../../utils/pagination.js";
import type { RequestContext } from "../../utils/requestContext.js";
import { auditService } from "../audit/audit.service.js";
import type { BusinessContext } from "../members/members.interface.js";
import { statementRulesService } from "../statement-rules/statement-rules.service.js";
import { transactionsService, type TransactionOrigin } from "../transactions/transactions.service.js";
import type { ICategorizeBody, IListLinesQuery, IMatchBody, IRunMatcherBody, ISplitBody, ISummaryQuery, MatchedBy } from "./statement-lines.interface.js";

const INSERT_BATCH = 1000;
// A payment and its statement line can be a few days apart.
const DATE_WINDOW_DAYS = 3;
const MIN_WORD_LENGTH = 4;
const MAX_MATCHER_LINES = 2000;

type StoredLine = Prisma.StatementLineGetPayload<object>;

const toDto = <T extends { txnDate: Date }>(line: T) => ({ ...line, txnDate: fromDbDate(line.txnDate) });

// ---------------------------------------------------------------------------
// Bringing lines in
// ---------------------------------------------------------------------------

// Every source ends here. Repeats are skipped by the unique hash, which is what makes importing the
// same file twice, or a sync that restarts, harmless. Runs in the caller's transaction.
const ingest = async (
  tx: Prisma.TransactionClient,
  owner: { workspaceId: string; businessId: string; financialAccountId: string; connectionId?: string; importId?: string },
  lines: { line: CanonicalLine; dedupeHash: string }[],
) => {
  const created: string[] = [];
  for (let start = 0; start < lines.length; start += INSERT_BATCH) {
    const rows = await tx.statementLine.createManyAndReturn({
      data: lines.slice(start, start + INSERT_BATCH).map(({ line, dedupeHash }) => ({
        ...owner,
        ...line,
        txnDate: toDbDate(line.txnDate),
        dedupeHash,
      })),
      skipDuplicates: true,
      select: { id: true },
    });
    created.push(...rows.map((row) => row.id));
  }
  return { created, skipped: lines.length - created.length };
};

// ---------------------------------------------------------------------------
// Finding what a line matches
// ---------------------------------------------------------------------------

interface Candidate {
  journal_line_id: string;
  entry_no: string;
  entry_date: Date;
  memo: string | null;
  reference_no: string | null;
  description: string | null;
  transaction_id: string | null;
}

// Journal lines on this account with the same amount and side, close in date, not already settling
// another statement line, and not reversed. Money in is a debit on an asset account.
const findCandidates = (tx: Prisma.TransactionClient, line: StoredLine, ledgerAccountId: string, windowDays = DATE_WINDOW_DAYS) => {
  const debit = line.direction === "IN" ? line.amountMinor : 0n;
  const credit = line.direction === "OUT" ? line.amountMinor : 0n;
  const day = fromDbDate(line.txnDate);
  return tx.$queryRaw<Candidate[]>`
    SELECT l.id AS journal_line_id, e.entry_no, e.entry_date, e.memo, t.reference_no, t.description, t.id AS transaction_id
    FROM journal_lines l
    JOIN journal_entries e ON e.id = l.journal_entry_id
    LEFT JOIN transactions t ON t.journal_entry_id = e.id
    WHERE l.business_id = ${line.businessId}::uuid
      AND l.ledger_account_id = ${ledgerAccountId}::uuid
      AND l.debit_minor = ${debit}
      AND l.credit_minor = ${credit}
      AND e.entry_date BETWEEN ${day}::date - ${windowDays}::int AND ${day}::date + ${windowDays}::int
      AND e.reverses_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_id = e.id)
      AND NOT EXISTS (SELECT 1 FROM statement_line_links k WHERE k.journal_line_id = l.id)
    ORDER BY abs(e.entry_date - ${day}::date), l.id
    LIMIT 20`;
};

const wordsOf = (text: string | null) =>
  (text ?? "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= MIN_WORD_LENGTH);

const sharesAWord = (line: StoredLine, candidate: Candidate) => {
  const candidateText = `${candidate.description ?? ""} ${candidate.memo ?? ""}`.toLowerCase();
  return [...wordsOf(line.description), ...wordsOf(line.counterparty)].some((word) => candidateText.includes(word));
};

// The document's matcher, strictest first. A wrong automatic match is worse than asking, so anything
// unclear stays in the review inbox.
const pickMatch = (line: StoredLine, candidates: Candidate[]): { candidate: Candidate; matchedBy: MatchedBy } | null => {
  const reference = line.reference?.toLowerCase();
  if (reference) {
    const exact = candidates.filter((candidate) => candidate.reference_no?.toLowerCase() === reference);
    if (exact.length === 1) return { candidate: exact[0]!, matchedBy: "REFERENCE" };
  }
  // Only one possibility, and either on the very same day or the words agree.
  if (candidates.length !== 1) return null;
  const only = candidates[0]!;
  const sameDay = fromDbDate(only.entry_date) === fromDbDate(line.txnDate);
  return sameDay || sharesAWord(line, only) ? { candidate: only, matchedBy: "AMOUNT_DATE" } : null;
};

const ledgerIdOfAccount = async (tx: Prisma.TransactionClient, financialAccountId: string) => {
  const account = await tx.financialAccount.findUniqueOrThrow({ where: { id: financialAccountId }, select: { ledgerAccountId: true } });
  if (!account.ledgerAccountId) throw new AppError(409, ErrorCode.BUSINESS_NOT_PROVISIONED);
  return account.ledgerAccountId;
};

const settleLine = async (tx: Prisma.TransactionClient, lineId: string, status: "MATCHED" | "AWAITING_POSTING", matchedBy: MatchedBy) =>
  tx.statementLine.update({ where: { id: lineId }, data: { status, matchedBy, lastMatchError: null } });

// ---------------------------------------------------------------------------
// Turning a line into a transaction
// ---------------------------------------------------------------------------

const originOf = (line: StoredLine, part?: number): TransactionOrigin => ({
  source: line.connectionId ? "SYNC" : "IMPORT",
  providerTxnId: `statement:${line.id}${part === undefined ? "" : `:${part}`}`,
});

// A statement shows the total that left the account. A transfer's fee posts separately to Bank Charges,
// so the transfer is that total less the fee. Income and expense have no fee of their own in the books:
// the whole amount goes to the category, and split is there to show a fee on its own.
const transferAmounts = (line: StoredLine) => {
  const hasFee = line.direction === "OUT" && line.feeMinor > 0n && line.feeMinor < line.amountMinor;
  return { amountMinor: line.amountMinor - (hasFee ? line.feeMinor : 0n), feeMinor: hasFee ? line.feeMinor : 0n };
};

// Connects a line to a transaction, and to its journal lines once it has reached the ledger. A transfer
// with a fee has two lines on the account, and reconciling needs both.
const linkTransaction = async (
  tx: Prisma.TransactionClient,
  line: StoredLine,
  transaction: { id: string; journalEntryId: string | null },
  ledgerAccountId: string,
) => {
  const journalLines = transaction.journalEntryId
    ? await tx.journalLine.findMany({ where: { journalEntryId: transaction.journalEntryId, ledgerAccountId }, select: { id: true } })
    : [];
  const owner = { businessId: line.businessId, statementLineId: line.id, transactionId: transaction.id };
  await tx.statementLineLink.createMany({
    data: journalLines.length > 0 ? journalLines.map((journalLine) => ({ ...owner, journalLineId: journalLine.id })) : [owner],
  });
  return journalLines.length > 0;
};

const canPost = (business: BusinessContext) => business.permissions.includes(Permission.LEDGER_POST);

// ---------------------------------------------------------------------------
// The automatic matcher
// ---------------------------------------------------------------------------

// Each line is its own transaction, so one that can't be posted leaves the others alone.
const matchOne = async (business: BusinessContext, lineId: string, context: RequestContext) => {
  try {
    return await withBusinessScope(business, async (tx) => {
      const [locked] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM statement_lines WHERE id = ${lineId}::uuid AND status = 'UNMATCHED' FOR UPDATE SKIP LOCKED`;
      if (!locked) return null;

      const line = await tx.statementLine.findUniqueOrThrow({ where: { id: lineId } });
      if (await tx.statementLineLink.count({ where: { statementLineId: lineId } })) return null;

      const ledgerAccountId = await ledgerIdOfAccount(tx, line.financialAccountId);

      const match = pickMatch(line, await findCandidates(tx, line, ledgerAccountId));
      if (match) {
        await tx.statementLineLink.create({
          data: {
            businessId: line.businessId,
            statementLineId: lineId,
            journalLineId: match.candidate.journal_line_id,
            transactionId: match.candidate.transaction_id,
          },
        });
        await settleLine(tx, lineId, "MATCHED", match.matchedBy);
        return match.matchedBy;
      }

      if (!business.permissions.includes(Permission.FINANCE_WRITE)) return null;
      const rule = await statementRulesService.findFor(tx, line.businessId, line);
      if (!rule) return null;

      const transaction = await transactionsService.createWithin(
        tx,
        business,
        {
          type: line.direction === "IN" ? "INCOME" : "EXPENSE",
          accountId: line.financialAccountId,
          categoryId: rule.categoryId,
          amountMinor: line.amountMinor.toString(),
          feeMinor: "0",
          txnDate: fromDbDate(line.txnDate),
          ...(line.reference ? { referenceNo: line.reference.slice(0, 100) } : {}),
          ...(line.description ? { description: line.description } : {}),
          // Someone who can't post still gets the categorising done, as a draft.
          postNow: rule.autoPost && canPost(business),
        },
        context,
        originOf(line),
      );
      const reachedLedger = await linkTransaction(tx, line, transaction, ledgerAccountId);
      await settleLine(tx, lineId, reachedLedger ? "MATCHED" : "AWAITING_POSTING", "RULE");
      return "RULE" as const;
    });
  } catch (error) {
    // A closed period, for example. The line waits for a person, who can see why.
    if (!(error instanceof AppError)) throw error;
    await prisma.statementLine.update({ where: { id: lineId }, data: { lastMatchError: error.code } });
    return null;
  }
};

const matchLines = async (business: BusinessContext, lineIds: string[], context: RequestContext) => {
  const outcomes = { matched: 0, ruled: 0, needsReview: 0 };
  for (const lineId of lineIds) {
    const outcome = await matchOne(business, lineId, context);
    if (outcome === "RULE") outcomes.ruled += 1;
    else if (outcome) outcomes.matched += 1;
    else outcomes.needsReview += 1;
  }
  return outcomes;
};

const runMatcher = async (business: BusinessContext, body: IRunMatcherBody, context: RequestContext) => {
  const lines = await withBusinessScope(business, (tx) =>
    tx.statementLine.findMany({
      where: {
        businessId: business.businessId,
        status: "UNMATCHED",
        ...(body.financialAccountId ? { financialAccountId: body.financialAccountId } : {}),
      },
      select: { id: true },
      orderBy: { id: "asc" },
      take: MAX_MATCHER_LINES,
    }),
  );
  return matchLines(business, lines.map((line) => line.id), context);
};

// ---------------------------------------------------------------------------
// Keeping links true as the books change. Runs in the worker.
// ---------------------------------------------------------------------------

// Handles what happens to a transaction after its line was linked: a draft gets posted (the journal
// line is filled in), or it gets voided or reversed (the line returns to the inbox).
const settlePendingLinks = async (businessId?: string) => {
  const where = businessId ? { businessId } : {};
  const pending = await prisma.statementLineLink.findMany({
    where: { ...where, journalLineId: null },
    include: { transaction: { select: { status: true, journalEntryId: true } }, statementLine: { select: { financialAccountId: true } } },
  });

  const touched = new Set<string>();
  for (const link of pending) {
    const status = link.transaction?.status;
    if (status === "VOID" || status === "REJECTED" || !link.transaction) {
      await prisma.statementLineLink.delete({ where: { id: link.id } });
      touched.add(link.statementLineId);
    } else if (status === "POSTED" && link.transaction.journalEntryId) {
      const ledgerAccountId = await ledgerIdOfAccount(prisma as unknown as Prisma.TransactionClient, link.statementLine.financialAccountId);
      const journalLines = await prisma.journalLine.findMany({
        where: { journalEntryId: link.transaction.journalEntryId, ledgerAccountId },
        select: { id: true },
      });
      const [first, ...others] = journalLines;
      if (first) await prisma.statementLineLink.update({ where: { id: link.id }, data: { journalLineId: first.id } });
      if (others.length > 0) {
        await prisma.statementLineLink.createMany({
          data: others.map((journalLine) => ({
            businessId: link.businessId,
            statementLineId: link.statementLineId,
            transactionId: link.transactionId,
            journalLineId: journalLine.id,
          })),
        });
      }
      touched.add(link.statementLineId);
    }
  }

  // A reversed journal no longer settles anything, unless a reconciliation already relies on it.
  const reversed = await prisma.statementLineLink.findMany({
    where: {
      ...where,
      journalLine: { entry: { reversedBy: { isNot: null } }, reconciliation: null },
    },
    select: { id: true, statementLineId: true },
  });
  for (const link of reversed) {
    await prisma.statementLineLink.delete({ where: { id: link.id } });
    touched.add(link.statementLineId);
  }

  for (const lineId of touched) {
    const line = await prisma.statementLine.findUniqueOrThrow({ where: { id: lineId }, include: { links: { select: { journalLineId: true } } } });
    const allInLedger = line.links.length > 0 && line.links.every((link) => link.journalLineId !== null);
    const lostPart = line.links.length === 0 || line.status === "MATCHED";
    await prisma.statementLine.update({
      where: { id: lineId },
      data: allInLedger
        ? { status: "MATCHED", lastMatchError: null }
        : lostPart
          ? { status: "UNMATCHED", matchedBy: null }
          : { status: "AWAITING_POSTING" },
    });
  }
  return touched.size;
};

// ---------------------------------------------------------------------------
// The review inbox
// ---------------------------------------------------------------------------

const list = async (business: BusinessContext, query: IListLinesQuery) => {
  const rows = await withBusinessScope(business, (tx) =>
    tx.statementLine.findMany({
      where: {
        businessId: business.businessId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.financialAccountId ? { financialAccountId: query.financialAccountId } : {}),
        ...(query.importId ? { importId: query.importId } : {}),
        ...(query.connectionId ? { connectionId: query.connectionId } : {}),
        ...(query.from || query.to
          ? { txnDate: { ...(query.from ? { gte: toDbDate(query.from) } : {}), ...(query.to ? { lte: toDbDate(query.to) } : {}) } }
          : {}),
      },
      orderBy: { id: "desc" },
      ...pageArgs(query),
    }),
  );
  const page = toPage(rows, query.limit);
  return { items: page.items.map(toDto), nextCursor: page.nextCursor };
};

const summary = (business: BusinessContext, query: ISummaryQuery) =>
  withBusinessScope(business, async (tx) => {
    const rows = await tx.statementLine.groupBy({
      by: ["status"],
      where: { businessId: business.businessId, ...(query.financialAccountId ? { financialAccountId: query.financialAccountId } : {}) },
      _count: { _all: true },
    });
    const counts = new Map(rows.map((row) => [row.status, row._count._all]));
    return {
      unmatched: counts.get("UNMATCHED") ?? 0,
      awaitingPosting: counts.get("AWAITING_POSTING") ?? 0,
      matched: counts.get("MATCHED") ?? 0,
      ignored: counts.get("IGNORED") ?? 0,
    };
  });

const findOrThrow = async (tx: Prisma.TransactionClient, businessId: string, lineId: string) => {
  const line = await tx.statementLine.findFirst({ where: { id: lineId, businessId } });
  if (!line) throw new AppError(404, ErrorCode.NOT_FOUND);
  return line;
};

const SUGGESTION_WINDOW_DAYS = 10;

// A line with what it's linked to, and journal lines it might match, for the review screen.
const getOne = (business: BusinessContext, lineId: string) =>
  withBusinessScope(business, async (tx) => {
    const line = await findOrThrow(tx, business.businessId, lineId);
    const links = await tx.statementLineLink.findMany({
      where: { statementLineId: lineId },
      select: { transactionId: true, journalLineId: true },
    });
    const suggestions =
      line.status === "UNMATCHED"
        ? await findCandidates(tx, line, await ledgerIdOfAccount(tx, line.financialAccountId), SUGGESTION_WINDOW_DAYS)
        : [];
    return {
      ...toDto(line),
      links,
      suggestions: suggestions.map((candidate) => ({
        journalLineId: candidate.journal_line_id,
        entryNo: candidate.entry_no,
        entryDate: fromDbDate(candidate.entry_date),
        memo: candidate.memo,
        referenceNo: candidate.reference_no,
        transactionId: candidate.transaction_id,
      })),
    };
  });

// Locks the line, so two people reviewing it can't both act on it.
const lockOpen = async (tx: Prisma.TransactionClient, businessId: string, lineId: string) => {
  const [locked] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM statement_lines WHERE id = ${lineId}::uuid AND business_id = ${businessId}::uuid FOR UPDATE`;
  if (!locked) throw new AppError(404, ErrorCode.NOT_FOUND);

  const line = await tx.statementLine.findUniqueOrThrow({ where: { id: lineId } });
  if (line.status !== "UNMATCHED") throw new AppError(409, ErrorCode.STATEMENT_LINE_NOT_OPEN, { status: line.status });
  // Left over from a split where one part was voided. Unmatching clears it, so it's a clear choice.
  if (await tx.statementLineLink.count({ where: { statementLineId: lineId } })) {
    throw new AppError(409, ErrorCode.STATEMENT_LINE_NOT_OPEN, { status: "PARTLY_LINKED" });
  }
  return line;
};

const match = (business: BusinessContext, lineId: string, body: IMatchBody, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    const line = await lockOpen(tx, business.businessId, lineId);
    const ledgerAccountId = await ledgerIdOfAccount(tx, line.financialAccountId);

    const journalLineIds = [...new Set(body.journalLineIds)];
    const journalLines = await tx.journalLine.findMany({
      where: {
        id: { in: journalLineIds },
        businessId: business.businessId,
        ledgerAccountId,
        statementLink: null,
        entry: { reversedBy: null, reversesId: null },
      },
      select: { id: true, debitMinor: true, creditMinor: true, entry: { select: { postedTransaction: { select: { id: true } } } } },
    });
    if (journalLines.length !== journalLineIds.length) {
      throw new AppError(422, ErrorCode.JOURNAL_LINE_NOT_MATCHABLE, { requested: journalLineIds.length, usable: journalLines.length });
    }

    // Several book entries may add up to one statement line, such as a batched deposit.
    const total = journalLines.reduce((sum, journalLine) => sum + (line.direction === "IN" ? journalLine.debitMinor - journalLine.creditMinor : journalLine.creditMinor - journalLine.debitMinor), 0n);
    if (total !== line.amountMinor) {
      throw new AppError(422, ErrorCode.SPLIT_TOTAL_MISMATCH, { expectedMinor: line.amountMinor, actualMinor: total });
    }

    await tx.statementLineLink.createMany({
      data: journalLines.map((journalLine) => ({
        businessId: business.businessId,
        statementLineId: lineId,
        journalLineId: journalLine.id,
        transactionId: journalLine.entry.postedTransaction?.id ?? null,
      })),
    });
    const settled = await settleLine(tx, lineId, "MATCHED", "MANUAL");
    await auditService.recordForBusiness(tx, business, {
      action: "statement_line.matched",
      context,
      entityType: "statement_line",
      entityId: lineId,
      after: { journalLineIds },
    });
    return toDto(settled);
  });

// Takes away the link only. A transaction the line created stays until someone voids or reverses it.
const unmatch = (business: BusinessContext, lineId: string, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    const line = await findOrThrow(tx, business.businessId, lineId);
    const links = await tx.statementLineLink.findMany({
      where: { statementLineId: lineId },
      select: { id: true, journalLineId: true, transactionId: true, journalLine: { select: { reconciliation: { select: { reconciliationId: true } } } } },
    });
    if (links.length === 0) throw new AppError(409, ErrorCode.STATEMENT_LINE_NOT_OPEN, { status: line.status });
    if (links.some((link) => link.journalLine?.reconciliation)) throw new AppError(409, ErrorCode.STATEMENT_LINE_RECONCILED);

    await tx.statementLineLink.deleteMany({ where: { statementLineId: lineId } });
    const after = await tx.statementLine.update({ where: { id: lineId }, data: { status: "UNMATCHED", matchedBy: null } });
    await auditService.recordForBusiness(tx, business, {
      action: "statement_line.unmatched",
      context,
      entityType: "statement_line",
      entityId: lineId,
      before: { journalLineIds: links.map((link) => link.journalLineId), transactionIds: links.map((link) => link.transactionId) },
    });
    return toDto(after);
  });

const categorize = (business: BusinessContext, lineId: string, body: ICategorizeBody, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    const line = await lockOpen(tx, business.businessId, lineId);
    const ledgerAccountId = await ledgerIdOfAccount(tx, line.financialAccountId);
    const { amountMinor, feeMinor } = body.transferAccountId ? transferAmounts(line) : { amountMinor: line.amountMinor, feeMinor: 0n };
    const description = body.description ?? line.description;

    // Money out of this account goes to the other one. Money in came from it.
    const transfer = body.transferAccountId
      ? line.direction === "OUT"
        ? { type: "TRANSFER" as const, accountId: line.financialAccountId, toAccountId: body.transferAccountId }
        : { type: "TRANSFER" as const, accountId: body.transferAccountId, toAccountId: line.financialAccountId }
      : null;

    const transaction = await transactionsService.createWithin(
      tx,
      business,
      {
        ...(transfer ?? { type: line.direction === "IN" ? ("INCOME" as const) : ("EXPENSE" as const), accountId: line.financialAccountId }),
        ...(body.categoryId ? { categoryId: body.categoryId } : {}),
        amountMinor: amountMinor.toString(),
        feeMinor: feeMinor.toString(),
        txnDate: fromDbDate(line.txnDate),
        ...(line.reference ? { referenceNo: line.reference.slice(0, 100) } : {}),
        ...(description ? { description } : {}),
        postNow: body.postNow,
      },
      context,
      originOf(line),
    );
    const reachedLedger = await linkTransaction(tx, line, transaction, ledgerAccountId);
    const after = await settleLine(tx, lineId, reachedLedger ? "MATCHED" : "AWAITING_POSTING", "MANUAL");
    await auditService.recordForBusiness(tx, business, {
      action: "statement_line.categorized",
      context,
      entityType: "statement_line",
      entityId: lineId,
      after: { transactionId: transaction.id, categoryId: body.categoryId, transferAccountId: body.transferAccountId },
    });
    return { ...toDto(after), transactionId: transaction.id };
  });

// One statement line, several categories. All the parts are created or none are.
const split = (business: BusinessContext, lineId: string, body: ISplitBody, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    const line = await lockOpen(tx, business.businessId, lineId);
    const ledgerAccountId = await ledgerIdOfAccount(tx, line.financialAccountId);

    const total = body.parts.reduce((sum, part) => sum + BigInt(part.amountMinor), 0n);
    if (total !== line.amountMinor) {
      throw new AppError(422, ErrorCode.SPLIT_TOTAL_MISMATCH, { expectedMinor: line.amountMinor, actualMinor: total });
    }

    const transactionIds: string[] = [];
    let allInLedger = true;
    for (const [index, part] of body.parts.entries()) {
      const description = part.description ?? line.description;
      const transaction = await transactionsService.createWithin(
        tx,
        business,
        {
          type: line.direction === "IN" ? "INCOME" : "EXPENSE",
          accountId: line.financialAccountId,
          categoryId: part.categoryId,
          amountMinor: part.amountMinor,
          feeMinor: "0",
          txnDate: fromDbDate(line.txnDate),
          ...(line.reference ? { referenceNo: line.reference.slice(0, 100) } : {}),
          ...(description ? { description } : {}),
          postNow: body.postNow,
        },
        context,
        originOf(line, index),
      );
      transactionIds.push(transaction.id);
      if (!(await linkTransaction(tx, line, transaction, ledgerAccountId))) allInLedger = false;
    }

    const after = await settleLine(tx, lineId, allInLedger ? "MATCHED" : "AWAITING_POSTING", "MANUAL");
    await auditService.recordForBusiness(tx, business, {
      action: "statement_line.split",
      context,
      entityType: "statement_line",
      entityId: lineId,
      after: { transactionIds },
    });
    return { ...toDto(after), transactionIds };
  });

const ignore = (business: BusinessContext, lineId: string, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    await lockOpen(tx, business.businessId, lineId);
    const after = await tx.statementLine.update({ where: { id: lineId }, data: { status: "IGNORED" } });
    await auditService.recordForBusiness(tx, business, { action: "statement_line.ignored", context, entityType: "statement_line", entityId: lineId });
    return toDto(after);
  });

const restore = (business: BusinessContext, lineId: string, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    const line = await findOrThrow(tx, business.businessId, lineId);
    if (line.status !== "IGNORED") throw new AppError(409, ErrorCode.STATEMENT_LINE_NOT_OPEN, { status: line.status });
    const after = await tx.statementLine.update({ where: { id: lineId }, data: { status: "UNMATCHED" } });
    await auditService.recordForBusiness(tx, business, { action: "statement_line.restored", context, entityType: "statement_line", entityId: lineId });
    return toDto(after);
  });

export const statementLinesService = {
  ingest,
  matchLines,
  runMatcher,
  settlePendingLinks,
  list,
  summary,
  getOne,
  match,
  unmatch,
  categorize,
  split,
  ignore,
  restore,
};
