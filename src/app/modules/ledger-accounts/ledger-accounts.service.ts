import type { Prisma } from "../../../lib/prisma.js";
import { withBusinessScope } from "../../../lib/rls.js";
import { CODE_RANGES, chartTemplateFor, commonTemplate, LedgerCode, normalBalanceOf } from "../../constants/chartOfAccounts.js";
import { AppError, ErrorCode, isUniqueViolation } from "../../utils/errors.js";
import type { RequestContext } from "../../utils/requestContext.js";
import { auditService } from "../audit/audit.service.js";
import type { BusinessContext } from "../members/members.interface.js";
import type {
  ICreateLedgerAccountBody,
  IListLedgerAccountsQuery,
  IUpdateLedgerAccountBody,
  LedgerActor,
} from "./ledger-accounts.interface.js";

// Part of setting up a new business. Running it twice changes nothing.
const seedChart = (tx: Prisma.TransactionClient, actor: LedgerActor, businessType: string) =>
  tx.ledgerAccount.createMany({
    data: chartTemplateFor(businessType).map((template) => ({
      ...template,
      workspaceId: actor.workspaceId,
      businessId: actor.businessId,
      createdBy: actor.userId,
      isSystem: true,
    })),
    skipDuplicates: true,
  });

// Like getByCode, but first adds the account if the business was created before it existed
// (for example VAT Payable, added in 11.6). Only for accounts in the common chart.
const ensureByCode = async (tx: Prisma.TransactionClient, actor: LedgerActor, code: string) => {
  const template = commonTemplate(code);
  if (!template) throw new Error(`no common account ${code}`);
  await tx.ledgerAccount.createMany({
    data: [{ ...template, workspaceId: actor.workspaceId, businessId: actor.businessId, createdBy: actor.userId, isSystem: true }],
    skipDuplicates: true,
  });
  return getByCode(tx, actor.businessId, code);
};

const getByCode = async (tx: Prisma.TransactionClient, businessId: string, code: string) => {
  const account = await tx.ledgerAccount.findUnique({ where: { businessId_code: { businessId, code } } });
  if (!account) throw new AppError(409, ErrorCode.BUSINESS_NOT_PROVISIONED, { code });
  return account;
};

// Allocates the next free code in a range. The lock stops two requests picking the same one.
const createInRange = async (
  tx: Prisma.TransactionClient,
  actor: LedgerActor,
  range: readonly [number, number],
  account: { name: string; nameBn?: string | null; type: "ASSET" | "REVENUE" | "EXPENSE" },
) => {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ledger-code:${actor.businessId}`}, 0))`;

  const used = await tx.ledgerAccount.findMany({
    where: { businessId: actor.businessId, code: { gte: String(range[0]), lte: String(range[1]) } },
    select: { code: true },
  });
  const usedCodes = new Set(used.map((item) => Number(item.code)));

  for (let code = range[0]; code <= range[1]; code++) {
    if (usedCodes.has(code)) continue;
    return tx.ledgerAccount.create({
      data: {
        ...account,
        code: String(code),
        normalBalance: normalBalanceOf(account.type),
        workspaceId: actor.workspaceId,
        businessId: actor.businessId,
        createdBy: actor.userId,
      },
    });
  }
  throw new AppError(409, ErrorCode.LEDGER_CODE_RANGE_FULL, { range });
};

// Every financial account gets its own asset account. The first Cash account uses the seeded 1100.
const createForFinancialAccount = async (
  tx: Prisma.TransactionClient,
  actor: LedgerActor,
  account: { name: string; type: keyof typeof CODE_RANGES },
) => {
  if (account.type === "CASH") {
    const seeded = await tx.ledgerAccount.findFirst({
      where: { businessId: actor.businessId, code: LedgerCode.CASH, financialAccount: null },
    });
    if (seeded) return seeded;
  }
  return createInRange(tx, actor, CODE_RANGES[account.type], { name: account.name, type: "ASSET" });
};

const createForCategory = (
  tx: Prisma.TransactionClient,
  actor: LedgerActor,
  category: { name: string; nameBn?: string | null; type: "INCOME" | "EXPENSE" },
) =>
  category.type === "INCOME"
    ? createInRange(tx, actor, CODE_RANGES.INCOME_CATEGORY, { name: category.name, nameBn: category.nameBn ?? null, type: "REVENUE" })
    : createInRange(tx, actor, CODE_RANGES.EXPENSE_CATEGORY, { name: category.name, nameBn: category.nameBn ?? null, type: "EXPENSE" });

const assertParentFits = async (
  tx: Prisma.TransactionClient,
  businessId: string,
  parentId: string,
  type: string,
  selfId?: string,
) => {
  const parent = await tx.ledgerAccount.findFirst({ where: { id: parentId, businessId, type: type as never } });
  if (!parent || parent.id === selfId) throw new AppError(422, ErrorCode.LEDGER_PARENT_INVALID);
};

const create = async (business: BusinessContext, body: ICreateLedgerAccountBody, context: RequestContext) => {
  try {
    return await withBusinessScope(business, async (tx) => {
      if (body.parentId) await assertParentFits(tx, business.businessId, body.parentId, body.type);

      const account = await tx.ledgerAccount.create({
        data: {
          ...body,
          normalBalance: normalBalanceOf(body.type),
          workspaceId: business.workspaceId,
          businessId: business.businessId,
          createdBy: business.userId,
        },
      });
      await auditService.recordForBusiness(tx, business, {
        action: "ledger_account.created",
        context,
        entityType: "ledger_account",
        entityId: account.id,
        after: { code: account.code, name: account.name, type: account.type },
      });
      return account;
    });
  } catch (error) {
    throw isUniqueViolation(error) ? new AppError(409, ErrorCode.CODE_TAKEN) : error;
  }
};

const list = (business: BusinessContext, query: IListLedgerAccountsQuery) =>
  withBusinessScope(business, (tx) =>
    tx.ledgerAccount.findMany({
      where: {
        businessId: business.businessId,
        ...(query.type ? { type: query.type } : {}),
        ...(query.includeInactive ? {} : { isActive: true }),
      },
      orderBy: { code: "asc" },
    }),
  );

const update = (
  business: BusinessContext,
  ledgerAccountId: string,
  body: IUpdateLedgerAccountBody,
  context: RequestContext,
) =>
  withBusinessScope(business, async (tx) => {
    const before = await tx.ledgerAccount.findFirst({
      where: { id: ledgerAccountId, businessId: business.businessId },
      include: { financialAccount: { select: { id: true } } },
    });
    if (!before) throw new AppError(404, ErrorCode.NOT_FOUND);

    // The posting engine needs these accounts, so they cannot be switched off.
    if (body.isActive === false && (before.isSystem || before.financialAccount)) {
      throw new AppError(409, ErrorCode.LEDGER_ACCOUNT_PROTECTED);
    }
    if (body.parentId) await assertParentFits(tx, business.businessId, body.parentId, before.type, ledgerAccountId);

    const after = await tx.ledgerAccount.update({ where: { id: ledgerAccountId }, data: body });

    const pick = (source: typeof after) =>
      Object.fromEntries(Object.keys(body).map((key) => [key, source[key as keyof IUpdateLedgerAccountBody]]));
    await auditService.recordForBusiness(tx, business, {
      action: "ledger_account.updated",
      context,
      entityType: "ledger_account",
      entityId: ledgerAccountId,
      before: pick(before),
      after: pick(after),
    });
    return after;
  });

// A financial account's rename carries through to the account behind it.
const rename = (tx: Prisma.TransactionClient, ledgerAccountId: string, name: string) =>
  tx.ledgerAccount.update({ where: { id: ledgerAccountId }, data: { name } });

// For other modules: throws unless every id is an active account in this business.
const assertAllUsable = async (tx: Prisma.TransactionClient, businessId: string, ids: string[]) => {
  const unique = [...new Set(ids)];
  const count = await tx.ledgerAccount.count({ where: { id: { in: unique }, businessId, isActive: true } });
  if (count !== unique.length) throw new AppError(422, ErrorCode.LEDGER_ACCOUNT_NOT_USABLE);
};

const assertCategoryAccountFits = async (
  tx: Prisma.TransactionClient,
  businessId: string,
  ledgerAccountId: string,
  categoryType: "INCOME" | "EXPENSE",
) => {
  const expected = categoryType === "INCOME" ? "REVENUE" : "EXPENSE";
  const account = await tx.ledgerAccount.findFirst({ where: { id: ledgerAccountId, businessId, isActive: true, type: expected } });
  if (!account) throw new AppError(422, ErrorCode.LEDGER_ACCOUNT_NOT_USABLE, { expected });
};

export const ledgerAccountsService = {
  seedChart,
  ensureByCode,
  getByCode,
  createForFinancialAccount,
  createForCategory,
  create,
  list,
  update,
  rename,
  assertAllUsable,
  assertCategoryAccountFits,
};
