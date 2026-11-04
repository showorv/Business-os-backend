import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { renderCsv } from "../src/app/exports/renderCsv.js";
import { renderPdf } from "../src/app/exports/renderPdf.js";
import { reportExportsService } from "../src/app/modules/report-exports/report-exports.service.js";
import { prisma } from "../src/lib/prisma.js";
import { withRls } from "../src/lib/rls.js";
import { addMember, api, bearer, enableMfa, runPendingEvents, setupFinance, totpCode, type FinanceSetup } from "./helpers/api.js";

const seed = async () => {
  const f = await setupFinance();
  const post = (body: object) => api().post(`${f.base}/transactions`).set("Authorization", f.auth).send({ postNow: true, txnDate: "2026-11-05", ...body });
  await post({ type: "INCOME", accountId: f.bankId, categoryId: f.salesId, amountMinor: "125000000" });
  await post({ type: "EXPENSE", accountId: f.bankId, categoryId: f.rentId, amountMinor: "3000050" });
  return f;
};

const request = (f: FinanceSetup, body: object) => api().post(`${f.base}/report-exports`).set("Authorization", f.auth).send(body);

// Requests, runs the worker's step, then downloads the file.
const exportFile = async (f: FinanceSetup, body: object) => {
  const created = await request(f, body);
  if (created.status !== 202) throw new Error(`export failed: ${JSON.stringify(created.body)}`);
  await runPendingEvents();

  const url = `${f.base}/report-exports/${created.body.data.id}`;
  const status = await api().get(url).set("Authorization", f.auth);
  expect(status.body.data.status).toBe("READY");

  const link = await api().get(`${url}/download`).set("Authorization", f.auth);
  expect(link.status).toBe(200);
  const file = await fetch(link.body.data.url);
  expect(file.status).toBe(200);
  return {
    bytes: Buffer.from(await file.arrayBuffer()),
    disposition: file.headers.get("content-disposition") ?? "",
    fileName: status.body.data.fileName as string,
  };
};

const NOVEMBER = { from: "2026-11-01", to: "2026-11-30" };

describe("CSV", () => {
  it("starts with a BOM, so Excel reads Bangla, and keeps values machine-readable", async () => {
    const f = await seed();
    const { bytes, fileName, disposition } = await exportFile(f, { report: "PROFIT_AND_LOSS", format: "CSV", ...NOVEMBER, locale: "bn-BD" });
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(fileName).toBe("profit-and-loss-2026-11-01_2026-11-30.csv");
    expect(disposition).toContain("attachment");

    const text = bytes.toString("utf8");
    expect(text).toContain("হিসাব");
    expect(text).toContain("ভাড়া");
    // Headers translate; the values stay plain, whatever the language.
    expect(text).toContain("1250000.00");
    expect(text).toContain("30000.50");
    expect(text).toContain("1219999.50");
  });

  it("neutralises formulas in user-typed names, and leaves negative amounts alone", () => {
    const csv = renderCsv({
      title: "T", businessName: "B", period: "P", note: "N", currency: "BDT",
      columns: [{ label: "Name", numeric: false }, { label: "Amount", numeric: true }],
      rows: [
        { kind: "item", cells: ['=HYPERLINK("http://evil","x")', -500n] },
        { kind: "item", cells: ["+1", 1n] },
        { kind: "item", cells: ["Comma, name", null] },
      ],
    }).toString("utf8");
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"",""x"")",-5.00`);
    expect(csv).toContain("'+1,0.01");
    expect(csv).toContain('"Comma, name",');
  });
});

describe("Excel", () => {
  it("has real numbers people can add up, and Bangla text", async () => {
    const f = await seed();
    const { bytes } = await exportFile(f, { report: "TRIAL_BALANCE", format: "XLSX", asOf: "2026-11-30", locale: "bn-BD" });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0]!;
    const rows: unknown[][] = [];
    sheet.eachRow((row) => rows.push((row.values as unknown[]).slice(1)));

    expect(JSON.stringify(rows)).toContain("ট্রায়াল ব্যালেন্স");
    const sales = rows.find((row) => row[0] === "4000")!;
    expect(sales[1]).toBe("বিক্রয় আয়");
    expect(sales[3]).toBe(1250000);
    const total = rows.at(-1)!;
    expect(total[2]).toBe(total[3]);
  });
});

describe("PDF", () => {
  it("makes a real PDF in Bangla, with the fonts embedded", async () => {
    const f = await seed();
    const { bytes, fileName } = await exportFile(f, { report: "BALANCE_SHEET", format: "PDF", asOf: "2026-11-30", locale: "bn-BD", digitStyle: "bangla" });
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(fileName).toBe("balance-sheet-2026-11-30.pdf");
    expect(bytes.toString("latin1")).toMatch(/FontFile/);
  });

  it("a hostile name stays text: no script runs and nothing is fetched", async () => {
    const pdf = await renderPdf(
      {
        title: "T", businessName: `<img src="http://127.0.0.1:9/x"><script>document.title='x'</script>`, period: "P", note: "N", currency: "BDT",
        columns: [{ label: "A", numeric: false }],
        rows: [{ kind: "item", cells: ["<b>x</b>"] }],
      },
      { businessName: "B", locale: "en", digitStyle: "latin", grouping: "lakh" },
    );
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });
});

describe("the export flow", () => {
  it("each report type works in each language", async () => {
    const f = await seed();
    for (const body of [
      { report: "TRIAL_BALANCE", asOf: "2026-11-30" },
      { report: "PROFIT_AND_LOSS", ...NOVEMBER },
      { report: "BALANCE_SHEET", asOf: "2026-11-30" },
      { report: "CASH_FLOW", ...NOVEMBER },
    ]) {
      for (const locale of ["en", "bn-BD"]) {
        const { bytes } = await exportFile(f, { ...body, format: "CSV", locale });
        expect(bytes.length).toBeGreaterThan(10);
      }
    }
  });

  it("queues rather than waits, defaults to my language, and audits the request", async () => {
    const f = await seed();
    await api().patch(`/api/v1/users/me`).set("Authorization", f.auth).send({ locale: "bn-BD", digitStyle: "bangla" });
    const created = await request(f, { report: "CASH_FLOW", format: "CSV", ...NOVEMBER });
    expect(created.status).toBe(202);
    expect(created.body.data).toMatchObject({ status: "QUEUED", locale: "bn-BD", digitStyle: "bangla" });
    expect(created.body.data.storageKey).toBeUndefined();

    const notReady = await api().get(`${f.base}/report-exports/${created.body.data.id}/download`).set("Authorization", f.auth);
    expect(notReady.status).toBe(409);
    expect(notReady.body.error.code).toBe("EXPORT_NOT_READY");

    expect(await prisma.auditLog.count({ where: { action: "report.export_requested" } })).toBe(1);
    const event = await prisma.outboxEvent.findFirstOrThrow({ where: { type: "report_export.requested" } });
    expect(event.payload).toMatchObject({ exportId: created.body.data.id });
  });

  it("needs the right dates for the report", async () => {
    const f = await seed();
    const res = await request(f, { report: "TRIAL_BALANCE", format: "CSV", ...NOVEMBER });
    expect(res.status).toBe(422);
    expect(res.body.error.params.fields[0].code).toBe("REPORT_DATES_REQUIRED");
    expect((await request(f, { report: "CASH_FLOW", format: "CSV", asOf: "2026-11-30" })).status).toBe(422);
    expect((await request(f, { report: "CASH_FLOW", format: "DOC", ...NOVEMBER })).status).toBe(422);
  });

  it("needs finance.read, and recent MFA when MFA is on", async () => {
    const f = await seed();
    const manager = await addMember(f.owner, f.businessId, "MANAGER");
    const denied = await api().post(`${f.base}/report-exports`).set("Authorization", bearer(manager)).send({ report: "CASH_FLOW", format: "CSV", ...NOVEMBER });
    expect(denied.status).toBe(403);

    const secret = await enableMfa(f.owner);
    const blocked = await request(f, { report: "CASH_FLOW", format: "CSV", ...NOVEMBER });
    expect(blocked.status).toBe(401);
    expect(blocked.body.error.code).toBe("MFA_REQUIRED");

    const stepUp = await api().post("/api/v1/auth/mfa/step-up").set("Authorization", f.auth).send({ code: await totpCode(secret, 30) });
    const allowed = await api().post(`${f.base}/report-exports`).set("Authorization", `Bearer ${stepUp.body.data.accessToken}`).send({ report: "CASH_FLOW", format: "CSV", ...NOVEMBER });
    expect(allowed.status).toBe(202);
  });

  it("if access is removed before the job runs, no file is made", async () => {
    const f = await seed();
    const accountant = await addMember(f.owner, f.businessId, "ACCOUNTANT");
    const created = await api().post(`${f.base}/report-exports`).set("Authorization", bearer(accountant)).send({ report: "CASH_FLOW", format: "CSV", ...NOVEMBER });
    await api().delete(`${f.base}/members/${accountant.memberId}`).set("Authorization", f.auth);

    await runPendingEvents();
    const row = await prisma.reportExport.findUniqueOrThrow({ where: { id: created.body.data.id } });
    expect(row).toMatchObject({ status: "FAILED", errorCode: "PERMISSION_DENIED", storageKey: null });
  });

  it("running a finished export again does nothing, and a failed one is recorded", async () => {
    const f = await seed();
    const created = await request(f, { report: "CASH_FLOW", format: "CSV", ...NOVEMBER });
    await runPendingEvents();
    const finished = await prisma.reportExport.findUniqueOrThrow({ where: { id: created.body.data.id } });
    await reportExportsService.run(created.body.data.id);
    expect((await prisma.reportExport.findUniqueOrThrow({ where: { id: created.body.data.id } })).finishedAt).toEqual(finished.finishedAt);

    const second = await request(f, { report: "CASH_FLOW", format: "CSV", ...NOVEMBER });
    await reportExportsService.markFailed(second.body.data.id);
    expect((await prisma.reportExport.findUniqueOrThrow({ where: { id: second.body.data.id } })).status).toBe("FAILED");
  });

  it("another business can't see or download it, and the role can't delete it", async () => {
    const f = await seed();
    const created = await request(f, { report: "CASH_FLOW", format: "CSV", ...NOVEMBER });
    await runPendingEvents();

    const other = await setupFinance();
    expect((await api().get(`${other.base}/report-exports/${created.body.data.id}`).set("Authorization", other.auth)).status).toBe(404);
    expect((await api().get(`${other.base}/report-exports/${created.body.data.id}/download`).set("Authorization", other.auth)).status).toBe(404);
    expect((await api().get(`${f.base}/report-exports`).set("Authorization", other.auth)).status).toBe(404);

    const scope = { userId: f.owner.userId, businessIds: [f.businessId] };
    await expect(withRls(scope, (tx) => tx.$executeRawUnsafe(`DELETE FROM report_exports`))).rejects.toThrow(/permission denied/);
  });
});
