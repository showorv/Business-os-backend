import { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app.js";
import { relayDeliveries, requeueStuckDeliveries } from "../src/app/jobs/deliveryRelay.js";
import { NotificationType } from "../src/app/modules/notifications/notifications.interface.js";
import { notificationsService, sendAfterQuietHours } from "../src/app/modules/notifications/notifications.service.js";
import { renderNotification } from "../src/app/notifications/templates.js";
import { sendEmail } from "../src/lib/mailer.js";
import { prisma } from "../src/lib/prisma.js";
import { QueueName, queues } from "../src/lib/queues.js";
import { closeRealtime } from "../src/lib/realtime.js";
import { withRls } from "../src/lib/rls.js";
import { sendPush } from "../src/lib/webPush.js";
import { addMember, API, api, bearer, createBusiness, registerUser, runPendingEvents, setupFinance, type Session } from "./helpers/api.js";
import { notificationsFor, sendPendingDeliveries } from "./helpers/delivery.js";

vi.mock("../src/lib/mailer.js", () => ({ emailEnabled: vi.fn(() => true), sendEmail: vi.fn(async () => {}) }));
vi.mock("../src/lib/webPush.js", () => ({ pushEnabled: () => true, pushPublicKey: () => "public-key", sendPush: vi.fn(async () => true) }));

const mockedEmail = vi.mocked(sendEmail);
const mockedPush = vi.mocked(sendPush);

beforeEach(() => {
  mockedEmail.mockReset();
  mockedEmail.mockResolvedValue(undefined);
  mockedPush.mockReset();
  mockedPush.mockResolvedValue(true);
});

const get = (session: Session, url: string) => api().get(url).set("Authorization", bearer(session));
const N = `${API}/notifications`;

let serial = 0;
const send = (userId: string, extra: object = {}) =>
  notificationsService.notify([
    { type: NotificationType.GOAL_ACHIEVED, userId, params: { goalId: "g", goalName: "Target" }, dedupeKey: `test:${++serial}`, ...extra },
  ]);

const FCM = "https://fcm.googleapis.com/fcm/send/abc";
const subscribe = (session: Session, endpoint = FCM) =>
  api().post(`${N}/push/subscriptions`).set("Authorization", bearer(session)).send({ endpoint, keys: { p256dh: "key", auth: "secret" } });

describe("the in-app list", () => {
  it("lists, counts and marks as read", async () => {
    const user = await registerUser();
    await send(user.userId);
    await send(user.userId);

    const list = await get(user, N);
    expect(list.status).toBe(200);
    expect(list.body.data.items).toHaveLength(2);
    expect(list.body.data.items[0]).toMatchObject({ type: "goal.achieved", params: { goalName: "Target" }, readAt: null });
    expect((await get(user, `${N}/unread-count`)).body.data.count).toBe(2);

    const read = await api().post(`${N}/${list.body.data.items[0].id}/read`).set("Authorization", bearer(user));
    expect(read.status).toBe(200);
    expect((await get(user, `${N}/unread-count`)).body.data.count).toBe(1);
    expect((await get(user, `${N}?unreadOnly=true`)).body.data.items).toHaveLength(1);

    const all = await api().post(`${N}/read-all`).set("Authorization", bearer(user));
    expect(all.body.data.marked).toBe(1);
    expect((await get(user, `${N}/unread-count`)).body.data.count).toBe(0);
  });

  it("returns a type and values, not a sentence", async () => {
    const user = await registerUser();
    await send(user.userId);
    const [item] = (await get(user, N)).body.data.items;
    expect(item).not.toHaveProperty("subject");
    expect(item).not.toHaveProperty("dedupeKey");
    expect(item).not.toHaveProperty("email");
  });

  it("one person can't see or mark another's", async () => {
    const owner = await registerUser();
    const other = await registerUser();
    await send(owner.userId);
    const [item] = (await get(owner, N)).body.data.items;

    expect((await get(other, N)).body.data.items).toHaveLength(0);
    expect((await api().post(`${N}/${item.id}/read`).set("Authorization", bearer(other))).status).toBe(404);
    expect((await get(other, `${N}/${item.id}/deliveries`)).status).toBe(404);
    expect((await get(owner, `${N}/unread-count`)).body.data.count).toBe(1);
  });

  it("the database itself hides other people's rows", async () => {
    const owner = await registerUser();
    const other = await registerUser();
    await send(owner.userId);
    const seen = await withRls({ userId: other.userId, businessIds: [] }, (tx) => tx.notification.findMany());
    expect(seen).toHaveLength(0);
    const deliveries = await withRls({ userId: other.userId, businessIds: [] }, (tx) => tx.notificationDelivery.findMany());
    expect(deliveries).toHaveLength(0);
  });

  it("the restricted role can't create notifications", async () => {
    const user = await registerUser();
    await expect(
      withRls({ userId: user.userId, businessIds: [] }, (tx) =>
        tx.notification.create({ data: { userId: user.userId, type: "x", params: {}, dedupeKey: "forged" } }),
      ),
    ).rejects.toThrow();
  });

  it("needs signing in", async () => {
    expect((await api().get(N)).status).toBe(401);
  });

  it("email-only messages stay out of the list, so secret values never show", async () => {
    const user = await registerUser();
    await notificationsService.notify([
      { type: NotificationType.PASSWORD_CHANGED, userId: user.userId, params: {}, dedupeKey: `test:${++serial}` },
    ]);
    expect((await get(user, N)).body.data.items).toHaveLength(0);
  });
});

describe("running twice", () => {
  it("the same key notifies once", async () => {
    const user = await registerUser();
    await send(user.userId, { dedupeKey: "same" });
    await send(user.userId, { dedupeKey: "same" });
    expect(await notificationsFor(user.userId)).toHaveLength(1);
  });

  it("sending a delivery twice emails once", async () => {
    const user = await registerUser();
    await send(user.userId);
    const [notification] = await notificationsFor(user.userId);
    const email = notification!.deliveries.find((d) => d.channel === "EMAIL")!;
    await notificationsService.sendDelivery(email.id);
    await notificationsService.sendDelivery(email.id);
    expect(mockedEmail).toHaveBeenCalledTimes(1);
  });
});

describe("email", () => {
  it("is sent in the reader's language", async () => {
    const user = await registerUser();
    await api().patch(`${API}/users/me`).set("Authorization", bearer(user)).send({ locale: "bn-BD" });
    await send(user.userId);
    await sendPendingDeliveries();

    expect(mockedEmail).toHaveBeenCalledTimes(1);
    const [email] = mockedEmail.mock.calls[0]!;
    expect(email.to).toBe(user.email);
    expect(email.subject).toContain("লক্ষ্য পূরণ হয়েছে");
    expect(email.html).toContain('lang="bn-BD"');
  });

  it("records a failure, and the retry can succeed", async () => {
    const user = await registerUser();
    await send(user.userId);
    const [notification] = await notificationsFor(user.userId);
    const email = notification!.deliveries.find((d) => d.channel === "EMAIL")!;

    mockedEmail.mockRejectedValueOnce(Object.assign(new Error("refused"), { code: "ECONNREFUSED" }));
    await expect(notificationsService.sendDelivery(email.id)).rejects.toThrow("refused");
    let saved = await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: email.id } });
    expect(saved).toMatchObject({ status: "PENDING", attempts: 1, lastErrorCode: "ECONNREFUSED" });

    await notificationsService.sendDelivery(email.id);
    saved = await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: email.id } });
    expect(saved).toMatchObject({ status: "SENT", attempts: 2, lastErrorCode: null });
  });

  it("is skipped, not failed, when no mail server is set up", async () => {
    const { emailEnabled } = await import("../src/lib/mailer.js");
    vi.mocked(emailEnabled).mockReturnValueOnce(false);
    const user = await registerUser();
    await send(user.userId);
    await sendPendingDeliveries();
    const [notification] = await notificationsFor(user.userId);
    expect(notification!.deliveries.find((d) => d.channel === "EMAIL")).toMatchObject({ status: "SKIPPED", lastErrorCode: "EMAIL_NOT_CONFIGURED" });
  });

  it("a user's typed text can't inject HTML", () => {
    const { html, text } = renderNotification(
      NotificationType.TASK_ASSIGNED,
      { taskId: "1", title: `<script>alert(1)</script>"><img src=x>` },
      { locale: "en", digitStyle: "latin", grouping: "lakh", businessName: "<b>Shop</b>" },
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>Shop");
    expect(html).toContain("&lt;script&gt;");
    expect(text).toContain("<script>");
  });

  it("money and dates follow the reader's settings", () => {
    const params = { budgetId: "1", budgetName: "Nov", categoryName: "ভাড়া", percent: 80, actualMinor: "12500000", amountMinor: "15000000", currency: "BDT" };
    const bangla = renderNotification(NotificationType.BUDGET_THRESHOLD, params, { locale: "bn-BD", digitStyle: "bangla", grouping: "lakh", businessName: null });
    expect(bangla.subject).toContain("৮০%");
    expect(bangla.text).toContain("৳১,২৫,০০০.০০");
    const english = renderNotification(NotificationType.BUDGET_THRESHOLD, params, { locale: "en", digitStyle: "latin", grouping: "western", businessName: null });
    expect(english.text).toContain("৳125,000.00");
  });
});

describe("preferences", () => {
  it("has sensible defaults, and can be changed", async () => {
    const user = await registerUser();
    expect((await get(user, `${N}/preferences`)).body.data).toMatchObject({ emailEnabled: true, pushEnabled: true, quietHoursStart: null });
    const res = await api().patch(`${N}/preferences`).set("Authorization", bearer(user)).send({ emailEnabled: false, quietHoursStart: "22:00", quietHoursEnd: "08:00" });
    expect(res.status).toBe(200);
    expect((await get(user, `${N}/preferences`)).body.data).toMatchObject({ emailEnabled: false, quietHoursStart: "22:00", quietHoursEnd: "08:00" });
  });

  it("refuses half of a quiet-hours pair, a bad time and a bad timezone", async () => {
    const user = await registerUser();
    const patch = (body: object) => api().patch(`${N}/preferences`).set("Authorization", bearer(user)).send(body);
    expect((await patch({ quietHoursStart: "22:00" })).status).toBe(422);
    expect((await patch({ quietHoursStart: "25:00", quietHoursEnd: "08:00" })).status).toBe(422);
    expect((await patch({ timezone: "Mars/Olympus" })).status).toBe(422);
  });

  it("turning email off skips it, and keeps in-app", async () => {
    const user = await registerUser();
    await api().patch(`${N}/preferences`).set("Authorization", bearer(user)).send({ emailEnabled: false });
    await send(user.userId);
    await sendPendingDeliveries();
    expect(mockedEmail).not.toHaveBeenCalled();
    const [notification] = await notificationsFor(user.userId);
    expect(notification!.deliveries.find((d) => d.channel === "EMAIL")).toMatchObject({ status: "SKIPPED", lastErrorCode: "DISABLED_BY_USER" });
    expect(notification!.deliveries.find((d) => d.channel === "IN_APP")).toMatchObject({ status: "SENT" });
  });

  it("security emails ignore the setting", async () => {
    const user = await registerUser();
    await api().patch(`${N}/preferences`).set("Authorization", bearer(user)).send({ emailEnabled: false, quietHoursStart: "00:00", quietHoursEnd: "23:59" });
    await notificationsService.notify([{ type: NotificationType.ACCOUNT_LOCKED, userId: user.userId, params: {}, dedupeKey: `test:${++serial}` }]);
    await sendPendingDeliveries();
    expect(mockedEmail).toHaveBeenCalledTimes(1);
  });
});

describe("quiet hours", () => {
  const preferences = { quietHoursStart: "22:00", quietHoursEnd: "08:00", timezone: "Asia/Dhaka" };
  // 09:00 and 23:00 in Dhaka.
  const morning = new Date("2026-11-05T03:00:00.000Z");
  const night = new Date("2026-11-05T17:00:00.000Z");

  it("sends now outside them", () => {
    expect(sendAfterQuietHours(preferences, morning)).toEqual(morning);
  });

  it("waits until they end, across midnight", () => {
    expect(sendAfterQuietHours(preferences, night).toISOString()).toBe("2026-11-06T02:00:00.000Z");
  });

  it("handles a window within one day", () => {
    const lunch = { ...preferences, quietHoursStart: "08:00", quietHoursEnd: "10:00" };
    expect(sendAfterQuietHours(lunch, morning).toISOString()).toBe("2026-11-05T04:00:00.000Z");
  });

  it("email waits but in-app doesn't", async () => {
    const user = await registerUser();
    await api().patch(`${N}/preferences`).set("Authorization", bearer(user)).send({ quietHoursStart: "00:00", quietHoursEnd: "23:59" });
    await send(user.userId);
    expect(await sendPendingDeliveries()).toBe(0);
    expect(mockedEmail).not.toHaveBeenCalled();
    expect((await get(user, `${N}/unread-count`)).body.data.count).toBe(1);
  });
});

describe("push", () => {
  it("saves a subscription and sends to it", async () => {
    const user = await registerUser();
    expect((await get(user, `${N}/push/config`)).body.data).toEqual({ enabled: true, publicKey: "public-key" });
    expect((await subscribe(user)).status).toBe(201);
    await send(user.userId);
    await sendPendingDeliveries();

    expect(mockedPush).toHaveBeenCalledTimes(1);
    const [target, payload] = mockedPush.mock.calls[0]!;
    expect(target.endpoint).toBe(FCM);
    expect(payload).toMatchObject({ title: expect.stringContaining("Target") });
  });

  it("is skipped with no subscription", async () => {
    const user = await registerUser();
    await send(user.userId);
    const [notification] = await notificationsFor(user.userId);
    expect(notification!.deliveries.find((d) => d.channel === "PUSH")).toMatchObject({ status: "SKIPPED", lastErrorCode: "NO_SUBSCRIPTION" });
    expect(mockedPush).not.toHaveBeenCalled();
  });

  it("forgets a browser that has gone away", async () => {
    const user = await registerUser();
    await subscribe(user);
    mockedPush.mockResolvedValueOnce(false);
    await send(user.userId);
    await sendPendingDeliveries();
    expect((await get(user, `${N}/push/subscriptions`)).body.data).toHaveLength(0);
  });

  it("only accepts real push services, so it can't reach the internal network", async () => {
    const user = await registerUser();
    for (const endpoint of ["http://fcm.googleapis.com/x", "https://169.254.169.254/latest", "https://localhost/x", "https://fcm.googleapis.com.evil.com/x"]) {
      expect((await subscribe(user, endpoint)).status).toBe(422);
    }
    expect((await subscribe(user, "https://updates.push.services.mozilla.com/wpush/v2/abc")).status).toBe(201);
    expect((await subscribe(user, "https://web.push.apple.com/abc")).status).toBe(201);
  });

  it("a shared browser belongs to whoever signed in last", async () => {
    const first = await registerUser();
    const second = await registerUser();
    await subscribe(first);
    await subscribe(second);
    expect((await get(first, `${N}/push/subscriptions`)).body.data).toHaveLength(0);
    expect((await get(second, `${N}/push/subscriptions`)).body.data).toHaveLength(1);
  });

  it("a subscription can be removed only by its owner", async () => {
    const user = await registerUser();
    const other = await registerUser();
    const { body } = await subscribe(user);
    const remove = (session: Session) => api().delete(`${N}/push/subscriptions/${body.data.id}`).set("Authorization", bearer(session));
    expect((await remove(other)).status).toBe(404);
    expect((await remove(user)).status).toBe(200);
  });
});

describe("the delivery relay", () => {
  it("queues what's due once, and leaves what isn't", async () => {
    const queue = queues[QueueName.NOTIFICATIONS];
    await queue.obliterate({ force: true });
    const user = await registerUser();
    await send(user.userId);
    await prisma.notificationDelivery.create({
      data: { notificationId: (await notificationsFor(user.userId))[0]!.id, userId: user.userId, channel: "PUSH", sendAfter: new Date(Date.now() + 60_000) },
    }).catch(() => {});

    expect(await relayDeliveries()).toBe(1);
    expect(await relayDeliveries()).toBe(0);
    expect(await queue.getWaitingCount()).toBe(1);
    await queue.obliterate({ force: true });
  });

  it("puts back sends lost when Redis was emptied", async () => {
    const queue = queues[QueueName.NOTIFICATIONS];
    await queue.obliterate({ force: true });
    const user = await registerUser();
    await send(user.userId);
    await relayDeliveries();
    await queue.obliterate({ force: true });

    expect(await requeueStuckDeliveries()).toBe(0);
    await prisma.notificationDelivery.updateMany({ where: { status: "QUEUED" }, data: { queuedAt: new Date(Date.now() - 60 * 60 * 1000) } });
    expect(await requeueStuckDeliveries()).toBe(1);
    expect(await queue.getWaitingCount()).toBe(1);
    await queue.obliterate({ force: true });
  });
});

describe("the live stream", () => {
  let server: Server;
  let base: string;

  beforeEach(async () => {
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    closeRealtime();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const open = async (session: Session) => {
    const controller = new AbortController();
    const res = await fetch(`${base}${N}/stream`, { headers: { Authorization: bearer(session) }, signal: controller.signal });
    return { res, controller, reader: res.body!.getReader() };
  };

  const readUntil = async (reader: ReadableStreamDefaultReader<Uint8Array>, text: string) => {
    const decoder = new TextDecoder();
    let received = "";
    while (!received.includes(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value);
    }
    return received;
  };

  it("pushes a new notification straight away, only to its owner", async () => {
    const user = await registerUser();
    const other = await registerUser();
    const stream = await open(user);
    const otherStream = await open(other);
    expect(stream.res.headers.get("content-type")).toContain("text/event-stream");
    await readUntil(stream.reader, "connected");
    await readUntil(otherStream.reader, "connected");
    // Give the subscription a moment to reach Redis.
    await new Promise((resolve) => setTimeout(resolve, 100));

    await send(user.userId);
    const received = await readUntil(stream.reader, "goal.achieved");
    expect(received).toContain("event: notification");
    expect(received).toContain("Target");

    let otherGotIt = false;
    void otherStream.reader.read().then(({ value }) => {
      otherGotIt = new TextDecoder().decode(value).includes("goal.achieved");
    }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(otherGotIt).toBe(false);

    stream.controller.abort();
    otherStream.controller.abort();
  });

  it("needs signing in, and limits how many one person can hold", async () => {
    expect((await fetch(`${base}${N}/stream`)).status).toBe(401);

    const user = await registerUser();
    const streams = [];
    for (let i = 0; i < 5; i += 1) streams.push(await open(user));
    expect((await fetch(`${base}${N}/stream`, { headers: { Authorization: bearer(user) } })).status).toBe(429);
    for (const stream of streams) stream.controller.abort();
  });
});

describe("what people get told about", () => {
  it("approvers hear about a transaction waiting for them, but not its submitter", async () => {
    const f = await setupFinance();
    const accountant = await addMember(f.owner, f.businessId, "ACCOUNTANT");
    await api().patch(`${f.base}`).set("Authorization", f.auth).send({ settings: { approvalThresholdMinor: "1000" } });

    const res = await api().post(`${f.base}/transactions`).set("Authorization", bearer(accountant)).send({
      postNow: true, type: "EXPENSE", accountId: f.bankId, categoryId: f.rentId, amountMinor: "5000", txnDate: "2026-11-05",
    });
    expect(res.body.data.status).toBe("PENDING_APPROVAL");
    await runPendingEvents();

    const [notification] = await notificationsFor(f.owner.userId, "transaction.pending_approval");
    expect(notification?.params).toMatchObject({ amountMinor: "5000", currency: "BDT", number: res.body.data.number });
    expect(await notificationsFor(accountant.userId, "transaction.pending_approval")).toHaveLength(0);
  });

  it("a budget threshold and a goal reach people who can see finance, once", async () => {
    const f = await setupFinance();
    const viewer = await addMember(f.owner, f.businessId, "VIEWER");
    const post = (path: string, body: object) => api().post(`${f.base}${path}`).set("Authorization", f.auth).send(body);
    await post("/budgets", { name: "Nov", startMonth: "2026-11", endMonth: "2026-11", lines: [{ categoryId: f.rentId, amountMinor: "1000", alertPercent: 80 }] });
    await post("/goals", { name: "Sell", metric: "REVENUE", targetMinor: "100", startMonth: "2026-11", endMonth: "2026-11" });

    await post("/transactions", { postNow: true, type: "EXPENSE", accountId: f.bankId, categoryId: f.rentId, amountMinor: "900", txnDate: "2026-11-05" });
    await post("/transactions", { postNow: true, type: "INCOME", accountId: f.bankId, categoryId: f.salesId, amountMinor: "500", txnDate: "2026-11-05" });
    await runPendingEvents();
    await runPendingEvents();

    const budget = await notificationsFor(f.owner.userId, "budget.threshold");
    expect(budget).toHaveLength(1);
    expect(budget[0]!.params).toMatchObject({ percent: 80, actualMinor: "900", amountMinor: "1000", budgetName: "Nov" });
    expect(await notificationsFor(f.owner.userId, "goal.achieved")).toHaveLength(1);
    // A viewer has no finance.read unless granted it.
    expect(await notificationsFor(viewer.userId, "budget.threshold")).toHaveLength(0);
  });

  it("an invitation is emailed, with a link that works", async () => {
    const owner = await registerUser();
    const business = await createBusiness(owner, "Dhaka Traders");
    const invited = await registerUser();
    const res = await api().post(`${API}/businesses/${business.id}/invitations`).set("Authorization", bearer(owner)).send({ email: invited.email, roleKey: "MANAGER" });
    await runPendingEvents();
    await sendPendingDeliveries();

    expect(mockedEmail).toHaveBeenCalledTimes(1);
    const [email] = mockedEmail.mock.calls[0]!;
    expect(email.to).toBe(invited.email);
    expect(email.subject).toContain("Dhaka Traders");
    const token = decodeURIComponent(/token=([^\s"&]+)/.exec(email.text)![1]!);
    expect(token).toBe(res.body.data.token);

    // Stored encrypted, so reading the tables doesn't reveal the link.
    const stored = await prisma.notification.findFirstOrThrow({ where: { type: "invitation" } });
    expect(JSON.stringify(stored.params)).not.toContain(token);
    const event = await prisma.outboxEvent.findFirstOrThrow({ where: { type: "invitation.created" } });
    expect(JSON.stringify(event.payload)).not.toContain(token);

    const accepted = await api().post(`${API}/invitations/accept`).set("Authorization", bearer(invited)).send({ token });
    expect(accepted.status).toBe(200);
  });

  it("an invitation replaced before sending isn't emailed", async () => {
    const owner = await registerUser();
    const business = await createBusiness(owner);
    const post = () => api().post(`${API}/businesses/${business.id}/invitations`).set("Authorization", bearer(owner)).send({ email: "new@example.com", roleKey: "MANAGER" });
    await post();
    await post();
    await runPendingEvents();
    await sendPendingDeliveries();
    expect(mockedEmail).toHaveBeenCalledTimes(1);
  });
});
