import type { Prisma } from "../../../lib/prisma.js";
import { withBusinessScope } from "../../../lib/rls.js";
import { categoryTemplatesFor } from "../../constants/categoryTemplates.js";
import { AppError, ErrorCode, isUniqueViolation } from "../../utils/errors.js";
import { pageArgs, toPage } from "../../utils/pagination.js";
import type { RequestContext } from "../../utils/requestContext.js";
import { auditService } from "../audit/audit.service.js";
import type { BusinessContext } from "../members/members.interface.js";
import type {
  ICategoryOwner,
  ICreateCategoryBody,
  IListCategoriesQuery,
  IUpdateCategoryBody,
} from "./categories.interface.js";

// Part of setting up a new business. Running it twice changes nothing.
const seedDefaults = (tx: Prisma.TransactionClient, owner: ICategoryOwner, businessType: string) =>
  tx.category.createMany({
    data: categoryTemplatesFor(businessType).map((template) => ({ ...template, ...owner, isSystem: true })),
    skipDuplicates: true,
  });

const nameTakenOr = (error: unknown) => (isUniqueViolation(error) ? new AppError(409, ErrorCode.NAME_TAKEN) : error);

const create = async (business: BusinessContext, body: ICreateCategoryBody, context: RequestContext) => {
  try {
    return await withBusinessScope(business, async (tx) => {
      const category = await tx.category.create({
        data: {
          ...body,
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

export const categoriesService = { seedDefaults, create, list, update, getUsable };
