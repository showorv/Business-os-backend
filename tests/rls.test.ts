import { describe, expect, it } from "vitest";
import { auditService } from "../src/app/modules/audit/audit.service.js";
import { prisma } from "../src/lib/prisma.js";
import { withRls } from "../src/lib/rls.js";
import { addMember, API, api, bearer, createBusiness, registerUser, uniqueEmail } from "./helpers/api.js";

const twoBusinesses = async () => {
  const alice = await registerUser();
  const bob = await registerUser();
  const aliceBiz = await createBusiness(alice, "Alice Shop");
  const bobBiz = await createBusiness(bob, "Bob Shop");
  return { alice, bob, aliceBiz, bobBiz };
};

describe("cross-business access through the API", () => {
  it("every route answers 404 for a business the caller is not in", async () => {
    const { alice, bobBiz } = await twoBusinesses();
    const auth = bearer(alice);
    const base = `${API}/businesses/${bobBiz.id}`;

    const responses = await Promise.all([
      api().get(base).set("Authorization", auth),
      api().patch(base).set("Authorization", auth).send({ name: "Hacked" }),
      api().post(`${base}/status`).set("Authorization", auth).send({ status: "ARCHIVED" }),
      api().get(`${base}/members`).set("Authorization", auth),
      api().get(`${base}/invitations`).set("Authorization", auth),
      api().post(`${base}/invitations`).set("Authorization", auth).send({ email: uniqueEmail(), roleKey: "ADMIN" }),
      api().get(`${base}/audit`).set("Authorization", auth),
    ]);

    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    }
    const row = await prisma.business.findUniqueOrThrow({ where: { id: bobBiz.id } });
    expect(row.name).toBe("Bob Shop");
    expect(row.status).toBe("ACTIVE");
  });

  it("gives the same 404 for a real id, a random id and garbage, so ids cannot be probed", async () => {
    const { alice, bobBiz } = await twoBusinesses();
    const codes = await Promise.all(
      [bobBiz.id, "01a1a2e2-f803-7508-9289-da9789e8298e", "not-a-uuid"].map(async (id) => {
        const res = await api().get(`${API}/businesses/${id}`).set("Authorization", bearer(alice));
        return [res.status, res.body.error.code];
      }),
    );
    expect(codes).toEqual([
      [404, "NOT_FOUND"],
      [404, "NOT_FOUND"],
      [404, "NOT_FOUND"],
    ]);
  });

  it("records an attempt on someone else's business", async () => {
    const { alice, bobBiz } = await twoBusinesses();
    await api().get(`${API}/businesses/${bobBiz.id}`).set("Authorization", bearer(alice));
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "business.access_denied" } });
    expect(audit.actorUserId).toBe(alice.userId);
    expect(audit.entityId).toBe(bobBiz.id);
  });

  it("a member of one business cannot reach a member id from another", async () => {
    const { alice, bob, aliceBiz, bobBiz } = await twoBusinesses();
    const bobsMember = await addMember(bob, bobBiz.id, "VIEWER");
    const res = await api()
      .delete(`${API}/businesses/${aliceBiz.id}/members/${bobsMember.memberId}`)
      .set("Authorization", bearer(alice));
    expect(res.status).toBe(404);
    const row = await prisma.businessMember.findUniqueOrThrow({ where: { id: bobsMember.memberId } });
    expect(row.status).toBe("ACTIVE");
  });
});

// These skip the app's checks on purpose and ask PostgreSQL directly, as a buggy query would.
describe("Row-Level Security at the database", () => {
  const scoped = (userId: string, businessIds: string[]) => (work: Parameters<typeof withRls>[1]) =>
    withRls({ userId, businessIds }, work);

  it("runs as a role that cannot bypass RLS", async () => {
    const { alice, aliceBiz } = await twoBusinesses();
    const [row] = await scoped(alice.userId, [aliceBiz.id])((tx) =>
      tx.$queryRaw`SELECT current_user::text AS name, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS super`,
    ) as { name: string; bypass: boolean; super: boolean }[];
    expect(row).toEqual({ name: "business_os_app", bypass: false, super: false });
  });

  it("a query with no WHERE only sees the businesses in scope", async () => {
    const { alice, aliceBiz } = await twoBusinesses();
    const businesses = (await scoped(alice.userId, [aliceBiz.id])((tx) => tx.business.findMany())) as { id: string }[];
    expect(businesses.map((item) => item.id)).toEqual([aliceBiz.id]);

    const members = (await scoped(alice.userId, [aliceBiz.id])((tx) => tx.businessMember.findMany())) as { businessId: string }[];
    expect(members.every((item) => item.businessId === aliceBiz.id)).toBe(true);
    expect(await prisma.business.count()).toBe(2);
  });

  it("an empty scope sees nothing", async () => {
    const { alice } = await twoBusinesses();
    const rows = await scoped(alice.userId, [])((tx) => tx.business.findMany());
    expect(rows).toEqual([]);
  });

  it("looking up another business by id finds nothing, and updating it changes nothing", async () => {
    const { alice, aliceBiz, bobBiz } = await twoBusinesses();
    const result = await scoped(alice.userId, [aliceBiz.id])(async (tx) => ({
      found: await tx.business.findUnique({ where: { id: bobBiz.id } }),
      updated: await tx.business.updateMany({ where: { id: bobBiz.id }, data: { name: "Hacked" } }),
    }));
    expect(result).toEqual({ found: null, updated: { count: 0 } });
    expect((await prisma.business.findUniqueOrThrow({ where: { id: bobBiz.id } })).name).toBe("Bob Shop");
  });

  it("cannot insert a row into another business", async () => {
    const { alice, bob, aliceBiz, bobBiz } = await twoBusinesses();
    await expect(
      scoped(alice.userId, [aliceBiz.id])((tx) =>
        tx.invitation.create({
          data: {
            workspaceId: bobBiz.workspaceId,
            businessId: bobBiz.id,
            email: "x@example.com",
            roleId: "00000000-0000-0000-0000-000000000000",
            tokenHash: "x",
            expiresAt: new Date(),
            createdBy: bob.userId,
          },
        }),
      ),
    ).rejects.toThrow();
    expect(await prisma.invitation.count()).toBe(0);
  });

  it("cannot move its own row into another business", async () => {
    const { alice, aliceBiz, bobBiz } = await twoBusinesses();
    await expect(
      scoped(alice.userId, [aliceBiz.id])((tx) =>
        tx.businessMember.updateMany({ where: { businessId: aliceBiz.id }, data: { businessId: bobBiz.id } }),
      ),
    ).rejects.toThrow();
  });

  it("has no DELETE on business tables, and audit rows cannot be changed", async () => {
    const { alice, aliceBiz } = await twoBusinesses();
    const inScope = scoped(alice.userId, [aliceBiz.id]);
    await expect(inScope((tx) => tx.$executeRaw`DELETE FROM business_members`)).rejects.toThrow(/permission denied/);
    await expect(inScope((tx) => tx.$executeRaw`DELETE FROM businesses`)).rejects.toThrow(/permission denied/);
    await expect(inScope((tx) => tx.$executeRaw`UPDATE audit_logs SET action = 'x'`)).rejects.toThrow(/permission denied/);
    await expect(inScope((tx) => tx.$queryRaw`SELECT id FROM users`)).rejects.toThrow(/permission denied/);
  });

  it("audit rows of other businesses are invisible", async () => {
    const { alice, aliceBiz, bobBiz } = await twoBusinesses();
    const rows = (await scoped(alice.userId, [aliceBiz.id])((tx) => tx.auditLog.findMany())) as { businessId: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.businessId === aliceBiz.id)).toBe(true);
    expect(rows.some((row) => row.businessId === bobBiz.id)).toBe(false);
  });

  it("leaves nothing behind on the connection after the transaction", async () => {
    const { alice, aliceBiz } = await twoBusinesses();
    await scoped(alice.userId, [aliceBiz.id])((tx) => tx.business.findMany());
    const rows = await prisma.$transaction(async (tx) => tx.$queryRaw<{ name: string }[]>`SELECT current_user::text AS name`);
    expect(rows[0]!.name).not.toBe("business_os_app");
    expect(await prisma.business.count()).toBe(2);
  });
});

describe("Row-Level Security on finance tables", () => {
  const TABLES = [
    "financial_accounts",
    "categories",
    "transactions",
    "transaction_attachments",
    "documents",
    "business_sequences",
    "ledger_accounts",
    "fiscal_periods",
    "journal_entries",
    "journal_lines",
    "reconciliations",
    "reconciliation_lines",
    "ledger_monthly_rollups",
    "budgets",
    "budget_lines",
    "budget_alerts",
    "goals",
    "report_exports",
    "outbox_events",
    "exchange_rates",
    "intercompany_transfers",
  ];

  it("every business table has RLS switched on and a policy", async () => {
    const rows = await prisma.$queryRaw<{ tablename: string; rowsecurity: boolean; policies: bigint }[]>`
      SELECT t.tablename, t.rowsecurity,
        (SELECT count(*) FROM pg_policies p WHERE p.tablename = t.tablename) AS policies
      FROM pg_tables t WHERE t.schemaname = 'public'`;

    const expected = [...TABLES, "businesses", "business_members", "invitations", "audit_logs", "idempotency_keys"];
    for (const table of expected) {
      const row = rows.find((item) => item.tablename === table);
      expect(row?.rowsecurity, table).toBe(true);
      expect(Number(row?.policies), table).toBeGreaterThan(0);
    }
  });

  it("a query with no WHERE sees only this business's accounts and categories", async () => {
    const { alice, aliceBiz } = await twoBusinesses();
    const result = await withRls({ userId: alice.userId, businessIds: [aliceBiz.id] }, async (tx) => ({
      accounts: await tx.financialAccount.findMany(),
      categories: await tx.category.findMany(),
    }));
    expect(result.accounts.length).toBe(1);
    expect(result.categories.length).toBeGreaterThan(0);
    expect([...result.accounts, ...result.categories].every((row) => row.businessId === aliceBiz.id)).toBe(true);
    expect(await prisma.financialAccount.count()).toBe(2);
  });

  it("idempotency keys of other users are invisible", async () => {
    const { alice, bob, aliceBiz } = await twoBusinesses();
    await prisma.idempotencyKey.create({
      data: { userId: bob.userId, key: "bobs-key-123", requestHash: "x", statusCode: 201, responseBody: {}, expiresAt: new Date(Date.now() + 1000) },
    });
    const rows = await withRls({ userId: alice.userId, businessIds: [aliceBiz.id] }, (tx) => tx.idempotencyKey.findMany());
    expect(rows).toEqual([]);
  });

  it("cannot delete financial rows", async () => {
    const { alice, aliceBiz } = await twoBusinesses();
    const inScope = (sql: string) =>
      withRls({ userId: alice.userId, businessIds: [aliceBiz.id] }, (tx) => tx.$executeRawUnsafe(sql));
    for (const table of ["financial_accounts", "categories", "transactions", "documents"]) {
      await expect(inScope(`DELETE FROM ${table}`), table).rejects.toThrow(/permission denied/);
    }
  });
});

describe("audit chain across RLS", () => {
  it("stays intact when rows are written from different businesses in one workspace", async () => {
    const owner = await registerUser();
    const first = await createBusiness(owner, "First");
    const second = await createBusiness(owner, "Second");

    // The second business's RLS scope cannot see the first's rows, yet must link to them.
    for (const business of [first, second, first]) {
      const res = await api()
        .patch(`${API}/businesses/${business.id}`)
        .set("Authorization", bearer(owner))
        .send({ name: `${business.name} renamed` });
      expect(res.status).toBe(200);
    }

    const result = await auditService.verifyChain(first.workspaceId);
    expect(result.brokenAtId).toBeNull();
    expect(result.checked).toBe(6);
  });
});

describe("GET /businesses/:id/audit", () => {
  it("shows only this business, and filters by action", async () => {
    const owner = await registerUser();
    const first = await createBusiness(owner, "First");
    const second = await createBusiness(owner, "Second");
    await api().patch(`${API}/businesses/${second.id}`).set("Authorization", bearer(owner)).send({ name: "Renamed" });

    const res = await api().get(`${API}/businesses/${first.id}/audit`).set("Authorization", bearer(owner));
    expect(res.body.data.map((row: { action: string }) => row.action)).toEqual(["business.created"]);

    const filtered = await api()
      .get(`${API}/businesses/${second.id}/audit?action=business.updated`)
      .set("Authorization", bearer(owner));
    expect(filtered.body.data).toHaveLength(1);
  });
});

describe("tasks, reminders and schedules stay inside their business", () => {
  it("the database hides another business's rows, even with no filter", async () => {
    const { alice, bob, aliceBiz, bobBiz } = await twoBusinesses();
    const auth = bearer(alice);
    const base = `${API}/businesses/${aliceBiz.id}`;
    const task = await api().post(`${base}/tasks`).set("Authorization", auth).send({ title: "secret", dueAt: new Date(Date.now() + 86_400_000 * 3).toISOString() });
    await api().post(`${base}/tasks/${task.body.data.id}/comments`).set("Authorization", auth).send({ body: "secret" });

    const seen = await withRls({ userId: bob.userId, workspaceId: bobBiz.workspaceId, businessIds: [bobBiz.id] }, async (tx) => ({
      tasks: await tx.task.findMany(),
      comments: await tx.taskComment.findMany(),
      reminders: await tx.reminder.findMany(),
      schedules: await tx.recurringSchedule.findMany(),
      runs: await tx.recurringRun.findMany(),
    }));
    expect(seen).toEqual({ tasks: [], comments: [], reminders: [], schedules: [], runs: [] });
  });

  it("a row can't be written into another business", async () => {
    const { bob, aliceBiz, bobBiz } = await twoBusinesses();
    await expect(
      withRls({ userId: bob.userId, workspaceId: bobBiz.workspaceId, businessIds: [bobBiz.id] }, (tx) =>
        tx.task.create({ data: { workspaceId: aliceBiz.workspaceId, businessId: aliceBiz.id, title: "x", createdBy: bob.userId } }),
      ),
    ).rejects.toThrow();
  });

  it("a task id from another business is a 404", async () => {
    const { alice, bob, aliceBiz, bobBiz } = await twoBusinesses();
    const task = await api().post(`${API}/businesses/${aliceBiz.id}/tasks`).set("Authorization", bearer(alice)).send({ title: "secret" });
    const res = await api().get(`${API}/businesses/${bobBiz.id}/tasks/${task.body.data.id}`).set("Authorization", bearer(bob));
    expect(res.status).toBe(404);
  });

  it("comments can't be edited or deleted, even by mistake", async () => {
    const { alice, aliceBiz } = await twoBusinesses();
    const base = `${API}/businesses/${aliceBiz.id}/tasks`;
    const task = await api().post(base).set("Authorization", bearer(alice)).send({ title: "x" });
    await api().post(`${base}/${task.body.data.id}/comments`).set("Authorization", bearer(alice)).send({ body: "said" });
    await expect(
      withRls({ userId: alice.userId, workspaceId: aliceBiz.workspaceId, businessIds: [aliceBiz.id] }, (tx) => tx.taskComment.updateMany({ data: { body: "changed" } })),
    ).rejects.toThrow();
  });
});
