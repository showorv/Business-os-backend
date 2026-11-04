import type { Prisma } from "../../../lib/prisma.js";
import { withBusinessScope } from "../../../lib/rls.js";
import { Permission } from "../../constants/permissions.js";
import { AppError, ErrorCode } from "../../utils/errors.js";
import type { RequestContext } from "../../utils/requestContext.js";
import { auditService } from "../audit/audit.service.js";
import { categoriesService } from "../categories/categories.service.js";
import type { BusinessContext } from "../members/members.interface.js";
import type { ICreateRuleBody, IUpdateRuleBody } from "./statement-rules.interface.js";

const REQUIRED_CATEGORY_TYPE = { IN: "INCOME", OUT: "EXPENSE" } as const;

const assertCategoryFits = async (tx: Prisma.TransactionClient, businessId: string, categoryId: string, direction: "IN" | "OUT") => {
  const category = await categoriesService.getUsable(tx, businessId, categoryId);
  if (category.type !== REQUIRED_CATEGORY_TYPE[direction]) {
    throw new AppError(422, ErrorCode.RULE_CATEGORY_MISMATCH, { direction, categoryType: category.type });
  }
};

// A rule that posts writes to the books by itself, so making one takes the same permission as posting.
const assertMayAutoPost = (business: BusinessContext, autoPost: boolean | undefined) => {
  if (autoPost && !business.permissions.includes(Permission.LEDGER_POST)) {
    throw new AppError(403, ErrorCode.PERMISSION_DENIED, { permission: Permission.LEDGER_POST });
  }
};

const create = (business: BusinessContext, body: ICreateRuleBody, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    assertMayAutoPost(business, body.autoPost);
    await assertCategoryFits(tx, business.businessId, body.categoryId, body.direction);

    const { maxAmountMinor, ...fields } = body;
    const rule = await tx.statementRule.create({
      data: {
        ...fields,
        maxAmountMinor: maxAmountMinor ? BigInt(maxAmountMinor) : null,
        workspaceId: business.workspaceId,
        businessId: business.businessId,
        createdBy: business.userId,
      },
    });
    await auditService.recordForBusiness(tx, business, {
      action: "statement_rule.created",
      context,
      entityType: "statement_rule",
      entityId: rule.id,
      after: { name: rule.name, containsText: rule.containsText, categoryId: rule.categoryId, autoPost: rule.autoPost },
    });
    return rule;
  });

const list = (business: BusinessContext) =>
  withBusinessScope(business, (tx) =>
    tx.statementRule.findMany({ where: { businessId: business.businessId }, orderBy: [{ priority: "asc" }, { id: "asc" }] }),
  );

const findOrThrow = async (tx: Prisma.TransactionClient, businessId: string, ruleId: string) => {
  const rule = await tx.statementRule.findFirst({ where: { id: ruleId, businessId } });
  if (!rule) throw new AppError(404, ErrorCode.NOT_FOUND);
  return rule;
};

const update = (business: BusinessContext, ruleId: string, body: IUpdateRuleBody, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    const before = await findOrThrow(tx, business.businessId, ruleId);
    assertMayAutoPost(business, body.autoPost);
    if (body.categoryId) await assertCategoryFits(tx, business.businessId, body.categoryId, before.direction);

    const { maxAmountMinor, ...fields } = body;
    const after = await tx.statementRule.update({
      where: { id: ruleId },
      data: { ...fields, ...(maxAmountMinor !== undefined ? { maxAmountMinor: maxAmountMinor ? BigInt(maxAmountMinor) : null } : {}) },
    });
    const pick = (rule: typeof before) => ({ name: rule.name, containsText: rule.containsText, categoryId: rule.categoryId, autoPost: rule.autoPost, isActive: rule.isActive });
    await auditService.recordForBusiness(tx, business, {
      action: "statement_rule.updated",
      context,
      entityType: "statement_rule",
      entityId: ruleId,
      before: pick(before),
      after: pick(after),
    });
    return after;
  });

const remove = (business: BusinessContext, ruleId: string, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    const before = await findOrThrow(tx, business.businessId, ruleId);
    await tx.statementRule.delete({ where: { id: ruleId } });
    await auditService.recordForBusiness(tx, business, {
      action: "statement_rule.deleted",
      context,
      entityType: "statement_rule",
      entityId: ruleId,
      before: { name: before.name, containsText: before.containsText },
    });
    return { removed: true };
  });

// The first active rule that fits a statement line, in priority order.
const findFor = async (
  tx: Prisma.TransactionClient,
  businessId: string,
  line: { direction: "IN" | "OUT"; amountMinor: bigint; description: string | null; counterparty: string | null; reference: string | null },
) => {
  const rules = await tx.statementRule.findMany({
    where: { businessId, isActive: true, direction: line.direction },
    orderBy: [{ priority: "asc" }, { id: "asc" }],
  });
  const text = [line.description, line.counterparty, line.reference].filter(Boolean).join(" ").toLowerCase();
  return (
    rules.find(
      (rule) => text.includes(rule.containsText.toLowerCase()) && (rule.maxAmountMinor === null || line.amountMinor <= rule.maxAmountMinor),
    ) ?? null
  );
};

export const statementRulesService = { create, list, update, remove, findFor };
