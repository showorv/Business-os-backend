import { z } from "zod";
import { aiValidation } from "../modules/ai/ai.validation.js";
import { documentsValidation } from "../modules/documents/documents.validation.js";
import { addPath } from "./registry.js";

const source = z.object({
  tool: z.string(),
  businesses: z.array(z.string()),
  period: z.string().optional(),
  asOf: z.string().optional(),
  currency: z.array(z.string()).optional(),
  basis: z.enum(["POSTED_ACTUALS", "PLAN", "DOCUMENT", "PROPOSAL"]).optional(),
  documents: z.array(z.object({ documentId: z.uuid(), fileName: z.string(), page: z.number() })).optional(),
  proposalId: z.uuid().optional(),
});

const proposal = z.object({
  id: z.uuid(),
  businessId: z.uuid(),
  conversationId: z.uuid(),
  kind: z.enum(["TRANSACTION", "TASK"]),
  payload: z.record(z.string(), z.unknown()),
  status: z.enum(["PENDING", "CONFIRMED", "REJECTED", "EXPIRED"]),
  resultId: z.uuid().nullable(),
  expiresAt: z.string(),
});

const answer = z.object({
  conversationId: z.uuid(),
  messageId: z.uuid(),
  content: z.string(),
  language: z.enum(["en", "bn"]),
  guardStatus: z.enum(["ok", "corrected", "fallback", "blocked"]),
  sources: z.array(source),
  proposals: z.array(proposal),
  usage: z.object({ promptTokens: z.number(), completionTokens: z.number() }),
});

const page = (item: z.ZodType) => z.object({ items: z.array(item), nextCursor: z.string().nullable() });
const documents = "/businesses/{businessId}/documents";

addPath("AI", { method: "get", path: "/ai/status", summary: "Whether the assistant is switched on, and today's token use", response: z.object({ configured: z.boolean(), model: z.string().nullable(), tokensUsedToday: z.number(), dailyTokenLimit: z.number() }) });
addPath("AI", { method: "post", path: "/ai/chat", summary: "Ask a question, in English or Bangla. Needs ai.use, and each tool checks its own permission", body: aiValidation.chat, response: answer });
addPath("AI", { method: "get", path: "/ai/conversations", summary: "Your conversations", query: aiValidation.listQuery, response: page(z.object({ id: z.uuid(), title: z.string(), createdAt: z.string() })) });
addPath("AI", { method: "get", path: "/ai/conversations/{conversationId}", summary: "One conversation with its messages and sources", params: aiValidation.conversationParams });
addPath("AI", { method: "get", path: "/ai/proposals", summary: "Things the assistant suggested writing", query: aiValidation.proposalsQuery, response: page(proposal) });
addPath("AI", { method: "post", path: "/ai/proposals/{proposalId}/confirm", summary: "Confirm a suggestion. It runs through the normal service, audited as via AI", params: aiValidation.proposalParams, body: aiValidation.confirm, response: proposal });
addPath("AI", { method: "post", path: "/ai/proposals/{proposalId}/reject", summary: "Turn a suggestion down", params: aiValidation.proposalParams });

const businessParams = z.object({ businessId: z.uuid() });
addPath("Documents", { method: "get", path: `${documents}/search`, summary: "Search documents by meaning and exact words, in any language. Needs no AI key. Needs documents.read", params: businessParams, query: documentsValidation.searchQuery, response: z.array(z.object({ documentId: z.uuid(), fileName: z.string(), documentType: z.string(), page: z.number(), heading: z.string().nullable(), content: z.string(), score: z.number() })) });
addPath("Documents", { method: "post", path: `${documents}/{documentId}/reindex`, summary: "Read a document again. Needs documents.write", params: businessParams.extend(documentsValidation.documentParams.shape), status: 202 });
