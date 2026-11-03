import { execSync } from "node:child_process";
import dotenv from "dotenv";

export default function setup() {
  const { parsed } = dotenv.config({ path: ".env.test", quiet: true });
  const databaseUrl = parsed?.DATABASE_URL ?? "";

  // These tests wipe tables. Never run them against anything but a local *_test database.
  const url = new URL(databaseUrl);
  if (!url.pathname.endsWith("_test") || !["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new Error(`Refusing to run tests against ${url.hostname}${url.pathname}`);
  }

  execSync("npx prisma migrate deploy", {
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: databaseUrl, DIRECT_DATABASE_URL: databaseUrl },
  });
}
