import { randomUUID } from "node:crypto";
import { logger } from "../../lib/logger.js";
import { EMBEDDING_MODEL, embedPassages, toVectorLiteral } from "../../lib/embeddings.js";
import { scanForMalware } from "../../lib/malwareScanner.js";
import { prisma } from "../../lib/prisma.js";
import { deleteObject, readObjectBytes } from "../../lib/storage.js";
import { auditService } from "../modules/audit/audit.service.js";
import { chunkPages } from "./chunkText.js";
import { extractText, sha256OfBytes } from "./extractText.js";

// A statement's figures belong in the ledger through import, not in search, where AI might quote them.
const NOT_SEARCHABLE = ["STATEMENT"];
// A job that died mid-way is picked up again after this long.
const PROCESSING_EXPIRES_MS = 30 * 60 * 1000;
const INSERT_BATCH = 50;
const PENDING_BATCH = 20;

const SYSTEM_CONTEXT = (documentId: string) => ({ ip: null, userAgent: "worker", requestId: `document-${documentId}` });

const audit = (document: { id: string; workspaceId: string; businessId: string }, action: string, after: object) =>
  auditService.recordStandalone({
    action,
    context: SYSTEM_CONTEXT(document.id),
    workspaceId: document.workspaceId,
    businessId: document.businessId,
    entityType: "document",
    entityId: document.id,
    after,
  });

// A file failing a check is refused, and can no longer be downloaded or attached to anything.
const reject = async (document: { id: string; workspaceId: string; businessId: string; storageKey: string }, reason: "INFECTED" | "CHANGED_AFTER_UPLOAD") => {
  await prisma.document.update({
    where: { id: document.id },
    data: { status: "REJECTED", ingestStatus: "REJECTED", scanStatus: reason === "INFECTED" ? "INFECTED" : undefined },
  });
  await deleteObject(document.storageKey).catch((error: unknown) => logger.warn({ err: error, document_id: document.id }, "could not delete refused file"));
  await audit(document, "document.rejected", { reason });
};

const saveChunks = async (document: { id: string; workspaceId: string; businessId: string }, chunks: ReturnType<typeof chunkPages>, vectors: number[][]) => {
  await prisma.$transaction(async (tx) => {
    // Replacing them all means re-reading a document leaves nothing out of date.
    await tx.documentChunk.deleteMany({ where: { documentId: document.id } });
    for (let start = 0; start < chunks.length; start += INSERT_BATCH) {
      for (const [offset, chunk] of chunks.slice(start, start + INSERT_BATCH).entries()) {
        await tx.$executeRaw`
          INSERT INTO document_chunks (id, workspace_id, business_id, document_id, chunk_index, page, heading, content, embedding, embedding_model)
          VALUES (${randomUUID()}::uuid, ${document.workspaceId}::uuid, ${document.businessId}::uuid, ${document.id}::uuid,
            ${chunk.chunkIndex}, ${chunk.page}, ${chunk.heading}, ${chunk.content},
            ${toVectorLiteral(vectors[start + offset]!)}::vector, ${EMBEDDING_MODEL})`;
      }
    }
  });
};

// Runs in the worker: check the file, read it, split it, work out its meaning, and save.
const ingest = async (documentId: string) => {
  const document = await prisma.document.findUnique({ where: { id: documentId } });
  if (!document || document.status !== "READY" || document.deletedAt || NOT_SEARCHABLE.includes(document.type)) return;

  const { count } = await prisma.document.updateMany({
    where: {
      id: documentId,
      OR: [{ ingestStatus: { not: "PROCESSING" } }, { updatedAt: { lt: new Date(Date.now() - PROCESSING_EXPIRES_MS) } }],
    },
    data: { ingestStatus: "PROCESSING" },
  });
  if (count === 0) return;

  const bytes = await readObjectBytes(document.storageKey);
  if (!bytes) throw new Error("stored file is missing");

  // An upload link stays valid for 15 minutes, so someone could have replaced the file since it was checked.
  if (sha256OfBytes(bytes) !== document.sha256) return reject(document, "CHANGED_AFTER_UPLOAD");

  const scan = await scanForMalware(bytes);
  if (scan === "INFECTED") return reject(document, "INFECTED");

  const { pages, pagesSkipped } = await extractText(bytes, document.mime);
  const chunks = chunkPages(pages);
  const vectors = await embedPassages(chunks.map((chunk) => (chunk.heading ? `${chunk.heading}\n${chunk.content}` : chunk.content)));

  await saveChunks(document, chunks, vectors);
  await prisma.document.update({
    where: { id: documentId },
    data: { scanStatus: scan, ingestStatus: chunks.length > 0 ? "READY" : "NO_TEXT" },
  });
  await audit(document, "document.indexed", { chunks: chunks.length, pages: pages.length, pagesSkipped, scan });
};

// When retries run out. The file is fine: it just can't be searched.
const markFailed = (documentId: string) => prisma.document.update({ where: { id: documentId }, data: { ingestStatus: "FAILED" } });

// Finds documents that were never read, which includes everything uploaded before this phase.
const listPending = async () => {
  const documents = await prisma.document.findMany({
    where: { status: "READY", deletedAt: null, ingestStatus: "NOT_STARTED", type: { notIn: NOT_SEARCHABLE as never[] } },
    select: { id: true },
    take: PENDING_BATCH,
    orderBy: { id: "asc" },
  });
  return documents.map((document) => document.id);
};

export const ingestionService = { ingest, markFailed, listPending };
