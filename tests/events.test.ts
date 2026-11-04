import { Worker } from "bullmq";
import { describe, expect, it } from "vitest";
import { relayOutbox } from "../src/app/jobs/outboxRelay.js";
import { processEvent } from "../src/app/jobs/processEvent.js";
import type { EventJob } from "../src/app/jobs/eventTypes.js";
import { prisma } from "../src/lib/prisma.js";
import { queueConnection, QueueName, queues } from "../src/lib/queues.js";
import { withRls } from "../src/lib/rls.js";
import { api, setupFinance, type FinanceSetup } from "./helpers/api.js";

const expense = (f: FinanceSetup, extra: object = {}) =>
  api().post(`${f.base}/transactions`).set("Authorization", f.auth).send({ postNow: true, type: "EXPENSE", accountId: f.bankId, categoryId: f.rentId, amountMinor: "100", txnDate: "2026-11-05", ...extra });

const clearQueues = () => Promise.all(Object.values(queues).map((queue) => queue.obliterate({ force: true })));

describe("the outbox", () => {
  it("saves an event with the posting", async () => {
    const f = await setupFinance();
    const res = await expense(f);
    const event = await prisma.outboxEvent.findFirstOrThrow({ where: { businessId: f.businessId, type: "journal.posted" } });
    expect(event.publishedAt).toBeNull();
    expect(event.actorUserId).toBe(f.owner.userId);
    expect(event.payload).toMatchObject({ entryId: res.body.data.journalEntryId, entryDate: "2026-11-05" });
  });

  it("has no event if the posting fails, because they share a transaction", async () => {
    const f = await setupFinance();
    await prisma.fiscalPeriod.updateMany({ where: { businessId: f.businessId, startDate: new Date("2026-11-01") }, data: { status: "CLOSED" } });
    expect((await expense(f)).status).toBe(409);
    expect(await prisma.outboxEvent.count({ where: { businessId: f.businessId, type: "journal.posted" } })).toBe(0);
  });

  it("the relay publishes each event once, and a second run finds nothing", async () => {
    await clearQueues();
    const f = await setupFinance();
    await expense(f);
    await expense(f, { amountMinor: "200" });

    expect(await relayOutbox()).toBe(2);
    expect(await relayOutbox()).toBe(0);
    expect(await prisma.outboxEvent.count({ where: { publishedAt: null } })).toBe(0);
    expect(await queues[QueueName.LEDGER_EVENTS].getWaitingCount()).toBe(2);
    await clearQueues();
  });

  it("if publishing fails, events stay unpublished and go out on the next run", async () => {
    await clearQueues();
    const f = await setupFinance();
    await expense(f);

    const queue = queues[QueueName.LEDGER_EVENTS];
    const realAdd = queue.add.bind(queue);
    queue.add = (() => Promise.reject(new Error("redis down"))) as typeof queue.add;
    try {
      await expect(relayOutbox()).rejects.toThrow("redis down");
    } finally {
      queue.add = realAdd;
    }
    expect(await prisma.outboxEvent.count({ where: { publishedAt: null } })).toBe(1);

    expect(await relayOutbox()).toBe(1);
    expect(await queue.getWaitingCount()).toBe(1);
    await clearQueues();
  });

  it("a repeat publish of one event does not create a second job", async () => {
    await clearQueues();
    const f = await setupFinance();
    await expense(f);
    await relayOutbox();
    await prisma.outboxEvent.updateMany({ data: { publishedAt: null } });
    await relayOutbox();
    expect(await queues[QueueName.LEDGER_EVENTS].getWaitingCount()).toBe(1);
    await clearQueues();
  });

  it("two relays at once never publish the same event twice", async () => {
    await clearQueues();
    const f = await setupFinance();
    await expense(f);
    await expense(f, { amountMinor: "300" });
    const counts = await Promise.all([relayOutbox(), relayOutbox()]);
    expect(counts[0]! + counts[1]!).toBe(2);
    await clearQueues();
  });

  it("the restricted role can add events only for its own business, and can't change them", async () => {
    const f = await setupFinance();
    const other = await setupFinance();
    const scope = { userId: f.owner.userId, businessIds: [f.businessId] };
    await expect(
      withRls(scope, (tx) => tx.outboxEvent.createMany({ data: { workspaceId: other.owner.userId, businessId: other.businessId, actorUserId: f.owner.userId, type: "x", payload: {} } })),
    ).rejects.toThrow();
    await expect(withRls(scope, (tx) => tx.$executeRawUnsafe(`UPDATE outbox_events SET type = 'x'`))).rejects.toThrow(/permission denied/);
    await expect(withRls(scope, (tx) => tx.$executeRawUnsafe(`DELETE FROM outbox_events`))).rejects.toThrow(/permission denied/);
  });
});

describe("through real BullMQ", () => {
  it("a posting becomes a job, and a worker turns it into a budget alert", async () => {
    await clearQueues();
    const f = await setupFinance();
    await api().post(`${f.base}/budgets`).set("Authorization", f.auth).send({ name: "Nov", startMonth: "2026-11", endMonth: "2026-11", lines: [{ categoryId: f.rentId, amountMinor: "100" }] });
    await expense(f);
    await relayOutbox();

    const finished = new Promise<void>((resolve, reject) => {
      const worker = new Worker<EventJob>(QueueName.LEDGER_EVENTS, (job) => processEvent(job.data), { connection: queueConnection });
      worker.on("completed", () => void worker.close().then(resolve));
      worker.on("failed", (_job, error) => void worker.close().then(() => reject(error)));
    });
    await finished;

    expect(await prisma.budgetAlert.count()).toBe(2);
    await clearQueues();
  });
});
