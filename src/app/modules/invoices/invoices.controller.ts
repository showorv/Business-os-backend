import type { RequestHandler } from "express";
import { getRequestContext } from "../../utils/requestContext.js";
import { sendResponse } from "../../utils/sendResponse.js";
import type {
  IAgingQuery,
  ICreateInvoiceBody,
  IEmailInvoiceBody,
  IInvoiceParams,
  IInvoicePdfQuery,
  IListInvoicesQuery,
  IPaymentParams,
  IRecordPaymentBody,
  IUpdateInvoiceBody,
  IVoidInvoiceBody,
} from "./invoices.interface.js";
import { invoicesService } from "./invoices.service.js";

const create: RequestHandler = async (req, res) => {
  const invoice = await invoicesService.create(req.business!, req.validated.body as ICreateInvoiceBody, getRequestContext(req));
  sendResponse(res, 201, invoice);
};

const list: RequestHandler = async (req, res) => {
  const page = await invoicesService.list(req.business!, req.validated.query as IListInvoicesQuery);
  sendResponse(res, 200, page.items, { nextCursor: page.nextCursor });
};

const aging: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await invoicesService.aging(req.business!, req.validated.query as IAgingQuery));
};

const getOne: RequestHandler = async (req, res) => {
  const { invoiceId } = req.validated.params as IInvoiceParams;
  sendResponse(res, 200, await invoicesService.getOne(req.business!, invoiceId));
};

const update: RequestHandler = async (req, res) => {
  const { invoiceId } = req.validated.params as IInvoiceParams;
  const invoice = await invoicesService.update(req.business!, invoiceId, req.validated.body as IUpdateInvoiceBody, getRequestContext(req));
  sendResponse(res, 200, invoice);
};

const remove: RequestHandler = async (req, res) => {
  const { invoiceId } = req.validated.params as IInvoiceParams;
  await invoicesService.remove(req.business!, invoiceId, getRequestContext(req));
  res.status(204).end();
};

const issue: RequestHandler = async (req, res) => {
  const { invoiceId } = req.validated.params as IInvoiceParams;
  sendResponse(res, 200, await invoicesService.issue(req.business!, invoiceId, getRequestContext(req)));
};

const recordPayment: RequestHandler = async (req, res) => {
  const { invoiceId } = req.validated.params as IInvoiceParams;
  const invoice = await invoicesService.recordPayment(req.business!, invoiceId, req.validated.body as IRecordPaymentBody, getRequestContext(req));
  sendResponse(res, 201, invoice);
};

const voidPayment: RequestHandler = async (req, res) => {
  const { invoiceId, paymentId } = req.validated.params as IPaymentParams;
  sendResponse(res, 200, await invoicesService.voidPayment(req.business!, invoiceId, paymentId, getRequestContext(req)));
};

const voidInvoice: RequestHandler = async (req, res) => {
  const { invoiceId } = req.validated.params as IInvoiceParams;
  const invoice = await invoicesService.voidInvoice(req.business!, invoiceId, req.validated.body as IVoidInvoiceBody, getRequestContext(req));
  sendResponse(res, 200, invoice);
};

const pdf: RequestHandler = async (req, res) => {
  const { invoiceId } = req.validated.params as IInvoiceParams;
  const file = await invoicesService.pdf(req.business!, invoiceId, req.validated.query as IInvoicePdfQuery);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${file.fileName}"`);
  res.setHeader("Cache-Control", "no-store");
  res.send(file.content);
};

const email: RequestHandler = async (req, res) => {
  const { invoiceId } = req.validated.params as IInvoiceParams;
  const invoice = await invoicesService.email(req.business!, invoiceId, req.validated.body as IEmailInvoiceBody, getRequestContext(req));
  sendResponse(res, 200, invoice);
};

export const invoicesController = { create, list, aging, getOne, update, remove, issue, recordPayment, voidPayment, voidInvoice, pdf, email };
