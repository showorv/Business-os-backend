import dotenv from "dotenv";
import { z } from "zod";

// Tests always use .env.test and override the shell, so they can never reach a real database.
const isTest = process.env.NODE_ENV === "test";
dotenv.config({ path: isTest ? ".env.test" : ".env", override: isTest, quiet: true });

const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);
const optionalString = z.preprocess(emptyToUndefined, z.string().optional());
const optionalUrl = z.preprocess(emptyToUndefined, z.url().optional());

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(5001),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),

    DATABASE_URL: z.url(),
    REDIS_URL: z.url(),

    CORS_ORIGINS: z
      .string()
      .default("")
      .transform((value) => value.split(",").map((origin) => origin.trim()).filter(Boolean)),
    REGISTRATION_ENABLED: z.stringbool().default(true),

    JWT_ACCESS_SECRET: z.string().min(32),
    JWT_MFA_SECRET: z.string().min(32),
    MFA_ENCRYPTION_KEY: z
      .string()
      .refine((value) => Buffer.from(value, "base64").length === 32, "must decode to exactly 32 bytes"),

    ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().min(1).max(15).default(15),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(7).max(30).default(30),
    BCRYPT_COST: z.coerce.number().int().min(4).max(15).default(12),
    COOKIE_DOMAIN: optionalString,

    S3_ENDPOINT: z.url(),
    S3_REGION: z.string().default("us-east-1"),
    S3_ACCESS_KEY: z.string().min(1),
    S3_SECRET_KEY: z.string().min(1),
    S3_BUCKET: z.string().min(3),

    // Containers and CI runners often can't start Chrome's sandbox. Safe here, because the PDF page
    // runs no scripts and loads nothing from outside.
    CHROME_NO_SANDBOX: z.stringbool().default(false),

    SENTRY_DSN: optionalUrl,
    OTEL_EXPORTER_OTLP_ENDPOINT: optionalUrl,
  })
  .superRefine((value, ctx) => {
    if (value.JWT_ACCESS_SECRET === value.JWT_MFA_SECRET) {
      ctx.addIssue({ code: "custom", path: ["JWT_MFA_SECRET"], message: "must differ from JWT_ACCESS_SECRET" });
    }
    if (value.NODE_ENV === "production" && value.BCRYPT_COST < 12) {
      ctx.addIssue({ code: "custom", path: ["BCRYPT_COST"], message: "must be at least 12 in production" });
    }
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // The logger depends on this config, so this is the one place that writes to stderr directly.
  const problems = parsed.error.issues.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`).join("\n");
  process.stderr.write(`Invalid environment configuration:\n${problems}\n`);
  process.exit(1);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === "production";
