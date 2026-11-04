import net from "node:net";
import type { AddressInfo } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chunkPages } from "../src/app/ai/chunkText.js";
import { extractText } from "../src/app/ai/extractText.js";
import { ingestionService } from "../src/app/ai/ingestion.js";
import { keywordsOf } from "../src/app/ai/search.js";
import { runMaintenanceJob } from "../src/app/jobs/maintenance.js";
import { prisma } from "../src/lib/prisma.js";
import { queues, QueueName } from "../src/lib/queues.js";
import { withAiScope } from "../src/lib/rls.js";
import { deleteObject, putObject } from "../src/lib/storage.js";
import { addMember, api, bearer, PDF_BYTES, putFile, runPendingEvents, setupFinance, uploadDocument, type FinanceSetup } from "./helpers/api.js";
import { uploadReadableDocument } from "./helpers/ai.js";
import { ocrResult } from "./helpers/fake-ocr.js";
import { HEADER, uploadStatement } from "./helpers/statements.js";
import { LEASE_TEXT } from "./helpers/eval-books.js";

const search = (f: FinanceSetup, q: string, extra = "") => api().get(`${f.base}/documents/search?q=${encodeURIComponent(q)}${extra}`).set("Authorization", f.auth);

const chunksOf = (documentId: string) => prisma.documentChunk.findMany({ where: { documentId }, orderBy: { chunkIndex: "asc" } });

beforeEach(() => {
  ocrResult.text = "";
});

describe("splitting into passages", () => {
  const words = (count: number, word = "word") => Array.from({ length: count }, (_value, index) => `${word}${index}`).join(" ");

  it("a short document is one passage, keeping its page", () => {
    expect(chunkPages([{ page: 3, text: "A short sentence about rent." }])).toEqual([{ chunkIndex: 0, page: 3, heading: null, content: "A short sentence about rent." }]);
  });

  it("a long one overlaps, so a sentence across the join can still be found", () => {
    const chunks = chunkPages([{ page: 1, text: `${words(700)}.` }]);
    expect(chunks.length).toBeGreaterThan(2);
    const first = chunks[0]!.content.split(" ");
    const second = chunks[1]!.content.split(" ");
    expect(first.length).toBe(300);
    expect(second.slice(0, 40)).toEqual(first.slice(-40));
  });

  it("keeps the page of each passage, and the heading it falls under", () => {
    const chunks = chunkPages([{ page: 1, text: `Payment Terms\n${words(20)}.` }, { page: 2, text: `${words(20, "other")}.` }]);
    expect(chunks[0]).toMatchObject({ page: 1, heading: "Payment Terms" });
    expect(chunks[1]).toMatchObject({ page: 2, heading: "Payment Terms" });
  });

  it("handles Bangla, and normalises it so the same word always matches", () => {
    const decomposed = "বাড়ি ভাড়া চুক্তি।".normalize("NFD");
    const [chunk] = chunkPages([{ page: 1, text: decomposed }]);
    expect(chunk!.content).toBe("বাড়ি ভাড়া চুক্তি।".normalize("NFC"));
  });

  it("an empty page makes no passages", () => {
    expect(chunkPages([{ page: 1, text: "  \n \n" }])).toEqual([]);
  });
});

describe("reading files", () => {
  it("a damaged PDF gives no text rather than an error that would keep retrying", async () => {
    expect(await extractText(PDF_BYTES, "application/pdf")).toEqual({ pages: [], pagesSkipped: 0 });
  });

  it("reads a real text PDF page by page, without needing OCR", async () => {
    const puppeteer = (await import("puppeteer")).default;
    const browser = await puppeteer.launch({ headless: true, ...(process.env.CHROME_NO_SANDBOX === "true" ? { args: ["--no-sandbox"] } : {}) });
    const page = await browser.newPage();
    await page.setContent(`<p>The lease ends on 30 June 2027 for this property.</p><div style="page-break-before:always">Second page about the security deposit amount.</div>`);
    const pdf = Buffer.from(await page.pdf({ format: "A4" }));
    await browser.close();

    const { pages } = await extractText(pdf, "application/pdf");
    expect(pages.map((item) => item.page)).toEqual([1, 2]);
    expect(pages[0]!.text).toContain("30 June 2027");
    expect(pages[1]!.text).toContain("security deposit");
  });
});

describe("processing an upload", () => {
  it("indexes it, recording page, model and status", async () => {
    const f = await setupFinance();
    const document = await uploadReadableDocument(f, LEASE_TEXT);
    expect(document).toMatchObject({ ingestStatus: "READY", scanStatus: "NOT_SCANNED" });

    const chunks = await chunksOf(document.id);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]).toMatchObject({ page: 1, embeddingModel: "test/fake-embeddings", businessId: f.businessId });
    expect(chunks[0]!.content).toContain("30 June 2027");
  });

  it("a file with no text is marked so, and doesn't fail", async () => {
    const f = await setupFinance();
    const document = await uploadReadableDocument(f, "");
    expect(document.ingestStatus).toBe("NO_TEXT");
    expect(await chunksOf(document.id)).toHaveLength(0);
  });

  it("running twice leaves one set of passages", async () => {
    const f = await setupFinance();
    const document = await uploadReadableDocument(f, LEASE_TEXT);
    const before = (await chunksOf(document.id)).length;
    ocrResult.text = LEASE_TEXT;
    await ingestionService.ingest(document.id);
    await ingestionService.ingest(document.id);
    expect(await chunksOf(document.id)).toHaveLength(before);
  });

  it("a statement isn't indexed: its figures belong in the ledger", async () => {
    const f = await setupFinance();
    const { body } = await uploadStatement(f, `${HEADER}\n01/11/2026,Sale,,,5000.00,\n`);
    await runPendingEvents();
    expect(await chunksOf(body.data.id)).toHaveLength(0);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: body.data.id } })).ingestStatus).toBe("NOT_STARTED");
  });

  it("a file swapped after upload is refused, closing the gap from Phase 3", async () => {
    const f = await setupFinance();
    const created = await api().post(`${f.base}/documents/uploads`).set("Authorization", f.auth).send({ type: "CONTRACT", fileName: "c.pdf", mime: "application/pdf", sizeBytes: PDF_BYTES.length });
    await putFile(created.body.data.uploadUrl, PDF_BYTES, "application/pdf");
    const { id } = (await api().post(`${f.base}/documents/${created.body.data.document.id}/complete`).set("Authorization", f.auth)).body.data;

    const stored = await prisma.document.findUniqueOrThrow({ where: { id } });
    await putObject(stored.storageKey, Buffer.from("%PDF-1.4 something else entirely!!"), "application/pdf");
    await runPendingEvents();

    const after = await prisma.document.findUniqueOrThrow({ where: { id } });
    expect(after).toMatchObject({ status: "REJECTED", ingestStatus: "REJECTED" });
    expect((await api().get(`${f.base}/documents/${id}/download`).set("Authorization", f.auth)).status).toBe(409);
    await deleteObject(stored.storageKey).catch(() => {});
  });

  it("a job that dies can be picked up again, and one running isn't started twice", async () => {
    const f = await setupFinance();
    const document = await uploadReadableDocument(f, LEASE_TEXT);
    await prisma.document.update({ where: { id: document.id }, data: { ingestStatus: "PROCESSING" } });
    await prisma.documentChunk.deleteMany({ where: { documentId: document.id } });
    ocrResult.text = LEASE_TEXT;
    await ingestionService.ingest(document.id);
    expect(await chunksOf(document.id)).toHaveLength(0);

    await prisma.$executeRaw`UPDATE documents SET updated_at = now() - interval '1 hour' WHERE id = ${document.id}::uuid`;
    await ingestionService.ingest(document.id);
    expect((await chunksOf(document.id)).length).toBeGreaterThan(0);
  });

  it("documents from before this phase are picked up by the timer", async () => {
    const f = await setupFinance();
    const queue = queues[QueueName.DOCUMENTS];
    await queue.obliterate({ force: true });
    const document = await uploadDocument(f.base, f.auth);
    await prisma.outboxEvent.deleteMany({ where: { type: "document.uploaded" } });
    expect(await runMaintenanceJob("documents.ingest-pending")).toBe(1);
    expect(await queue.getJob(`ingest-${document.id}`)).toBeDefined();
    await queue.obliterate({ force: true });
  });

  it("re-reading on request works, and is audited", async () => {
    const f = await setupFinance();
    const document = await uploadReadableDocument(f, "First version of the text here.");
    const res = await api().post(`${f.base}/documents/${document.id}/reindex`).set("Authorization", f.auth);
    expect(res.status).toBe(202);
    ocrResult.text = "A completely different version of the text.";
    await runPendingEvents();
    const [chunk] = await chunksOf(document.id);
    expect(chunk!.content).toContain("completely different");
    expect(await prisma.auditLog.count({ where: { action: "document.reindex_requested" } })).toBe(1);
  });
});

describe("malware scanning", () => {
  // Speaks the ClamAV protocol, so the real client code runs.
  const fakeClamav = async (answer: string) => {
    const received: Buffer[] = [];
    const server = net.createServer((socket) => {
      socket.on("data", (data: Buffer) => {
        received.push(data);
        const all = Buffer.concat(received);
        if (all.subarray(-4).equals(Buffer.alloc(4))) socket.end(answer);
      });
    }).listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    return { server, port: (server.address() as AddressInfo).port, received };
  };

  const scanner = async (port: number) => {
    vi.resetModules();
    process.env.CLAMAV_HOST = "127.0.0.1";
    process.env.CLAMAV_PORT = String(port);
    try {
      return await vi.importActual<typeof import("../src/lib/malwareScanner.js")>("../src/lib/malwareScanner.js");
    } finally {
      delete process.env.CLAMAV_HOST;
      delete process.env.CLAMAV_PORT;
    }
  };

  it("reports clean, infected, and refuses to guess", async () => {
    for (const [answer, expected] of [["stream: OK\0", "CLEAN"], ["stream: Eicar-Test FOUND\0", "INFECTED"]] as const) {
      const fake = await fakeClamav(answer);
      const { scanForMalware } = await scanner(fake.port);
      expect(await scanForMalware(Buffer.from("hello"))).toBe(expected);
      const sent = Buffer.concat(fake.received);
      expect(sent.subarray(0, 10).toString()).toBe("zINSTREAM\0");
      expect(sent.readUInt32BE(10)).toBe(5);
      fake.server.close();
    }

    const fake = await fakeClamav("something odd\0");
    const { scanForMalware } = await scanner(fake.port);
    await expect(scanForMalware(Buffer.from("hello"))).rejects.toThrow();
    fake.server.close();
  });

  it("is switched off without a host", async () => {
    vi.resetModules();
    const { scanForMalware } = await vi.importActual<typeof import("../src/lib/malwareScanner.js")>("../src/lib/malwareScanner.js");
    expect(await scanForMalware(Buffer.from("x"))).toBe("NOT_SCANNED");
  });
});

describe("searching", () => {
  it("common words don't count, but codes and real words do", () => {
    expect(keywordsOf("When does the lease agreement end?")).toEqual(["lease", "agreement", "end"]);
    expect(keywordsOf("বাড়ি ভাড়ার চুক্তি কবে শেষ হবে?")).toEqual(["বাড়ি", "ভাড়ার", "চুক্তি", "শেষ"]);
    expect(keywordsOf("Find invoice INV-2041")).toEqual(["find", "invoice", "inv-2041"]);
    expect(keywordsOf("the of?")).toEqual([]);
  });

  it("finds a passage, with its file and page, by meaning or exact word", async () => {
    const f = await setupFinance();
    await uploadReadableDocument(f, LEASE_TEXT);
    await uploadReadableDocument(f, "Invoice INV-2041 from Dhaka Paper Mills for office supplies.", "INVOICE", "invoice.png");

    const res = await search(f, "INV-2041");
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({ fileName: "invoice.png", page: 1, documentType: "INVOICE" });
    expect(res.body.data[0].content).toContain("INV-2041");
    expect(res.body.data[0]).not.toHaveProperty("storageKey");
  });

  it("filters by type", async () => {
    const f = await setupFinance();
    await uploadReadableDocument(f, LEASE_TEXT);
    await uploadReadableDocument(f, "Invoice for rent supplies.", "INVOICE", "invoice.png");
    const res = await search(f, "rent", "&type=INVOICE");
    expect(res.body.data.map((hit: { fileName: string }) => hit.fileName)).toEqual(["invoice.png"]);
  });

  it("a Bangla word finds Bangla text", async () => {
    const f = await setupFinance();
    await uploadReadableDocument(f, "বিদ্যুৎ বিল প্রতি মাসের ১৫ তারিখের মধ্যে পরিশোধ করতে হবে।");
    const res = await search(f, "বিদ্যুৎ");
    expect(res.body.data[0].content).toContain("বিদ্যুৎ");
  });

  it("never shows another business's documents", async () => {
    const f = await setupFinance();
    const other = await setupFinance();
    await uploadReadableDocument(other, "A secret contract about confidential pricing.");
    expect((await search(f, "secret contract confidential")).body.data).toEqual([]);
    expect((await api().get(`${other.base}/documents/search?q=secret`).set("Authorization", f.auth)).status).toBe(404);

    const { workspaceId } = await prisma.business.findUniqueOrThrow({ where: { id: f.businessId } });
    const rows = await withAiScope({ userId: f.owner.userId, workspaceId, businessIds: [f.businessId] }, (tx) => tx.$queryRaw<unknown[]>`SELECT 1 FROM ai_document_chunks`);
    expect(rows).toHaveLength(0);
  });

  it("the restricted role can't see another business's passages either", async () => {
    const f = await setupFinance();
    const other = await setupFinance();
    await uploadReadableDocument(other, "A secret contract about confidential pricing.");
    const { withRls } = await import("../src/lib/rls.js");
    const { workspaceId } = await prisma.business.findUniqueOrThrow({ where: { id: f.businessId } });
    expect(await withRls({ userId: f.owner.userId, workspaceId, businessIds: [f.businessId] }, (tx) => tx.documentChunk.count())).toBe(0);
  });

  it("a deleted document disappears straight away", async () => {
    const f = await setupFinance();
    const document = await uploadReadableDocument(f, LEASE_TEXT);
    expect((await search(f, "lease")).body.data.length).toBeGreaterThan(0);
    await api().delete(`${f.base}/documents/${document.id}`).set("Authorization", f.auth);
    expect((await search(f, "lease")).body.data).toEqual([]);
    expect(await chunksOf(document.id)).toHaveLength(0);
  });

  it("needs documents.read", async () => {
    const f = await setupFinance();
    const manager = await addMember(f.owner, f.businessId, "MANAGER");
    expect((await api().get(`${f.base}/documents/search?q=x`).set("Authorization", bearer(manager))).status).toBe(200);
  });

  it("a search with only punctuation finds nothing, rather than failing", async () => {
    const f = await setupFinance();
    await uploadReadableDocument(f, LEASE_TEXT);
    expect((await search(f, "???")).status).toBe(200);
  });
});
