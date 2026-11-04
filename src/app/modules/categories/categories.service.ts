import type { Prisma } from "../../../lib/prisma.js";
import { withBusinessScope } from "../../../lib/rls.js";
import { categoryTemplatesFor } from "../../constants/categoryTemplates.js";
import { AppError, ErrorCode, isUniqueViolation } from "../../utils/errors.js";
import { pageArgs, toPage } from "../../utils/pagination.js";
import type { RequestContext } from "../../utils/requestContext.js";
import { auditService } from "../audit/audit.service.js";
import type { BusinessContext } from "../members/members.interface.js";
import type { LedgerActor } from "../ledger-accounts/ledger-accounts.interface.js";
import { ledgerAccountsService } from "../ledger-accounts/ledger-accounts.service.js";
import type {
  ICreateCategoryBody,
  IListCategoriesQuery,
  IUpdateCategoryBody,
} from "./categories.interface.js";

// Part of setting up a new business. Running it twice changes nothing.
const seedDefaults = async (tx: Prisma.TransactionClient, actor: LedgerActor, businessType: string) => {
  const accounts = await tx.ledgerAccount.findMany({ where: { businessId: actor.businessId }, select: { id: true, code: true } });
  const idByCode = new Map(accounts.map((account) => [account.code, account.id]));

  await tx.category.createMany({
    data: categoryTemplatesFor(businessType).map(({ ledgerCode, ...template }) => ({
      ...template,
      workspaceId: actor.workspaceId,
      businessId: actor.businessId,
      createdBy: actor.userId,
      ledgerAccountId: idByCode.get(ledgerCode) ?? null,
      isSystem: true,
    })),
    skipDuplicates: true,
  });
};

// For categories created before the ledger existed. Template names go to their usual account,
// and anything else gets its own new account.
const linkExistingToLedger = async (tx: Prisma.TransactionClient, actor: LedgerActor, businessType: string) => {
  const unlinked = await tx.category.findMany({ where: { businessId: actor.businessId, ledgerAccountId: null } });
  const templates = categoryTemplatesFor(businessType);

  for (const category of unlinked) {
    const template = templates.find((item) => item.type === category.type && item.name === category.name);
    const ledger = template
      ? await ledgerAccountsService.getByCode(tx, actor.businessId, template.ledgerCode)
      : await ledgerAccountsService.createForCategory(tx, actor, category);
    await tx.category.update({ where: { id: category.id }, data: { ledgerAccountId: ledger.id } });
  }
};

const nameTakenOr = (error: unknown) => (isUniqueViolation(error) ? new AppError(409, ErrorCode.NAME_TAKEN) : error);

const create = async (business: BusinessContext, body: ICreateCategoryBody, context: RequestContext) => {
  try {
    return await withBusinessScope(business, async (tx) => {
      if (body.ledgerAccountId) {
        await ledgerAccountsService.assertCategoryAccountFits(tx, business.businessId, body.ledgerAccountId, body.type);
      }
      const ledgerAccountId = body.ledgerAccountId ?? (await ledgerAccountsService.createForCategory(tx, business, body)).id;

      const category = await tx.category.create({
        data: {
          ...body,
          ledgerAccountId,
          workspaceId: business.workspaceId,
          businessId: business.businessId,
          createdBy: business.userId,
        },
      });
      await auditService.recordForBusiness(tx, business, {
        action: "category.created",
        context,
        entityType: "category",
        entityId: category.id,
        after: body,
      });
      return category;
    });
  } catch (error) {
    throw nameTakenOr(error);
  }
};

const list = async (business: BusinessContext, query: IListCategoriesQuery) => {
  const rows = await withBusinessScope(business, (tx) =>
    tx.category.findMany({
      where: {
        businessId: business.businessId,
        ...(query.type ? { type: query.type } : {}),
        ...(query.includeInactive ? {} : { isActive: true }),
      },
      orderBy: { id: "asc" },
      ...pageArgs(query),
    }),
  );
  return toPage(rows, query.limit);
};

const update = async (
  business: BusinessContext,
  categoryId: string,
  body: IUpdateCategoryBody,
  context: RequestContext,
) => {
  try {
    return await withBusinessScope(business, async (tx) => {
      const before = await tx.category.findFirst({ where: { id: categoryId, businessId: business.businessId } });
      if (!before) throw new AppError(404, ErrorCode.NOT_FOUND);

      // Only future postings use a new account; journals already posted stay where they are.
      if (body.ledgerAccountId) {
        await ledgerAccountsService.assertCategoryAccountFits(tx, business.businessId, body.ledgerAccountId, before.type);
      }

      const after = await tx.category.update({ where: { id: categoryId }, data: body });

      const pick = (source: typeof before) =>
        Object.fromEntries(Object.keys(body).map((key) => [key, source[key as keyof typeof body]]));
      await auditService.recordForBusiness(tx, business, {
        action: "category.updated",
        context,
        entityType: "category",
        entityId: categoryId,
        before: pick(before),
        after: pick(after),
      });
      return after;
    });
  } catch (error) {
    throw nameTakenOr(error);
  }
};

// For other modules: the category must exist in this business and be active.
const getUsable = async (tx: Prisma.TransactionClient, businessId: string, categoryId: string) => {
  const category = await tx.category.findFirst({ where: { id: categoryId, businessId, isActive: true } });
  if (!category) throw new AppError(422, ErrorCode.CATEGORY_NOT_USABLE, { categoryId });
  return category;
};

export const categoriesService = { seedDefaults, linkExistingToLedger, create, list, update, getUsable };
