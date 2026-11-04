import { z } from "zod";

export const paginationQuery = {
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.uuid().optional(),
};

// Prisma arguments for "limit rows after the cursor". The extra row only says if a next page exists.
export const pageArgs = ({ limit, cursor }: { limit: number; cursor?: string | undefined }) => ({
  take: limit + 1,
  ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
});

export const toPage = <T extends { id: string }>(rows: T[], limit: number) => {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null };
};
