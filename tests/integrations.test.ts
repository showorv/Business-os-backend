import { UnrecoverableError, Worker } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import { redactPayload } from "../src/app/integrations/adapter.js";
import { queueDueSyncs, runSync } from "../src/app/jobs/integrationSync.js";
import { cleanUp } from "../src/app/jobs/maintenance.js";
import { relayOutbox } from "../src/app/jobs/outboxRelay.js";
import type { EventJob } from "../src/app/jobs/eventTypes.js";
import { processEvent } from "../src/app/jobs/processEvent.js";
import { decryptForWorkspace, encryptForWorkspace, hmacSha256Hex } from "../src/app/utils/crypto.js";
import { prisma } from "../src/lib/prisma.js";
import { queueConnection, QueueName, queues } from "../src/lib/queues.js";
import { withRls } from "../src/lib/rls.js";
import { addMember, API, api, bearer, runPendingEvents, setupFinance, type FinanceSetup } from "./helpers/api.js";
import { notificationsFor } from "./helpers/delivery.js";
import { linesOf } from "./helpers/statements.js";

vi.mock("../src/lib/mailer.js", () => ({ emailEnabled: () => true, sendEmail: vi.fn(async () => {}) }));

const I = (f: FinanceSetup) => `${f.base}/integrations`;
const WEBHOOK_SECRET = "a-long-webhook-secret";

const connect = (f: FinanceSetup, secrets: object = { apiKey: "key-123", webhookSecret: WEBHOOK_SECRET }, extra: object = {}) =>
  api().post(`${I(f)}/connections`).set("Authorization", f.auth).send({ provider: "sandbox", financialAccountId: f.bankId, secrets, ...extra });

const connected = async (secrets?: object) => {
  const f = await setupFinance();
  const { body } = await connect(f, secrets);
  // Clears the first sync event, so each test decides when syncing happens.
  await prisma.outboxEvent.updateMany({ where: { type: "integration_sync.requested" }, data: { publishedAt: new Date() } });
  return { f, connectionId: body.data.id as string };
};

const runsOf = async (f: FinanceSetup, connectionId: string) =>
  (await api().get(`${I(f)}/connections/${connectionId}/sync-runs`).set("Authorization", f.auth)).body.data.items as { status: string; fetched: number; newLines: number; skipped: number; errorCode: string | null }[];

const statusOf = async (connectionId: string) => prisma.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } });

describe("providers", () => {
  it("lists what's available, including what each can do", async () => {
    const f = await setupFinance();
    const res = await api().get(`${I(f)}/providers`).set("Authorization", f.auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      expect.objectContaining({ key: "sandbox", capabilities: expect.objectContaining({ webhooks: true }), secretFields: ["apiKey", "webhookSecret", "mode"] }),
    ]);
  });

  it("refuses an unknown provider", async () => {
    const f = await setupFinance();
    const res = await api().post(`${I(f)}/connections`).set("Authorization", f.auth).send({ provider: "bkash", financialAccountId: f.bankId, secrets: {} });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("PROVIDER_NOT_AVAILABLE");
  });
});

describe("secrets", () => {
  it("are stored encrypted and never returned", async () => {
    const f = await setupFinance();
    const { body, status, text } = await connect(f, { apiKey: "super-secret-value" });
    expect(status).toBe(201);
    expect(text).not.toContain("super-secret-value");
    expect(body.data).not.toHaveProperty("encryptedSecrets");

    const stored = await statusOf(body.data.id);
    expect(stored.encryptedSecrets).not.toContain("super-secret-value");
    expect(JSON.parse(decryptForWorkspace(stored.encryptedSecrets, stored.workspaceId, stored.id))).toEqual({ apiKey: "super-secret-value" });

    const list = await api().get(`${I(f)}/connections`).set("Authorization", f.auth);
    expect(list.text).not.toContain("encryptedSecrets");
  });

  it("refuses a password, PIN or OTP, naming the field but not its value", async () => {
    const f = await setupFinance();
    for (const secrets of [{ apiKey: "k", password: "hunter22" }, { apiKey: "k", pin: "1234" }, { apiKey: "k", otp: "999999" }]) {
      const res = await connect(f, secrets);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("INTEGRATION_SECRETS_INVALID");
      expect(res.text).not.toMatch(/hunter22|1234|999999/);
    }
  });

  it("can't be read with another workspace's key, or moved to another connection", () => {
    const stored = encryptForWorkspace("secret", "workspace-a", "connection-1");
    expect(decryptForWorkspace(stored, "workspace-a", "connection-1")).toBe("secret");
    expect(() => decryptForWorkspace(stored, "workspace-b", "connection-1")).toThrow();
    expect(() => decryptForWorkspace(stored, "workspace-a", "connection-2")).toThrow();
  });

  it("nothing secret is kept in stored payloads", () => {
    const clean = redactPayload({ amount: 100, access_token: "abc", nested: { apiKey: "k", msisdn: "01712345678", password: "p" }, list: [{ pin: "1" }] });
    expect(clean).toEqual({ amount: 100, access_token: "[REDACTED]", nested: { apiKey: "[REDACTED]", msisdn: "***678", password: "[REDACTED]" }, list: [{ pin: "[REDACTED]" }] });
  });
});

describe("connections", () => {
  it("one per account and provider, audited", async () => {
    const f = await setupFinance();
    await connect(f);
    const again = await connect(f);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("CONNECTION_ALREADY_EXISTS");
    expect(await prisma.auditLog.count({ where: { businessId: f.businessId, action: "integration.connected" } })).toBe(1);
  });

  it("only an owner or admin may manage them", async () => {
    const f = await setupFinance();
    const accountant = await addMember(f.owner, f.businessId, "ACCOUNTANT");
    expect((await api().get(`${I(f)}/connections`).set("Authorization", bearer(accountant))).status).toBe(403);
    const admin = await addMember(f.owner, f.businessId, "ADMIN");
    expect((await api().get(`${I(f)}/connections`).set("Authorization", bearer(admin))).status).toBe(200);
  });

  it("the account must belong to the business", async () => {
    const f = await setupFinance();
    const other = await setupFinance();
    const res = await api().post(`${I(f)}/connections`).set("Authorization", f.auth).send({ provider: "sandbox", financialAccountId: other.bankId, secrets: { apiKey: "k" } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).not.toBe(201);
  });

  it("an outsider gets 404, and the database hides the rows", async () => {
    const { f, connectionId } = await connected();
    const other = await setupFinance();
    expect((await api().get(`${I(f)}/connections/${connectionId}`).set("Authorization", other.auth)).status).toBe(404);
    const { workspaceId } = await prisma.business.findUniqueOrThrow({ where: { id: other.businessId } });
    const seen = await withRls({ userId: other.owner.userId, workspaceId, businessIds: [other.businessId] }, (tx) => tx.integrationConnection.findMany());
    expect(seen).toEqual([]);
  });

  it("the restricted role can't touch raw payloads", async () => {
    const { f } = await connected();
    const { workspaceId } = await prisma.business.findUniqueOrThrow({ where: { id: f.businessId } });
    await expect(withRls({ userId: f.owner.userId, workspaceId, businessIds: [f.businessId] }, (tx) => tx.rawPayload.findMany())).rejects.toThrow();
  });
});

describe("syncing", () => {
  it("brings in every page, records the run, and stays out of the ledger", async () => {
    const { f, connectionId } = await connected();
    const before = await prisma.journalEntry.count({ where: { businessId: f.businessId } });
    await runSync(connectionId);

    const [run] = await runsOf(f, connectionId);
    expect(run).toMatchObject({ status: "SUCCEEDED", fetched: 5, newLines: 5, skipped: 0, errorCode: null });
    const lines = await linesOf(f);
    expect(lines).toHaveLength(5);
    expect(lines.every((line) => line.status === "UNMATCHED")).toBe(true);
    expect(await prisma.journalEntry.count({ where: { businessId: f.businessId } })).toBe(before);

    const stored = await statusOf(connectionId);
    expect(stored).toMatchObject({ syncCursor: "5", consecutiveFailures: 0, syncingSince: null, lastBalanceMinor: 6114950n });
    expect(stored.lastSyncedAt).not.toBeNull();
  });

  it("the next sync starts from the cursor, adding nothing", async () => {
    const { f, connectionId } = await connected();
    await runSync(connectionId);
    await runSync(connectionId);
    const [latest] = await runsOf(f, connectionId);
    expect(latest).toMatchObject({ fetched: 0, newLines: 0 });
    expect(await linesOf(f)).toHaveLength(5);
  });

  it("restarting from the beginning still adds nothing", async () => {
    const { f, connectionId } = await connected();
    await runSync(connectionId);
    await prisma.integrationConnection.update({ where: { id: connectionId }, data: { syncCursor: null } });
    await runSync(connectionId);
    const [latest] = await runsOf(f, connectionId);
    expect(latest).toMatchObject({ fetched: 5, newLines: 0, skipped: 5 });
    expect(await linesOf(f)).toHaveLength(5);
  });

  it("two syncs at once: only one runs", async () => {
    const { f, connectionId } = await connected();
    await Promise.all([runSync(connectionId), runSync(connectionId), runSync(connectionId)]);
    expect(await linesOf(f)).toHaveLength(5);
    expect((await runsOf(f, connectionId)).length).toBeLessThanOrEqual(3);
  });

  it("a claim abandoned by a crashed worker doesn't block forever", async () => {
    const { f, connectionId } = await connected();
    await prisma.integrationConnection.update({ where: { id: connectionId }, data: { syncingSince: new Date() } });
    await runSync(connectionId);
    expect(await linesOf(f)).toHaveLength(0);
    await prisma.integrationConnection.update({ where: { id: connectionId }, data: { syncingSince: new Date(Date.now() - 60 * 60 * 1000) } });
    await runSync(connectionId);
    expect(await linesOf(f)).toHaveLength(5);
  });

  it("rules apply to synced lines too", async () => {
    const { f, connectionId } = await connected();
    await api().post(`${f.base}/statement-rules`).set("Authorization", f.auth).send({ name: "Ads", containsText: "facebook", direction: "OUT", categoryId: f.rentId, autoPost: true });
    await prisma.fiscalPeriod.updateMany({ where: { businessId: f.businessId }, data: { status: "OPEN" } });
    await runSync(connectionId);
    const [transaction] = await prisma.transaction.findMany({ where: { businessId: f.businessId, source: "SYNC" } });
    expect(transaction).toMatchObject({ amountMinor: 300000n, categoryId: f.rentId });
  });

  it("stores what the provider sent, removed after 30 days", async () => {
    const { connectionId } = await connected();
    await runSync(connectionId);
    expect(await prisma.rawPayload.count({ where: { connectionId, kind: "FETCH" } })).toBe(3);
    await prisma.rawPayload.updateMany({ where: { connectionId }, data: { createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) } });
    expect(await cleanUp()).toMatchObject({ rawPayloads: 3 });
  });
});

describe("when a sync fails", () => {
  it("a revoked login stops at once, needs new credentials, and tells the managers", async () => {
    const { f, connectionId } = await connected({ apiKey: "k", mode: "revoked" });
    await expect(runSync(connectionId)).rejects.toBeInstanceOf(UnrecoverableError);

    expect(await statusOf(connectionId)).toMatchObject({ status: "NEEDS_REAUTH", syncingSince: null });
    expect((await runsOf(f, connectionId))[0]).toMatchObject({ status: "FAILED", errorCode: "SANDBOX_REVOKED" });
    expect(await notificationsFor(f.owner.userId, "integration.needs_reauth")).toHaveLength(1);

    // Further syncs do nothing until it's fixed, and it can't simply be switched back on.
    await runSync(connectionId);
    expect(await runsOf(f, connectionId)).toHaveLength(1);
    expect((await api().post(`${I(f)}/connections/${connectionId}/sync`).set("Authorization", f.auth)).status).toBe(409);
    expect((await api().patch(`${I(f)}/connections/${connectionId}`).set("Authorization", f.auth).send({ status: "ACTIVE" })).status).toBe(409);

    const fixed = await api().post(`${I(f)}/connections/${connectionId}/reauthorize`).set("Authorization", f.auth).send({ secrets: { apiKey: "new-key" } });
    expect(fixed.status).toBe(200);
    expect(fixed.body.data).toMatchObject({ status: "ACTIVE", consecutiveFailures: 0 });
    await runSync(connectionId);
    expect(await linesOf(f)).toHaveLength(5);
    expect(await prisma.auditLog.count({ where: { businessId: f.businessId, action: "integration.reauthorized" } })).toBe(1);
  });

  it("a passing fault is thrown for BullMQ to retry, and doesn't change the status", async () => {
    const { connectionId } = await connected({ apiKey: "k", mode: "flaky" });
    const error = await runSync(connectionId).catch((caught) => caught);
    expect(error).not.toBeInstanceOf(UnrecoverableError);
    expect(error.code).toBe("SANDBOX_TIMEOUT");
    expect(await statusOf(connectionId)).toMatchObject({ status: "ACTIVE", consecutiveFailures: 1, syncingSince: null });
  });

  it("a bad request isn't retried", async () => {
    const { connectionId } = await connected({ apiKey: "k", mode: "broken" });
    await expect(runSync(connectionId)).rejects.toBeInstanceOf(UnrecoverableError);
    expect((await statusOf(connectionId)).status).toBe("ACTIVE");
  });

  it("three failures in a row alert the managers, once", async () => {
    const { f, connectionId } = await connected({ apiKey: "k", mode: "flaky" });
    for (let attempt = 0; attempt < 4; attempt += 1) await runSync(connectionId).catch(() => {});
    const alerts = await notificationsFor(f.owner.userId, "integration.sync_failing");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.params).toMatchObject({ failures: 3, provider: "sandbox" });
  });

  it("a real BullMQ worker retries with backoff, then the job stays in the failed list", async () => {
    const queue = queues[QueueName.INTEGRATIONS];
    await queue.obliterate({ force: true });
    const { f, connectionId } = await connected({ apiKey: "k", mode: "flaky" });
    await api().post(`${I(f)}/connections/${connectionId}/sync`).set("Authorization", f.auth);
    await relayOutbox();

    const [waiting] = await queue.getWaiting();
    expect(waiting!.opts.attempts).toBe(5);
    await waiting!.updateData({ ...waiting!.data });
    await queue.remove(waiting!.id!);
    await queue.add(waiting!.name, waiting!.data, { attempts: 2, backoff: { type: "fixed", delay: 10 } });

    const worker = new Worker<EventJob>(QueueName.INTEGRATIONS, (job) => processEvent(job.data), { connection: queueConnection });
    await new Promise<void>((resolve) => worker.on("failed", (job) => { if (job && job.attemptsMade >= 2) resolve(); }));
    await worker.close();

    expect(await queue.getFailedCount()).toBe(1);
    expect(await runsOf(f, connectionId)).toHaveLength(2);
    await queue.obliterate({ force: true });
  });
});

describe("disabling and the timer", () => {
  it("a disabled connection doesn't sync, and it's audited", async () => {
    const { f, connectionId } = await connected();
    const res = await api().patch(`${I(f)}/connections/${connectionId}`).set("Authorization", f.auth).send({ status: "DISABLED" });
    expect(res.body.data.status).toBe("DISABLED");
    await runSync(connectionId);
    expect(await linesOf(f)).toHaveLength(0);
    expect(await prisma.auditLog.count({ where: { businessId: f.businessId, action: "integration.disabled" } })).toBe(1);
  });

  it("the timer queues only what's due", async () => {
    const { connectionId } = await connected();
    expect(await queueDueSyncs()).toBe(1);
    await runPendingEvents();
    expect((await statusOf(connectionId)).lastSyncedAt).not.toBeNull();
    expect(await queueDueSyncs()).toBe(0);

    await prisma.integrationConnection.update({ where: { id: connectionId }, data: { lastSyncedAt: new Date(Date.now() - 7 * 60 * 60 * 1000) } });
    expect(await queueDueSyncs()).toBe(1);
  });

  it("Sync now goes through the outbox", async () => {
    const { f, connectionId } = await connected();
    expect((await api().post(`${I(f)}/connections/${connectionId}/sync`).set("Authorization", f.auth)).status).toBe(202);
    await runPendingEvents();
    expect(await linesOf(f)).toHaveLength(5);
  });
});

describe("webhooks", () => {
  const URL = (id: string) => `${API}/webhooks/integrations/${id}`;
  const signed = (id: string, body: string, secret = WEBHOOK_SECRET, at = Date.now()) =>
    api().post(URL(id)).set("Content-Type", "application/json").set("x-sandbox-timestamp", String(at)).set("x-sandbox-signature", hmacSha256Hex(secret, `${at}.${body}`)).send(body);

  it("a signed call is stored without secrets, and triggers a sync", async () => {
    const { f, connectionId } = await connected();
    const res = await signed(connectionId, JSON.stringify({ event: "payment", token: "abc" }));
    expect(res.status).toBe(200);

    const [stored] = await prisma.rawPayload.findMany({ where: { connectionId, kind: "WEBHOOK" } });
    expect(stored?.payload).toEqual({ event: "payment", token: "[REDACTED]" });
    await runPendingEvents();
    expect(await linesOf(f)).toHaveLength(5);
  });

  it("refuses a wrong signature, an old timestamp, and a changed body", async () => {
    const { connectionId } = await connected();
    expect((await signed(connectionId, "{}", "another-long-secret-value")).status).toBe(401);
    expect((await signed(connectionId, "{}", WEBHOOK_SECRET, Date.now() - 10 * 60 * 1000)).status).toBe(401);
    const at = Date.now();
    const changed = await api().post(URL(connectionId)).set("Content-Type", "application/json").set("x-sandbox-timestamp", String(at)).set("x-sandbox-signature", hmacSha256Hex(WEBHOOK_SECRET, `${at}.{}`)).send('{"amount":1}');
    expect(changed.status).toBe(401);
    expect(await prisma.rawPayload.count({ where: { connectionId } })).toBe(0);
  });

  it("answers 404 for an unknown connection or a malformed id", async () => {
    expect((await signed("00000000-0000-7000-8000-000000000000", "{}")).status).toBe(404);
    expect((await signed("not-a-uuid", "{}")).status).toBe(404);
  });

  it("a forged body adds no statement line, because only the provider's API does", async () => {
    const { f, connectionId } = await connected();
    await signed(connectionId, JSON.stringify({ id: "fake", amount: "999999" }));
    expect(await linesOf(f)).toHaveLength(0);
  });

  it("the normal JSON API still parses bodies", async () => {
    const f = await setupFinance();
    expect((await api().post(`${f.base}/statement-rules`).set("Authorization", f.auth).send({ name: "x", containsText: "x", direction: "OUT", categoryId: f.rentId })).status).toBe(201);
  });
});
