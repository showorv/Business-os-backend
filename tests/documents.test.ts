import { describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import {
  addMember,
  api,
  bearer,
  PDF_BYTES,
  PNG_BYTES,
  putFile,
  setupFinance,
  uploadDocument,
} from "./helpers/api.js";
import { createHash } from "node:crypto";

const start = (base: string, auth: string, body: object) =>
  api().post(`${base}/documents/uploads`).set("Authorization", auth).send({
    type: "RECEIPT",
    fileName: "receipt.pdf",
    mime: "application/pdf",
    sizeBytes: PDF_BYTES.length,
    ...body,
  });

describe("upload flow", () => {
  it("uploads straight to storage, then records the real hash and audits it", async () => {
    const { base, auth } = await setupFinance();
    const created = await start(base, auth, {});
    expect(created.status).toBe(201);
    expect(created.body.data.document.status).toBe("PENDING_UPLOAD");
    expect(created.body.data.uploadUrl).toContain("X-Amz-Signature");
    expect(JSON.stringify(created.body.data.document)).not.toContain("storageKey");

    const put = await putFile(created.body.data.uploadUrl, PDF_BYTES, "application/pdf");
    expect(put.status).toBe(200);

    const done = await api().post(`${base}/documents/${created.body.data.document.id}/complete`).set("Authorization", auth);
    expect(done.status).toBe(200);
    expect(done.body.data.status).toBe("READY");
    expect(done.body.data.sha256).toBe(createHash("sha256").update(PDF_BYTES).digest("hex"));
    expect(done.body.data.sizeBytes).toBe(String(PDF_BYTES.length));
    expect(done.body.data.scanStatus).toBe("NOT_SCANNED");

    expect(await prisma.auditLog.count({ where: { action: "document.uploaded" } })).toBe(1);
  });

  it("completing twice is harmless", async () => {
    const { base, auth } = await setupFinance();
    const document = await uploadDocument(base, auth);
    const again = await api().post(`${base}/documents/${document.id}/complete`).set("Authorization", auth);
    expect(again.status).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: "document.uploaded" } })).toBe(1);
  });

  it("refuses to complete before the file arrives", async () => {
    const { base, auth } = await setupFinance();
    const created = await start(base, auth, {});
    const res = await api().post(`${base}/documents/${created.body.data.document.id}/complete`).set("Authorization", auth);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("DOCUMENT_NOT_UPLOADED");
  });

  it("rejects a file whose bytes are not what it claims, and removes it", async () => {
    const { base, auth } = await setupFinance();
    const fake = Buffer.from("<html><script>alert(1)</script></html>");
    const created = await start(base, auth, { sizeBytes: fake.length });
    await putFile(created.body.data.uploadUrl, fake, "application/pdf");

    const url = `${base}/documents/${created.body.data.document.id}`;
    const res = await api().post(`${url}/complete`).set("Authorization", auth);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("DOCUMENT_REJECTED");
    expect(res.body.error.params.reason).toBe("TYPE_MISMATCH");

    const row = await prisma.document.findUniqueOrThrow({ where: { id: created.body.data.document.id } });
    expect(row.status).toBe("REJECTED");

    const download = await api().get(`${url}/download`).set("Authorization", auth);
    expect(download.status).toBe(409);
    const retry = await api().post(`${url}/complete`).set("Authorization", auth);
    expect(retry.status).toBe(409);
  });

  it("rejects a real PNG declared as a PDF", async () => {
    const { base, auth } = await setupFinance();
    const created = await start(base, auth, { sizeBytes: PNG_BYTES.length });
    await putFile(created.body.data.uploadUrl, PNG_BYTES, "application/pdf");
    const res = await api().post(`${base}/documents/${created.body.data.document.id}/complete`).set("Authorization", auth);
    expect(res.status).toBe(422);
    expect(res.body.error.params.reason).toBe("TYPE_MISMATCH");
  });

  it("a file of a different size cannot become READY", async () => {
    const { base, auth } = await setupFinance();
    const created = await start(base, auth, { sizeBytes: PDF_BYTES.length + 50 });
    const put = await putFile(created.body.data.uploadUrl, PDF_BYTES, "application/pdf").catch(() => null);
    const res = await api().post(`${base}/documents/${created.body.data.document.id}/complete`).set("Authorization", auth);
    expect(res.status, `put was ${put?.status}`).not.toBe(200);
    const row = await prisma.document.findUniqueOrThrow({ where: { id: created.body.data.document.id } });
    expect(row.status).not.toBe("READY");
  });

  it("refuses disallowed types and oversized files up front", async () => {
    const { base, auth } = await setupFinance();
    expect((await start(base, auth, { mime: "text/html" })).status).toBe(422);
    expect((await start(base, auth, { mime: "application/x-msdownload" })).status).toBe(422);
    expect((await start(base, auth, { sizeBytes: 25 * 1024 * 1024 + 1 })).status).toBe(422);
    expect((await start(base, auth, { sizeBytes: 0 })).status).toBe(422);
  });
});

describe("download", () => {
  it("gives a short-lived link that forces a download and returns the same bytes", async () => {
    const { base, auth } = await setupFinance();
    const created = await start(base, auth, { fileName: "রসিদ নভেম্বর.pdf" });
    await putFile(created.body.data.uploadUrl, PDF_BYTES, "application/pdf");
    const url = `${base}/documents/${created.body.data.document.id}`;
    await api().post(`${url}/complete`).set("Authorization", auth);

    const link = await api().get(`${url}/download`).set("Authorization", auth);
    expect(link.status).toBe(200);
    expect(link.body.data.expiresIn).toBe(300);

    const file = await fetch(link.body.data.url);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-disposition")).toContain("attachment");
    expect(file.headers.get("content-disposition")).toContain(encodeURIComponent("রসিদ"));
    expect(Buffer.from(await file.arrayBuffer()).equals(PDF_BYTES)).toBe(true);
  });
});

describe("list and delete", () => {
  it("lists finished documents only, and hides deleted ones", async () => {
    const { base, auth } = await setupFinance();
    const document = await uploadDocument(base, auth);
    await start(base, auth, {});

    const list = await api().get(`${base}/documents`).set("Authorization", auth);
    expect(list.body.data.map((item: { id: string }) => item.id)).toEqual([document.id]);

    const removed = await api().delete(`${base}/documents/${document.id}`).set("Authorization", auth);
    expect(removed.status).toBe(200);
    expect((await api().get(`${base}/documents`).set("Authorization", auth)).body.data).toHaveLength(0);
    expect((await api().get(`${base}/documents/${document.id}/download`).set("Authorization", auth)).status).toBe(404);

    const row = await prisma.document.findUniqueOrThrow({ where: { id: document.id } });
    expect(row.deletedAt).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { action: "document.deleted" } })).toBe(1);
  });
});

describe("isolation and permissions", () => {
  it("another business cannot see, download, complete or delete a document", async () => {
    const mine = await setupFinance();
    const theirs = await setupFinance();
    const document = await uploadDocument(mine.base, mine.auth);

    const url = `${theirs.base}/documents/${document.id}`;
    expect((await api().get(`${url}/download`).set("Authorization", theirs.auth)).status).toBe(404);
    expect((await api().post(`${url}/complete`).set("Authorization", theirs.auth)).status).toBe(404);
    expect((await api().delete(url).set("Authorization", theirs.auth)).status).toBe(404);
    expect((await api().get(`${theirs.base}/documents`).set("Authorization", theirs.auth)).body.data).toHaveLength(0);
    // Using their own token on my business is also a 404.
    expect((await api().get(`${mine.base}/documents`).set("Authorization", theirs.auth)).status).toBe(404);
  });

  it("a viewer can read and download but not upload; a manager can upload", async () => {
    const { owner, businessId, base, auth } = await setupFinance();
    const document = await uploadDocument(base, auth);
    const viewer = await addMember(owner, businessId, "VIEWER");
    const manager = await addMember(owner, businessId, "MANAGER");

    expect((await api().get(`${base}/documents/${document.id}/download`).set("Authorization", bearer(viewer))).status).toBe(200);
    expect((await start(base, bearer(viewer), {})).status).toBe(403);
    expect((await api().delete(`${base}/documents/${document.id}`).set("Authorization", bearer(viewer))).status).toBe(403);
    expect((await start(base, bearer(manager), {})).status).toBe(201);
  });
});
