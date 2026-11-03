import { describe, expect, it } from "vitest";
import { auditService } from "../src/app/modules/audit/audit.service.js";
import { prisma } from "../src/lib/prisma.js";
import { API, api, bearer, registerUser, uniqueEmail } from "./helpers/api.js";

const context = { ip: "2001:DB8:0:0::1", userAgent: "test", requestId: "req-1" };

const expectBlocked = async (run: () => Promise<unknown>) => {
  await expect(run()).rejects.toThrow(/append-only/);
};

describe("audit log immutability", () => {
  it("rejects UPDATE, DELETE and TRUNCATE at the database level", async () => {
    await registerUser();
    await expectBlocked(() => prisma.$executeRawUnsafe(`UPDATE audit_logs SET action = 'tampered'`));
    await expectBlocked(() => prisma.$executeRawUnsafe(`DELETE FROM audit_logs`));
    await expectBlocked(() => prisma.$executeRawUnsafe(`TRUNCATE audit_logs`));
    expect(await prisma.auditLog.count()).toBe(1);
  });
});

describe("audit in the same transaction", () => {
  it("rolls back with the change it describes", async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await auditService.record(tx, { action: "test.rollback", context });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it("does not leave a half-created user when a write fails", async () => {
    const email = uniqueEmail();
    await registerUser(email);
    const workspaces = await prisma.workspace.count();
    const audits = await prisma.auditLog.count();

    const res = await api().post(`${API}/auth/register`).send({ name: "Dup", email, password: "correct-horse-battery" });
    expect(res.status).toBe(409);
    expect(await prisma.workspace.count()).toBe(workspaces);
    expect(await prisma.auditLog.count()).toBe(audits);
  });
});

describe("hash chain", () => {
  it("verifies a clean chain, including IPv6 and reordered JSON", async () => {
    const session = await registerUser();
    const { workspaceId } = await prisma.userWorkspace.findFirstOrThrow({ where: { userId: session.userId } });

    await prisma.$transaction((tx) =>
      auditService.record(tx, {
        action: "test.json",
        context,
        workspaceId,
        after: { zebra: 1, apple: { b: [1, { y: 2, x: 1 }], a: "বাংলা" } },
      }),
    );

    const result = await auditService.verifyChain(workspaceId);
    expect(result.brokenAtId).toBeNull();
    expect(result.checked).toBe(2);
  });

  it("links each row to the one before it", async () => {
    const session = await registerUser();
    await api().patch(`${API}/users/me`).set("Authorization", bearer(session)).send({ name: "Renamed" });
    const [first, second] = await prisma.auditLog.findMany({ orderBy: { id: "asc" } });
    expect(first!.prevHash).toBeNull();
    expect(Buffer.from(second!.prevHash!).equals(Buffer.from(first!.rowHash))).toBe(true);
  });

  it("keeps the chain intact under concurrent writers", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        prisma.$transaction((tx) => auditService.record(tx, { action: `test.concurrent.${index}`, context: null })),
      ),
    );
    const result = await auditService.verifyChain(null);
    expect(result).toMatchObject({ checked: 20, brokenAtId: null });
  });

  it("detects a row edited behind the triggers", async () => {
    const session = await registerUser();
    const { workspaceId } = await prisma.userWorkspace.findFirstOrThrow({ where: { userId: session.userId } });
    await api().patch(`${API}/users/me`).set("Authorization", bearer(session)).send({ name: "Renamed" });

    await prisma.$transaction([
      prisma.$executeRawUnsafe(`ALTER TABLE audit_logs DISABLE TRIGGER USER`),
      prisma.$executeRawUnsafe(`UPDATE audit_logs SET action = 'tampered' WHERE id = 1`),
      prisma.$executeRawUnsafe(`ALTER TABLE audit_logs ENABLE TRIGGER USER`),
    ]);

    const result = await auditService.verifyChain(workspaceId);
    expect(result.brokenAtId).toBe("1");
  });

  it("detects a deleted row", async () => {
    const session = await registerUser();
    const { workspaceId } = await prisma.userWorkspace.findFirstOrThrow({ where: { userId: session.userId } });
    await api().patch(`${API}/users/me`).set("Authorization", bearer(session)).send({ name: "Renamed" });
    await api().patch(`${API}/users/me`).set("Authorization", bearer(session)).send({ name: "Renamed again" });

    await prisma.$transaction([
      prisma.$executeRawUnsafe(`ALTER TABLE audit_logs DISABLE TRIGGER USER`),
      prisma.$executeRawUnsafe(`DELETE FROM audit_logs WHERE id = 2`),
      prisma.$executeRawUnsafe(`ALTER TABLE audit_logs ENABLE TRIGGER USER`),
    ]);

    const result = await auditService.verifyChain(workspaceId);
    expect(result.brokenAtId).toBe("3");
  });
});

describe("GET /audit/me", () => {
  it("returns my own rows, paginated, without hashes", async () => {
    const session = await registerUser();
    for (const name of ["One", "Two"]) {
      await api().patch(`${API}/users/me`).set("Authorization", bearer(session)).send({ name });
    }

    const page = await api().get(`${API}/audit/me?limit=2`).set("Authorization", bearer(session));
    expect(page.status).toBe(200);
    expect(page.body.data).toHaveLength(2);
    expect(page.body.data[0].after).toEqual({ name: "Two" });
    expect(page.body.data[0].before).toEqual({ name: "One" });
    expect(page.body.data[0].rowHash).toBeUndefined();

    const next = await api()
      .get(`${API}/audit/me?limit=2&cursor=${page.body.meta.nextCursor}`)
      .set("Authorization", bearer(session));
    expect(next.body.data).toHaveLength(1);
    expect(next.body.meta.nextCursor).toBeNull();
  });

  it("never shows another user's rows", async () => {
    const alice = await registerUser();
    const bob = await registerUser();
    const res = await api().get(`${API}/audit/me`).set("Authorization", bearer(alice));
    const actors = await prisma.auditLog.findMany({ where: { actorUserId: bob.userId } });
    expect(actors.length).toBeGreaterThan(0);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].action).toBe("auth.registered");
    expect(res.body.data[0].entityId).toBe(alice.userId);
  });

  it("rejects a bad cursor", async () => {
    const session = await registerUser();
    const res = await api().get(`${API}/audit/me?cursor=abc`).set("Authorization", bearer(session));
    expect(res.status).toBe(422);
  });
});
