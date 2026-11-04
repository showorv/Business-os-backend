import type { Prisma } from "../../lib/prisma.js";

// One counter row per business and name. Its row lock keeps numbers unique under concurrent requests.
export const nextSequence = async (tx: Prisma.TransactionClient, businessId: string, name: string) => {
  const [row] = await tx.$queryRaw<{ value: bigint }[]>`
    INSERT INTO business_sequences (business_id, name, value)
    VALUES (${businessId}::uuid, ${name}, 1)
    ON CONFLICT (business_id, name) DO UPDATE SET value = business_sequences.value + 1
    RETURNING value`;
  return String(row!.value).padStart(6, "0");
};
