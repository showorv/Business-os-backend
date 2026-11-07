import type { Prisma } from "../../../lib/prisma.js";
import { withBusinessScope } from "../../../lib/rls.js";
import { LedgerCode } from "../../constants/chartOfAccounts.js";
import { Permission } from "../../constants/permissions.js";
import { addDays, fromDbDate, todayInTimezone, toDbDate } from "../../utils/dates.js";
import { AppError, ErrorCode } from "../../utils/errors.js";
import { type IdempotencyRequest, withIdempotency } from "../../utils/idempotency.js";
import { EventType, publishEvent } from "../../utils/outbox.js";
import { pageArgs, toPage } from "../../utils/pagination.js";
import { buildTransactionLines } from "../../utils/postingRules.js";
import type { RequestContext } from "../../utils/requestContext.js";
import { nextSequence } from "../../utils/sequences.js";
import { accountsService } from "../accounts/accounts.service.js";
import { auditService } from "../audit/audit.service.js";
import { businessesService } from "../businesses/businesses.service.js";
import { categoriesService } from "../categories/categories.service.js";
import { contactsService } from "../contacts/contacts.service.js";
import { documentsService } from "../documents/documents.service.js";
import { canPostToSoftClosed, journalsService } from "../journals/journals.service.js";
import { ledgerAccountsService } from "../ledger-accounts/ledger-accounts.service.js";
import type { BusinessContext } from "../members/members.interface.js";
import type {
  ICreateTransactionBody,
  IListTransactionsQuery,
  IReverseTransactionBody,
  ITransactionDraft,
  IUpdateTransactionBody,
} from "./transactions.interface.js";

const DUPLICATE_WINDOW_DAYS = 2;

// Which category type each transaction type must use. ADJUSTMENT may use either, or none.
const REQUIRED_CATEGORY_TYPE = { INCOME: "INCOME", EXPENSE: "EXPENSE", REFUND: "INCOME" } as const;

const toDto = <T extends { txnDate: Date }>(transaction: T) => ({
  ...transaction,
  txnDate: fromDbDate(transaction.txnDate),
});

// ---------------------------------------------------------------------------
// Business rules shared by create and update
// ---------------------------------------------------------------------------

const assertTransferFields = (draft: ITransactionDraft) => {
  if (draft.type === "TRANSFER") {
    if (!draft.toAccountId || draft.toAccountId === draft.accountId) {
      throw new AppError(422, ErrorCode.TRANSFER_ACCOUNTS_INVALID);
    }
    if (draft.categoryId) throw new AppError(422, ErrorCode.CATEGORY_NOT_ALLOWED);
    return;
  }
  if (draft.toAccountId) throw new AppError(422, ErrorCode.TRANSFER_ACCOUNTS_INVALID);
  if (draft.feeMinor > 0n) throw new AppError(422, ErrorCode.FEE_NOT_ALLOWED);
};

const assertCategoryFits = async (tx: Prisma.TransactionClient, businessId: string, draft: ITransactionDraft) => {
  if (draft.type === "TRANSFER") return;

  const requiredType = draft.type === "ADJUSTMENT" ? null : REQUIRED_CATEGORY_TYPE[draft.type];
  if (!draft.categoryId) {
    if (requiredType) throw new AppError(422, ErrorCode.CATEGORY_REQUIRED);
    return;
  }

  const category = await categoriesService.getUsable(tx, businessId, draft.categoryId);
  if (requiredType && category.type !== requiredType) {
    throw new AppError(422, ErrorCode.CATEGORY_TYPE_MISMATCH, { expected: requiredType, actual: category.type });
  }
};

// Returns the currency the transaction uses: always the account's own.
const resolveCurrency = async (
  tx: Prisma.TransactionClient,
  businessId: string,
  draft: ITransactionDraft,
  requestedCurrency?: string,
) => {
  const account = await accountsService.getUsable(tx, businessId, draft.accountId);
  if (requestedCurrency && requestedCurrency !== account.currency) {
    throw new AppError(422, ErrorCode.CURRENCY_MISMATCH, { expected: account.currency, actual: requestedCurrency });
  }

  if (draft.toAccountId) {
    const toAccount = await accountsService.getUsable(tx, businessId, draft.toAccountId);
    if (toAccount.currency !== account.currency) {
      throw new AppError(422, ErrorCode.CURRENCY_MISMATCH, { expected: account.currency, actual: toAccount.currency });
    }
  }
  return account.currency;
};

// Same account, type and amount within 2 days, and no conflicting reference. It only flags the
// transaction: a real repeat payment is possible, so the user decides.
const findPossibleDuplicate = async (
  tx: Prisma.TransactionClient,
  businessId: string,
  draft: ITransactionDraft,
  excludeId?: string,
) =>
  tx.transaction.findFirst({
    where: {
      businessId,
      accountId: draft.accountId,
      type: draft.type,
      amountMinor: draft.amountMinor,
      status: { notIn: ["VOID", "REJECTED"] },
      txnDate: { gte: addDays(draft.txnDate, -DUPLICATE_WINDOW_DAYS), lte: addDays(draft.txnDate, DUPLICATE_WINDOW_DAYS) },
      ...(excludeId ? { id: { not: excludeId } } : {}),
      ...(draft.referenceNo ? { OR: [{ referenceNo: null }, { referenceNo: draft.referenceNo }] } : {}),
    },
    orderBy: { id: "asc" },
    select: { id: true },
  });

const nextTransactionNumber = async (tx: Prisma.TransactionClient, businessId: string, txnDate: Date, prefix: string) => {
  const year = txnDate.getUTCFullYear();
  return `${prefix}-${year}-${await nextSequence(tx, businessId, `transaction:${year}`)}`;
};

const assertPermission = (business: BusinessContext, permission: Permission) => {
  if (!business.permissions.includes(permission)) {
    throw new AppError(403, ErrorCode.PERMISSION_DENIED, { permission });
  }
};

// ---------------------------------------------------------------------------
// Posting to the ledger
// ---------------------------------------------------------------------------

type StoredTransaction = Prisma.TransactionGetPayload<object>;

// Expenses above the business's threshold need a second person.
const needsApproval = (transaction: StoredTransaction, threshold: string | null) =>
  transaction.type === "EXPENSE" && threshold !== null && transaction.amountMinor > BigInt(threshold);

// Turns a transaction into its journal, in one database transaction. This is the only moment a
// transaction changes the books.
const postToLedger = async (
  tx: Prisma.TransactionClient,
  business: BusinessContext,
  transaction: StoredTransaction,
  context: RequestContext,
  approvedBy?: string,
) => {
  const account = await accountsService.getUsable(tx, business.businessId, transaction.accountId);
  if (account.currency !== business.baseCurrency) {
    throw new AppError(422, ErrorCode.FOREIGN_CURRENCY_NOT_SUPPORTED, { currency: account.currency });
  }
  const toAccount = transaction.toAccountId
    ? await accountsService.getUsable(tx, business.businessId, transaction.toAccountId)
    : null;

  // The draft rules allow an adjustment with no category, but posting needs to know its side.
  if (transaction.type === "ADJUSTMENT" && !transaction.categoryId) {
    throw new AppError(422, ErrorCode.CATEGORY_REQUIRED);
  }
  const category = transaction.categoryId
    ? await categoriesService.getUsable(tx, business.businessId, transaction.categoryId)
    : null;
  if (category && !category.ledgerAccountId) throw new AppError(409, ErrorCode.BUSINESS_NOT_PROVISIONED);

  const salesReturns = await ledgerAccountsService.getByCode(tx, business.businessId, LedgerCode.SALES_RETURNS);
  const bankCharges = await ledgerAccountsService.getByCode(tx, business.businessId, LedgerCode.BANK_CHARGES);

  const entry = await journalsService.post(tx, business, {
    entryDate: transaction.txnDate,
    kind: "STANDARD",
    memo: transaction.description ?? transaction.number,
    sourceType: "transaction",
    sourceId: transaction.id,
    allowSoftClosed: canPostToSoftClosed(business),
    lines: buildTransactionLines({
      type: transaction.type,
      amountMinor: transaction.amountMinor,
      feeMinor: transaction.feeMinor,
      accountLedgerId: accountsService.ledgerIdOf(account),
      toAccountLedgerId: toAccount ? accountsService.ledgerIdOf(toAccount) : null,
      categoryLedgerId: category?.ledgerAccountId ?? null,
      categoryType: category?.type ?? null,
      salesReturnsLedgerId: salesReturns.id,
      bankChargesLedgerId: bankCharges.id,
    }),
  });

  const posted = await tx.transaction.update({
    where: { id: transaction.id },
    data: {
      status: "POSTED",
      journalEntryId: entry.id,
      ...(approvedBy ? { approvedBy, approvedAt: new Date() } : {}),
    },
  });
  await auditService.recordForBusiness(tx, business, {
    action: "transaction.posted",
    context,
    entityType: "transaction",
    entityId: transaction.id,
    after: { number: transaction.number, entryNo: entry.entryNo, amountMinor: transaction.amountMinor, approvedBy },
  });
  return posted;
};

// Posts straight away, or waits for a second person if the amount is above the threshold.
const submit = async (
  tx: Prisma.TransactionClient,
  business: BusinessContext,
  transaction: StoredTransaction,
  context: RequestContext,
) => {
  const { approvalThresholdMinor } = await businessesService.getTransactionSettings(tx, business.businessId);
  if (!needsApproval(transaction, approvalThresholdMinor)) return postToLedger(tx, business, transaction, context);

  const pending = await tx.transaction.update({ where: { id: transaction.id }, data: { status: "PENDING_APPROVAL" } });
  await publishEvent(tx, business, EventType.TRANSACTION_SUBMITTED, { transactionId: transaction.id });
  await auditService.recordForBusiness(tx, business, {
    action: "transaction.submitted",
    context,
    entityType: "transaction",
    entityId: transaction.id,
    after: { amountMinor: transaction.amountMinor, thresholdMinor: approvalThresholdMinor },
  });
  return pending;
};

// The checks every transaction passes. Recurring schedules run them when they are set up, so a bad
// schedule is refused straight away rather than failing weeks later.
const assertDraftValid = async (tx: Prisma.TransactionClient, businessId: string, draft: ITransactionDraft) => {
  assertTransferFields(draft);
  await resolveCurrency(tx, businessId, draft);
  await assertCategoryFits(tx, businessId, draft);
};

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

export interface TransactionOrigin {
  source: "MANUAL" | "RECURRING" | "IMPORT" | "SYNC" | "AI";
  // Where the source has its own id for this. A unique index stops it being recorded twice.
  providerTxnId?: string;
}

// In the caller's transaction, so importing a statement line and creating its transaction are one step.
const createWithin = async (
  tx: Prisma.TransactionClient,
  business: BusinessContext,
  body: ICreateTransactionBody,
  context: RequestContext,
  origin: TransactionOrigin = { source: "MANUAL" },
) => {
  if (body.postNow) assertPermission(business, Permission.LEDGER_POST);

  const draft: ITransactionDraft = {
    type: body.type,
    accountId: body.accountId,
    toAccountId: body.toAccountId ?? null,
    categoryId: body.categoryId ?? null,
    contactId: body.contactId ?? null,
    amountMinor: BigInt(body.amountMinor),
    feeMinor: BigInt(body.feeMinor),
    txnDate: toDbDate(body.txnDate),
    referenceNo: body.referenceNo ?? null,
  };

  assertTransferFields(draft);
  const currency = await resolveCurrency(tx, business.businessId, draft, body.currency);
  await assertCategoryFits(tx, business.businessId, draft);
  if (draft.contactId) await contactsService.assertUsable(tx, business.businessId, draft.contactId);
  const duplicate = await findPossibleDuplicate(tx, business.businessId, draft);
  const { transactionPrefix } = await businessesService.getTransactionSettings(tx, business.businessId);

  const transaction = await tx.transaction.create({
    data: {
      ...draft,
      workspaceId: business.workspaceId,
      businessId: business.businessId,
      number: await nextTransactionNumber(tx, business.businessId, draft.txnDate, transactionPrefix),
      currency,
      paymentMethod: body.paymentMethod ?? null,
      description: body.description ?? null,
      possibleDuplicate: duplicate !== null,
      duplicateOfId: duplicate?.id ?? null,
      source: origin.source,
      providerTxnId: origin.providerTxnId ?? null,
      createdBy: business.userId,
    },
  });

  await auditService.recordForBusiness(tx, business, {
    action: "transaction.created",
    context,
    entityType: "transaction",
    entityId: transaction.id,
    after: { number: transaction.number, type: draft.type, amountMinor: draft.amountMinor, currency, source: origin.source },
  });
  return toDto(body.postNow ? await submit(tx, business, transaction, context) : transaction);
};

// Everything starts as a DRAFT. postNow runs the post step in the same transaction.
const create = (
  business: BusinessContext,
  body: ICreateTransactionBody,
  idempotency: IdempotencyRequest | null,
  context: RequestContext,
  origin?: TransactionOrigin,
) =>
  withBusinessScope(business, (tx) =>
    withIdempotency(tx, business.userId, idempotency, 201, () => createWithin(tx, business, body, context, origin)),
  );

const list = async (business: BusinessContext, query: IListTransactionsQuery) => {
  const rows = await withBusinessScope(business, (tx) =>
    tx.transaction.findMany({
      where: {
        businessId: business.businessId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.type ? { type: query.type } : {}),
        ...(query.accountId ? { accountId: query.accountId } : {}),
        ...(query.categoryId ? { categoryId: query.categoryId } : {}),
        ...(query.contactId ? { contactId: query.contactId } : {}),
        ...(query.possibleDuplicate !== undefined ? { possibleDuplicate: query.possibleDuplicate } : {}),
        ...(query.from || query.to
          ? {
              txnDate: {
                ...(query.from ? { gte: toDbDate(query.from) } : {}),
                ...(query.to ? { lte: toDbDate(query.to) } : {}),
              },
            }
          : {}),
      },
      orderBy: [{ txnDate: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    }),
  );
  const page = toPage(rows, query.limit);
  return { ...page, items: page.items.map(toDto) };
};

// Each attachment carries its file's name, type and size, so a screen can list it without another call.
const getOne = async (business: BusinessContext, transactionId: string) => {
  const transaction = await withBusinessScope(business, (tx) =>
    tx.transaction.findFirst({
      where: { id: transactionId, businessId: business.businessId },
      include: {
        attachments: {
          select: { documentId: true, createdAt: true, document: { select: { fileName: true, mime: true, sizeBytes: true } } },
          orderBy: { createdAt: "asc" },
        },
      },
    }),
  );
  if (!transaction) throw new AppError(404, ErrorCode.NOT_FOUND);
  const attachments = transaction.attachments.map(({ document, ...attachment }) => ({
    ...attachment,
    fileName: document.fileName,
    mime: document.mime,
    sizeBytes: Number(document.sizeBytes),
  }));
  return toDto({ ...transaction, attachments });
};

// Locks the row, so two edits of one draft run one after the other.
const lockOrThrow = async (tx: Prisma.TransactionClient, businessId: string, transactionId: string) => {
  const [locked] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM transactions WHERE id = ${transactionId}::uuid AND business_id = ${businessId}::uuid FOR UPDATE`;
  if (!locked) throw new AppError(404, ErrorCode.NOT_FOUND);
  return tx.transaction.findUniqueOrThrow({ where: { id: transactionId } });
};

const assertDraft = (status: string) => {
  if (status !== "DRAFT") throw new AppError(409, ErrorCode.TRANSACTION_NOT_EDITABLE, { status });
};

const update = (
  business: BusinessContext,
  transactionId: string,
  body: IUpdateTransactionBody,
  context: RequestContext,
) =>
  withBusinessScope(business, async (tx) => {
    const before = await lockOrThrow(tx, business.businessId, transactionId);
    assertDraft(before.status);

    const draft: ITransactionDraft = {
      type: before.type,
      accountId: body.accountId ?? before.accountId,
      toAccountId: body.toAccountId === undefined ? before.toAccountId : body.toAccountId,
      categoryId: body.categoryId === undefined ? before.categoryId : body.categoryId,
      contactId: body.contactId === undefined ? before.contactId : body.contactId,
      amountMinor: body.amountMinor ? BigInt(body.amountMinor) : before.amountMinor,
      feeMinor: body.feeMinor ? BigInt(body.feeMinor) : before.feeMinor,
      txnDate: body.txnDate ? toDbDate(body.txnDate) : before.txnDate,
      referenceNo: body.referenceNo === undefined ? before.referenceNo : body.referenceNo,
    };

    assertTransferFields(draft);
    const currency = await resolveCurrency(tx, business.businessId, draft);
    await assertCategoryFits(tx, business.businessId, draft);
    if (draft.contactId && draft.contactId !== before.contactId) await contactsService.assertUsable(tx, business.businessId, draft.contactId);

    // Re-check only when a field the check uses changed, so a dismissed flag stays dismissed
    // after editing the description.
    const duplicateFieldsChanged =
      draft.accountId !== before.accountId ||
      draft.amountMinor !== before.amountMinor ||
      draft.txnDate.getTime() !== before.txnDate.getTime() ||
      draft.referenceNo !== before.referenceNo;
    const duplicateCheck = duplicateFieldsChanged
      ? await findPossibleDuplicate(tx, business.businessId, draft, transactionId)
      : undefined;

    const after = await tx.transaction.update({
      where: { id: transactionId },
      data: {
        ...draft,
        currency,
        ...(body.paymentMethod !== undefined ? { paymentMethod: body.paymentMethod } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(duplicateCheck !== undefined
          ? { possibleDuplicate: duplicateCheck !== null, duplicateOfId: duplicateCheck?.id ?? null }
          : {}),
      },
    });

    const pick = (source: typeof before) =>
      Object.fromEntries(Object.keys(body).map((key) => [key, source[key as keyof IUpdateTransactionBody]]));
    await auditService.recordForBusiness(tx, business, {
      action: "transaction.updated",
      context,
      entityType: "transaction",
      entityId: transactionId,
      before: pick(before),
      after: pick(after),
    });
    return toDto(after);
  });

// "This is not a duplicate": the user's decision on a flagged transaction.
const dismissDuplicate = (business: BusinessContext, transactionId: string, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    const before = await lockOrThrow(tx, business.businessId, transactionId);
    const after = await tx.transaction.update({
      where: { id: transactionId },
      data: { possibleDuplicate: false, duplicateOfId: null },
    });
    await auditService.recordForBusiness(tx, business, {
      action: "transaction.duplicate_dismissed",
      context,
      entityType: "transaction",
      entityId: transactionId,
      before: { duplicateOfId: before.duplicateOfId },
    });
    return toDto(after);
  });

// Which customer or supplier it was with. The books don't change, so a posted one can be tagged too.
const setContact = (business: BusinessContext, transactionId: string, contactId: string | null, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    const before = await lockOrThrow(tx, business.businessId, transactionId);
    if (before.status === "VOID") throw new AppError(409, ErrorCode.TRANSACTION_NOT_EDITABLE, { status: before.status });
    if (contactId && contactId !== before.contactId) await contactsService.assertUsable(tx, business.businessId, contactId);
    const after = await tx.transaction.update({ where: { id: transactionId }, data: { contactId } });
    await auditService.recordForBusiness(tx, business, {
      action: "transaction.contact_set",
      context,
      entityType: "transaction",
      entityId: transactionId,
      before: { contactId: before.contactId },
      after: { contactId },
    });
    return toDto(after);
  });

// A draft is voided, never deleted. A posted transaction is reversed instead.
const voidDraft = (business: BusinessContext, transactionId: string, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    const before = await lockOrThrow(tx, business.businessId, transactionId);
    assertDraft(before.status);

    const after = await tx.transaction.update({ where: { id: transactionId }, data: { status: "VOID" } });
    await auditService.recordForBusiness(tx, business, {
      action: "transaction.voided",
      context,
      entityType: "transaction",
      entityId: transactionId,
      before: { status: before.status },
      after: { status: after.status },
    });
    return toDto(after);
  });

const post = (business: BusinessContext, transactionId: string, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    const transaction = await lockOrThrow(tx, business.businessId, transactionId);
    assertDraft(transaction.status);
    return toDto(await submit(tx, business, transaction, context));
  });

const assertPending = (status: string) => {
  if (status !== "PENDING_APPROVAL") throw new AppError(409, ErrorCode.TRANSACTION_NOT_PENDING, { status });
};

// The second-person check: whoever entered a transaction can't approve it.
const approve = (business: BusinessContext, transactionId: string, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    const transaction = await lockOrThrow(tx, business.businessId, transactionId);
    assertPending(transaction.status);
    if (transaction.createdBy === business.userId) throw new AppError(403, ErrorCode.APPROVER_MUST_DIFFER);
    return toDto(await postToLedger(tx, business, transaction, context, business.userId));
  });

const reject = (business: BusinessContext, transactionId: string, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    const transaction = await lockOrThrow(tx, business.businessId, transactionId);
    assertPending(transaction.status);
    const rejected = await tx.transaction.update({ where: { id: transactionId }, data: { status: "REJECTED" } });
    await auditService.recordForBusiness(tx, business, {
      action: "transaction.rejected",
      context,
      entityType: "transaction",
      entityId: transactionId,
    });
    return toDto(rejected);
  });

// Books a mirror-image journal in the current period. The original journal stays as it was.
const reverse = (
  business: BusinessContext,
  transactionId: string,
  body: IReverseTransactionBody,
  context: RequestContext,
) =>
  withBusinessScope(business, async (tx) => {
    const transaction = await lockOrThrow(tx, business.businessId, transactionId);
    if (transaction.status !== "POSTED" || !transaction.journalEntryId) {
      throw new AppError(409, ErrorCode.TRANSACTION_NOT_POSTED, { status: transaction.status });
    }

    const entry = await journalsService.reverse(tx, business, transaction.journalEntryId, {
      entryDate: toDbDate(body.entryDate ?? todayInTimezone(business.timezone)),
      memo: body.memo,
      allowSoftClosed: canPostToSoftClosed(business),
    });
    const reversed = await tx.transaction.update({
      where: { id: transactionId },
      data: { status: "VOID", reversalEntryId: entry.id },
    });
    await auditService.recordForBusiness(tx, business, {
      action: "transaction.reversed",
      context,
      entityType: "transaction",
      entityId: transactionId,
      after: { reversalNo: entry.entryNo, memo: body.memo },
    });
    return toDto(reversed);
  });

const attachDocument = (
  business: BusinessContext,
  transactionId: string,
  documentId: string,
  context: RequestContext,
) =>
  withBusinessScope(business, async (tx) => {
    const transaction = await lockOrThrow(tx, business.businessId, transactionId);
    if (transaction.status === "VOID") {
      throw new AppError(409, ErrorCode.TRANSACTION_NOT_EDITABLE, { status: transaction.status });
    }
    await documentsService.assertReady(tx, business.businessId, documentId);

    // Attaching the same document twice is harmless, so it isn't an error.
    const { count } = await tx.transactionAttachment.createMany({
      data: {
        transactionId,
        documentId,
        workspaceId: business.workspaceId,
        businessId: business.businessId,
        createdBy: business.userId,
      },
      skipDuplicates: true,
    });
    if (count > 0) {
      await auditService.recordForBusiness(tx, business, {
        action: "transaction.document_attached",
        context,
        entityType: "transaction",
        entityId: transactionId,
        after: { documentId },
      });
    }
  });

const detachDocument = (
  business: BusinessContext,
  transactionId: string,
  documentId: string,
  context: RequestContext,
) =>
  withBusinessScope(business, async (tx) => {
    const { count } = await tx.transactionAttachment.deleteMany({
      where: { transactionId, documentId, businessId: business.businessId },
    });
    if (count === 0) throw new AppError(404, ErrorCode.NOT_FOUND);

    await auditService.recordForBusiness(tx, business, {
      action: "transaction.document_detached",
      context,
      entityType: "transaction",
      entityId: transactionId,
      before: { documentId },
    });
  });

export const transactionsService = {
  assertDraftValid,
  createWithin,
  create,
  list,
  getOne,
  update,
  dismissDuplicate,
  setContact,
  voidDraft,
  post,
  approve,
  reject,
  reverse,
  attachDocument,
  detachDocument,
};
