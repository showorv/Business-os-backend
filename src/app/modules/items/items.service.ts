import type { Prisma } from "../../../lib/prisma.js";
import { withBusinessScope } from "../../../lib/rls.js";
import { AppError, ErrorCode } from "../../utils/errors.js";
import { pageArgs, toPage } from "../../utils/pagination.js";
import type { RequestContext } from "../../utils/requestContext.js";
import { auditService } from "../audit/audit.service.js";
import { categoriesService } from "../categories/categories.service.js";
import type { BusinessContext } from "../members/members.interface.js";
import type { ICreateItemBody, IItemMovement, IItemTotals, IListItemsQuery, IUpdateItemBody } from "./items.interface.js";

// Invoices and bills that are in the books.
const COUNTED = ["ISSUED", "PARTIALLY_PAID", "PAID"] as const;

const include = {
  incomeCategory: { select: { id: true, name: true, nameBn: true } },
  expenseCategory: { select: { id: true, name: true, nameBn: true } },
} as const;

const emptyMovement = (): IItemMovement => ({ quantity: "0", amountMinor: "0", lines: 0 });

const totalsFor = async (tx: Prisma.TransactionClient, businessId: string, itemIds: string[]) => {
  const byItem = new Map<string, IItemTotals>();
  if (itemIds.length === 0) return byItem;
  for (const kind of ["SALE", "BILL"] as const) {
    const groups = await tx.invoiceLine.groupBy({
      by: ["itemId"],
      where: { businessId, itemId: { in: itemIds }, invoice: { kind, status: { in: [...COUNTED] } } },
      _sum: { quantity: true, amountMinor: true },
      _count: { _all: true },
    });
    for (const group of groups) {
      const totals = byItem.get(group.itemId!) ?? { sold: emptyMovement(), bought: emptyMovement() };
      totals[kind === "SALE" ? "sold" : "bought"] = {
        quantity: (group._sum.quantity ?? 0).toString(),
        amountMinor: (group._sum.amountMinor ?? 0n).toString(),
        lines: group._count._all,
      };
      byItem.set(group.itemId!, totals);
    }
  }
  return byItem;
};

const withTotals = async <T extends { id: string }>(tx: Prisma.TransactionClient, businessId: string, items: T[]) => {
  const totals = await totalsFor(
    tx,
    businessId,
    items.map((item) => item.id),
  );
  return items.map((item) => ({ ...item, totals: totals.get(item.id) ?? { sold: emptyMovement(), bought: emptyMovement() } }));
};

// The income category must be an income one, the expense category an expense one.
const assertCategories = async (tx: Prisma.TransactionClient, businessId: string, body: { incomeCategoryId?: string | null; expenseCategoryId?: string | null }) => {
  for (const [id, type] of [
    [body.incomeCategoryId, "INCOME"],
    [body.expenseCategoryId, "EXPENSE"],
  ] as const) {
    if (!id) continue;
    const category = await categoriesService.getUsable(tx, businessId, id);
    if (category.type !== type) throw new AppError(422, ErrorCode.CATEGORY_TYPE_MISMATCH, { categoryId: id, expected: type });
  }
};

const assertNameFree = async (tx: Prisma.TransactionClient, businessId: string, name: string, exceptId?: string) => {
  const taken = await tx.item.findFirst({
    where: { businessId, name: { equals: name, mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true, isActive: true },
  });
  if (taken) throw new AppError(409, ErrorCode.ITEM_NAME_TAKEN, { itemId: taken.id, archived: !taken.isActive });
};

// The body as Prisma wants it: prices as BigInt, left out when not sent.
const toData = <T extends { salePriceMinor?: string | null; purchasePriceMinor?: string | null }>(body: T) => {
  const { salePriceMinor, purchasePriceMinor, ...rest } = body;
  const money = (value: string | null | undefined) => (value === undefined ? undefined : value === null ? null : BigInt(value));
  return { ...rest, salePriceMinor: money(salePriceMinor), purchasePriceMinor: money(purchasePriceMinor) };
};

const create = (business: BusinessContext, body: ICreateItemBody, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    await assertNameFree(tx, business.businessId, body.name);
    await assertCategories(tx, business.businessId, body);
    const item = await tx.item.create({
      data: { ...toData(body), workspaceId: business.workspaceId, businessId: business.businessId, createdBy: business.userId },
      include,
    });
    await auditService.recordForBusiness(tx, business, {
      action: "item.created",
      context,
      entityType: "item",
      entityId: item.id,
      after: { name: item.name, salePriceMinor: item.salePriceMinor?.toString() ?? null, purchasePriceMinor: item.purchasePriceMinor?.toString() ?? null },
    });
    const [withTotal] = await withTotals(tx, business.businessId, [item]);
    return withTotal!;
  });

const list = (business: BusinessContext, query: IListItemsQuery) =>
  withBusinessScope(business, async (tx) => {
    const search = query.search || undefined;
    const rows = await tx.item.findMany({
      where: {
        businessId: business.businessId,
        ...(query.includeArchived ? {} : { isActive: true }),
        ...(query.use === "SALE" ? { salePriceMinor: { not: null } } : query.use === "BILL" ? { purchasePriceMinor: { not: null } } : {}),
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: "insensitive" } },
                { code: { contains: search, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      include,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { ...page, items: await withTotals(tx, business.businessId, page.items) };
  });

const getOne = (business: BusinessContext, itemId: string) =>
  withBusinessScope(business, async (tx) => {
    const item = await tx.item.findFirst({ where: { id: itemId, businessId: business.businessId }, include });
    if (!item) throw new AppError(404, ErrorCode.NOT_FOUND);
    const [withTotal] = await withTotals(tx, business.businessId, [item]);
    return withTotal!;
  });

const update = (business: BusinessContext, itemId: string, body: IUpdateItemBody, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    const before = await tx.item.findFirst({ where: { id: itemId, businessId: business.businessId } });
    if (!before) throw new AppError(404, ErrorCode.NOT_FOUND);
    if (body.name !== undefined) await assertNameFree(tx, business.businessId, body.name, itemId);
    await assertCategories(tx, business.businessId, body);
    const after = await tx.item.update({ where: { id: itemId }, data: toData(body), include });
    const show = (value: unknown) => (typeof value === "bigint" ? value.toString() : value);
    const pick = (source: typeof before) => Object.fromEntries(Object.keys(body).map((key) => [key, show(source[key as keyof IUpdateItemBody])]));
    await auditService.recordForBusiness(tx, business, {
      action: body.isActive === false && before.isActive ? "item.archived" : "item.updated",
      context,
      entityType: "item",
      entityId: itemId,
      before: pick(before),
      after: pick(after),
    });
    const [withTotal] = await withTotals(tx, business.businessId, [after]);
    return withTotal!;
  });

// For invoice lines: the item must be this business's and not archived.
const assertUsable = async (tx: Prisma.TransactionClient, businessId: string, itemId: string, line: number) => {
  const item = await tx.item.findFirst({ where: { id: itemId, businessId, isActive: true }, select: { id: true } });
  if (!item) throw new AppError(422, ErrorCode.ITEM_NOT_USABLE, { itemId, line });
};

export const itemsService = { create, list, getOne, update, assertUsable };
