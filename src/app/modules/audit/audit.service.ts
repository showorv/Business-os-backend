import { createHash } from "node:crypto";
import type { Prisma } from "../../../lib/prisma.js";
import { prisma } from "../../../lib/prisma.js";
import { withBusinessScope } from "../../../lib/rls.js";
import type { BusinessContext } from "../members/members.interface.js";
import type { AuditEntry, ChainVerification, IListAuditQuery, IListBusinessAuditQuery } from "./audit.interface.js";

const SYSTEM_CHAIN = "system";

// JSONB does not keep key order, so keys are sorted before hashing.
const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
};

interface HashInput {
  workspaceId: string | null;
  businessId: string | null;
  actorUserId: string | null;
  actorVia: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  requestId: string | null;
  at: Date;
}

const computeHash = (prevHash: Uint8Array | null, row: HashInput) =>
  createHash("sha256")
    .update(prevHash ? Buffer.from(prevHash).toString("hex") : "genesis")
    .update("|")
    .update(JSON.stringify(canonicalize({ ...row, at: row.at.toISOString() })))
    .digest();

const toJson = (value: unknown) =>
  value === undefined || value === null ? null : (JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue);

// Use the text PostgreSQL will store, so the hash still matches when the row is read back.
const canonicalIp = async (tx: Prisma.TransactionClient, ip: string | null) => {
  if (!ip?.includes(":")) return ip;
  const [row] = await tx.$queryRaw<{ ip: string }[]>`SELECT host(${ip}::inet) AS ip`;
  return row?.ip ?? ip;
};

// Call inside the same transaction as the change it describes: both commit or neither does.
const record = async (tx: Prisma.TransactionClient, entry: AuditEntry) => {
  const workspaceId = entry.workspaceId ?? null;

  // One chain per workspace. The lock keeps two writers from linking to the same previous row.
  const chain = workspaceId ?? SYSTEM_CHAIN;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${chain}, 0))`;

  // Through a database function: RLS may hide the row at the head of the chain from this transaction.
  const [head] = await tx.$queryRaw<{ hash: Uint8Array | null }[]>`
    SELECT audit_chain_head(${workspaceId}::uuid) AS hash`;

  const row: HashInput = {
    workspaceId,
    businessId: entry.businessId ?? null,
    actorUserId: entry.actorUserId ?? null,
    actorVia: entry.actorVia ?? "web",
    action: entry.action,
    entityType: entry.entityType ?? null,
    entityId: entry.entityId ?? null,
    before: toJson(entry.before),
    after: toJson(entry.after),
    ip: await canonicalIp(tx, entry.context?.ip ?? null),
    requestId: entry.context?.requestId ?? null,
    at: new Date(),
  };

  const prevHash = head?.hash ?? null;
  const rowHash = computeHash(prevHash, row);

  await tx.auditLog.create({
    data: {
      ...row,
      before: (row.before as Prisma.InputJsonValue | null) ?? undefined,
      after: (row.after as Prisma.InputJsonValue | null) ?? undefined,
      prevHash: prevHash ? Buffer.from(prevHash) : null,
      rowHash: Buffer.from(rowHash),
    },
  });
};

// The usual call inside a business transaction: fills in who and where from the business context.
const recordForBusiness = (
  tx: Prisma.TransactionClient,
  business: BusinessContext,
  entry: Omit<AuditEntry, "workspaceId" | "businessId" | "actorUserId">,
) =>
  record(tx, {
    ...entry,
    workspaceId: business.workspaceId,
    businessId: business.businessId,
    actorUserId: business.userId,
  });

// For events with no other change to commit, such as a failed login.
const recordStandalone = (entry: AuditEntry) => prisma.$transaction((tx) => record(tx, entry));

const LIST_FIELDS = {
  id: true,
  actorUserId: true,
  action: true,
  entityType: true,
  entityId: true,
  before: true,
  after: true,
  ip: true,
  actorVia: true,
  requestId: true,
  at: true,
} as const;

type AuditRow = Prisma.AuditLogGetPayload<{ select: typeof LIST_FIELDS }>;

// Fetch limit + 1 rows: the extra one only says whether another page exists.
const toPage = (rows: AuditRow[], limit: number) => {
  const page = rows.slice(0, limit);
  return {
    items: page.map((row) => ({ ...row, id: row.id.toString() })),
    nextCursor: rows.length > limit ? page.at(-1)!.id.toString() : null,
  };
};

const beforeCursor = (cursor?: string) => (cursor ? { id: { lt: BigInt(cursor) } } : {});

const listForActor = async (userId: string, query: IListAuditQuery) => {
  const rows = await prisma.auditLog.findMany({
    where: { actorUserId: userId, ...beforeCursor(query.cursor) },
    orderBy: { id: "desc" },
    take: query.limit + 1,
    select: LIST_FIELDS,
  });
  return toPage(rows, query.limit);
};

const listForBusiness = async (business: BusinessContext, query: IListBusinessAuditQuery) => {
  const rows = await withBusinessScope(business, (tx) =>
    tx.auditLog.findMany({
      where: {
        businessId: business.businessId,
        ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
        ...(query.action ? { action: query.action } : {}),
        ...beforeCursor(query.cursor),
      },
      orderBy: { id: "desc" },
      take: query.limit + 1,
      select: LIST_FIELDS,
    }),
  );
  return toPage(rows, query.limit);
};

const verifyChain = async (workspaceId: string | null): Promise<ChainVerification> => {
  const BATCH = 500;
  let checked = 0;
  let cursor: bigint | undefined;
  let prevHash: Uint8Array | null = null;

  for (;;) {
    const rows: Awaited<ReturnType<typeof prisma.auditLog.findMany>> = await prisma.auditLog.findMany({
      where: { workspaceId, ...(cursor ? { id: { gt: cursor } } : {}) },
      orderBy: { id: "asc" },
      take: BATCH,
    });
    if (rows.length === 0) return { workspaceId, checked, brokenAtId: null };

    for (const row of rows) {
      const expected = computeHash(prevHash, {
        workspaceId: row.workspaceId,
        businessId: row.businessId,
        actorUserId: row.actorUserId,
        actorVia: row.actorVia,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        before: row.before,
        after: row.after,
        ip: row.ip,
        requestId: row.requestId,
        at: row.at,
      });
      const linksToPrevious =
        (row.prevHash === null && prevHash === null) ||
        (row.prevHash !== null && prevHash !== null && Buffer.from(row.prevHash).equals(Buffer.from(prevHash)));

      if (!linksToPrevious || !expected.equals(Buffer.from(row.rowHash))) {
        return { workspaceId, checked, brokenAtId: row.id.toString() };
      }
      prevHash = row.rowHash;
      checked += 1;
    }
    cursor = rows.at(-1)!.id;
  }
};

const verifyAllChains = async () => {
  const chains = await prisma.auditLog.findMany({ distinct: ["workspaceId"], select: { workspaceId: true } });
  return Promise.all(chains.map(({ workspaceId }) => verifyChain(workspaceId)));
};

export const auditService = {
  record,
  recordForBusiness,
  recordStandalone,
  listForActor,
  listForBusiness,
  verifyChain,
  verifyAllChains,
};
