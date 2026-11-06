import { z } from "zod";
import { integrationsValidation } from "../modules/integrations/integrations.validation.js";
import { statementImportsValidation } from "../modules/statement-imports/statement-imports.validation.js";
import { statementLinesValidation } from "../modules/statement-lines/statement-lines.validation.js";
import { statementRulesValidation } from "../modules/statement-rules/statement-rules.validation.js";
import { statementTemplatesValidation } from "../modules/statement-templates/statement-templates.validation.js";
import { addPath } from "./registry.js";

const businessParams = z.object({ businessId: z.uuid() });
const connectionParams = businessParams.extend(integrationsValidation.connectionParams.shape);
const templateParams = businessParams.extend(statementTemplatesValidation.templateParams.shape);
const importParams = businessParams.extend(statementImportsValidation.importParams.shape);
const lineParams = businessParams.extend(statementLinesValidation.lineParams.shape);
const ruleParams = businessParams.extend(statementRulesValidation.ruleParams.shape);

const page = (item: z.ZodType) => z.object({ items: z.array(item), nextCursor: z.string().nullable() });

const connection = z.object({
  id: z.uuid(),
  financialAccountId: z.uuid(),
  provider: z.string(),
  status: z.enum(["ACTIVE", "NEEDS_REAUTH", "DISABLED"]),
  syncCursor: z.string().nullable(),
  syncEveryHours: z.number(),
  lastSyncedAt: z.string().nullable(),
  lastBalanceMinor: z.string().nullable(),
  consecutiveFailures: z.number(),
});

const syncRun = z.object({
  id: z.uuid(),
  status: z.enum(["RUNNING", "SUCCEEDED", "FAILED"]),
  fetched: z.number(),
  newLines: z.number(),
  skipped: z.number(),
  failed: z.number(),
  cursorAfter: z.string().nullable(),
  errorCode: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});

const template = z.object({ id: z.uuid(), name: z.string(), mapping: z.record(z.string(), z.unknown()), createdAt: z.string() });

const statementImport = z.object({
  id: z.uuid(),
  financialAccountId: z.uuid(),
  documentId: z.uuid(),
  status: z.enum(["QUEUED", "RUNNING", "COMPLETED", "FAILED"]),
  totalRows: z.number(),
  newLines: z.number(),
  duplicateRows: z.number(),
  failedRows: z.number(),
  balanceBreaks: z.number(),
  rowErrors: z.array(z.object({ row: z.number(), code: z.string() })),
  errorCode: z.string().nullable(),
  finishedAt: z.string().nullable(),
  createdAt: z.string(),
});

const line = z.object({
  id: z.uuid(),
  financialAccountId: z.uuid(),
  importId: z.uuid().nullable(),
  connectionId: z.uuid().nullable(),
  txnDate: z.string(),
  direction: z.enum(["IN", "OUT"]),
  amountMinor: z.string(),
  feeMinor: z.string(),
  balanceAfterMinor: z.string().nullable(),
  description: z.string().nullable(),
  reference: z.string().nullable(),
  counterparty: z.string().nullable(),
  status: z.enum(["UNMATCHED", "AWAITING_POSTING", "MATCHED", "IGNORED"]),
  matchedBy: z.string().nullable(),
  lastMatchError: z.string().nullable(),
  createdAt: z.string(),
});

const lineDetail = line.extend({
  links: z.array(z.object({ transactionId: z.uuid().nullable(), journalLineId: z.uuid().nullable() })),
  suggestions: z.array(
    z.object({ journalLineId: z.uuid(), entryNo: z.string(), entryDate: z.string(), memo: z.string().nullable(), referenceNo: z.string().nullable(), transactionId: z.uuid().nullable() }),
  ),
});

const mappingFields = z.object({
  headerRow: z.number().optional(),
  dateColumn: z.string().optional(),
  dateFormat: z.string().optional(),
  descriptionColumn: z.string().optional(),
  referenceColumn: z.string().optional(),
  counterpartyColumn: z.string().optional(),
  amountColumn: z.string().optional(),
  directionColumn: z.string().optional(),
  debitColumn: z.string().optional(),
  creditColumn: z.string().optional(),
  feeColumn: z.string().optional(),
  balanceColumn: z.string().optional(),
});

const previewLine = z.object({
  txnDate: z.string(),
  direction: z.enum(["IN", "OUT"]),
  amountMinor: z.string(),
  feeMinor: z.string(),
  balanceAfterMinor: z.string().nullable(),
  description: z.string().nullable(),
  reference: z.string().nullable(),
  counterparty: z.string().nullable(),
});

const preview = z.object({
  headers: z.array(z.string()),
  suggestion: mappingFields,
  dateFormats: z.array(z.string()),
  fileName: z.string(),
  currency: z.string(),
  rawRows: z.array(z.array(z.string())),
  result: z
    .object({
      totalRows: z.number(),
      readableRows: z.number(),
      failedRows: z.number(),
      balanceBreaks: z.number(),
      errors: z.array(z.object({ row: z.number(), code: z.string() })),
      lines: z.array(previewLine),
    })
    .optional(),
});

const rule = z.object({
  id: z.uuid(),
  name: z.string(),
  containsText: z.string(),
  direction: z.enum(["IN", "OUT"]),
  categoryId: z.uuid(),
  maxAmountMinor: z.string().nullable(),
  autoPost: z.boolean(),
  priority: z.number(),
  isActive: z.boolean(),
});

const integrations = "/businesses/{businessId}/integrations";
const templates = "/businesses/{businessId}/statement-templates";
const imports = "/businesses/{businessId}/statement-imports";
const lines = "/businesses/{businessId}/statement-lines";
const rules = "/businesses/{businessId}/statement-rules";

addPath("Integrations", { method: "get", path: `${integrations}/providers`, summary: "Providers you can connect, and what each can do. Needs integrations.manage", params: businessParams, response: z.array(z.object({ key: z.string(), name: z.string(), capabilities: z.record(z.string(), z.boolean()), secretFields: z.array(z.string()) })) });
addPath("Integrations", { method: "post", path: `${integrations}/connections`, summary: "Connect a provider to an account. Secrets are encrypted and never returned. Needs integrations.manage and recent MFA", params: businessParams, body: integrationsValidation.create, response: connection, status: 201 });
addPath("Integrations", { method: "get", path: `${integrations}/connections`, summary: "List connections. Needs integrations.manage", params: businessParams, response: z.array(connection) });
addPath("Integrations", { method: "get", path: `${integrations}/connections/{connectionId}`, summary: "One connection. Needs integrations.manage", params: connectionParams, response: connection });
addPath("Integrations", { method: "patch", path: `${integrations}/connections/{connectionId}`, summary: "Disable, enable or change how often it syncs. Needs integrations.manage", params: connectionParams, body: integrationsValidation.update, response: connection });
addPath("Integrations", { method: "post", path: `${integrations}/connections/{connectionId}/reauthorize`, summary: "Enter new credentials. Needs integrations.manage and recent MFA", params: connectionParams, body: integrationsValidation.reauthorize, response: connection });
addPath("Integrations", { method: "post", path: `${integrations}/connections/{connectionId}/sync`, summary: "Sync now, through the worker. Needs integrations.manage", params: connectionParams, response: z.object({ queued: z.boolean() }), status: 202 });
addPath("Integrations", { method: "get", path: `${integrations}/connections/{connectionId}/sync-runs`, summary: "Sync history. Needs integrations.manage", params: connectionParams, query: integrationsValidation.runsQuery, response: page(syncRun) });
addPath("Integrations", { method: "post", path: "/webhooks/integrations/{connectionId}", summary: "Called by a provider. Checked by its signature, not a sign-in", secured: false, params: integrationsValidation.connectionParams, response: z.object({ received: z.boolean() }) });

addPath("Statement templates", { method: "post", path: templates, summary: "Save a column mapping for one bank's format. Needs finance.write", params: businessParams, body: statementTemplatesValidation.create, response: template, status: 201 });
addPath("Statement templates", { method: "get", path: templates, summary: "List saved mappings. Needs finance.read", params: businessParams, response: z.array(template) });
addPath("Statement templates", { method: "patch", path: `${templates}/{templateId}`, summary: "Change a saved mapping. Needs finance.write", params: templateParams, body: statementTemplatesValidation.update, response: template });
addPath("Statement templates", { method: "delete", path: `${templates}/{templateId}`, summary: "Remove a saved mapping. Past imports aren't affected. Needs finance.write", params: templateParams });

addPath("Statement imports", { method: "post", path: `${imports}/preview`, summary: "See a file's columns, a suggested mapping, and what would be imported. Changes nothing. Needs finance.write", params: businessParams, body: statementImportsValidation.preview, response: preview });
addPath("Statement imports", { method: "post", path: imports, summary: "Import an uploaded statement, through the worker. Needs finance.write", params: businessParams, body: statementImportsValidation.create, response: statementImport, status: 202 });
addPath("Statement imports", { method: "get", path: imports, summary: "List imports. Needs finance.read", params: businessParams, query: statementImportsValidation.listQuery, response: page(statementImport) });
addPath("Statement imports", { method: "get", path: `${imports}/{importId}`, summary: "An import's status, counts and row errors. Needs finance.read", params: importParams, response: statementImport });

addPath("Statement lines", { method: "get", path: lines, summary: "The review inbox: use status=UNMATCHED. Needs finance.read", params: businessParams, query: statementLinesValidation.listQuery, response: page(line) });
addPath("Statement lines", { method: "get", path: `${lines}/summary`, summary: "How many lines are in each status. Needs finance.read", params: businessParams, query: statementLinesValidation.summaryQuery, response: z.object({ unmatched: z.number(), awaitingPosting: z.number(), matched: z.number(), ignored: z.number() }) });
addPath("Statement lines", { method: "post", path: `${lines}/run-matcher`, summary: "Try matching open lines again. Needs finance.write", params: businessParams, body: statementLinesValidation.runMatcher, response: z.object({ matched: z.number(), ruled: z.number(), needsReview: z.number() }) });
addPath("Statement lines", { method: "get", path: `${lines}/{lineId}`, summary: "One line, what it's linked to, and journal lines it might match. Needs finance.read", params: lineParams, response: lineDetail });
addPath("Statement lines", { method: "post", path: `${lines}/{lineId}/match`, summary: "Match to existing journal lines, which must add up to it. Needs finance.write", params: lineParams, body: statementLinesValidation.match, response: line });
addPath("Statement lines", { method: "post", path: `${lines}/{lineId}/unmatch`, summary: "Remove the link. Any transaction stays. Needs finance.write", params: lineParams, response: line });
addPath("Statement lines", { method: "post", path: `${lines}/{lineId}/categorize`, summary: "Create a transaction or transfer from it. Needs finance.write, and ledger.post for postNow", params: lineParams, body: statementLinesValidation.categorize, response: line.extend({ transactionId: z.uuid() }) });
addPath("Statement lines", { method: "post", path: `${lines}/{lineId}/split`, summary: "Create several transactions adding up to it. Needs finance.write, and ledger.post for postNow", params: lineParams, body: statementLinesValidation.split, response: line.extend({ transactionIds: z.array(z.uuid()) }) });
addPath("Statement lines", { method: "post", path: `${lines}/{lineId}/ignore`, summary: "Leave it out. Needs finance.write", params: lineParams, response: line });
addPath("Statement lines", { method: "post", path: `${lines}/{lineId}/restore`, summary: "Bring an ignored line back. Needs finance.write", params: lineParams, response: line });

addPath("Statement rules", { method: "post", path: rules, summary: "Categorize lines by their text. Needs finance.write, and ledger.post for autoPost", params: businessParams, body: statementRulesValidation.create, response: rule, status: 201 });
addPath("Statement rules", { method: "get", path: rules, summary: "List rules in the order they run. Needs finance.read", params: businessParams, response: z.array(rule) });
addPath("Statement rules", { method: "patch", path: `${rules}/{ruleId}`, summary: "Change or switch off a rule. Needs finance.write", params: ruleParams, body: statementRulesValidation.update, response: rule });
addPath("Statement rules", { method: "delete", path: `${rules}/{ruleId}`, summary: "Remove a rule. Lines it already handled stay. Needs finance.write", params: ruleParams });
