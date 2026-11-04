import type { Prisma } from "../../../lib/prisma.js";
import { withBusinessScope } from "../../../lib/rls.js";
import { fromDbDate, todayInTimezone, toDbDate } from "../../utils/dates.js";
import { AppError, ErrorCode, isUniqueViolation } from "../../utils/errors.js";
import { pageArgs, toPage } from "../../utils/pagination.js";
import type { RequestContext } from "../../utils/requestContext.js";
import { auditService } from "../audit/audit.service.js";
import type { BusinessContext } from "../members/members.interface.js";
import type {
  ICashAccountInput,
  ICreateAccountBody,
  IListAccountsQuery,
  IUpdateAccountBody,
} from "./accounts.interface.js";

const maskAccountNumber = (accountNumber: string) => `****${accountNumber.replace(/\D/g, "").slice(-4)}`;

const toDto = <T extends { openingDate: Date }>(account: T) => ({
  ...account,
  openingDate: fromDbDate(account.openingDate),
});

// Part of setting up a new business. Does nothing if the business already has a Cash account.
const ensureCashAccount = async (tx: Prisma.TransactionClient, input: ICashAccountInput) => {
  const existing = await tx.financialAccount.findFirst({
    where: { businessId: input.businessId, type: "CASH" },
    select: { id: true },
  });
  if (existing) return;

  await tx.financialAccount.create({
    data: { ...input, name: "Cash", type: "CASH", openingBalanceMinor: 0n, currentBalanceMinor: 0n },
  });
};

const nameTakenOr = (error: unknown) => (isUniqueViolation(error) ? new AppError(409, ErrorCode.NAME_TAKEN) : error);

const create = async (business: BusinessContext, body: ICreateAccountBody, context: RequestContext) => {
  const { accountNumber, openingDate, openingBalanceMinor, currency, ...fields } = body;
  const openingBalance = BigInt(openingBalanceMinor);

  try {
    const account = await withBusinessScope(business, async (tx) => {
      const created = await tx.financialAccount.create({
        data: {
          ...fields,
          workspaceId: business.workspaceId,
          businessId: business.businessId,
          createdBy: business.userId,
          currency: currency ?? business.baseCurrency,
          openingBalanceMinor: openingBalance,
          // Phase 4 replaces this with a posted opening-balance journal.
          currentBalanceMinor: openingBalance,
          openingDate: toDbDate(openingDate ?? todayInTimezone(business.timezone)),
          maskedNumber: accountNumber ? maskAccountNumber(accountNumber) : null,
        },
      });
      await auditService.recordForBusiness(tx, business, {
        action: "account.created",
        context,
        entityType: "financial_account",
        entityId: created.id,
        after: { name: created.name, type: created.type, currency: created.currency, openingBalanceMinor: openingBalance },
      });
      return created;
    });
    return toDto(account);
  } catch (error) {
    throw nameTakenOr(error);
  }
};

const list = async (business: BusinessContext, query: IListAccountsQuery) => {
  const rows = await withBusinessScope(business, (tx) =>
    tx.financialAccount.findMany({
      where: { businessId: business.businessId, ...(query.includeInactive ? {} : { isActive: true }) },
      orderBy: { id: "asc" },
      ...pageArgs(query),
    }),
  );
  const page = toPage(rows, query.limit);
  return { ...page, items: page.items.map(toDto) };
};

const findOrThrow = async (tx: Prisma.TransactionClient, businessId: string, accountId: string) => {
  const account = await tx.financialAccount.findFirst({ where: { id: accountId, businessId } });
  if (!account) throw new AppError(404, ErrorCode.NOT_FOUND);
  return account;
};

const getOne = async (business: BusinessContext, accountId: string) =>
  toDto(await withBusinessScope(business, (tx) => findOrThrow(tx, business.businessId, accountId)));

const update = async (
  business: BusinessContext,
  accountId: string,
  body: IUpdateAccountBody,
  context: RequestContext,
) => {
  const { accountNumber, ...fields } = body;
  const data = {
    ...fields,
    ...(accountNumber === undefined ? {} : { maskedNumber: accountNumber ? maskAccountNumber(accountNumber) : null }),
  };

  try {
    const account = await withBusinessScope(business, async (tx) => {
      const before = await findOrThrow(tx, business.businessId, accountId);
      const after = await tx.financialAccount.update({ where: { id: accountId }, data });

      const pick = (source: typeof before) =>
        Object.fromEntries(Object.keys(data).map((key) => [key, source[key as keyof typeof data]]));
      await auditService.recordForBusiness(tx, business, {
        action: "account.updated",
        context,
        entityType: "financial_account",
        entityId: accountId,
        before: pick(before),
        after: pick(after),
      });
      return after;
    });
    return toDto(account);
  } catch (error) {
    throw nameTakenOr(error);
  }
};

// For other modules: the account must exist in this business and be active.
const getUsable = async (tx: Prisma.TransactionClient, businessId: string, accountId: string) => {
  const account = await tx.financialAccount.findFirst({ where: { id: accountId, businessId, isActive: true } });
  if (!account) throw new AppError(422, ErrorCode.ACCOUNT_NOT_USABLE, { accountId });
  return account;
};

export const accountsService = { ensureCashAccount, create, list, getOne, update, getUsable };
