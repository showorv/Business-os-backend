import { afterEach, describe, expect, it } from "vitest";
import { billingService } from "../src/app/modules/billing/billing.service.js";
import { prisma } from "../src/lib/prisma.js";
import { API, api, bearer, createBusiness, registerUser, uniqueEmail, uploadDocument, type Session } from "./helpers/api.js";
import { useFakeModel } from "./helpers/ai.js";

const DAY_MS = 86_400_000;

const workspaceOf = async (session: Session) =>
  (await prisma.userWorkspace.findFirstOrThrow({ where: { userId: session.userId, isDefault: true } })).workspaceId;

// Moves the workspace's plan as the clock or the admin panel would, then clears cached business contexts.
const setSubscription = async (session: Session, data: { planKey?: string; source?: "FREE" | "TRIAL" | "PAID" | "GRANT"; endsAt?: Date | null }) => {
  const workspaceId = await workspaceOf(session);
  await prisma.workspaceSubscription.update({ where: { workspaceId }, data });
  await billingService.invalidateWorkspaceContexts(workspaceId);
};
const daysFromNow = (days: number) => new Date(Date.now() + days * DAY_MS);

const mine = (session: Session) => api().get(`${API}/billing/me`).set("Authorization", bearer(session));
const invite = (session: Session, businessId: string, email: string) =>
  api().post(`${API}/businesses/${businessId}/invitations`).set("Authorization", bearer(session)).send({ email, roleKey: "VIEWER" });

afterEach(async () => {
  await prisma.workspaceSubscription.deleteMany({ where: { planKey: "tiny" } });
  await prisma.plan.deleteMany({ where: { key: "tiny" } });
});

describe("plans", () => {
  it("lists the public plans without signing in", async () => {
    const res = await api().get(`${API}/billing/plans`);
    expect(res.status).toBe(200);
    const keys = res.body.data.map((plan: { key: string }) => plan.key);
    expect(keys).toEqual(["free", "pro"]);
    const pro = res.body.data[1];
    expect(pro).toMatchObject({ aiEnabled: true, maxBusinesses: 5, priceMonthlyMinor: "59900", priceYearlyMinor: "599000" });
  });

  it("a new sign-up owns its workspace and is on a 14-day Pro trial", async () => {
    const owner = await registerUser();
    const res = await mine(owner);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ state: "trial", source: "TRIAL", isOwner: true, plan: { key: "pro" }, usage: { businesses: 0, members: 0 } });
    const days = (new Date(res.body.data.endsAt).getTime() - Date.now()) / DAY_MS;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThanOrEqual(14);
  });

  it("an invited person sees their own workspace's plan, not the inviter's", async () => {
    const owner = await registerUser();
    const business = await createBusiness(owner);
    const viewer = await registerUser();
    const sent = await invite(owner, business.id, viewer.email);
    await api().post(`${API}/invitations/accept`).set("Authorization", bearer(viewer)).send({ token: sent.body.data.token });

    expect((await mine(owner)).body.data.usage).toMatchObject({ businesses: 1, members: 2 });
    expect((await mine(viewer)).body.data).toMatchObject({ isOwner: true, usage: { businesses: 0 } });
  });
});

describe("when a trial ends", () => {
  it("falls back to Free: one business, and newer ones are read-only until archived", async () => {
    const owner = await registerUser();
    const first = await createBusiness(owner, "First");
    const second = await createBusiness(owner, "Second");
    await setSubscription(owner, { endsAt: daysFromNow(-1) });

    expect((await mine(owner)).body.data).toMatchObject({ state: "expired", plan: { key: "free" }, subscribedPlanKey: "pro" });

    // No third business.
    const third = await api().post(`${API}/businesses`).set("Authorization", bearer(owner)).send({ name: "Third", type: "RETAIL" });
    expect(third.status).toBe(403);
    expect(third.body.error).toMatchObject({ code: "PLAN_LIMIT", params: { limit: "businesses", max: 1, plan: "free" } });

    // The oldest keeps working; the newer one can be read but not changed.
    const firstRead = await api().get(`${API}/businesses/${first.id}`).set("Authorization", bearer(owner));
    expect(firstRead.body.data.plan).toMatchObject({ key: "free", state: "expired", locked: false, aiEnabled: false });
    const secondRead = await api().get(`${API}/businesses/${second.id}`).set("Authorization", bearer(owner));
    expect(secondRead.status).toBe(200);
    expect(secondRead.body.data.plan.locked).toBe(true);

    const edit = await api().patch(`${API}/businesses/${second.id}`).set("Authorization", bearer(owner)).send({ name: "Renamed" });
    expect(edit.status).toBe(403);
    expect(edit.body.error.code).toBe("PLAN_BUSINESS_LOCKED");
    const editFirst = await api().patch(`${API}/businesses/${first.id}`).set("Authorization", bearer(owner)).send({ name: "Renamed" });
    expect(editFirst.status).toBe(200);

    // Archiving is still allowed, and an archived business doesn't count.
    const archived = await api().post(`${API}/businesses/${second.id}/status`).set("Authorization", bearer(owner)).send({ status: "ARCHIVED" });
    expect(archived.status).toBe(200);
    // Bringing it back would go over the limit again.
    const restore = await api().post(`${API}/businesses/${second.id}/status`).set("Authorization", bearer(owner)).send({ status: "ACTIVE" });
    expect(restore.status).toBe(403);
    expect(restore.body.error.code).toBe("PLAN_LIMIT");

    // Paying again (or a grant) unlocks everything; nothing was lost.
    await setSubscription(owner, { source: "GRANT", endsAt: null });
    const again = await api().post(`${API}/businesses/${second.id}/status`).set("Authorization", bearer(owner)).send({ status: "ACTIVE" });
    expect(again.status).toBe(200);
    expect((await mine(owner)).body.data.state).toBe("granted");
  });

  it("a paid plan keeps working for 7 days after it ends", async () => {
    const owner = await registerUser();
    await setSubscription(owner, { source: "PAID", endsAt: daysFromNow(-2) });
    const grace = (await mine(owner)).body.data;
    expect(grace).toMatchObject({ state: "grace", plan: { key: "pro" } });
    expect(new Date(grace.graceEndsAt).getTime()).toBeGreaterThan(Date.now());

    await setSubscription(owner, { endsAt: daysFromNow(-8) });
    expect((await mine(owner)).body.data).toMatchObject({ state: "expired", plan: { key: "free" } });
  });
});

describe("plan limits", () => {
  it("counts each person once for the team limit, pending invitations included", async () => {
    const owner = await registerUser();
    const business = await createBusiness(owner);
    await setSubscription(owner, { planKey: "free", source: "FREE", endsAt: null });

    // Free allows 3 people: the owner and two more.
    const a = uniqueEmail();
    expect((await invite(owner, business.id, a)).status).toBe(201);
    expect((await invite(owner, business.id, uniqueEmail())).status).toBe(201);
    const over = await invite(owner, business.id, uniqueEmail());
    expect(over.status).toBe(403);
    expect(over.body.error).toMatchObject({ code: "PLAN_LIMIT", params: { limit: "members", max: 3 } });
    // Inviting someone already counted again is fine.
    expect((await invite(owner, business.id, a.toUpperCase())).status).toBe(201);
  });

  it("refuses an upload that would go over the plan's storage", async () => {
    const owner = await registerUser();
    const business = await createBusiness(owner);
    await prisma.plan.create({ data: { key: "tiny", name: "Tiny", maxBusinesses: 1, maxMembers: 1, storageMb: 1, isPublic: false } });
    await setSubscription(owner, { planKey: "tiny", source: "GRANT", endsAt: null });

    const base = `${API}/businesses/${business.id}`;
    await uploadDocument(base, bearer(owner));
    const big = await api()
      .post(`${base}/documents/uploads`)
      .set("Authorization", bearer(owner))
      .send({ type: "RECEIPT", fileName: "big.pdf", mime: "application/pdf", sizeBytes: 1024 * 1024 });
    expect(big.status).toBe(403);
    expect(big.body.error).toMatchObject({ code: "PLAN_LIMIT", params: { limit: "storage", max: 1 } });
    // Hidden plans aren't on the pricing page.
    const plans = await api().get(`${API}/billing/plans`);
    expect(plans.body.data.map((plan: { key: string }) => plan.key)).not.toContain("tiny");
  });

  it("the assistant needs a plan with AI", async () => {
    useFakeModel();
    const owner = await registerUser();
    await createBusiness(owner);
    expect((await api().get(`${API}/ai/status`).set("Authorization", bearer(owner))).body.data).toMatchObject({ planAllowsAi: true, dailyTokenLimit: 100000 });

    await setSubscription(owner, { planKey: "free", source: "FREE", endsAt: null });
    const status = await api().get(`${API}/ai/status`).set("Authorization", bearer(owner));
    expect(status.body.data).toMatchObject({ planAllowsAi: false, dailyTokenLimit: 0 });
    const chat = await api().post(`${API}/ai/chat`).set("Authorization", bearer(owner)).send({ message: "How much money do we have?" });
    expect(chat.status).toBe(403);
    expect(chat.body.error).toMatchObject({ code: "PLAN_FEATURE_REQUIRED", params: { feature: "ai" } });
  });
});
