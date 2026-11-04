import type { Prisma } from "../../../lib/prisma.js";
import { withBusinessScope } from "../../../lib/rls.js";
import { AppError, ErrorCode, isUniqueViolation } from "../../utils/errors.js";
import type { RequestContext } from "../../utils/requestContext.js";
import { auditService } from "../audit/audit.service.js";
import type { BusinessContext } from "../members/members.interface.js";
import type { ICreateTemplateBody, IUpdateTemplateBody } from "./statement-templates.interface.js";

const nameTakenOr = (error: unknown) => (isUniqueViolation(error) ? new AppError(409, ErrorCode.NAME_TAKEN) : error);

const create = async (business: BusinessContext, body: ICreateTemplateBody, context: RequestContext) => {
  try {
    return await withBusinessScope(business, async (tx) => {
      const template = await tx.statementTemplate.create({
        data: { workspaceId: business.workspaceId, businessId: business.businessId, name: body.name, mapping: body.mapping, createdBy: business.userId },
      });
      await auditService.recordForBusiness(tx, business, {
        action: "statement_template.created",
        context,
        entityType: "statement_template",
        entityId: template.id,
        after: { name: body.name, mapping: body.mapping },
      });
      return template;
    });
  } catch (error) {
    throw nameTakenOr(error);
  }
};

const list = (business: BusinessContext) =>
  withBusinessScope(business, (tx) => tx.statementTemplate.findMany({ where: { businessId: business.businessId }, orderBy: { name: "asc" } }));

const findOrThrow = async (tx: Prisma.TransactionClient, businessId: string, templateId: string) => {
  const template = await tx.statementTemplate.findFirst({ where: { id: templateId, businessId } });
  if (!template) throw new AppError(404, ErrorCode.NOT_FOUND);
  return template;
};

const update = async (business: BusinessContext, templateId: string, body: IUpdateTemplateBody, context: RequestContext) => {
  try {
    return await withBusinessScope(business, async (tx) => {
      const before = await findOrThrow(tx, business.businessId, templateId);
      const after = await tx.statementTemplate.update({ where: { id: templateId }, data: body });
      await auditService.recordForBusiness(tx, business, {
        action: "statement_template.updated",
        context,
        entityType: "statement_template",
        entityId: templateId,
        before: { name: before.name, mapping: before.mapping },
        after: { name: after.name, mapping: after.mapping },
      });
      return after;
    });
  } catch (error) {
    throw nameTakenOr(error);
  }
};

// Past imports keep their own copy of the mapping, so removing a template changes nothing already done.
const remove = (business: BusinessContext, templateId: string, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    const before = await findOrThrow(tx, business.businessId, templateId);
    await tx.statementTemplate.delete({ where: { id: templateId } });
    await auditService.recordForBusiness(tx, business, {
      action: "statement_template.deleted",
      context,
      entityType: "statement_template",
      entityId: templateId,
      before: { name: before.name },
    });
    return { removed: true };
  });

const getMapping = async (tx: Prisma.TransactionClient, businessId: string, templateId: string) =>
  (await findOrThrow(tx, businessId, templateId)).mapping;

export const statementTemplatesService = { create, list, update, remove, getMapping };
