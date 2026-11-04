import { describe, expect, it, vi } from "vitest";
import { recurringSchedulesService } from "../src/app/modules/recurring-schedules/recurring-schedules.service.js";
import { todayInTimezone } from "../src/app/utils/dates.js";
import { prisma } from "../src/lib/prisma.js";
import { redis } from "../src/lib/redis.js";
import { addMember, API, api, bearer, journalLines, setupFinance, type FinanceSetup } from "./helpers/api.js";
import { notificationsFor } from "./helpers/delivery.js";

vi.mock("../src/lib/mailer.js", () => ({ emailEnabled: () => true, sendEmail: vi.fn(async () => {}) }));

const today = () => todayInTimezone("Asia/Dhaka");
const url = (f: FinanceSetup) => `${f.base}/recurring-schedules`;

const create = (f: FinanceSetup, extra: object = {}, auth = f.auth) =>
  api().post(url(f)).set("Authorization", auth).send({
    name: "Office rent",
    rrule: "FREQ=MONTHLY",
    startDate: today(),
    accountId: f.bankId,
    categoryId: f.rentId,
    amountMinor: "3000000",
    ...extra,
  });

const run = (f: FinanceSetup, id: string) => api().post(`${url(f)}/${id}/run`).set("Authorization", f.auth);

const transactionsOf = (f: FinanceSetup) => prisma.transaction.findMany({ where: { businessId: f.businessId, source: "RECURRING" }, orderBy: { txnDate: "asc" } });

// Moves a schedule back in time, as if the worker had been off.
const backdate = (id: string, startDate: string) =>
  prisma.recurringSchedule.update({
    where: { id },
    data: { startDate: new Date(`${startDate}T00:00:00.000Z`), nextRunAt: new Date(`${startDate}T00:00:00.000+06:00`) },
  });

describe("creating a schedule", () => {
  it("saves it with its first run", async () => {
    const f = await setupFinance();
    const res = await create(f);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ kind: "TRANSACTION", type: "EXPENSE", status: "ACTIVE", startDate: today(), amountMinor: "3000000", autoPost: false });
    expect(res.body.data.nextRunAt).not.toBeNull();
  });

  it("refuses a bad setup straight away, not weeks later", async () => {
    const f = await setupFinance();
    expect((await create(f, { categoryId: f.salesId })).status).toBe(422);
    expect((await create(f, { accountId: "00000000-0000-7000-8000-000000000000" })).status).toBeGreaterThanOrEqual(400);
    expect((await create(f, { rrule: "FREQ=HOURLY" })).status).toBe(422);
    expect((await create(f, { amountMinor: "0" })).status).toBe(422);
  });

  it("refuses a start in the past, so it can't quietly create old transactions", async () => {
    const f = await setupFinance();
    const res = await create(f, { startDate: "2020-01-01" });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("SCHEDULE_NO_FUTURE_OCCURRENCE");
  });

  it("auto-posting needs ledger.post", async () => {
    const f = await setupFinance();
    const manager = await addMember(f.owner, f.businessId, "MANAGER");
    expect((await create(f, {}, bearer(manager))).status).toBe(403);
    const accountant = await addMember(f.owner, f.businessId, "ACCOUNTANT");
    expect((await create(f, { autoPost: true }, bearer(accountant))).status).toBe(201);
  });
});

describe("running", () => {
  it("creates a draft, marked as recurring", async () => {
    const f = await setupFinance();
    const { body } = await create(f);
    const res = await run(f, body.data.id);
    expect(res.status).toBe(200);
    expect(res.body.data.runs).toHaveLength(1);
    expect(res.body.data.runs[0]).toMatchObject({ status: "CREATED", occurrenceDate: today() });

    const [transaction] = await transactionsOf(f);
    expect(transaction).toMatchObject({ status: "DRAFT", source: "RECURRING", amountMinor: 3000000n, createdBy: f.owner.userId });
    expect(transaction?.id).toBe(res.body.data.runs[0].transactionId);
  });

  it("auto-post writes a balanced journal", async () => {
    const f = await setupFinance();
    const { body } = await create(f, { autoPost: true });
    await run(f, body.data.id);
    const [transaction] = await transactionsOf(f);
    expect(transaction?.status).toBe("POSTED");
    const lines = await journalLines(f.base, f.auth, transaction!.journalEntryId!);
    expect(lines).toEqual(expect.arrayContaining([
      { code: "6100", debit: "3000000", credit: "0" },
      expect.objectContaining({ debit: "0", credit: "3000000" }),
    ]));
  });

  it("running again creates nothing more", async () => {
    const f = await setupFinance();
    const { body } = await create(f);
    await run(f, body.data.id);
    await run(f, body.data.id);
    await recurringSchedulesService.runAllDue();
    await Promise.all([recurringSchedulesService.runDue(body.data.id), recurringSchedulesService.runDue(body.data.id)]);
    expect(await transactionsOf(f)).toHaveLength(1);
  });

  it("two workers at the same moment make one transaction", async () => {
    const f = await setupFinance();
    const { body } = await create(f);
    await Promise.all([recurringSchedulesService.runDue(body.data.id), recurringSchedulesService.runDue(body.data.id)]);
    expect(await transactionsOf(f)).toHaveLength(1);
    expect(await prisma.recurringRun.count({ where: { scheduleId: body.data.id } })).toBe(1);
  });

  it("catches up what it missed, each on its own date", async () => {
    const f = await setupFinance();
    const { body } = await create(f, { rrule: "FREQ=MONTHLY;BYMONTHDAY=1" });
    await backdate(body.data.id, "2026-01-01");
    await run(f, body.data.id);

    const dates = (await transactionsOf(f)).map((t) => t.txnDate.toISOString().slice(0, 10));
    expect(dates.slice(0, 3)).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
    expect(dates.every((date) => date <= today())).toBe(true);
    const saved = await prisma.recurringSchedule.findUniqueOrThrow({ where: { id: body.data.id } });
    expect(saved.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("ends itself when the rule runs out", async () => {
    const f = await setupFinance();
    const { body } = await create(f, { rrule: "FREQ=MONTHLY;COUNT=1" });
    await run(f, body.data.id);
    const saved = await prisma.recurringSchedule.findUniqueOrThrow({ where: { id: body.data.id } });
    expect(saved).toMatchObject({ status: "ENDED", nextRunAt: null });
  });

  it("the timer skips paused schedules and closed businesses", async () => {
    const f = await setupFinance();
    const paused = await create(f);
    await api().patch(`${url(f)}/${paused.body.data.id}`).set("Authorization", f.auth).send({ status: "PAUSED" });
    expect(await recurringSchedulesService.runAllDue()).toBe(0);

    await api().patch(`${url(f)}/${paused.body.data.id}`).set("Authorization", f.auth).send({ status: "ACTIVE" });
    const another = await create(f, { name: "Second" });
    await prisma.business.update({ where: { id: f.businessId }, data: { status: "ARCHIVED" } });
    expect(await recurringSchedulesService.runAllDue()).toBe(0);
    expect(another.status).toBe(201);
    expect(await transactionsOf(f)).toHaveLength(0);
  });

  it("resuming looks forward, so paused months aren't made up", async () => {
    const f = await setupFinance();
    const { body } = await create(f, { rrule: "FREQ=MONTHLY;BYMONTHDAY=1" });
    await backdate(body.data.id, "2026-01-01");
    await api().patch(`${url(f)}/${body.data.id}`).set("Authorization", f.auth).send({ status: "PAUSED" });
    const resumed = await api().patch(`${url(f)}/${body.data.id}`).set("Authorization", f.auth).send({ status: "ACTIVE" });
    expect(new Date(resumed.body.data.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    await run(f, body.data.id);
    expect(await transactionsOf(f)).toHaveLength(0);
  });
});

describe("when a run can't succeed", () => {
  it("a closed period is recorded and the person told, and later dates still run", async () => {
    const f = await setupFinance();
    const { body } = await create(f, { autoPost: true, rrule: "FREQ=MONTHLY;BYMONTHDAY=1" });
    await backdate(body.data.id, "2026-07-01");
    await prisma.fiscalPeriod.updateMany({ where: { businessId: f.businessId, startDate: new Date("2026-07-01") }, data: { status: "CLOSED" } });

    const res = await run(f, body.data.id);
    const july = res.body.data.runs.find((r: { occurrenceDate: string }) => r.occurrenceDate === "2026-07-01");
    expect(july).toMatchObject({ status: "FAILED", transactionId: null });
    expect(july.errorCode).toMatch(/PERIOD/);

    const [notification] = await notificationsFor(f.owner.userId, "recurring.failed");
    expect(notification?.params).toMatchObject({ scheduleName: "Office rent", occurrenceDate: "2026-07-01" });

    const dates = (await transactionsOf(f)).map((t) => t.txnDate.toISOString().slice(0, 10));
    expect(dates).toContain("2026-08-01");
    expect(dates).not.toContain("2026-07-01");
  });

  it("if its creator has left, it pauses and tells the owners", async () => {
    const f = await setupFinance();
    const accountant = await addMember(f.owner, f.businessId, "ACCOUNTANT");
    const { body } = await create(f, {}, bearer(accountant));
    await prisma.businessMember.updateMany({ where: { businessId: f.businessId, userId: accountant.userId }, data: { status: "REMOVED" } });
    // Removing someone through the API clears this cache. This test changed the row directly.
    await redis.flushdb();

    await recurringSchedulesService.runDue(body.data.id);

    expect(await transactionsOf(f)).toHaveLength(0);
    expect((await prisma.recurringSchedule.findUniqueOrThrow({ where: { id: body.data.id } })).status).toBe("PAUSED");
    expect(await notificationsFor(f.owner.userId, "recurring.failed")).toHaveLength(1);
  });

  it("if its creator can no longer post, nothing posts", async () => {
    const f = await setupFinance();
    const accountant = await addMember(f.owner, f.businessId, "ACCOUNTANT");
    const { body } = await create(f, { autoPost: true }, bearer(accountant));
    const role = await prisma.role.findFirstOrThrow({ where: { key: "MANAGER" } });
    await prisma.businessMember.updateMany({ where: { businessId: f.businessId, userId: accountant.userId }, data: { roleId: role.id } });
    await redis.flushdb();

    await recurringSchedulesService.runDue(body.data.id);

    expect(await transactionsOf(f)).toHaveLength(0);
    const run = await prisma.recurringRun.findFirstOrThrow({ where: { scheduleId: body.data.id } });
    expect(run).toMatchObject({ status: "FAILED", errorCode: "PERMISSION_DENIED" });
  });

  it("an amount above the approval limit waits for a person", async () => {
    const f = await setupFinance();
    await api().patch(f.base).set("Authorization", f.auth).send({ settings: { approvalThresholdMinor: "1000" } });
    const { body } = await create(f, { autoPost: true });
    await run(f, body.data.id);
    const [transaction] = await transactionsOf(f);
    expect(transaction?.status).toBe("PENDING_APPROVAL");
    expect(transaction?.journalEntryId).toBeNull();
  });
});

describe("salary schedules", () => {
  it("needs no category, and lands on Salaries Expense", async () => {
    const f = await setupFinance();
    const res = await create(f, { kind: "SALARY", name: "Rahim's salary", categoryId: undefined, autoPost: true, amountMinor: "4500000", rrule: "FREQ=MONTHLY;BYMONTHDAY=-1" });
    expect(res.status).toBe(201);
    expect(res.body.data.type).toBe("EXPENSE");

    await backdate(res.body.data.id, today());
    await prisma.recurringSchedule.update({ where: { id: res.body.data.id }, data: { nextRunAt: new Date(Date.now() - 1000) } });
    await run(f, res.body.data.id);
    const [transaction] = await transactionsOf(f);
    const lines = await journalLines(f.base, f.auth, transaction!.journalEntryId!);
    expect(lines).toContainEqual({ code: "6000", debit: "4500000", credit: "0" });
  });

  it("refuses another category", async () => {
    const f = await setupFinance();
    const res = await create(f, { kind: "SALARY", categoryId: f.rentId });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("SALARY_CATEGORY_INVALID");
  });
});

describe("a schedule's automatic reminder", () => {
  const reminderOf = (id: string) => prisma.reminder.findFirst({ where: { sourceType: "RECURRING_SCHEDULE", sourceId: id } });

  it("fires the chosen days ahead at 09:00 local time", async () => {
    const f = await setupFinance();
    const { body } = await create(f, { remindDaysBefore: 3, rrule: "FREQ=MONTHLY;BYMONTHDAY=28" });
    const reminder = await reminderOf(body.data.id);
    expect(reminder).toMatchObject({ title: "Office rent", leadMinutes: 3 * 24 * 60, status: "ACTIVE", recipientUserId: f.owner.userId });
    const local = reminder!.nextOccurrenceAt!.toLocaleTimeString("en-GB", { timeZone: "Asia/Dhaka", hour: "2-digit", minute: "2-digit" });
    expect(local).toBe("09:00");
  });

  it("is absent without remindDaysBefore, and follows pause and resume", async () => {
    const f = await setupFinance();
    const none = await create(f);
    expect(await reminderOf(none.body.data.id)).toBeNull();

    const { body } = await create(f, { name: "With", remindDaysBefore: 1 });
    const patch = (data: object) => api().patch(`${url(f)}/${body.data.id}`).set("Authorization", f.auth).send(data);
    await patch({ status: "PAUSED" });
    expect((await reminderOf(body.data.id))?.status).toBe("CANCELLED");
    await patch({ status: "ACTIVE" });
    expect((await reminderOf(body.data.id))?.status).toBe("ACTIVE");
    await patch({ remindDaysBefore: null });
    expect((await reminderOf(body.data.id))?.status).toBe("CANCELLED");
  });
});

describe("access", () => {
  it("is limited by permission and business", async () => {
    const f = await setupFinance();
    const viewer = await addMember(f.owner, f.businessId, "VIEWER");
    const other = await setupFinance();
    const { body } = await create(f);

    expect((await api().get(url(f)).set("Authorization", bearer(viewer))).status).toBe(403);
    expect((await api().get(url(f)).set("Authorization", other.auth)).status).toBe(404);
    expect((await api().get(`${API}/businesses/${other.businessId}/recurring-schedules/${body.data.id}`).set("Authorization", other.auth)).status).toBe(404);
  });

  it("an ended schedule can't be run or changed", async () => {
    const f = await setupFinance();
    const { body } = await create(f);
    await api().patch(`${url(f)}/${body.data.id}`).set("Authorization", f.auth).send({ status: "ENDED" });
    expect((await run(f, body.data.id)).body.error.code).toBe("SCHEDULE_NOT_ACTIVE");
    expect((await api().patch(`${url(f)}/${body.data.id}`).set("Authorization", f.auth).send({ name: "x" })).status).toBe(409);
  });
});
