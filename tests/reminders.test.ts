import { Worker } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import { fireReminder, reconcileReminders } from "../src/app/jobs/reminderJobs.js";
import { scanOverdueTasks } from "../src/app/jobs/overdueScan.js";
import { prisma } from "../src/lib/prisma.js";
import { queueConnection, QueueName, queues } from "../src/lib/queues.js";
import { addMember, API, api, bearer, createBusiness, registerUser, runPendingEvents, type Session } from "./helpers/api.js";
import { notificationsFor } from "./helpers/delivery.js";

vi.mock("../src/lib/mailer.js", () => ({ emailEnabled: () => true, sendEmail: vi.fn(async () => {}) }));

const queue = queues[QueueName.REMINDERS];

const setup = async () => {
  const owner = await registerUser();
  const business = await createBusiness(owner);
  return { owner, businessId: business.id, base: `${API}/businesses/${business.id}/reminders` };
};

const post = (session: Session, url: string, body: object) => api().post(url).set("Authorization", bearer(session)).send(body);
const patch = (session: Session, url: string, body: object) => api().patch(url).set("Authorization", bearer(session)).send(body);

const inHours = (hours: number) => new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

describe("creating reminders", () => {
  it("works out when it first fires, using the business timezone", async () => {
    const { owner, base } = await setup();
    const startsAt = inHours(48);
    const res = await post(owner, base, { title: "ভাড়া", startsAt, leadMinutes: 60 });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: "ACTIVE", timezone: "Asia/Dhaka", recipientUserId: owner.userId, sourceType: "MANUAL" });
    expect(new Date(res.body.data.nextFireAt).getTime()).toBe(new Date(startsAt).getTime() - 60 * 60 * 1000);
  });

  it("refuses a reminder that can never fire", async () => {
    const { owner, base } = await setup();
    const res = await post(owner, base, { title: "x", startsAt: inHours(-5) });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("REMINDER_NO_FUTURE_OCCURRENCE");
  });

  it("refuses a bad rule and a flood", async () => {
    const { owner, base } = await setup();
    expect((await post(owner, base, { title: "x", startsAt: inHours(1), rrule: "nonsense" })).status).toBe(422);
    expect((await post(owner, base, { title: "x", startsAt: inHours(1), rrule: "FREQ=MINUTELY" })).status).toBe(422);
  });

  it("refuses a recipient outside the business", async () => {
    const { owner, base } = await setup();
    const stranger = await registerUser();
    const res = await post(owner, base, { title: "x", startsAt: inHours(1), recipientUserId: stranger.userId });
    expect(res.body.error.code).toBe("ASSIGNEE_NOT_MEMBER");
  });

  it("makes its BullMQ job through the outbox", async () => {
    await queue.obliterate({ force: true });
    const { owner, base } = await setup();
    const startsAt = inHours(2);
    const { body } = await post(owner, base, { title: "x", startsAt });
    await runPendingEvents();

    const job = await queue.getJob(`reminder-${body.data.id}-${new Date(startsAt).getTime()}`);
    expect(job?.data).toEqual({ reminderId: body.data.id, fireAt: new Date(startsAt).toISOString() });
    expect(await job?.getState()).toBe("delayed");
    await queue.obliterate({ force: true });
  });
});

describe("firing", () => {
  const dueReminder = async (extra: object = {}) => {
    const context = await setup();
    const { body } = await post(context.owner, context.base, { title: "Rent", startsAt: inHours(1), ...extra });
    return { ...context, reminder: body.data as { id: string; nextFireAt: string } };
  };

  it("a one-time reminder notifies and completes", async () => {
    const { owner, reminder } = await dueReminder();
    await fireReminder({ reminderId: reminder.id, fireAt: reminder.nextFireAt });

    const [notification] = await notificationsFor(owner.userId, "reminder.due");
    expect(notification?.params).toMatchObject({ title: "Rent", reminderId: reminder.id });
    expect(notification?.deliveries.map((d) => d.channel).sort()).toEqual(["EMAIL", "IN_APP", "PUSH"]);

    const saved = await prisma.reminder.findUniqueOrThrow({ where: { id: reminder.id } });
    expect(saved.status).toBe("COMPLETED");
    expect(saved.nextFireAt).toBeNull();
    expect(saved.lastFiredAt).not.toBeNull();
  });

  it("a repeating reminder moves on and queues its next firing", async () => {
    await queue.obliterate({ force: true });
    const { owner, reminder } = await dueReminder({ rrule: "FREQ=DAILY" });
    await fireReminder({ reminderId: reminder.id, fireAt: reminder.nextFireAt });

    const saved = await prisma.reminder.findUniqueOrThrow({ where: { id: reminder.id } });
    expect(saved.status).toBe("ACTIVE");
    expect(saved.nextFireAt!.getTime()).toBeGreaterThan(new Date(reminder.nextFireAt).getTime());
    expect(await queue.getJob(`reminder-${reminder.id}-${saved.nextFireAt!.getTime()}`)).toBeDefined();
    expect(await notificationsFor(owner.userId, "reminder.due")).toHaveLength(1);
    await queue.obliterate({ force: true });
  });

  it("running the same job twice notifies once", async () => {
    const { owner, reminder } = await dueReminder({ rrule: "FREQ=DAILY" });
    const job = { reminderId: reminder.id, fireAt: reminder.nextFireAt };
    await fireReminder(job);
    await fireReminder(job);
    await Promise.all([fireReminder(job), fireReminder(job)]);
    expect(await notificationsFor(owner.userId, "reminder.due")).toHaveLength(1);
  });

  it("discards a job left over from before an edit", async () => {
    const { owner, base, reminder } = await dueReminder();
    await patch(owner, `${base}/${reminder.id}`, { startsAt: inHours(10) });
    await fireReminder({ reminderId: reminder.id, fireAt: reminder.nextFireAt });

    expect(await notificationsFor(owner.userId, "reminder.due")).toHaveLength(0);
    expect((await prisma.reminder.findUniqueOrThrow({ where: { id: reminder.id } })).status).toBe("ACTIVE");
  });

  it("a paused reminder doesn't fire", async () => {
    const { owner, base, reminder } = await dueReminder();
    const paused = await patch(owner, `${base}/${reminder.id}`, { status: "PAUSED" });
    expect(paused.body.data.nextFireAt).toBeNull();
    await fireReminder({ reminderId: reminder.id, fireAt: reminder.nextFireAt });
    expect(await notificationsFor(owner.userId, "reminder.due")).toHaveLength(0);
  });

  it("uses only the channels chosen", async () => {
    const { owner, reminder } = await dueReminder({ channels: ["IN_APP"] });
    await fireReminder({ reminderId: reminder.id, fireAt: reminder.nextFireAt });
    const [notification] = await notificationsFor(owner.userId, "reminder.due");
    expect(notification?.deliveries.map((d) => d.channel)).toEqual(["IN_APP"]);
  });

  it("someone removed from the business gets nothing", async () => {
    const { owner, businessId, base } = await setup();
    const member = await addMember(owner, businessId, "MANAGER");
    const { body } = await post(owner, base, { title: "x", startsAt: inHours(1), recipientUserId: member.userId });
    await prisma.businessMember.updateMany({ where: { businessId, userId: member.userId }, data: { status: "REMOVED" } });

    await fireReminder({ reminderId: body.data.id, fireAt: body.data.nextFireAt });
    expect(await notificationsFor(member.userId, "reminder.due")).toHaveLength(0);
  });

  it("a worker that was down sends one message, not one per missed day", async () => {
    const { owner, reminder } = await dueReminder({ rrule: "FREQ=DAILY" });
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    await prisma.reminder.update({ where: { id: reminder.id }, data: { startsAt: weekAgo, nextFireAt: weekAgo, nextOccurrenceAt: weekAgo } });

    await fireReminder({ reminderId: reminder.id, fireAt: weekAgo.toISOString() });

    expect(await notificationsFor(owner.userId, "reminder.due")).toHaveLength(1);
    const saved = await prisma.reminder.findUniqueOrThrow({ where: { id: reminder.id } });
    expect(saved.nextFireAt!.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("the reconciler", () => {
  it("rebuilds every job after Redis is emptied, and repeating it adds nothing", async () => {
    await queue.obliterate({ force: true });
    const { owner, base } = await setup();
    const one = await post(owner, base, { title: "one", startsAt: inHours(1) });
    const two = await post(owner, base, { title: "two", startsAt: inHours(2), rrule: "FREQ=DAILY" });
    await post(owner, base, { title: "paused", startsAt: inHours(3) }).then((res) => patch(owner, `${base}/${res.body.data.id}`, { status: "PAUSED" }));

    expect(await queue.getDelayedCount()).toBe(0);
    expect(await reconcileReminders()).toBe(2);
    expect(await reconcileReminders()).toBe(2);
    expect(await queue.getDelayedCount()).toBe(2);
    expect(await queue.getJob(`reminder-${one.body.data.id}-${new Date(one.body.data.nextFireAt).getTime()}`)).toBeDefined();
    expect(await queue.getJob(`reminder-${two.body.data.id}-${new Date(two.body.data.nextFireAt).getTime()}`)).toBeDefined();
    await queue.obliterate({ force: true });
  });

  it("gives a job that failed for good another chance", async () => {
    await queue.obliterate({ force: true });
    const { owner, base } = await setup();
    const { body } = await post(owner, base, { title: "x", startsAt: inHours(1) });
    const late = new Date(Date.now() - 5 * 60 * 1000);
    await prisma.reminder.update({ where: { id: body.data.id }, data: { nextFireAt: late, nextOccurrenceAt: late } });

    // A real worker whose only attempt fails, so the job ends up in BullMQ's failed set.
    await queue.add("reminder.fire", { reminderId: body.data.id, fireAt: late.toISOString() }, { jobId: `reminder-${body.data.id}-${late.getTime()}`, attempts: 1 });
    const worker = new Worker(QueueName.REMINDERS, async () => { throw new Error("database down"); }, { connection: queueConnection });
    await new Promise((resolve) => worker.once("failed", resolve));
    await worker.close();

    const id = `reminder-${body.data.id}-${late.getTime()}`;
    expect(await (await queue.getJob(id))?.getState()).toBe("failed");

    await reconcileReminders();
    expect(await (await queue.getJob(id))?.getState()).not.toBe("failed");
    await queue.obliterate({ force: true });
  });
});

describe("the overdue scan", () => {
  it("notifies once a day, the assignee or else the creator", async () => {
    const { owner, businessId } = await setup();
    const member = await addMember(owner, businessId, "MANAGER");
    const tasks = `${API}/businesses/${businessId}/tasks`;
    const late = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await post(owner, tasks, { title: "Assigned", dueAt: late, assigneeId: member.userId });
    await post(owner, tasks, { title: "Unassigned", dueAt: late });
    await post(owner, tasks, { title: "Not yet", dueAt: inHours(5) });
    const done = await post(owner, tasks, { title: "Finished", dueAt: late });
    await patch(owner, `${tasks}/${done.body.data.id}`, { status: "DONE" });

    expect(await scanOverdueTasks()).toBe(2);
    await scanOverdueTasks();

    expect((await notificationsFor(member.userId, "task.overdue")).map((n) => (n.params as { title: string }).title)).toEqual(["Assigned"]);
    expect((await notificationsFor(owner.userId, "task.overdue")).map((n) => (n.params as { title: string }).title)).toEqual(["Unassigned"]);
  });

  it("skips businesses that are closed", async () => {
    const { owner, businessId } = await setup();
    await post(owner, `${API}/businesses/${businessId}/tasks`, { title: "x", dueAt: new Date(Date.now() - 1000).toISOString() });
    await prisma.business.update({ where: { id: businessId }, data: { status: "ARCHIVED" } });
    expect(await scanOverdueTasks()).toBe(0);
  });
});

describe("reminders a task or schedule manages", () => {
  it("can't be edited by hand", async () => {
    const { owner, businessId, base } = await setup();
    const task = await post(owner, `${API}/businesses/${businessId}/tasks`, { title: "x", dueAt: inHours(72) });
    const reminder = await prisma.reminder.findFirstOrThrow({ where: { sourceId: task.body.data.id } });
    const res = await patch(owner, `${base}/${reminder.id}`, { title: "new" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("REMINDER_MANAGED_BY_SOURCE");
  });
});
