import type { Request } from "express";
import type { Prisma } from "../../lib/prisma.js";
import { sha256Hex } from "./crypto.js";
import { AppError, ErrorCode } from "./errors.js";
import { bigintToString } from "./money.js";

const KEY_PATTERN = /^[\w-]{8,128}$/;
const TTL_MS = 24 * 60 * 60 * 1000;

export interface IdempotencyRequest {
  key: string;
  requestHash: string;
}

// The Idempotency-Key header is optional. Call after validate().
export const readIdempotencyKey = (req: Request): IdempotencyRequest | null => {
  const key = req.get("idempotency-key");
  if (key === undefined) return null;
  if (!KEY_PATTERN.test(key)) throw new AppError(400, ErrorCode.IDEMPOTENCY_KEY_INVALID);

  return { key, requestHash: sha256Hex(`${req.method} ${req.originalUrl} ${JSON.stringify(req.validated.body)}`) };
};

// Claims the key, runs `work`, and saves its response, all in the caller's transaction:
// - If `work` fails, everything rolls back, so a retry runs it again.
// - If two identical requests race, the second waits on the insert, then gets the first's response.
export const withIdempotency = async <T>(
  tx: Prisma.TransactionClient,
  userId: string,
  request: IdempotencyRequest | null,
  statusCode: number,
  work: () => Promise<T>,
): Promise<{ body: T; statusCode: number; replayed: boolean }> => {
  if (!request) return { body: await work(), statusCode, replayed: false };

  const { key, requestHash } = request;
  const expiresAt = new Date(Date.now() + TTL_MS);

  const claimed = await tx.$queryRaw<unknown[]>`
    INSERT INTO idempotency_keys (user_id, key, request_hash, status_code, response_body, expires_at)
    VALUES (${userId}::uuid, ${key}, ${requestHash}, ${statusCode}, 'null'::jsonb, ${expiresAt})
    ON CONFLICT (user_id, key) DO NOTHING
    RETURNING key`;

  if (claimed.length === 0) {
    const existing = await tx.idempotencyKey.findUniqueOrThrow({ where: { userId_key: { userId, key } } });

    if (existing.expiresAt > new Date()) {
      if (existing.requestHash !== requestHash) throw new AppError(422, ErrorCode.IDEMPOTENCY_KEY_REUSED);
      return { body: existing.responseBody as T, statusCode: existing.statusCode, replayed: true };
    }
    // An expired key can be used again.
    await tx.idempotencyKey.update({ where: { userId_key: { userId, key } }, data: { requestHash, expiresAt } });
  }

  const body = await work();
  await tx.idempotencyKey.update({
    where: { userId_key: { userId, key } },
    data: { statusCode, responseBody: JSON.parse(JSON.stringify(body, bigintToString)) },
  });
  return { body, statusCode, replayed: false };
};
