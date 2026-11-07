import { describe, expect, it } from "vitest";
import { addPeriod, billingService } from "../src/app/modules/billing/billing.service.js";
import { prisma } from "../src/lib/prisma.js";
import { API, api, bearer, createBusiness, registerUser, type Session } from "./helpers/api.js";

const DAY_MS = 86_400_000;
const daysFromNow = (days: number) => new Date(Date.now() + days * DAY_MS);

const workspaceOf = async (session: Session) =>
  (await prisma.userWorkspace.findFirstOrThrow({ where: { userId: session.userId, isDefault: true } })).workspaceId;
const setSubscription = async (session: Session, data: { planKey?: string; source?: "FREE" | "TRIAL" | "PAID" | "GRANT"; endsAt?: Date | null }) => {
  const workspaceId = await workspaceOf(session);
  await prisma.workspaceSubscription.update({ where: { workspaceId }, data });
  await billingService.invalidateWorkspaceContexts(workspaceId);
};

const checkout = (session: Session, body: object) => api().post(`${API}/billing/checkout`).set("Authorization", bearer(session)).send(body);
const answer = (session: Session, paymentId: string, outcome: string, method = "bkash") =>
  api().post(`${API}/billing/payments/${paymentId}/demo`).set("Authorization", bearer(session)).send({ outcome, method });
const mine = async (session: Session) => (await api().get(`${API}/billing/me`).set("Authorization", bearer(session))).body.data;

describe("paying for a plan with the demo gateway", () => {
  it("paying during the trial adds a year after the trial, with a receipt and an email", async () => {
    const owner = await registerUser();
    const trialEnds = new Date((await mine(owner)).endsAt);

    const started = await checkout(owner, { planKey: "pro", billingCycle: "YEARLY", amountMinor: "1" });
    expect(started.status).toBe(201);
    // The price is the plan's, whatever the browser sends.
    expect(started.body.data).toMatchObject({ amountMinor: "599000", currency: "BDT" });
    expect(started.body.data.redirectUrl).toMatch(new RegExp(`/pay/demo/${started.body.data.paymentId}$`));
    const paymentId = started.body.data.paymentId as string;

    const paid = await answer(owner, paymentId, "PAID");
    expect(paid.status).toBe(200);
    expect(paid.body.data).toMatchObject({ status: "PAID", method: "bkash", planName: "Pro", billedTo: { email: owner.email } });
    expect(paid.body.data.receiptNumber).toMatch(/^BOS-\d{4}-\d{6}$/);
    expect(paid.body.data.periodStart).toBe(trialEnds.toISOString());
    expect(paid.body.data.periodEnd).toBe(addPeriod(trialEnds, "YEARLY").toISOString());

    expect(await mine(owner)).toMatchObject({ state: "active", source: "PAID", billingCycle: "YEARLY", endsAt: paid.body.data.periodEnd });
    const notes = await prisma.notification.findMany({ where: { userId: owner.userId, type: "billing.payment_received" } });
    expect(notes).toHaveLength(1);

    // The same answer twice changes nothing; a different one is refused.
    expect((await answer(owner, paymentId, "PAID")).body.data.receiptNumber).toBe(paid.body.data.receiptNumber);
    const late = await answer(owner, paymentId, "FAILED");
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("PAYMENT_NOT_PENDING");

    const list = await api().get(`${API}/billing/payments`).set("Authorization", bearer(owner));
    expect(list.body.data.map((row: { id: string }) => row.id)).toEqual([paymentId]);
  });

  it("a failed or cancelled payment leaves the plan as it was, and both show in the history", async () => {
    const owner = await registerUser();
    const before = await mine(owner);
    const first = (await checkout(owner, { planKey: "pro", billingCycle: "MONTHLY" })).body.data;
    expect(first.amountMinor).toBe("59900");
    expect((await answer(owner, first.paymentId, "FAILED")).body.data).toMatchObject({ status: "FAILED", failureReason: "declined", receiptNumber: null });
    const second = (await checkout(owner, { planKey: "pro", billingCycle: "MONTHLY" })).body.data;
    expect((await answer(owner, second.paymentId, "CANCELLED")).body.data.status).toBe("CANCELLED");
    // A checkout that was never finished isn't listed.
    await checkout(owner, { planKey: "pro", billingCycle: "MONTHLY" });

    expect(await mine(owner)).toMatchObject({ state: "trial", endsAt: before.endsAt });
    const list = await api().get(`${API}/billing/payments`).set("Authorization", bearer(owner));
    expect(list.body.data.map((row: { status: string }) => row.status)).toEqual(["CANCELLED", "FAILED"]);
  });

  it("after the trial ended, paying starts now and unlocks every business", async () => {
    const owner = await registerUser();
    await createBusiness(owner, "First");
    const second = await createBusiness(owner, "Second");
    await setSubscription(owner, { endsAt: daysFromNow(-3) });
    const locked = await api().patch(`${API}/businesses/${second.id}`).set("Authorization", bearer(owner)).send({ name: "Renamed" });
    expect(locked.body.error.code).toBe("PLAN_BUSINESS_LOCKED");

    const { paymentId } = (await checkout(owner, { planKey: "pro", billingCycle: "MONTHLY" })).body.data;
    const paid = (await answer(owner, paymentId, "PAID")).body.data;
    const started = new Date(paid.periodStart).getTime();
    expect(Math.abs(started - Date.now())).toBeLessThan(60_000);

    const edit = await api().patch(`${API}/businesses/${second.id}`).set("Authorization", bearer(owner)).send({ name: "Renamed" });
    expect(edit.status).toBe(200);
    expect((await mine(owner)).state).toBe("active");
  });

  it("refuses what can't be bought, and other people's payments", async () => {
    const owner = await registerUser();
    expect((await checkout(owner, { planKey: "free", billingCycle: "MONTHLY" })).body.error.code).toBe("PLAN_NOT_FOR_SALE");
    expect((await checkout(owner, { planKey: "gold", billingCycle: "MONTHLY" })).body.error.code).toBe("PLAN_NOT_FOR_SALE");

    const { paymentId } = (await checkout(owner, { planKey: "pro", billingCycle: "MONTHLY" })).body.data;
    const stranger = await registerUser();
    expect((await api().get(`${API}/billing/payments/${paymentId}`).set("Authorization", bearer(stranger))).status).toBe(404);
    expect((await answer(stranger, paymentId, "PAID")).status).toBe(404);

    // Pro given free for good: nothing to pay for.
    await setSubscription(owner, { source: "GRANT", endsAt: null });
    expect((await checkout(owner, { planKey: "pro", billingCycle: "YEARLY" })).body.error.code).toBe("BILLING_NOT_NEEDED");

    // Only the account's owner pays.
    await prisma.workspace.update({ where: { id: await workspaceOf(stranger) }, data: { ownerUserId: null } });
    const notOwner = await checkout(stranger, { planKey: "pro", billingCycle: "YEARLY" });
    expect(notOwner.status).toBe(403);
    expect(notOwner.body.error.code).toBe("BILLING_OWNER_ONLY");
  });

  it("a checkout left open too long can't be paid", async () => {
    const owner = await registerUser();
    const before = await mine(owner);
    const { paymentId } = (await checkout(owner, { planKey: "pro", billingCycle: "MONTHLY" })).body.data;
    await prisma.payment.update({ where: { id: paymentId }, data: { expiresAt: daysFromNow(-1) } });
    const late = await answer(owner, paymentId, "PAID");
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("PAYMENT_EXPIRED");
    expect((await mine(owner)).endsAt).toBe(before.endsAt);
  });
});

describe("plan reminders", () => {
  it("warns before a trial ends, once, and says when a paid plan is in its grace days", async () => {
    const trial = await registerUser();
    await setSubscription(trial, { endsAt: daysFromNow(2.5) });
    const paid = await registerUser();
    await setSubscription(paid, { source: "PAID", endsAt: daysFromNow(-2) });

    await billingService.sendPlanReminders();
    await billingService.sendPlanReminders();

    const ending = await prisma.notification.findMany({ where: { userId: trial.userId, type: "billing.plan_ending" } });
    expect(ending).toHaveLength(1);
    expect(ending[0]!.params).toMatchObject({ stage: "trial", days: 3, planName: "Pro" });
    const ended = await prisma.notification.findMany({ where: { userId: paid.userId, type: "billing.plan_ended" } });
    expect(ended).toHaveLength(1);
    expect(ended[0]!.params).toMatchObject({ stage: "grace" });

    // One day left is a new reminder.
    await setSubscription(trial, { endsAt: daysFromNow(0.5) });
    await billingService.sendPlanReminders();
    expect(await prisma.notification.count({ where: { userId: trial.userId, type: "billing.plan_ending" } })).toBe(2);
  });

  it("a month after 31 January is the end of February", () => {
    expect(addPeriod(new Date("2027-01-31T10:00:00Z"), "MONTHLY").toISOString()).toBe("2027-02-28T10:00:00.000Z");
    expect(addPeriod(new Date("2028-02-29T10:00:00Z"), "YEARLY").toISOString()).toBe("2029-02-28T10:00:00.000Z");
  });
});
