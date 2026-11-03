import { defineConfig } from "prisma/config";
import dotenv from "dotenv";
dotenv.config({ quiet: true });
export default defineConfig({
  schema: "prisma/schema",

  migrations: {
    path: "prisma/migrations",
  },

  datasource: {
    // Migrations need a direct connection: poolers such as Neon's break Prisma's advisory lock.
    url: process.env["DIRECT_DATABASE_URL"] ?? process.env["DATABASE_URL"],
  },
});
