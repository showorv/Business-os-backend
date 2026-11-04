import { createHash, randomUUID } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import type { Prisma } from "../../../lib/prisma.js";
import { withAiScope, withBusinessScope } from "../../../lib/rls.js";
import { createDownloadUrl, createUploadUrl, deleteObject, openObjectStream } from "../../../lib/storage.js";
import { searchDocuments } from "../../ai/search.js";
import { EventType, publishEvent } from "../../utils/outbox.js";
import { AppError, ErrorCode } from "../../utils/errors.js";
import { pageArgs, toPage } from "../../utils/pagination.js";
import type { RequestContext } from "../../utils/requestContext.js";
import { auditService } from "../audit/audit.service.js";
import type { BusinessContext } from "../members/members.interface.js";
import type { ICreateUploadBody, IListDocumentsQuery, ISearchDocumentsQuery, UploadProblem } from "./documents.interface.js";
import { CSV_MIME } from "./documents.validation.js";

const SNIFF_BYTES = 4100;

// Never includes the internal storage key.
const publicFields = {
  id: true,
  type: true,
  status: true,
  fileName: true,
  mime: true,
  sizeBytes: true,
  sha256: true,
  scanStatus: true,
  ingestStatus: true,
  createdBy: true,
  createdAt: true,
} as const;

const findOrThrow = async (tx: Prisma.TransactionClient, businessId: string, documentId: string) => {
  const document = await tx.document.findFirst({ where: { id: documentId, businessId, deletedAt: null } });
  if (!document) throw new AppError(404, ErrorCode.NOT_FOUND);
  return document;
};

// Step 1 of an upload: record the document and hand the client a signed URL to send the file to.
// The key uses a random id, so a user's file name never becomes a storage path.
const createUpload = async (business: BusinessContext, body: ICreateUploadBody) => {
  const storageKey = `workspaces/${business.workspaceId}/businesses/${business.businessId}/documents/${randomUUID()}`;

  const document = await withBusinessScope(business, (tx) =>
    tx.document.create({
      data: {
        ...body,
        sizeBytes: BigInt(body.sizeBytes),
        storageKey,
        workspaceId: business.workspaceId,
        businessId: business.businessId,
        createdBy: business.userId,
      },
      select: publicFields,
    }),
  );

  return { document, ...(await createUploadUrl(storageKey, body.mime, body.sizeBytes)) };
};

const UTF16_BOMS = ["fffe", "feff"];

const isPlainText = (start: Buffer, detectedMime: string | undefined) => {
  if (detectedMime) return false;
  return UTF16_BOMS.includes(start.subarray(0, 2).toString("hex")) || !start.includes(0);
};

// Reads the stored file itself, because the client's claims about it can't be trusted.
const inspectUpload = async (storageKey: string, declaredMime: string, declaredSize: bigint) => {
  const stream = await openObjectStream(storageKey);
  if (!stream) return { problem: "NOT_UPLOADED" as UploadProblem };

  const hash = createHash("sha256");
  let start = Buffer.alloc(0);
  let size = 0n;

  for await (const chunk of stream) {
    size += BigInt(chunk.length);
    if (size > declaredSize) return { problem: "SIZE_MISMATCH" as UploadProblem };
    hash.update(chunk);
    if (start.length < SNIFF_BYTES) start = Buffer.concat([start, chunk]).subarray(0, SNIFF_BYTES);
  }
  if (size !== declaredSize) return { problem: "SIZE_MISMATCH" as UploadProblem };

  const detected = await fileTypeFromBuffer(start);
  // CSV has no signature to check, so it just mustn't look like some other kind of file.
  const typeFits = declaredMime === CSV_MIME ? isPlainText(start, detected?.mime) : detected?.mime === declaredMime;
  if (!typeFits) return { problem: "TYPE_MISMATCH" as UploadProblem };

  return { sha256: hash.digest("hex") };
};

// Step 2: the client says it finished. No transaction stays open while the file is read.
const completeUpload = async (business: BusinessContext, documentId: string, context: RequestContext) => {
  const document = await withBusinessScope(business, (tx) => findOrThrow(tx, business.businessId, documentId));

  if (document.status === "REJECTED") throw new AppError(409, ErrorCode.DOCUMENT_REJECTED);

  const select = { where: { id: documentId }, select: publicFields };
  if (document.status === "READY") {
    return withBusinessScope(business, (tx) => tx.document.findUniqueOrThrow(select));
  }

  const inspection = await inspectUpload(document.storageKey, document.mime, document.sizeBytes);

  if (inspection.problem === "NOT_UPLOADED") throw new AppError(409, ErrorCode.DOCUMENT_NOT_UPLOADED);

  if (inspection.problem) {
    await deleteObject(document.storageKey);
    await withBusinessScope(business, async (tx) => {
      await tx.document.update({ where: { id: documentId }, data: { status: "REJECTED" } });
      await auditService.recordForBusiness(tx, business, {
        action: "document.rejected",
        context,
        entityType: "document",
        entityId: documentId,
        after: { reason: inspection.problem },
      });
    });
    throw new AppError(422, ErrorCode.DOCUMENT_REJECTED, { reason: inspection.problem });
  }

  return withBusinessScope(business, async (tx) => {
    const ready = await tx.document.update({
      ...select,
      data: { status: "READY", sha256: inspection.sha256 },
    });
    await auditService.recordForBusiness(tx, business, {
      action: "document.uploaded",
      context,
      entityType: "document",
      entityId: documentId,
      after: { fileName: ready.fileName, mime: ready.mime, sizeBytes: ready.sizeBytes, sha256: ready.sha256 },
    });
    await publishEvent(tx, business, EventType.DOCUMENT_UPLOADED, { documentId });
    return ready;
  });
};

const list = async (business: BusinessContext, query: IListDocumentsQuery) => {
  const rows = await withBusinessScope(business, (tx) =>
    tx.document.findMany({
      where: {
        businessId: business.businessId,
        deletedAt: null,
        status: "READY",
        ...(query.type ? { type: query.type } : {}),
      },
      orderBy: { id: "desc" },
      select: publicFields,
      ...pageArgs(query),
    }),
  );
  return toPage(rows, query.limit);
};

const getDownloadUrl = async (business: BusinessContext, documentId: string) => {
  const document = await withBusinessScope(business, (tx) => findOrThrow(tx, business.businessId, documentId));
  if (document.status !== "READY") throw new AppError(409, ErrorCode.DOCUMENT_NOT_READY);
  return createDownloadUrl(document.storageKey, document.fileName);
};

// Soft delete: the stored file stays, because it may be evidence for the books.
const remove = (business: BusinessContext, documentId: string, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    const document = await findOrThrow(tx, business.businessId, documentId);

    const attachments = await tx.transactionAttachment.count({ where: { documentId } });
    if (attachments > 0) throw new AppError(409, ErrorCode.DOCUMENT_IN_USE, { attachments });

    await tx.document.update({ where: { id: documentId }, data: { deletedAt: new Date() } });
    // A deleted document must stop appearing in search straight away.
    await tx.documentChunk.deleteMany({ where: { documentId } });
    await auditService.recordForBusiness(tx, business, {
      action: "document.deleted",
      context,
      entityType: "document",
      entityId: documentId,
      before: { fileName: document.fileName },
    });
  });

// For other modules: the document must be uploaded, checked and not deleted.
const assertReady = async (tx: Prisma.TransactionClient, businessId: string, documentId: string) => {
  const document = await tx.document.findFirst({
    where: { id: documentId, businessId, deletedAt: null, status: "READY" },
    select: { id: true },
  });
  if (!document) throw new AppError(422, ErrorCode.DOCUMENT_NOT_READY, { documentId });
};

const search = async (business: BusinessContext, query: ISearchDocumentsQuery) => {
  const hits = await withAiScope({ userId: business.userId, workspaceId: business.workspaceId, businessIds: [business.businessId] }, (tx) =>
    searchDocuments(tx, [business.businessId], query.q, query.limit, query.type ? [query.type] : undefined),
  );
  return hits;
};

// Reads a document again, such as after it failed, or when the embedding model has changed.
const reindex = (business: BusinessContext, documentId: string, context: RequestContext) =>
  withBusinessScope(business, async (tx) => {
    const document = await findOrThrow(tx, business.businessId, documentId);
    if (document.status !== "READY" || document.type === "STATEMENT") throw new AppError(409, ErrorCode.DOCUMENT_NOT_READY);

    const after = await tx.document.update({ where: { id: documentId }, data: { ingestStatus: "NOT_STARTED" }, select: publicFields });
    await auditService.recordForBusiness(tx, business, { action: "document.reindex_requested", context, entityType: "document", entityId: documentId });
    await publishEvent(tx, business, EventType.DOCUMENT_UPLOADED, { documentId });
    return after;
  });

export const documentsService = { search, reindex, createUpload, completeUpload, list, getDownloadUrl, remove, assertReady };
