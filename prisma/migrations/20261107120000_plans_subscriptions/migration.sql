-- Phase 11.1: plans, one subscription per workspace, and who owns each workspace.
-- These are platform tables: only the server's own connection reads them, never the restricted app role,
-- so they have no row-level security and no grants to business_os_app.

CREATE TYPE "SubscriptionSource" AS ENUM ('FREE', 'TRIAL', 'PAID', 'GRANT');
CREATE TYPE "BillingCycle" AS ENUM ('MONTHLY', 'YEARLY');

CREATE TABLE "plans" (
    "key" VARCHAR(40) NOT NULL,
    "name" TEXT NOT NULL,
    "name_bn" TEXT,
    "description" TEXT,
    "description_bn" TEXT,
    "currency" CHAR(3) NOT NULL DEFAULT 'BDT',
    "price_monthly_minor" BIGINT NOT NULL DEFAULT 0,
    "price_yearly_minor" BIGINT NOT NULL DEFAULT 0,
    "max_businesses" INTEGER,
    "max_members" INTEGER,
    "storage_mb" INTEGER,
    "ai_enabled" BOOLEAN NOT NULL DEFAULT false,
    "ai_daily_tokens" INTEGER NOT NULL DEFAULT 0,
    "is_public" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "plans_pkey" PRIMARY KEY ("key"),
    CONSTRAINT "plans_prices_not_negative" CHECK ("price_monthly_minor" >= 0 AND "price_yearly_minor" >= 0),
    CONSTRAINT "plans_limits_positive" CHECK (
      ("max_businesses" IS NULL OR "max_businesses" >= 1) AND
      ("max_members" IS NULL OR "max_members" >= 1) AND
      ("storage_mb" IS NULL OR "storage_mb" >= 0) AND
      "ai_daily_tokens" >= 0)
);

CREATE TABLE "workspace_subscriptions" (
    "workspace_id" UUID NOT NULL,
    "plan_key" VARCHAR(40) NOT NULL,
    "source" "SubscriptionSource" NOT NULL,
    "billing_cycle" "BillingCycle",
    "ends_at" TIMESTAMPTZ(3),
    "note" TEXT,
    "granted_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "workspace_subscriptions_pkey" PRIMARY KEY ("workspace_id")
);
CREATE INDEX "workspace_subscriptions_ends_at_idx" ON "workspace_subscriptions"("ends_at");
ALTER TABLE "workspace_subscriptions" ADD CONSTRAINT "workspace_subscriptions_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workspace_subscriptions" ADD CONSTRAINT "workspace_subscriptions_plan_key_fkey"
  FOREIGN KEY ("plan_key") REFERENCES "plans"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "workspaces" ADD COLUMN "owner_user_id" UUID;
CREATE INDEX "workspaces_owner_user_id_idx" ON "workspaces"("owner_user_id");
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_user_id_fkey"
  FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The person whose own workspace it is: they created it when they signed up.
UPDATE "workspaces" w SET "owner_user_id" = uw."user_id"
FROM "user_workspaces" uw WHERE uw."workspace_id" = w."id" AND uw."is_default" = true;

-- Starting plans. Prices are in poisha (1 taka = 100). The platform admin panel changes them later.
INSERT INTO "plans" ("key", "name", "name_bn", "description", "description_bn", "price_monthly_minor", "price_yearly_minor",
  "max_businesses", "max_members", "storage_mb", "ai_enabled", "ai_daily_tokens", "sort_order", "updated_at") VALUES
  ('free', 'Free', 'ফ্রি', 'One business, the full books, tasks and documents.', 'একটি ব্যবসা, পুরো হিসাব, কাজ ও ডকুমেন্ট।',
    0, 0, 1, 3, 500, false, 0, 1, CURRENT_TIMESTAMP),
  ('pro', 'Pro', 'প্রো', 'Several businesses side by side, a bigger team, more storage and the AI assistant.', 'একাধিক ব্যবসা পাশাপাশি, বড় দল, বেশি জায়গা ও AI সহকারী।',
    59900, 599000, 5, 15, 10240, true, 100000, 2, CURRENT_TIMESTAMP);

-- Accounts made before plans existed keep everything they had: Pro with no end date. The admin can
-- change this later.
INSERT INTO "workspace_subscriptions" ("workspace_id", "plan_key", "source", "note", "updated_at")
SELECT "id", 'pro', 'GRANT', 'Existing account before plans', CURRENT_TIMESTAMP FROM "workspaces";
