import type { Prisma } from "../../../lib/prisma.js";
import { emailEnabled, sendEmail } from "../../../lib/mailer.js";
import { withBusinessScope } from "../../../lib/rls.js";
import { LedgerCode } from "../../constants/chartOfAccounts.js";
import { renderInvoicePdf, type InvoiceDocument } from "../../exports/renderInvoice.js";
import { escapeHtml } from "../../exports/renderPdf.js";
import { fromDbDate, todayInTimezone, toDbDate } from "../../utils/dates.js";
import { AppError, ErrorCode } from "../../utils/errors.js";
import { formatMoney } from "../../utils/money.js";
import { pageArgs, toPage } from "../../utils/pagination.js";
import { buildInvoiceLines, buildInvoicePaymentLines, lineAmountMinor } from "../../utils/postingRules.js";
import type { RequestContext } from "../../utils/requestContext.js";
import { nextSequence } from "../../utils/sequences.js";
import { accountsService } from "../accounts/accounts.service.js";
import { auditService } from "../audit/audit.service.js";
import { categoriesService } from "../categories/categories.service.js";
import { canPostToSoftClosed, journalsService } from "../journals/journals.service.js";
import { ledgerAccountsService } from "../ledger-accounts/ledger-accounts.service.js";
import type { BusinessContext } from "../members/members.interface.js";
import {
  AGING_BUCKETS,
  type AgingBucket,
  type IAgingAmounts,
  type IAgingQuery,
  type IAgingReport,
  type IAgingRow,
  type ICreateInvoiceBody,
  type IEmailInvoiceBody,
  type IInvoiceLineInput,
  type IInvoicePdfQuery,
  type IListInvoicesQuery,
  type IRecordPaymentBody,
  type IUpdateInvoiceBody,
  type IVoidInvoiceBody,
} from "./invoices.interface.js";

type Kind = "SALE" | "BILL";

// An invoice is money a customer owes (receivables); a bill is money owed to a supplier (payables).
const CONTROL_ACCOUNT: Record<Kind, string> = { SALE: LedgerCode.ACCOUNTS_RECEIVABLE, BILL: LedgerCode.ACCOUNTS_PAYABLE };
const NUMBER_PREFIX: Record<Kind, string> = { SALE: "INV", BILL: "BILL" };
const CATEGORY_TYPE: Record<Kind, "INCOME" | "EXPENSE"> = { SALE: "INCOME", BILL: "EXPENSE" };
const CONTACT_KINDS: Record<Kind, ("CUSTOMER" | "SUPPLIER" | "BOTH")[]> = { SALE: ["CUSTOMER", "BOTH"], BILL: ["SUPPLIER", "BOTH"] };
const OPEN_STATUSES = ["ISSUED", "PARTIALLY_PAID"] as const;

const include = {
  contact: { select: { id: true, kind: true, name: true, company: true, phone: true, email: true, address: true, taxId: true } },
  lines: { orderBy: { lineNo: "asc" }, include: { category: { select: { id: true, name: true, nameBn: true } } } },
  payments: { orderBy: [{ paidOn: "asc" }, { id: "asc" }], include: { account: { select: { id: true, name: true } } } },
} satisfies Prisma.InvoiceInclude;

type StoredInvoice = Prisma.InvoiceGetPayload<{ include: typeof include }>;

const isOpen = (status: string) => (OPEN_STATUSES as readonly string[]).includes(status);

const toDto = (invoice: StoredInvoice, today: string) => {
  const dueDate = fromDbDate(invoice.dueDate);
  return {
    ...invoice,
    issueDate: fromDbDate(invoice.issueDate),
    dueDate,
    dueMinor: invoice.status === "VOID" ? 0n : invoice.totalMinor - invoice.paidMinor,
    isOverdue: isOpen(invoice.status) && dueDate < today,
    lines: invoice.lines.map((line) => ({ ...line, quantity: line.quantity.toString() })),
    payments: invoice.payments.map((payment) => ({ ...payment, paidOn: fromDbDate(payment.paidOn) })),
  };
};

// A summary row for lists, without lines and payments.
const toListDto = (
  invoice: Prisma.InvoiceGetPayload<{ include: { contact: { select: { id: true; name: true } } } }>,
  today: string,
) => {
  const dueDate = fromDbDate(invoice.dueDate);
  return {
    ...invoice,
    issueDate: fromDbDate(invoice.issueDate),
    dueDate,
    dueMinor: invoice.status === "VOID" ? 0n : invoice.totalMinor - invoice.paidMinor,
    isOverdue: isOpen(invoice.status) && dueDate < today,
  };
};

const load = async (tx: Prisma.TransactionClient, businessId: string, invoiceId: string, lock = false) => {
  // Payments on the same invoice queue up behind each other, so two can't both pass the "due" check.
  if (lock) await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${invoiceId}::uuid FOR UPDATE`;
  const invoice = await tx.invoice.findFirst({ where: { id: invoiceId, businessId }, include });
  if (!invoice) throw new AppError(404, ErrorCode.NOT_FOUND);
  return invoice;
};

const assertContact = async (tx: Prisma.TransactionClient, businessId: string, contactId: string, kind: Kind) => {
  const contact = await tx.contact.findFirst({ where: { id: contactId, businessId, isActive: true }, select: { kind: true } });
  if (!contact) throw new AppError(422, ErrorCode.CONTACT_NOT_USABLE, { contactId });
  if (!CONTACT_KINDS[kind].includes(contact.kind)) throw new AppError(422, ErrorCode.CONTACT_KIND_MISMATCH, { kind: contact.kind });
};

// Checks each line's category and works out its amount. Returns rows ready to insert.
const prepareLines = async (tx: Prisma.TransactionClient, businessId: string, kind: Kind, lines: IInvoiceLineInput[]) => {
  const prepared = [];
  for (const [index, line] of lines.entries()) {
    const category = await categoriesService.getUsable(tx, businessId, line.categoryId);
    if (category.type !== CATEGORY_TYPE[kind]) {
      throw new AppError(422, ErrorCode.CATEGORY_TYPE_MISMATCH, { line: index + 1, expected: CATEGORY_TYPE[kind] });
    }
    const unitPriceMinor = BigInt(line.unitPriceMinor);
    prepared.push({
      businessId,
      lineNo: index + 1,
      description: line.description,
      quantity: line.quantity,
      unitPriceMinor,
      amountMinor: lineAmountMinor(line.quantity, unitPriceMinor),
      categoryId: line.categoryId,
    });
  }
  return { lines: prepared, totalMinor: prepared.reduce((sum, line) => sum + line.amountMinor, 0n) };
};

const statusAfterPayment = (totalMinor: bigint, paidMinor: bigint) =>
  paidMinor === 0n ? "ISSUED" : paidMinor >= totalMinor ? "PAID" : "PARTIALLY_PAID";

// A reversal can't be dated before the entry it undoes.
const reversalDate = (business: BusinessContext, original: Date) => {
  const today = toDbDate(todayInTimezone(business.timezone));
  return today < original ? original : today;
};

// ---------------------------------------------------------------------------
// Issuing: the moment an invoice or bill reaches the books
// ---------------------------------------------------------------------------

const issueInTx = async (tx: Prisma.TransactionClient, business: BusinessContext, invoiceId: string, context: RequestContext) => {
  const invoice = await load(tx, business.businessId, invoiceId, true);
  if (invoice.status !== "DRAFT") throw new AppError(409, ErrorCode.INVOICE_NOT_DRAFT, { status: invoice.status });
  if (invoice.totalMinor <= 0n) throw new AppError(422, ErrorCode.INVOICE_TOTAL_ZERO);

  // The contact or a category may have been archived since the draft was saved.
  await assertContact(tx, business.businessId, invoice.contactId, invoice.kind);
  const ledgerLines = [];
  for (const line of invoice.lines) {
    const category = await categoriesService.getUsable(tx, business.businessId, line.categoryId);
    if (!category.ledgerAccountId) throw new AppError(409, ErrorCode.BUSINESS_NOT_PROVISIONED);
    ledgerLines.push({ ledgerAccountId: category.ledgerAccountId, amountMinor: line.amountMinor });
  }

  const year = invoice.issueDate.getUTCFullYear();
  const prefix = NUMBER_PREFIX[invoice.kind];
  const number = `${prefix}-${year}-${await nextSequence(tx, business.businessId, `${prefix.toLowerCase()}:${year}`)}`;
  const control = await ledgerAccountsService.getByCode(tx, business.businessId, CONTROL_ACCOUNT[invoice.kind]);

  const entry = await journalsService.post(tx, business, {
    entryDate: invoice.issueDate,
    kind: "STANDARD",
    memo: `${number} · ${invoice.contact.name}`,
    sourceType: "invoice",
    sourceId: invoice.id,
    allowSoftClosed: canPostToSoftClosed(business),
    lines: buildInvoiceLines({ kind: invoice.kind, controlLedgerId: control.id, memo: number, lines: ledgerLines }),
  });

  await tx.invoice.update({
    where: { id: invoice.id },
    data: { status: "ISSUED", number, journalEntryId: entry.id, issuedAt: new Date(), issuedBy: business.userId },
  });
  await auditService.recordForBusiness(tx, business, {
    action: "invoice.issued",
    context,
    entityType: "invoice",
    entityId: invoice.id,
    after: { kind: invoice.kind, number, totalMinor: invoice.totalMinor, entryNo: entry.entryNo },
  });
};

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

const create = (business: BusinessContext, body: ICreateInvoiceBody, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    await assertContact(tx, business.businessId, body.contactId, body.kind);
    const { lines, totalMinor } = await prepareLines(tx, business.businessId, body.kind, body.lines);

    const invoice = await tx.invoice.create({
      data: {
        workspaceId: business.workspaceId,
        businessId: business.businessId,
        kind: body.kind,
        contactId: body.contactId,
        issueDate: toDbDate(body.issueDate),
        dueDate: toDbDate(body.dueDate),
        currency: business.baseCurrency,
        totalMinor,
        referenceNo: body.referenceNo ?? null,
        notes: body.notes ?? null,
        createdBy: business.userId,
        lines: { create: lines },
      },
    });
    await auditService.recordForBusiness(tx, business, {
      action: "invoice.created",
      context,
      entityType: "invoice",
      entityId: invoice.id,
      after: { kind: body.kind, contactId: body.contactId, totalMinor, lines: lines.length },
    });
    if (body.issue) await issueInTx(tx, business, invoice.id, context);
    return toDto(await load(tx, business.businessId, invoice.id), todayInTimezone(business.timezone));
  });

const update = (business: BusinessContext, invoiceId: string, body: IUpdateInvoiceBody, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    const before = await load(tx, business.businessId, invoiceId, true);
    if (before.status !== "DRAFT") throw new AppError(409, ErrorCode.INVOICE_NOT_DRAFT, { status: before.status });

    const issueDate = body.issueDate ?? fromDbDate(before.issueDate);
    const dueDate = body.dueDate ?? fromDbDate(before.dueDate);
    if (dueDate < issueDate) throw new AppError(422, ErrorCode.VALIDATION_FAILED, { dueDate: "DUE_DATE_BEFORE_ISSUE_DATE" });
    if (body.contactId) await assertContact(tx, business.businessId, body.contactId, before.kind);

    const data: Prisma.InvoiceUpdateInput = {
      ...(body.contactId ? { contact: { connect: { id: body.contactId } } } : {}),
      ...(body.issueDate ? { issueDate: toDbDate(body.issueDate) } : {}),
      ...(body.dueDate ? { dueDate: toDbDate(body.dueDate) } : {}),
      ...(body.referenceNo !== undefined ? { referenceNo: body.referenceNo } : {}),
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
    };
    if (body.lines) {
      const { lines, totalMinor } = await prepareLines(tx, business.businessId, before.kind, body.lines);
      await tx.invoiceLine.deleteMany({ where: { invoiceId } });
      await tx.invoiceLine.createMany({ data: lines.map((line) => ({ ...line, invoiceId })) });
      data.totalMinor = totalMinor;
    }
    const after = await tx.invoice.update({ where: { id: invoiceId }, data });
    await auditService.recordForBusiness(tx, business, {
      action: "invoice.updated",
      context,
      entityType: "invoice",
      entityId: invoiceId,
      before: { totalMinor: before.totalMinor, contactId: before.contactId },
      after: { totalMinor: after.totalMinor, contactId: after.contactId, changed: Object.keys(body) },
    });
    return toDto(await load(tx, business.businessId, invoiceId), todayInTimezone(business.timezone));
  });

const remove = (business: BusinessContext, invoiceId: string, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    const invoice = await load(tx, business.businessId, invoiceId, true);
    if (invoice.status !== "DRAFT") throw new AppError(409, ErrorCode.INVOICE_NOT_DRAFT, { status: invoice.status });
    await tx.invoice.delete({ where: { id: invoiceId } });
    await auditService.recordForBusiness(tx, business, {
      action: "invoice.deleted",
      context,
      entityType: "invoice",
      entityId: invoiceId,
      before: { kind: invoice.kind, contactId: invoice.contactId, totalMinor: invoice.totalMinor },
    });
  });

const issue = (business: BusinessContext, invoiceId: string, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    await issueInTx(tx, business, invoiceId, context);
    return toDto(await load(tx, business.businessId, invoiceId), todayInTimezone(business.timezone));
  });

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

const recordPayment = (business: BusinessContext, invoiceId: string, body: IRecordPaymentBody, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    const invoice = await load(tx, business.businessId, invoiceId, true);
    if (!isOpen(invoice.status)) throw new AppError(409, ErrorCode.INVOICE_NOT_OPEN, { status: invoice.status });

    const amountMinor = BigInt(body.amountMinor);
    const dueMinor = invoice.totalMinor - invoice.paidMinor;
    if (amountMinor > dueMinor) throw new AppError(422, ErrorCode.PAYMENT_EXCEEDS_DUE, { dueMinor: dueMinor.toString() });

    const paidOn = toDbDate(body.paidOn);
    const account = await accountsService.getUsable(tx, business.businessId, body.accountId);
    if (account.currency !== invoice.currency) {
      throw new AppError(422, ErrorCode.FOREIGN_CURRENCY_NOT_SUPPORTED, { currency: account.currency });
    }
    const control = await ledgerAccountsService.getByCode(tx, business.businessId, CONTROL_ACCOUNT[invoice.kind]);

    const entry = await journalsService.post(tx, business, {
      entryDate: paidOn,
      kind: "STANDARD",
      memo: `${invoice.kind === "SALE" ? "Payment for" : "Payment of"} ${invoice.number} · ${invoice.contact.name}`,
      sourceType: "invoice_payment",
      sourceId: invoice.id,
      allowSoftClosed: canPostToSoftClosed(business),
      lines: buildInvoicePaymentLines({
        kind: invoice.kind,
        controlLedgerId: control.id,
        accountLedgerId: accountsService.ledgerIdOf(account),
        amountMinor,
      }),
    });

    const payment = await tx.invoicePayment.create({
      data: {
        workspaceId: business.workspaceId,
        businessId: business.businessId,
        invoiceId,
        accountId: account.id,
        paidOn,
        amountMinor,
        note: body.note ?? null,
        journalEntryId: entry.id,
        createdBy: business.userId,
      },
    });
    const paidMinor = invoice.paidMinor + amountMinor;
    await tx.invoice.update({ where: { id: invoiceId }, data: { paidMinor, status: statusAfterPayment(invoice.totalMinor, paidMinor) } });
    await auditService.recordForBusiness(tx, business, {
      action: "invoice.payment_recorded",
      context,
      entityType: "invoice",
      entityId: invoiceId,
      after: { paymentId: payment.id, amountMinor, accountId: account.id, entryNo: entry.entryNo },
    });
    return toDto(await load(tx, business.businessId, invoiceId), todayInTimezone(business.timezone));
  });

const voidPayment = (business: BusinessContext, invoiceId: string, paymentId: string, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    const invoice = await load(tx, business.businessId, invoiceId, true);
    const payment = invoice.payments.find((item) => item.id === paymentId);
    if (!payment) throw new AppError(404, ErrorCode.NOT_FOUND);
    if (payment.voidedAt) throw new AppError(409, ErrorCode.PAYMENT_ALREADY_VOID);

    const reversal = await journalsService.reverse(tx, business, payment.journalEntryId, {
      entryDate: reversalDate(business, payment.paidOn),
      allowSoftClosed: canPostToSoftClosed(business),
    });
    await tx.invoicePayment.update({
      where: { id: paymentId },
      data: { voidedAt: new Date(), voidedBy: business.userId, reversalJournalId: reversal.id },
    });
    const paidMinor = invoice.paidMinor - payment.amountMinor;
    await tx.invoice.update({ where: { id: invoiceId }, data: { paidMinor, status: statusAfterPayment(invoice.totalMinor, paidMinor) } });
    await auditService.recordForBusiness(tx, business, {
      action: "invoice.payment_voided",
      context,
      entityType: "invoice",
      entityId: invoiceId,
      after: { paymentId, amountMinor: payment.amountMinor, reversalNo: reversal.entryNo },
    });
    return toDto(await load(tx, business.businessId, invoiceId), todayInTimezone(business.timezone));
  });

const voidInvoice = (business: BusinessContext, invoiceId: string, body: IVoidInvoiceBody, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    const invoice = await load(tx, business.businessId, invoiceId, true);
    // A draft never reached the books, so it is deleted rather than voided.
    if (!isOpen(invoice.status) && invoice.status !== "PAID") {
      throw new AppError(409, ErrorCode.INVOICE_NOT_OPEN, { status: invoice.status });
    }
    if (invoice.paidMinor > 0n) throw new AppError(409, ErrorCode.INVOICE_HAS_PAYMENTS);

    const reversal = await journalsService.reverse(tx, business, invoice.journalEntryId!, {
      entryDate: reversalDate(business, invoice.issueDate),
      memo: `Void ${invoice.number}: ${body.reason}`,
      allowSoftClosed: canPostToSoftClosed(business),
    });
    await tx.invoice.update({
      where: { id: invoiceId },
      data: { status: "VOID", voidedAt: new Date(), voidedBy: business.userId, voidReason: body.reason },
    });
    await auditService.recordForBusiness(tx, business, {
      action: "invoice.voided",
      context,
      entityType: "invoice",
      entityId: invoiceId,
      after: { number: invoice.number, reason: body.reason, reversalNo: reversal.entryNo },
    });
    return toDto(await load(tx, business.businessId, invoiceId), todayInTimezone(business.timezone));
  });

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const list = (business: BusinessContext, query: IListInvoicesQuery) =>
  withBusinessScope(business, async (tx) => {
    const today = todayInTimezone(business.timezone);
    const search = query.search || undefined;
    const rows = await tx.invoice.findMany({
      where: {
        businessId: business.businessId,
        kind: query.kind,
        ...(query.status ? { status: query.status } : {}),
        ...(query.overdue ? { status: { in: [...OPEN_STATUSES] }, dueDate: { lt: toDbDate(today) } } : {}),
        ...(query.contactId ? { contactId: query.contactId } : {}),
        ...(search
          ? {
              OR: [
                { number: { contains: search, mode: "insensitive" } },
                { referenceNo: { contains: search, mode: "insensitive" } },
                { contact: { name: { contains: search, mode: "insensitive" } } },
              ],
            }
          : {}),
      },
      include: { contact: { select: { id: true, name: true } } },
      orderBy: [{ issueDate: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { ...page, items: page.items.map((row) => toListDto(row, today)) };
  });

const getOne = (business: BusinessContext, invoiceId: string) =>
  withBusinessScope(business, async (tx) => toDto(await load(tx, business.businessId, invoiceId), todayInTimezone(business.timezone)));

const DAY_MS = 24 * 60 * 60 * 1000;

const bucketFor = (daysPastDue: number): AgingBucket =>
  daysPastDue <= 0 ? "current" : daysPastDue <= 30 ? "days1to30" : daysPastDue <= 60 ? "days31to60" : daysPastDue <= 90 ? "days61to90" : "over90";

const emptyAmounts = (): IAgingAmounts => ({
  ...(Object.fromEntries(AGING_BUCKETS.map((bucket) => [bucket, "0"])) as Record<AgingBucket, string>),
  totalMinor: "0",
});

const addTo = (amounts: IAgingAmounts, bucket: AgingBucket, amount: bigint) => {
  amounts[bucket] = (BigInt(amounts[bucket]) + amount).toString();
  amounts.totalMinor = (BigInt(amounts.totalMinor) + amount).toString();
};

// Baki: what is still owed on open invoices (or bills), grouped by how long past due it is.
// Counted as of a day; an invoice issued after that day is left out.
const aging = (business: BusinessContext, query: IAgingQuery) =>
  withBusinessScope(business, async (tx): Promise<IAgingReport> => {
    const asOf = query.asOf ?? todayInTimezone(business.timezone);
    const asOfDate = toDbDate(asOf);
    const open = await tx.invoice.findMany({
      where: {
        businessId: business.businessId,
        kind: query.kind,
        status: { in: [...OPEN_STATUSES] },
        issueDate: { lte: asOfDate },
        ...(query.contactId ? { contactId: query.contactId } : {}),
      },
      select: { contactId: true, dueDate: true, totalMinor: true, paidMinor: true, contact: { select: { name: true } } },
      orderBy: [{ dueDate: "asc" }, { id: "asc" }],
    });

    const totals = emptyAmounts();
    const byContact = new Map<string, IAgingRow>();
    for (const invoice of open) {
      const due = invoice.totalMinor - invoice.paidMinor;
      if (due <= 0n) continue;
      const bucket = bucketFor(Math.round((asOfDate.getTime() - invoice.dueDate.getTime()) / DAY_MS));
      let row = byContact.get(invoice.contactId);
      if (!row) {
        row = { contactId: invoice.contactId, contactName: invoice.contact.name, invoices: 0, oldestDueDate: fromDbDate(invoice.dueDate), ...emptyAmounts() };
        byContact.set(invoice.contactId, row);
      }
      row.invoices += 1;
      addTo(row, bucket, due);
      addTo(totals, bucket, due);
    }
    // Biggest balances first: those are the calls to make.
    const rows = [...byContact.values()].sort((a, b) => {
      const diff = BigInt(b.totalMinor) - BigInt(a.totalMinor);
      return diff > 0n ? 1 : diff < 0n ? -1 : a.contactName.localeCompare(b.contactName);
    });
    return { kind: query.kind, asOf, currency: business.baseCurrency, totals, rows };
  });

// ---------------------------------------------------------------------------
// PDF and email
// ---------------------------------------------------------------------------

const documentFor = async (business: BusinessContext, invoiceId: string) =>
  withBusinessScope(business, async (tx) => {
    const invoice = await load(tx, business.businessId, invoiceId);
    const details = await tx.business.findUniqueOrThrow({
      where: { id: business.businessId },
      select: { name: true, legalName: true, taxId: true, settings: true },
    });
    const doc: InvoiceDocument = {
      kind: invoice.kind,
      number: invoice.number,
      status: invoice.status,
      issueDate: fromDbDate(invoice.issueDate),
      dueDate: fromDbDate(invoice.dueDate),
      currency: invoice.currency,
      totalMinor: invoice.totalMinor,
      paidMinor: invoice.paidMinor,
      referenceNo: invoice.referenceNo,
      notes: invoice.notes,
      business: { name: details.name, legalName: details.legalName, taxId: details.taxId },
      contact: invoice.contact,
      lines: invoice.lines.map((line) => ({ ...line, quantity: line.quantity.toString() })),
    };
    const grouping = (details.settings as { numberGrouping?: "lakh" | "western" }).numberGrouping ?? "lakh";
    return { invoice, doc, grouping, businessName: details.legalName ?? details.name };
  });

const fileNameOf = (doc: InvoiceDocument) => `${doc.number ?? `draft-${doc.kind.toLowerCase()}`}.pdf`;

const pdf = async (business: BusinessContext, invoiceId: string, query: IInvoicePdfQuery) => {
  const { doc, grouping } = await documentFor(business, invoiceId);
  return { fileName: fileNameOf(doc), content: await renderInvoicePdf(doc, { locale: query.locale, grouping }) };
};

const email = async (business: BusinessContext, invoiceId: string, body: IEmailInvoiceBody, context: RequestContext) => {
  if (!emailEnabled()) throw new AppError(503, ErrorCode.EMAIL_NOT_CONFIGURED);
  const { invoice, doc, grouping, businessName } = await documentFor(business, invoiceId);
  if (invoice.kind !== "SALE" || invoice.status === "DRAFT" || invoice.status === "VOID") {
    throw new AppError(409, ErrorCode.INVOICE_NOT_SENDABLE, { reason: "status" });
  }
  const to = body.to ?? invoice.contact.email;
  if (!to) throw new AppError(422, ErrorCode.INVOICE_NOT_SENDABLE, { reason: "no_email" });

  // The PDF is made outside the database transaction: a browser takes a moment to start.
  const content = await renderInvoicePdf(doc, { locale: "en", grouping });
  const due = formatMoney(invoice.totalMinor - invoice.paidMinor, invoice.currency, { digitStyle: "latin", grouping });
  const dueDate = fromDbDate(invoice.dueDate);
  const lines = [
    `Dear ${invoice.contact.name},`,
    ...(body.message ? ["", body.message] : []),
    "",
    `Please find invoice ${invoice.number} attached. Balance due: ${due}, by ${dueDate}.`,
    "",
    businessName,
  ];
  await sendEmail({
    to,
    subject: `Invoice ${invoice.number} from ${businessName}`,
    text: lines.join("\n"),
    html: lines.map((line) => (line ? `<p>${escapeHtml(line)}</p>` : "")).join(""),
    attachments: [{ filename: fileNameOf(doc), content, contentType: "application/pdf" }],
  });

  return withBusinessScope(business, async (tx) => {
    await tx.invoice.update({ where: { id: invoiceId }, data: { emailedAt: new Date() } });
    await auditService.recordForBusiness(tx, business, {
      action: "invoice.emailed",
      context,
      entityType: "invoice",
      entityId: invoiceId,
      after: { number: invoice.number, to },
    });
    return toDto(await load(tx, business.businessId, invoiceId), todayInTimezone(business.timezone));
  });
};

export const invoicesService = { create, update, remove, issue, recordPayment, voidPayment, voidInvoice, list, getOne, aging, pdf, email };
