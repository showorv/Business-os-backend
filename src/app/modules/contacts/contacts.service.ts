import type { Prisma } from "../../../lib/prisma.js";
import { withBusinessScope } from "../../../lib/rls.js";
import { fromDbDate } from "../../utils/dates.js";
import { AppError, ErrorCode } from "../../utils/errors.js";
import { pageArgs, toPage } from "../../utils/pagination.js";
import type { RequestContext } from "../../utils/requestContext.js";
import { auditService } from "../audit/audit.service.js";
import type { BusinessContext } from "../members/members.interface.js";
import type { IContactTotals, ICreateContactBody, IListContactsQuery, IUpdateContactBody } from "./contacts.interface.js";

// Money in from a contact is income; money out is expenses and refunds.
const MONEY_IN = ["INCOME"] as const;
const MONEY_OUT = ["EXPENSE", "REFUND"] as const;

// Posted totals for each contact, one row per currency, newest activity included. Payments against
// invoices and bills are added in, since they move money with the contact without being transactions.
const totalsFor = async (tx: Prisma.TransactionClient, businessId: string, contactIds: string[]) => {
  const byContact = new Map<string, IContactTotals[]>();
  if (contactIds.length === 0) return byContact;
  const groups = await tx.transaction.groupBy({
    by: ["contactId", "currency", "type"],
    where: { businessId, contactId: { in: contactIds }, status: "POSTED", type: { in: [...MONEY_IN, ...MONEY_OUT] } },
    _sum: { amountMinor: true },
    _count: { _all: true },
    _max: { txnDate: true },
  });
  for (const group of groups) {
    const list = byContact.get(group.contactId!) ?? [];
    let row = list.find((item) => item.currency === group.currency);
    if (!row) {
      row = { currency: group.currency, receivedMinor: "0", paidMinor: "0", transactions: 0, lastDate: null };
      list.push(row);
    }
    const amount = group._sum.amountMinor ?? 0n;
    if ((MONEY_IN as readonly string[]).includes(group.type)) row.receivedMinor = (BigInt(row.receivedMinor) + amount).toString();
    else row.paidMinor = (BigInt(row.paidMinor) + amount).toString();
    row.transactions += group._count._all;
    const last = group._max.txnDate ? fromDbDate(group._max.txnDate) : null;
    if (last && (!row.lastDate || last > row.lastDate)) row.lastDate = last;
    byContact.set(group.contactId!, list);
  }

  // Money against invoices and bills counts too: received for an invoice, paid for a bill.
  const payments = await tx.invoicePayment.findMany({
    where: { businessId, voidedAt: null, invoice: { contactId: { in: contactIds } } },
    select: { amountMinor: true, paidOn: true, invoice: { select: { contactId: true, kind: true, currency: true } } },
  });
  for (const payment of payments) {
    const { contactId, kind, currency } = payment.invoice;
    const list = byContact.get(contactId) ?? [];
    let row = list.find((item) => item.currency === currency);
    if (!row) {
      row = { currency, receivedMinor: "0", paidMinor: "0", transactions: 0, lastDate: null };
      list.push(row);
    }
    if (kind === "SALE") row.receivedMinor = (BigInt(row.receivedMinor) + payment.amountMinor).toString();
    else row.paidMinor = (BigInt(row.paidMinor) + payment.amountMinor).toString();
    row.transactions += 1;
    const paidOn = fromDbDate(payment.paidOn);
    if (!row.lastDate || paidOn > row.lastDate) row.lastDate = paidOn;
    byContact.set(contactId, list);
  }
  return byContact;
};

const withTotals = async <T extends { id: string }>(tx: Prisma.TransactionClient, businessId: string, contacts: T[]) => {
  const totals = await totalsFor(
    tx,
    businessId,
    contacts.map((contact) => contact.id),
  );
  return contacts.map((contact) => ({ ...contact, totals: totals.get(contact.id) ?? [] }));
};

const create = (business: BusinessContext, body: ICreateContactBody, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    const contact = await tx.contact.create({
      data: { ...body, workspaceId: business.workspaceId, businessId: business.businessId, createdBy: business.userId },
    });
    await auditService.recordForBusiness(tx, business, {
      action: "contact.created",
      context,
      entityType: "contact",
      entityId: contact.id,
      after: { kind: body.kind, name: body.name },
    });
    return { ...contact, totals: [] as IContactTotals[] };
  });

const list = (business: BusinessContext, query: IListContactsQuery) =>
  withBusinessScope(business, async (tx) => {
    const search = query.search || undefined;
    const rows = await tx.contact.findMany({
      where: {
        businessId: business.businessId,
        ...(query.includeArchived ? {} : { isActive: true }),
        ...(query.kind ? { kind: { in: [query.kind, "BOTH"] } } : {}),
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: "insensitive" } },
                { company: { contains: search, mode: "insensitive" } },
                { phone: { contains: search } },
                { email: { contains: search, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { ...page, items: await withTotals(tx, business.businessId, page.items) };
  });

const getOne = (business: BusinessContext, contactId: string) =>
  withBusinessScope(business, async (tx) => {
    const contact = await tx.contact.findFirst({ where: { id: contactId, businessId: business.businessId } });
    if (!contact) throw new AppError(404, ErrorCode.NOT_FOUND);
    const [withTotal] = await withTotals(tx, business.businessId, [contact]);
    return withTotal!;
  });

const update = (business: BusinessContext, contactId: string, body: IUpdateContactBody, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    const before = await tx.contact.findFirst({ where: { id: contactId, businessId: business.businessId } });
    if (!before) throw new AppError(404, ErrorCode.NOT_FOUND);
    const after = await tx.contact.update({ where: { id: contactId }, data: body });
    const pick = (source: typeof before) => Object.fromEntries(Object.keys(body).map((key) => [key, source[key as keyof IUpdateContactBody]]));
    await auditService.recordForBusiness(tx, business, {
      action: body.isActive === false && before.isActive ? "contact.archived" : "contact.updated",
      context,
      entityType: "contact",
      entityId: contactId,
      before: pick(before),
      after: pick(after),
    });
    const [withTotal] = await withTotals(tx, business.businessId, [after]);
    return withTotal!;
  });

// For transactions: the contact must belong to this business and not be archived.
const assertUsable = async (tx: Prisma.TransactionClient, businessId: string, contactId: string) => {
  const contact = await tx.contact.findFirst({ where: { id: contactId, businessId, isActive: true }, select: { id: true } });
  if (!contact) throw new AppError(422, ErrorCode.CONTACT_NOT_USABLE, { contactId });
};

export const contactsService = { create, list, getOne, update, assertUsable };
