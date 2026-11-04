import { afterAll, beforeAll, beforeEach, vi } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { redis } from "../src/lib/redis.js";
import { ensureBucket } from "../src/lib/storage.js";
import { resetDatabase } from "./helpers/db.js";

// The real model and OCR take a minute to load, so normal tests use stand-ins. See helpers/fake-models.ts.
// tests/ai-real-models.test.ts and the live evaluation run with the real ones.
if (!process.env.RUN_MODEL_TESTS) {
  vi.doMock("../src/lib/embeddings.js", () => import("./helpers/fake-models.js"));
  vi.doMock("../src/lib/ocr.js", () => import("./helpers/fake-ocr.js"));
}

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
