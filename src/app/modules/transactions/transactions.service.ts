import type { Prisma } from "../../../lib/prisma.js";
import { withBusinessScope } from "../../../lib/rls.js";
import { addDays, fromDbDate, toDbDate } from "../../utils/dates.js";
import { AppError, ErrorCode } from "../../utils/errors.js";
import { type IdempotencyRequest, withIdempotency } from "../../utils/idempotency.js";
import { pageArgs, toPage } from "../../utils/pagination.js";
import type { RequestContext } from "../../utils/requestContext.js";
import { accountsService } from "../accounts/accounts.service.js";
import { auditService } from "../audit/audit.service.js";
import { businessesService } from "../businesses/businesses.service.js";
import { categoriesService } from "../categories/categories.service.js";
import { documentsService } from "../documents/documents.service.js";
import type { BusinessContext } from "../members/members.interface.js";
import type {
  ICreateTransactionBody,
  IListTransactionsQuery,
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

// One counter row per business and year. Its row lock makes numbers unique under concurrent requests.
const nextTransactionNumber = async (tx: Prisma.TransactionClient, businessId: string, txnDate: Date) => {
  const year = txnDate.getUTCFullYear();
  const name = `transaction:${year}`;
  const [row] = await tx.$queryRaw<{ value: bigint }[]>`
    INSERT INTO business_sequences (business_id, name, value)
    VALUES (${businessId}::uuid, ${name}, 1)
    ON CONFLICT (business_id, name) DO UPDATE SET value = business_sequences.value + 1
    RETURNING value`;

  const prefix = await businessesService.getTransactionPrefix(tx, businessId);
  return `${prefix}-${year}-${String(row!.value).padStart(6, "0")}`;
};

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

// Everything is created as a DRAFT. Phase 4 adds approval and posting to the ledger.
const create = (
  business: BusinessContext,
  body: ICreateTransactionBody,
  idempotency: IdempotencyRequest | null,
  context: RequestContext,
) =>
  withBusinessScope(business, (tx) =>
    withIdempotency(tx, business.userId, idempotency, 201, async () => {
      const draft: ITransactionDraft = {
        type: body.type,
        accountId: body.accountId,
        toAccountId: body.toAccountId ?? null,
        categoryId: body.categoryId ?? null,
        amountMinor: BigInt(body.amountMinor),
        feeMinor: BigInt(body.feeMinor),
        txnDate: toDbDate(body.txnDate),
        referenceNo: body.referenceNo ?? null,
      };

      assertTransferFields(draft);
      const currency = await resolveCurrency(tx, business.businessId, draft, body.currency);
      await assertCategoryFits(tx, business.businessId, draft);
      const duplicate = await findPossibleDuplicate(tx, business.businessId, draft);

      const transaction = await tx.transaction.create({
        data: {
          ...draft,
          workspaceId: business.workspaceId,
          businessId: business.businessId,
          number: await nextTransactionNumber(tx, business.businessId, draft.txnDate),
          currency,
          paymentMethod: body.paymentMethod ?? null,
          description: body.description ?? null,
          possibleDuplicate: duplicate !== null,
          duplicateOfId: duplicate?.id ?? null,
          createdBy: business.userId,
        },
      });

      await auditService.recordForBusiness(tx, business, {
        action: "transaction.created",
        context,
        entityType: "transaction",
        entityId: transaction.id,
        after: { number: transaction.number, type: draft.type, amountMinor: draft.amountMinor, currency },
      });
      return toDto(transaction);
    }),
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

const getOne = async (business: BusinessContext, transactionId: string) => {
  const transaction = await withBusinessScope(business, (tx) =>
    tx.transaction.findFirst({
      where: { id: transactionId, businessId: business.businessId },
      include: { attachments: { select: { documentId: true, createdAt: true } } },
    }),
  );
  if (!transaction) throw new AppError(404, ErrorCode.NOT_FOUND);
  return toDto(transaction);
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
      amountMinor: body.amountMinor ? BigInt(body.amountMinor) : before.amountMinor,
      feeMinor: body.feeMinor ? BigInt(body.feeMinor) : before.feeMinor,
      txnDate: body.txnDate ? toDbDate(body.txnDate) : before.txnDate,
      referenceNo: body.referenceNo === undefined ? before.referenceNo : body.referenceNo,
    };

    assertTransferFields(draft);
    const currency = await resolveCurrency(tx, business.businessId, draft);
    await assertCategoryFits(tx, business.businessId, draft);

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

// A draft is voided, never deleted. Posted transactions get reversals in Phase 4.
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
  create,
  list,
  getOne,
  update,
  dismissDuplicate,
  voidDraft,
  attachDocument,
  detachDocument,
};
