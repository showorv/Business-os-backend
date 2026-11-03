import { PrismaPg } from "@prisma/adapter-pg";
import { env } from "../app/config/env.config.js";
import { PrismaClient } from "../generated/prisma/client.js";

const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });

// Prisma's defaults (2s to get a connection, 5s per transaction) are too short for a database in a
// far-away region: opening a Neon connection from Bangladesh alone takes about 2s.
export const prisma = new PrismaClient({
  adapter,
  transactionOptions: { maxWait: 10_000, timeout: 20_000 },
});
export type { Prisma } from "../generated/prisma/client.js";
