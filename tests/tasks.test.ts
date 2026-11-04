import { describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { addMember, API, api, bearer, createBusiness, registerUser, runPendingEvents, uploadDocument, type Session } from "./helpers/api.js";
import { auditActions } from "./helpers/db.js";
import { notificationsFor } from "./helpers/delivery.js";

const setup = async () => {
  const owner = await registerUser();
  const business = await createBusiness(owner);
  return { owner, businessId: business.id, base: `${API}/businesses/${business.id}/tasks` };
};

const post = (session: Session, url: string, body: object) => api().post(url).set("Authorization", bearer(session)).send(body);
const patch = (session: Session, url: string, body: object) => api().patch(url).set("Authorization", bearer(session)).send(body);
const get = (session: Session, url: string) => api().get(url).set("Authorization", bearer(session));

const inDays = (days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

describe("creating tasks", () => {
  it("starts as TODO and is audited", async () => {
    const { owner, base } = await setup();
    const res = await post(owner, base, { title: "ভ্যাট রিটার্ন জমা", priority: "HIGH" });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ title: "ভ্যাট রিটার্ন জমা", status: "TODO", priority: "HIGH", isOverdue: false });
    expect(await auditActions()).toContain("task.created");
  });

  it("refuses an assignee who isn't in the business", async () => {
    const { owner, base } = await setup();
    const stranger = await registerUser();
    const res = await post(owner, base, { title: "x", assigneeId: stranger.userId });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("ASSIGNEE_NOT_MEMBER");
  });

  it("a viewer can read tasks but not write them", async () => {
    const { owner, businessId, base } = await setup();
    const viewer = await addMember(owner, businessId, "VIEWER");
    expect((await get(viewer, base)).status).toBe(200);
    expect((await post(viewer, base, { title: "x" })).status).toBe(403);
  });

  it("someone outside the business gets 404", async () => {
    const { base } = await setup();
    const stranger = await registerUser();
    expect((await get(stranger, base)).status).toBe(404);
  });
});

describe("task status", () => {
  it("follows the allowed moves and records completion", async () => {
    const { owner, base } = await setup();
    const { body } = await post(owner, base, { title: "x" });
    const url = `${base}/${body.data.id}`;

    expect((await patch(owner, url, { status: "IN_PROGRESS" })).status).toBe(200);
    const done = await patch(owner, url, { status: "DONE" });
    expect(done.body.data.completedAt).not.toBeNull();

    const blocked = await patch(owner, url, { status: "BLOCKED" });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("TASK_STATUS_INVALID");
  });

  it("reopening clears the completion time", async () => {
    const { owner, base } = await setup();
    const { body } = await post(owner, base, { title: "x" });
    const url = `${base}/${body.data.id}`;
    await patch(owner, url, { status: "DONE" });
    const reopened = await patch(owner, url, { status: "TODO" });
    expect(reopened.body.data.completedAt).toBeNull();
  });
});

describe("task views", () => {
  it("my tasks, overdue, and summary", async () => {
    const { owner, businessId, base } = await setup();
    const member = await addMember(owner, businessId, "MANAGER");
    await post(owner, base, { title: "Mine", assigneeId: owner.userId });
    await post(owner, base, { title: "Theirs", assigneeId: member.userId });
    await post(owner, base, { title: "Late", dueAt: inDays(-2) });
    await post(owner, base, { title: "Later", dueAt: inDays(5) });

    const mine = await get(owner, `${base}?mine=true`);
    expect(mine.body.data.items.map((t: { title: string }) => t.title)).toEqual(["Mine"]);

    const overdue = await get(owner, `${base}?overdue=true`);
    expect(overdue.body.data.items.map((t: { title: string }) => t.title)).toEqual(["Late"]);
    expect(overdue.body.data.items[0].isOverdue).toBe(true);

    const summary = await get(owner, `${base}/summary`);
    expect(summary.body.data).toMatchObject({ todo: 4, overdue: 1, assignedToMe: 1 });
  });

  it("a finished task is not overdue", async () => {
    const { owner, base } = await setup();
    const { body } = await post(owner, base, { title: "Late", dueAt: inDays(-2) });
    await patch(owner, `${base}/${body.data.id}`, { status: "DONE" });
    expect((await get(owner, `${base}?overdue=true`)).body.data.items).toHaveLength(0);
  });

  it("all businesses shows only the ones you belong to", async () => {
    const first = await setup();
    const second = await createBusiness(first.owner, "Second");
    const other = await setup();
    await post(first.owner, first.base, { title: "One" });
    await post(first.owner, `${API}/businesses/${second.id}/tasks`, { title: "Two" });
    await post(other.owner, other.base, { title: "Not yours" });

    const res = await get(first.owner, `${API}/tasks`);
    expect(res.status).toBe(200);
    const titles = res.body.data.items.map((t: { title: string }) => t.title).sort();
    expect(titles).toEqual(["One", "Two"]);
    expect(res.body.data.items.find((t: { title: string }) => t.title === "Two").businessName).toBe("Second");
  });

  it("the calendar shows tasks and reminders on their local day", async () => {
    const { owner, businessId, base } = await setup();
    // 20:00 UTC is already the next day in Dhaka.
    const dueAt = "2030-03-10T20:00:00.000Z";
    await post(owner, base, { title: "Task", dueAt });
    await post(owner, `${API}/businesses/${businessId}/reminders`, { title: "Rent", startsAt: "2030-03-01T03:00:00.000Z", rrule: "FREQ=WEEKLY" });

    const res = await get(owner, `${base}/calendar?from=2030-03-01&to=2030-03-31`);
    expect(res.status).toBe(200);
    expect(res.body.data.find((item: { kind: string }) => item.kind === "TASK").date).toBe("2030-03-11");
    expect(res.body.data.filter((item: { kind: string }) => item.kind === "REMINDER")).toHaveLength(5);
  });

  it("the calendar refuses a very long range", async () => {
    const { owner, base } = await setup();
    const res = await get(owner, `${base}/calendar?from=2030-01-01&to=2031-01-01`);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("DATE_RANGE_TOO_LONG");
  });
});

describe("comments and attachments", () => {
  it("a comment tells the assignee and creator, but not its author", async () => {
    const { owner, businessId, base } = await setup();
    const member = await addMember(owner, businessId, "MANAGER");
    const { body } = await post(owner, base, { title: "x", assigneeId: member.userId });
    await runPendingEvents();

    const comment = await post(member, `${base}/${body.data.id}/comments`, { body: "Done soon" });
    expect(comment.status).toBe(201);
    await runPendingEvents();

    expect(await notificationsFor(owner.userId, "task.commented")).toHaveLength(1);
    expect(await notificationsFor(member.userId, "task.commented")).toHaveLength(0);

    const list = await get(owner, `${base}/${body.data.id}/comments`);
    expect(list.body.data.map((c: { body: string }) => c.body)).toEqual(["Done soon"]);
  });

  it("attaches and removes a document", async () => {
    const { owner, businessId, base } = await setup();
    const { body } = await post(owner, base, { title: "x" });
    const url = `${base}/${body.data.id}`;
    const document = await uploadDocument(`${API}/businesses/${businessId}`, bearer(owner));

    expect((await post(owner, `${url}/attachments`, { documentId: document.id })).status).toBe(200);
    expect((await get(owner, url)).body.data.attachments).toHaveLength(1);
    expect((await api().delete(`${url}/attachments/${document.id}`).set("Authorization", bearer(owner))).status).toBe(200);
    expect((await get(owner, url)).body.data.attachments).toHaveLength(0);
  });
});

describe("assignment notifications", () => {
  it("tells a new assignee, once, but not someone assigning themselves", async () => {
    const { owner, businessId, base } = await setup();
    const member = await addMember(owner, businessId, "MANAGER");

    await post(owner, base, { title: "Self", assigneeId: owner.userId });
    const { body } = await post(owner, base, { title: "For them", assigneeId: member.userId });
    await patch(owner, `${base}/${body.data.id}`, { priority: "URGENT" });
    await runPendingEvents();

    expect(await notificationsFor(owner.userId, "task.assigned")).toHaveLength(0);
    const received = await notificationsFor(member.userId, "task.assigned");
    expect(received).toHaveLength(1);
    expect(received[0]!.params).toMatchObject({ title: "For them" });
  });

  it("reassigning tells the new person", async () => {
    const { owner, businessId, base } = await setup();
    const member = await addMember(owner, businessId, "MANAGER");
    const { body } = await post(owner, base, { title: "x" });
    await patch(owner, `${base}/${body.data.id}`, { assigneeId: member.userId });
    await runPendingEvents();
    expect(await notificationsFor(member.userId, "task.assigned")).toHaveLength(1);
  });
});

describe("a task's automatic reminder", () => {
  const reminderOf = (taskId: string) => prisma.reminder.findFirst({ where: { sourceType: "TASK", sourceId: taskId } });

  it("fires a day before the due date", async () => {
    const { owner, base } = await setup();
    const dueAt = inDays(5);
    const { body } = await post(owner, base, { title: "x", dueAt });
    const reminder = await reminderOf(body.data.id);
    expect(reminder?.nextFireAt?.getTime()).toBe(new Date(dueAt).getTime() - 24 * 60 * 60 * 1000);
    expect(reminder?.recipientUserId).toBe(owner.userId);
  });

  it("fires at the due time if that's less than a day away", async () => {
    const { owner, base } = await setup();
    const dueAt = inDays(0.25);
    const { body } = await post(owner, base, { title: "x", dueAt });
    expect((await reminderOf(body.data.id))?.nextFireAt?.getTime()).toBe(new Date(dueAt).getTime());
  });

  it("follows the assignee and the new due date, and stops when finished", async () => {
    const { owner, businessId, base } = await setup();
    const member = await addMember(owner, businessId, "MANAGER");
    const { body } = await post(owner, base, { title: "x", dueAt: inDays(5) });
    const url = `${base}/${body.data.id}`;

    const later = inDays(10);
    await patch(owner, url, { dueAt: later, assigneeId: member.userId });
    let reminder = await reminderOf(body.data.id);
    expect(reminder?.recipientUserId).toBe(member.userId);
    expect(reminder?.nextOccurrenceAt?.getTime()).toBe(new Date(later).getTime());

    await patch(owner, url, { status: "DONE" });
    reminder = await reminderOf(body.data.id);
    expect(reminder?.status).toBe("CANCELLED");
    expect(reminder?.nextFireAt).toBeNull();

    await patch(owner, url, { status: "TODO" });
    expect((await reminderOf(body.data.id))?.status).toBe("ACTIVE");
  });

  it("has no reminder without a due date, and removing the date cancels it", async () => {
    const { owner, base } = await setup();
    const none = await post(owner, base, { title: "no date" });
    expect(await reminderOf(none.body.data.id)).toBeNull();

    const { body } = await post(owner, base, { title: "x", dueAt: inDays(5) });
    await patch(owner, `${base}/${body.data.id}`, { dueAt: null });
    expect((await reminderOf(body.data.id))?.status).toBe("CANCELLED");
  });
});
