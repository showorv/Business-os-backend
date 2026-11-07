import { describe, expect, it, vi } from "vitest";
import { checkAuditChains, checkLedgers, cleanUp, registerMaintenanceJobs, runMaintenanceJob } from "../src/app/jobs/maintenance.js";
import { prisma } from "../src/lib/prisma.js";
import { QueueName, queues } from "../src/lib/queues.js";
import { deleteObject, openObjectStream, putObject } from "../src/lib/storage.js";
import { api, setupFinance, type FinanceSetup } from "./helpers/api.js";
import { notificationsFor } from "./helpers/delivery.js";

vi.mock("../src/lib/mailer.js", () => ({ emailEnabled: () => true, sendEmail: vi.fn(async () => {}) }));

const expense = (f: FinanceSetup) =>
  api().post(`${f.base}/transactions`).set("Authorization", f.auth).send({ postNow: true, type: "EXPENSE", accountId: f.bankId, categoryId: f.rentId, amountMinor: "100", txnDate: "2026-11-05" });

describe("the nightly ledger check", () => {
  it("finds nothing wrong in healthy books", async () => {
    const f = await setupFinance();
    await expense(f);
    expect(await checkLedgers()).toMatchObject({ problems: 0 });
    expect(await notificationsFor(f.owner.userId, "ledger.check_failed")).toHaveLength(0);
  });

  it("tells the managers when figures don't match, once a day", async () => {
    const f = await setupFinance();
    await expense(f);
    await prisma.financialAccount.update({ where: { id: f.bankId }, data: { currentBalanceMinor: 999n } });

    expect(await checkLedgers()).toMatchObject({ problems: 1 });
    await checkLedgers();

    const [notification, ...rest] = await notificationsFor(f.owner.userId, "ledger.check_failed");
    expect(rest).toHaveLength(0);
    expect(notification?.params).toMatchObject({ accountsOutOfStep: 1 });
    expect(notification?.deliveries.map((d) => d.channel)).toContain("EMAIL");
  });
});

describe("the nightly audit check", () => {
  it("passes on an untouched log", async () => {
    const f = await setupFinance();
    await expense(f);
    expect(await checkAuditChains()).toMatchObject({ broken: 0 });
  });

  it("notices a changed row and tells the workspace's owners", async () => {
    const f = await setupFinance();
    await expense(f);
    const row = await prisma.auditLog.findFirstOrThrow({ where: { businessId: f.businessId }, orderBy: { id: "desc" } });
    await prisma.$executeRawUnsafe(`ALTER TABLE audit_logs DISABLE TRIGGER USER`);
    await prisma.$executeRaw`UPDATE audit_logs SET action = 'tampered' WHERE id = ${row.id}`;
    await prisma.$executeRawUnsafe(`ALTER TABLE audit_logs ENABLE TRIGGER USER`);

    expect(await checkAuditChains()).toMatchObject({ broken: 1 });
    expect(await notificationsFor(f.owner.userId, "audit.check_failed")).toHaveLength(1);
  });
});

describe("the nightly clean-up", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const ago = (days: number) => new Date(Date.now() - days * DAY);

  it("removes what has expired and keeps what hasn't", async () => {
    const f = await setupFinance();
    const userId = f.owner.userId;
    const owner = { workspaceId: (await prisma.business.findUniqueOrThrow({ where: { id: f.businessId } })).workspaceId, businessId: f.businessId };

    await prisma.idempotencyKey.createMany({
      data: [
        { userId, key: "expired-key", requestHash: "x", statusCode: 201, responseBody: {}, expiresAt: ago(1) },
        { userId, key: "current-key", requestHash: "x", statusCode: 201, responseBody: {}, expiresAt: new Date(Date.now() + DAY) },
      ],
    });
    await prisma.outboxEvent.createMany({
      data: [
        { ...owner, actorUserId: userId, type: "t", payload: {}, publishedAt: ago(40) },
        { ...owner, actorUserId: userId, type: "t", payload: {}, publishedAt: ago(1) },
        { ...owner, actorUserId: userId, type: "t", payload: {}, createdAt: ago(40) },
      ],
    });
    await prisma.notification.createMany({
      data: [
        { userId, type: "t", params: {}, dedupeKey: "old", createdAt: ago(200) },
        { userId, type: "t", params: {}, dedupeKey: "new" },
      ],
    });
    await prisma.passwordResetToken.createMany({
      data: [
        { userId, tokenHash: "old", expiresAt: ago(10) },
        { userId, tokenHash: "new", expiresAt: new Date(Date.now() + DAY) },
      ],
    });

    const result = await cleanUp();
    expect(result).toMatchObject({ idempotencyKeys: 1, notifications: 1, resetTokens: 1, events: 1 });

    expect(await prisma.idempotencyKey.count({ where: { userId } })).toBe(1);
    // An event that was never published stays, however old: it hasn't been acted on yet.
    expect(await prisma.outboxEvent.count({ where: { type: "t" } })).toBe(2);
    expect(await prisma.notification.findUnique({ where: { dedupeKey: "new" } })).not.toBeNull();
  });

  it("removes abandoned uploads and old export files from storage too", async () => {
    const f = await setupFinance();
    const { workspaceId } = await prisma.business.findUniqueOrThrow({ where: { id: f.businessId } });
    const owner = { workspaceId, businessId: f.businessId };

    const abandoned = await prisma.document.create({
      data: { ...owner, type: "RECEIPT", fileName: "a.pdf", storageKey: "test/abandoned.pdf", mime: "application/pdf", sizeBytes: 1n, createdBy: f.owner.userId, createdAt: ago(3) },
    });
    const fresh = await prisma.document.create({
      data: { ...owner, type: "RECEIPT", fileName: "b.pdf", storageKey: "test/fresh.pdf", mime: "application/pdf", sizeBytes: 1n, createdBy: f.owner.userId },
    });

    const key = "test/old-export.csv";
    await putObject(key, new TextEncoder().encode("x"), "text/csv");
    const old = await prisma.reportExport.create({
      data: { ...owner, report: "TRIAL_BALANCE", format: "CSV", params: {}, locale: "en", digitStyle: "latin", status: "READY", storageKey: key, requestedBy: f.owner.userId, createdAt: ago(40) },
    });

    expect(await cleanUp()).toMatchObject({ abandonedUploads: 1, exportFiles: 1 });

    expect((await prisma.document.findUniqueOrThrow({ where: { id: abandoned.id } })).deletedAt).not.toBeNull();
    expect((await prisma.document.findUniqueOrThrow({ where: { id: fresh.id } })).deletedAt).toBeNull();
    expect(await prisma.reportExport.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await openObjectStream(key)).toBeNull();
    await deleteObject("test/abandoned.pdf").catch(() => {});
  });
});

describe("the timers", () => {
  it("register once, however many times the worker restarts", async () => {
    const queue = queues[QueueName.MAINTENANCE];
    await queue.obliterate({ force: true });
    await registerMaintenanceJobs();
    await registerMaintenanceJobs();
    const schedulers = await queue.getJobSchedulers();
    expect(schedulers.map((scheduler) => scheduler.key).sort()).toEqual([
      "audit.verify", "billing.plan-reminders", "documents.ingest-pending", "integrations.sync-due", "ledger.verify", "recurring.run-due", "reminders.reconcile", "statement-lines.settle", "system.clean-up", "tasks.overdue-scan",
    ]);
    await queue.obliterate({ force: true });
  });

  it("every timer has something to run", async () => {
    for (const name of ["reminders.reconcile", "recurring.run-due", "tasks.overdue-scan", "documents.ingest-pending", "integrations.sync-due", "statement-lines.settle", "ledger.verify", "audit.verify", "system.clean-up", "billing.plan-reminders"]) {
      await expect(runMaintenanceJob(name)).resolves.toBeDefined();
    }
  });
});
