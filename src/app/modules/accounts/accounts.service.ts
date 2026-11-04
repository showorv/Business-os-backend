import type { Prisma } from "../../../lib/prisma.js";
import { withBusinessScope } from "../../../lib/rls.js";
import { LedgerCode } from "../../constants/chartOfAccounts.js";
import { fromDbDate, todayInTimezone, toDbDate } from "../../utils/dates.js";
import { AppError, ErrorCode, isUniqueViolation } from "../../utils/errors.js";
import { pageArgs, toPage } from "../../utils/pagination.js";
import { credit, debit } from "../../utils/postingRules.js";
import type { RequestContext } from "../../utils/requestContext.js";
import { auditService } from "../audit/audit.service.js";
import type { FiscalActor } from "../fiscal-periods/fiscal-periods.interface.js";
import { canPostToSoftClosed, journalsService } from "../journals/journals.service.js";
import type { LedgerActor } from "../ledger-accounts/ledger-accounts.interface.js";
import { ledgerAccountsService } from "../ledger-accounts/ledger-accounts.service.js";
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

// An opening balance is a real journal: Dr the account, Cr Opening Balance Equity. That keeps the
// books balanced from the first day.
const postOpeningBalance = async (
  tx: Prisma.TransactionClient,
  actor: LedgerActor & FiscalActor,
  account: { id: string; name: string; openingBalanceMinor: bigint; openingDate: Date; ledgerAccountId: string },
  allowSoftClosed: boolean,
) => {
  const equity = await ledgerAccountsService.getByCode(tx, actor.businessId, LedgerCode.OPENING_BALANCE_EQUITY);
  return journalsService.post(tx, actor, {
    entryDate: account.openingDate,
    kind: "OPENING",
    memo: `Opening balance: ${account.name}`,
    sourceType: "financial_account",
    sourceId: account.id,
    allowBackfill: true,
    allowSoftClosed,
    lines: [debit(account.ledgerAccountId, account.openingBalanceMinor), credit(equity.id, account.openingBalanceMinor)],
  });
};

// Part of setting up a new business. Does nothing if the business already has a Cash account.
const ensureCashAccount = async (
  tx: Prisma.TransactionClient,
  actor: LedgerActor,
  input: ICashAccountInput,
) => {
  const existing = await tx.financialAccount.findFirst({
    where: { businessId: actor.businessId, type: "CASH" },
    select: { id: true },
  });
  if (existing) return;

  const ledger = await ledgerAccountsService.createForFinancialAccount(tx, actor, { name: "Cash", type: "CASH" });
  await tx.financialAccount.create({
    data: {
      ...input,
      workspaceId: actor.workspaceId,
      businessId: actor.businessId,
      createdBy: actor.userId,
      ledgerAccountId: ledger.id,
      name: "Cash",
      type: "CASH",
      openingBalanceMinor: 0n,
      currentBalanceMinor: 0n,
    },
  });
};

// For accounts created before the ledger existed. Their balance came from a plain number, so it
// restarts at zero and the opening journal rebuilds it.
const linkExistingToLedger = async (tx: Prisma.TransactionClient, actor: LedgerActor & FiscalActor) => {
  const unlinked = await tx.financialAccount.findMany({ where: { businessId: actor.businessId, ledgerAccountId: null } });

  for (const account of unlinked) {
    const ledger = await ledgerAccountsService.createForFinancialAccount(tx, actor, account);
    const canPost = account.currency === actor.baseCurrency && account.openingBalanceMinor > 0n;
    await tx.financialAccount.update({
      where: { id: account.id },
      data: { ledgerAccountId: ledger.id, ...(canPost ? { currentBalanceMinor: 0n } : {}) },
    });
    if (canPost) {
      await postOpeningBalance(tx, actor, { ...account, ledgerAccountId: ledger.id }, true);
    }
  }
};

const nameTakenOr = (error: unknown) => (isUniqueViolation(error) ? new AppError(409, ErrorCode.NAME_TAKEN) : error);

const create = async (business: BusinessContext, body: ICreateAccountBody, context: RequestContext) => {
  const { accountNumber, openingDate, openingBalanceMinor, currency, ...fields } = body;
  const openingBalance = BigInt(openingBalanceMinor);
  const accountCurrency = currency ?? business.baseCurrency;

  // The ledger only holds the base currency for now, so a foreign balance can't be posted yet.
  if (openingBalance > 0n && accountCurrency !== business.baseCurrency) {
    throw new AppError(422, ErrorCode.FOREIGN_CURRENCY_NOT_SUPPORTED, { currency: accountCurrency });
  }

  try {
    const account = await withBusinessScope(business, async (tx) => {
      const ledger = await ledgerAccountsService.createForFinancialAccount(tx, business, { name: fields.name, type: fields.type });
      const created = await tx.financialAccount.create({
        data: {
          ...fields,
          workspaceId: business.workspaceId,
          businessId: business.businessId,
          createdBy: business.userId,
          ledgerAccountId: ledger.id,
          currency: accountCurrency,
          openingBalanceMinor: openingBalance,
          // Starts at zero: the opening journal below is what moves it.
          currentBalanceMinor: 0n,
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

      if (openingBalance === 0n) return created;
      await postOpeningBalance(tx, business, { ...created, ledgerAccountId: ledger.id }, canPostToSoftClosed(business));
      return tx.financialAccount.findUniqueOrThrow({ where: { id: created.id } });
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
      if (body.name && before.ledgerAccountId && before.type !== "CASH") {
        await ledgerAccountsService.rename(tx, before.ledgerAccountId, body.name);
      }

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

// For the posting engine's callers: an account from before the ledger needs `npm run db:provision`.
const ledgerIdOf = (account: { ledgerAccountId: string | null }) => {
  if (!account.ledgerAccountId) throw new AppError(409, ErrorCode.BUSINESS_NOT_PROVISIONED);
  return account.ledgerAccountId;
};

export const accountsService = {
  ensureCashAccount,
  linkExistingToLedger,
  create,
  list,
  getOne,
  update,
  getUsable,
  ledgerIdOf,
};
