import { afterAll, beforeAll, beforeEach } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { redis } from "../src/lib/redis.js";
import { ensureBucket } from "../src/lib/storage.js";
import { resetDatabase } from "./helpers/db.js";

beforeAll(async () => {
  if (redis.status !== "ready") await new Promise((resolve) => redis.once("ready", resolve));
  await ensureBucket();
});

beforeEach(async () => {
  await resetDatabase();
  await redis.flushdb();
});

afterAll(async () => {
  await prisma.$disconnect();
  redis.disconnect();
});
