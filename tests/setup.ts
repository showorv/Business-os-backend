import { afterAll, beforeAll, beforeEach } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { redis } from "../src/lib/redis.js";
import { resetDatabase } from "./helpers/db.js";

beforeAll(async () => {
  if (redis.status !== "ready") await new Promise((resolve) => redis.once("ready", resolve));
});

beforeEach(async () => {
  await resetDatabase();
  await redis.flushdb();
});

afterAll(async () => {
  await prisma.$disconnect();
  redis.disconnect();
});
