import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { billingService } from "../src/app/modules/billing/billing.service.js";
import { platformService } from "../src/app/modules/platform/platform.service.js";
import { prisma } from "../src/lib/prisma.js";
import { useFakeModel } from "./helpers/ai.js";
import { API, api, bearer, createBusiness, enableMfa, registerUser, uniqueEmail, type Session } from "./helpers/api.js";

const DAY_MS = 86_400_000;
const daysFromNow = (days: number) => new Date(Date.now() + days * DAY_MS);

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

// Plans are seeded by migration and not reset between test files, so put them back as they were.
let seededPlans: Awaited<ReturnType<typeof prisma.plan.findMany>> = [];
beforeAll(async () => {
  seededPlans = await prisma.plan.findMany();
});

afterEach(async () => {
  await prisma.platformSetting.deleteMany();
  platformService.forgetCache();
  await prisma.workspaceSubscription.deleteMany({ where: { planKey: { notIn: seededPlans.map((plan) => plan.key) } } });
  await prisma.plan.deleteMany({ where: { key: { notIn: seededPlans.map((plan) => plan.key) } } });
  for (const { key, createdAt: _createdAt, updatedAt: _updatedAt, ...plan } of seededPlans) await prisma.plan.update({ where: { key }, data: plan });
});

describe("who can open the admin panel", () => {
  it("only a platform admin with two-step verification on", async () => {
    const someone = await registerUser();
    const denied = await as(someone).get("/admin/overview");
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("PLATFORM_ADMIN_ONLY");

    await prisma.user.update({ where: { id: someone.userId }, data: { isPlatformAdmin: true } });
    const noMfa = await as(someone).get("/admin/overview");
    expect(noMfa.body.error.code).toBe("PLATFORM_ADMIN_MFA_REQUIRED");
    expect((await as(someone).get("/users/me")).body.data.isPlatformAdmin).toBe(true);

    await enableMfa(someone);
    const ok = await as(someone).get("/admin/overview");
    expect(ok.status).toBe(200);
    expect(ok.body.data.workspaces.total).toBeGreaterThan(0);
  });
});

describe("managing accounts", () => {
  it("finds an account, gives Pro free until a date, then moves it to Free, all audited", async () => {
    const admin = await makeAdmin();
    const owner = await registerUser();
    await createBusiness(owner, "Rahim Traders");
    const workspaceId = await workspaceOf(owner);
    await prisma.workspaceSubscription.update({ where: { workspaceId }, data: { endsAt: daysFromNow(-1) } });

    const found = await as(admin).get(`/admin/workspaces?search=${encodeURIComponent(owner.email)}&state=expired`);
    expect(found.body.data.items).toHaveLength(1);
    expect(found.body.data.items[0]).toMatchObject({ id: workspaceId, state: "expired", businesses: 1, owner: { email: owner.email } });
    expect((await as(admin).get(`/admin/workspaces?search=Rahim%20Traders`)).body.data.items.map((row: { id: string }) => row.id)).toContain(workspaceId);

    const until = daysFromNow(30).toISOString();
    const granted = await as(admin).post(`/admin/workspaces/${workspaceId}/subscription`, { planKey: "pro", source: "GRANT", endsAt: until, note: "Shop owner from the fair" });
    expect(granted.status).toBe(200);
    expect(granted.body.data).toMatchObject({ state: "granted", subscription: { source: "GRANT", note: "Shop owner from the fair" } });
    expect(await mine(owner)).toMatchObject({ state: "granted", endsAt: until });

    // A trial needs an end date; Free can't be a gift.
    expect((await as(admin).post(`/admin/workspaces/${workspaceId}/subscription`, { planKey: "pro", source: "TRIAL", endsAt: null })).status).toBe(422);
    expect((await as(admin).post(`/admin/workspaces/${workspaceId}/subscription`, { planKey: "free", source: "GRANT", endsAt: null })).status).toBe(400);

    await as(admin).post(`/admin/workspaces/${workspaceId}/subscription`, { planKey: "free", source: "FREE", endsAt: null });
    expect((await mine(owner)).state).toBe("free");

    const detail = (await as(admin).get(`/admin/workspaces/${workspaceId}`)).body.data;
    expect(detail.history.map((row: { action: string }) => row.action)).toEqual(["platform.subscription_changed", "platform.subscription_changed"]);
    expect(detail.history[0].actor.email).toBe(admin.email);
    const activity = (await as(admin).get("/admin/activity")).body.data;
    expect(activity.items[0]).toMatchObject({ action: "platform.subscription_changed", workspaceId });
  });

  it("suspending an account closes its businesses until it's lifted", async () => {
    const admin = await makeAdmin();
    const owner = await registerUser();
    const business = await createBusiness(owner);
    const workspaceId = await workspaceOf(owner);

    expect((await as(admin).post(`/admin/workspaces/${workspaceId}/suspend`, { reason: "Unpaid chargeback" })).body.data.suspendedReason).toBe("Unpaid chargeback");
    const blocked = await as(owner).get(`/businesses/${business.id}`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("WORKSPACE_SUSPENDED");
    expect((await as(admin).get("/admin/workspaces?suspended=true")).body.data.items.map((row: { id: string }) => row.id)).toEqual([workspaceId]);

    await as(admin).post(`/admin/workspaces/${workspaceId}/unsuspend`);
    expect((await as(owner).get(`/businesses/${business.id}`)).status).toBe(200);

    // An admin can't lock themselves out.
    const own = await as(admin).post(`/admin/workspaces/${await workspaceOf(admin)}/suspend`, { reason: "oops" });
    expect(own.status).toBe(409);
  });
});

describe("plans and coupons", () => {
  it("a price change shows on the pricing page and in checkout; Free stays free; hidden plans stay hidden", async () => {
    const admin = await makeAdmin();
    const updated = await as(admin).patch("/admin/plans/pro", { priceMonthlyMinor: "69900", maxBusinesses: 8 });
    expect(updated.body.data).toMatchObject({ priceMonthlyMinor: "69900", maxBusinesses: 8 });
    const plans = (await api().get(`${API}/billing/plans`)).body.data;
    expect(plans.find((plan: { key: string }) => plan.key === "pro")).toMatchObject({ priceMonthlyMinor: "69900", maxBusinesses: 8 });
    const owner = await registerUser();
    expect((await as(owner).post("/billing/checkout", { planKey: "pro", billingCycle: "MONTHLY" })).body.data.amountMinor).toBe("69900");

    expect((await as(admin).patch("/admin/plans/free", { priceMonthlyMinor: "100" })).status).toBe(400);

    const created = await as(admin).post("/admin/plans", {
      key: "business",
      name: "Business",
      nameBn: null,
      description: null,
      descriptionBn: null,
      priceMonthlyMinor: "149900",
      priceYearlyMinor: "1499000",
      maxBusinesses: null,
      maxMembers: 50,
      storageMb: 51200,
      aiEnabled: true,
      aiDailyTokens: 300000,
      isPublic: false,
      sortOrder: 3,
    });
    expect(created.status).toBe(201);
    expect((await api().get(`${API}/billing/plans`)).body.data.map((plan: { key: string }) => plan.key)).toEqual(["free", "pro"]);
    expect((await as(admin).post("/admin/plans", { ...created.body.data, key: "business" })).status).toBe(409);
  });

  it("a coupon takes money off once per redemption, and a 100% coupon needs no payment page", async () => {
    const admin = await makeAdmin();
    const coupon = await as(admin).post("/admin/coupons", { code: "fair50", percentOff: 50, planKeys: ["pro"], maxRedemptions: 1 });
    expect(coupon.status).toBe(201);
    expect(coupon.body.data).toMatchObject({ code: "FAIR50", redemptions: 0 });
    expect((await as(admin).post("/admin/coupons", { code: "both", percentOff: 10, amountOffMinor: "100" })).status).toBe(422);

    const owner = await registerUser();
    const price = await as(owner).post("/billing/price", { planKey: "pro", billingCycle: "YEARLY", couponCode: "Fair50" });
    expect(price.body.data).toMatchObject({ listAmountMinor: "599000", discountMinor: "299500", amountMinor: "299500", couponCode: "FAIR50" });
    expect((await as(owner).post("/billing/price", { planKey: "pro", billingCycle: "YEARLY", couponCode: "NOPE" })).body.error).toMatchObject({ code: "COUPON_INVALID", params: { reason: "not_found" } });

    const { paymentId } = (await as(owner).post("/billing/checkout", { planKey: "pro", billingCycle: "YEARLY", couponCode: "fair50" })).body.data;
    const paid = (await as(owner).post(`/billing/payments/${paymentId}/demo`, { outcome: "PAID" })).body.data;
    expect(paid).toMatchObject({ amountMinor: "299500", discountMinor: "299500", couponCode: "FAIR50" });
    expect((await prisma.coupon.findUniqueOrThrow({ where: { code: "FAIR50" } })).redemptions).toBe(1);

    const second = await registerUser();
    expect((await as(second).post("/billing/checkout", { planKey: "pro", billingCycle: "YEARLY", couponCode: "fair50" })).body.error.params.reason).toBe("used_up");

    await as(admin).post("/admin/coupons", { code: "FRIEND", percentOff: 100 });
    const free = (await as(second).post("/billing/checkout", { planKey: "pro", billingCycle: "MONTHLY", couponCode: "friend" })).body.data;
    expect(free.redirectUrl).toMatch(new RegExp(`/settings/plan\\?payment=${free.paymentId}$`));
    expect(free.amountMinor).toBe("0");
    expect(await mine(second)).toMatchObject({ state: "active", source: "PAID" });
    const receipt = (await as(second).get(`/billing/payments/${free.paymentId}`)).body.data;
    expect(receipt).toMatchObject({ status: "PAID", method: "coupon", gateway: "coupon", amountMinor: "0" });

    // Switched off, it stops working.
    const friend = (await as(admin).get("/admin/coupons")).body.data.find((row: { code: string }) => row.code === "FRIEND");
    await as(admin).patch(`/admin/coupons/${friend.id}`, { active: false });
    expect((await as(owner).post("/billing/price", { planKey: "pro", billingCycle: "MONTHLY", couponCode: "friend" })).body.error.params.reason).toBe("inactive");

    const overview = (await as(admin).get("/admin/overview")).body.data;
    expect(overview.revenue.thisMonthMinor).toBe("299500");
    expect(overview.revenue.payingWorkspaces).toBe(2);
    const payments = (await as(admin).get("/admin/payments?status=PAID")).body.data;
    expect(payments.total).toBe(2);
  });
});

describe("platform settings", () => {
  it("trial length, sign-ups, the AI switch and the announcement", async () => {
    const admin = await makeAdmin();
    expect((await as(admin).get("/admin/settings")).body.data).toMatchObject({ trialDays: 14, graceDays: 7, aiEnabled: true, signupsEnabled: true });

    await as(admin).patch("/admin/settings", { trialDays: 30 });
    const longTrial = await registerUser();
    expect((new Date((await mine(longTrial)).endsAt).getTime() - Date.now()) / DAY_MS).toBeGreaterThan(29.9);
    await as(admin).patch("/admin/settings", { trialDays: 0 });
    expect((await mine(await registerUser())).state).toBe("free");

    // Sign-ups closed, except for someone invited.
    const inviter = await registerUser();
    const business = await createBusiness(inviter);
    const invitedEmail = uniqueEmail();
    await as(inviter).post(`/businesses/${business.id}/invitations`, { email: invitedEmail, roleKey: "VIEWER" });
    await as(admin).patch("/admin/settings", { signupsEnabled: false });
    const closed = await api().post(`${API}/auth/register`).send({ email: uniqueEmail(), password: "correct-horse-battery", name: "Someone" });
    expect(closed.status).toBe(403);
    expect(closed.body.error.code).toBe("SIGNUPS_CLOSED");
    // The public pages see the same: no trial now, and sign-ups closed.
    expect((await api().get(`${API}/platform/signup`)).body.data).toEqual({ trialDays: 0, trialPlanKey: "pro", signupsEnabled: false });
    expect((await api().post(`${API}/auth/register`).send({ email: invitedEmail, password: "correct-horse-battery", name: "Invited" })).status).toBe(201);

    useFakeModel();
    await as(admin).patch("/admin/settings", { aiEnabled: false });
    expect((await as(inviter).get("/ai/status")).body.data.paused).toBe(true);
    const chat = await as(inviter).post("/ai/chat", { message: "How much money do we have?" });
    expect(chat.status).toBe(503);
    expect(chat.body.error.code).toBe("AI_PAUSED");

    expect((await api().get(`${API}/platform/announcement`)).body.data).toBeNull();
    expect((await as(admin).patch("/admin/settings", { announcement: { active: true, tone: "warning", en: "", bn: "" } })).status).toBe(422);
    await as(admin).patch("/admin/settings", { announcement: { active: true, tone: "warning", en: "Maintenance tonight at 11 pm.", bn: "" } });
    expect((await api().get(`${API}/platform/announcement`)).body.data).toEqual({ tone: "warning", en: "Maintenance tonight at 11 pm.", bn: "Maintenance tonight at 11 pm." });

    const actions = (await as(admin).get("/admin/activity")).body.data.items.map((row: { action: string }) => row.action);
    expect(actions.filter((action: string) => action === "platform.settings_updated").length).toBe(5);
  });

  it("grace days come from the settings", async () => {
    const admin = await makeAdmin();
    const owner = await registerUser();
    await prisma.workspaceSubscription.update({ where: { workspaceId: await workspaceOf(owner) }, data: { source: "PAID", endsAt: daysFromNow(-4) } });
    await billingService.invalidateWorkspaceContexts(await workspaceOf(owner));
    expect((await mine(owner)).state).toBe("grace");
    await as(admin).patch("/admin/settings", { graceDays: 3 });
    expect((await mine(owner)).state).toBe("expired");
  });
});
