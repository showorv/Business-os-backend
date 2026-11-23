import { afterEach, describe, expect, it } from "vitest";
import { addPeriod } from "../src/app/modules/billing/billing.service.js";
import { platformService } from "../src/app/modules/platform/platform.service.js";
import { prisma } from "../src/lib/prisma.js";
import { API, api, bearer, enableMfa, registerUser, type Session } from "./helpers/api.js";

// Paying by hand: the customer sends money by bKash, Nagad, Rocket or bank, tells the app, and a platform
// admin checks it arrived. Approved, it settles exactly like an online payment.

const makeAdmin = async () => {
  const admin = await registerUser();
  await prisma.user.update({ where: { id: admin.userId }, data: { isPlatformAdmin: true } });
  await enableMfa(admin);
  return admin;
};
const as = (session: Session) => ({
  get: (path: string) => api().get(`${API}${path}`).set("Authorization", bearer(session)),
  post: (path: string, body: object = {}) => api().post(`${API}${path}`).set("Authorization", bearer(session)).send(body),
  patch: (path: string, body: object) => api().patch(`${API}${path}`).set("Authorization", bearer(session)).send(body),
});
const workspaceOf = async (session: Session) =>
  (await prisma.userWorkspace.findFirstOrThrow({ where: { userId: session.userId, isDefault: true } })).workspaceId;
const mine = async (session: Session) => (await as(session).get("/billing/me")).body.data;
const pro = () => prisma.plan.findUniqueOrThrow({ where: { key: "pro" } });

const manualSettings = {
  enabled: true,
  methods: [
    { method: "bkash", details: "01712-345678 (Personal)" },
    { method: "bank", details: "Dutch-Bangla Bank, Gulshan branch, account 123.456.7890" },
  ],
  whatsapp: "+8801712345678",
  phone: "",
  email: "billing@example.com",
  noteEn: "We check payments every day from 10am to 8pm.",
  noteBn: "",
};
const turnOn = (admin: Session) => as(admin).patch("/admin/settings", { manualPayments: manualSettings });
const tellPaid = (session: Session, body: Partial<{ planKey: string; billingCycle: string; method: string; reference: string; couponCode: string }> = {}) =>
  as(session).post("/billing/claims", { planKey: "pro", billingCycle: "YEARLY", method: "bkash", reference: "8AB3CD9EF1", ...body });

afterEach(async () => {
  await prisma.platformSetting.deleteMany();
  platformService.forgetCache();
});

describe("how customers pay", () => {
  it("paying by hand is off next to an online gateway until the admin turns it on, with the numbers to send to", async () => {
    const admin = await makeAdmin();
    const owner = await registerUser();

    // Tests run with the demo gateway on, so by hand is only offered once switched on.
    const before = (await as(owner).get("/billing/pay-info")).body.data;
    expect(before).toEqual({ online: true, manual: null });
    const refused = await tellPaid(owner);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("MANUAL_PAYMENTS_OFF");

    expect((await as(admin).patch("/admin/settings", { manualPayments: { ...manualSettings, email: "not an email" } })).status).toBe(422);
    expect((await as(owner).patch("/admin/settings", { manualPayments: manualSettings })).status).toBe(403);
    expect((await turnOn(admin)).status).toBe(200);
    expect((await as(admin).get("/admin/settings")).body.data.manualPayments).toEqual(manualSettings);

    const after = (await as(owner).get("/billing/pay-info")).body.data;
    expect(after.online).toBe(true);
    expect(after.manual.methods).toEqual(manualSettings.methods);
    expect(after.manual.whatsapp).toBe("+8801712345678");
    expect(after.manual.noteEn).toBe(manualSettings.noteEn);
    // The code to write in the reference belongs to this account.
    const workspaceId = await workspaceOf(owner);
    expect(after.manual.reference).toBe(`BOS-${workspaceId.replaceAll("-", "").slice(-8).toUpperCase()}`);

    // Signed out, the numbers aren't shown.
    expect((await api().get(`${API}/billing/pay-info`)).status).toBe(401);
  });
});

describe("a payment told by hand", () => {
  it("the admin hears of it, approves it, and it settles like an online payment: receipt, plan period, revenue", async () => {
    const admin = await makeAdmin();
    await turnOn(admin);
    const owner = await registerUser();
    const workspaceId = await workspaceOf(owner);
    const plan = await pro();
    const trialEnds = new Date((await mine(owner)).endsAt);

    // A transaction ID that isn't plain text is refused.
    expect((await tellPaid(owner, { reference: "<script>" })).status).toBe(422);

    const told = await tellPaid(owner);
    expect(told.status).toBe(201);
    const claim = told.body.data;
    expect(claim).toMatchObject({ status: "PENDING", gateway: "manual", method: "bkash", gatewayRef: "8AB3CD9EF1", amountMinor: String(plan.priceYearlyMinor), receiptNumber: null });

    // One at a time.
    const twice = await tellPaid(owner, { reference: "9ZZ0000000" });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe("PAYMENT_CLAIM_OPEN");
    expect((await mine(owner)).pendingPayment.id).toBe(claim.id);
    // Not paid yet: still on the trial, and it isn't in the list of payments that went somewhere.
    expect((await mine(owner)).state).toBe("trial");

    // Every platform admin is told.
    const heard = await prisma.notification.findFirst({ where: { userId: admin.userId, type: "billing.payment_claim_submitted", entityId: claim.id } });
    expect(heard?.params).toMatchObject({ reference: "8AB3CD9EF1", methodName: "bKash", amount: String(plan.priceYearlyMinor) });

    const waiting = (await as(admin).get("/admin/payments?review=true&pageSize=100")).body.data;
    const row = waiting.items.find((item: { id: string }) => item.id === claim.id);
    expect(row).toMatchObject({ workspaceId, gatewayRef: "8AB3CD9EF1" });
    expect(row.payReference).toMatch(/^BOS-[0-9A-F]{8}$/);
    expect((await as(admin).get("/admin/payments?search=8ab3cd&pageSize=100")).body.data.items.map((item: { id: string }) => item.id)).toContain(claim.id);
    expect((await as(admin).get("/admin/overview")).body.data.paymentsToReview).toBeGreaterThanOrEqual(1);
    const revenueBefore = BigInt((await as(admin).get("/admin/overview")).body.data.revenue.thisMonthMinor);

    // Only an admin can approve.
    expect((await as(owner).post(`/admin/payments/${claim.id}/approve`)).status).toBe(403);

    const approved = await as(admin).post(`/admin/payments/${claim.id}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body.data.status).toBe("PAID");
    expect(approved.body.data.receiptNumber).toMatch(/^BOS-\d{4}-\d{6}$/);
    // The trial's days are kept: the year starts when the trial would have ended.
    expect(new Date(approved.body.data.periodEnd).getTime()).toBe(addPeriod(trialEnds, "YEARLY").getTime());

    const now = await mine(owner);
    expect(now).toMatchObject({ state: "active", source: "PAID", billingCycle: "YEARLY", pendingPayment: null });
    expect(new Date(now.endsAt).getTime()).toBe(addPeriod(trialEnds, "YEARLY").getTime());
    // A receipt, like any paid plan.
    expect(await prisma.notification.findFirst({ where: { userId: owner.userId, type: "billing.payment_received", entityId: claim.id } })).not.toBeNull();
    expect((await as(owner).get(`/billing/payments/${claim.id}`)).body.data.status).toBe("PAID");

    const overview = (await as(admin).get("/admin/overview")).body.data;
    expect(BigInt(overview.revenue.thisMonthMinor) - revenueBefore).toBe(plan.priceYearlyMinor);

    // Approving twice changes nothing.
    const again = await as(admin).post(`/admin/payments/${claim.id}/approve`);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("PAYMENT_NOT_PENDING");

    // In the workspace's history and the admin activity.
    expect(await prisma.auditLog.findFirst({ where: { action: "platform.payment_approved", entityId: claim.id } })).not.toBeNull();
    expect(await prisma.auditLog.findFirst({ where: { action: "billing.payment_claimed", entityId: claim.id } })).not.toBeNull();
  });

  it("rejected, the customer is told why and can tell us again, or take one back", async () => {
    const admin = await makeAdmin();
    await turnOn(admin);
    const owner = await registerUser();

    const claim = (await tellPaid(owner, { billingCycle: "MONTHLY", method: "nagad", reference: "NG7781234" })).body.data;
    const rejected = await as(admin).post(`/admin/payments/${claim.id}/reject`, { reason: "No Nagad payment with this ID" });
    expect(rejected.status).toBe(200);
    expect(rejected.body.data).toMatchObject({ status: "FAILED", failureReason: "No Nagad payment with this ID" });
    expect((await as(admin).post(`/admin/payments/${claim.id}/reject`, { reason: "x" })).status).toBe(422);

    const told = await prisma.notification.findFirst({ where: { userId: owner.userId, type: "billing.payment_rejected", entityId: claim.id } });
    expect(told?.params).toMatchObject({ reason: "No Nagad payment with this ID", reference: "NG7781234" });
    const history = (await as(owner).get("/billing/payments")).body.data;
    expect(history.find((payment: { id: string }) => payment.id === claim.id)).toMatchObject({ status: "FAILED", failureReason: "No Nagad payment with this ID" });
    expect((await mine(owner)).state).toBe("trial");

    // They can tell us again, and take that one back.
    const second = (await tellPaid(owner, { billingCycle: "MONTHLY", method: "nagad", reference: "NG7781299" })).body.data;
    expect(second.status).toBe("PENDING");
    const cancelled = await as(owner).post(`/billing/payments/${second.id}/cancel`);
    expect(cancelled.body.data.status).toBe("CANCELLED");
    expect((await mine(owner)).pendingPayment).toBeNull();
    expect((await as(admin).post(`/admin/payments/${second.id}/approve`)).body.error.code).toBe("PAYMENT_NOT_PENDING");

    // Someone else's can't be taken back.
    const third = (await tellPaid(owner)).body.data;
    const stranger = await registerUser();
    expect((await as(stranger).post(`/billing/payments/${third.id}/cancel`)).status).toBe(404);

    // An online checkout isn't the admin's to approve or reject.
    await prisma.platformSetting.deleteMany();
    platformService.forgetCache();
    const other = await registerUser();
    const online = (await as(other).post("/billing/checkout", { planKey: "pro", billingCycle: "MONTHLY" })).body.data;
    const notManual = await as(admin).post(`/admin/payments/${online.paymentId}/reject`, { reason: "Not ours to check" });
    expect(notManual.status).toBe(409);
    expect(notManual.body.error.code).toBe("PAYMENT_NOT_MANUAL");
  });

  it("the admin records money received another way; it counts and the owner gets a receipt", async () => {
    const admin = await makeAdmin();
    const owner = await registerUser();
    const workspaceId = await workspaceOf(owner);
    const plan = await pro();

    const recorded = await as(admin).post(`/admin/workspaces/${workspaceId}/payments`, { planKey: "pro", billingCycle: "MONTHLY", amountMinor: "50000", method: "cash" });
    expect(recorded.status).toBe(201);
    expect(recorded.body.data).toMatchObject({
      status: "PAID",
      gateway: "manual",
      method: "cash",
      amountMinor: "50000",
      listAmountMinor: String(plan.priceMonthlyMinor),
      discountMinor: String(plan.priceMonthlyMinor - 50000n),
      payReference: expect.stringMatching(/^BOS-/),
    });
    expect(await mine(owner)).toMatchObject({ state: "active", source: "PAID", billingCycle: "MONTHLY" });
    expect(await prisma.notification.findFirst({ where: { userId: owner.userId, type: "billing.payment_received", entityId: recorded.body.data.id } })).not.toBeNull();
    expect(await prisma.auditLog.findFirst({ where: { action: "platform.payment_recorded", entityId: recorded.body.data.id } })).not.toBeNull();

    const free = await as(admin).post(`/admin/workspaces/${workspaceId}/payments`, { planKey: "free", billingCycle: "MONTHLY", amountMinor: "100", method: "cash" });
    expect(free.body.error.code).toBe("PLAN_NOT_FOR_SALE");
    expect((await as(admin).post(`/admin/workspaces/${workspaceId}/payments`, { planKey: "pro", billingCycle: "MONTHLY", amountMinor: "0", method: "cash" })).status).toBe(422);
    expect((await as(owner).post(`/admin/workspaces/${workspaceId}/payments`, { planKey: "pro", billingCycle: "MONTHLY", amountMinor: "50000", method: "cash" })).status).toBe(403);
  });
});
