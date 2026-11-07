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
    // Requests one address may make per minute, across the whole API. Many phones can share one
    // mobile-network address, so raise it if real users see "Too many requests".
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(30).max(100_000).default(300),

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

    // The web app's address, for links in emails.
    APP_URL: z.url().default("http://localhost:5173"),
    // Leave empty to switch email off: deliveries are then recorded as SKIPPED.
    SMTP_URL: optionalUrl,
    EMAIL_FROM: z.string().default("Business OS <no-reply@localhost>"),
    // Generate the pair with: npx web-push generate-vapid-keys. Leave empty to switch push off.
    VAPID_PUBLIC_KEY: optionalString,
    VAPID_PRIVATE_KEY: optionalString,
    VAPID_SUBJECT: z.string().default("mailto:admin@example.com"),
    // Leave empty to switch off the queue screen at /admin/queues. Sign in as "admin".
    BULL_BOARD_PASSWORD: z.preprocess(emptyToUndefined, z.string().min(12).optional()),

    // Any service with an OpenAI-style API. The default is Groq. Leave the key empty to switch the
    // assistant off; document search keeps working, because embeddings run here.
    AI_API_KEY: optionalString,
    AI_BASE_URL: z.url().default("https://api.groq.com/openai/v1"),
    AI_CHAT_MODEL: z.string().default("openai/gpt-oss-120b"),
    AI_DAILY_TOKEN_LIMIT: z.coerce.number().int().positive().default(100_000),
    // Where the embedding model and OCR language data are saved after their first download.
    MODEL_CACHE_DIR: z.string().default(".cache"),
    // A ClamAV daemon. Leave empty to switch malware scanning off: documents then stay NOT_SCANNED.
    CLAMAV_HOST: optionalString,
    CLAMAV_PORT: z.coerce.number().int().positive().default(3310),

    // Who takes payments for plans. "demo" is a pretend payment page for testing: no money moves.
    // SSLCommerz and bKash are added once the merchant accounts exist.
    PAYMENT_GATEWAY: z.enum(["demo"]).default("demo"),
    // The demo page would let anyone get Pro free, so production refuses it unless this is "true".
    PAYMENT_DEMO_IN_PRODUCTION: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),

    SENTRY_DSN: optionalUrl,
    OTEL_EXPORTER_OTLP_ENDPOINT: optionalUrl,
  })
  .superRefine((value, ctx) => {
    if (value.JWT_ACCESS_SECRET === value.JWT_MFA_SECRET) {
      ctx.addIssue({ code: "custom", path: ["JWT_MFA_SECRET"], message: "must differ from JWT_ACCESS_SECRET" });
    }
    if (Boolean(value.VAPID_PUBLIC_KEY) !== Boolean(value.VAPID_PRIVATE_KEY)) {
      ctx.addIssue({ code: "custom", path: ["VAPID_PRIVATE_KEY"], message: "set both VAPID keys, or neither" });
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
