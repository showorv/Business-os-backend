-- Step 11.3: the platform admin panel. Platform tables, read and written only by the server's owner
-- connection, never through row-level security.

ALTER TABLE "users" ADD COLUMN "is_platform_admin" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "workspaces" ADD COLUMN "suspended_at" TIMESTAMPTZ(3),
ADD COLUMN "suspended_reason" TEXT;

-- Coupons. A payment keeps the plan's price, the discount and what was charged.
ALTER TABLE "payments" ADD COLUMN "coupon_code" VARCHAR(40),
ADD COLUMN "discount_minor" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN "list_amount_minor" BIGINT NOT NULL DEFAULT 0;
UPDATE "payments" SET "list_amount_minor" = "amount_minor";
-- A coupon can take the whole price off, so nothing is charged.
ALTER TABLE "payments" DROP CONSTRAINT "payments_amount_positive";
ALTER TABLE "payments" ADD CONSTRAINT "payments_amounts_add_up" CHECK (
  "amount_minor" >= 0 AND "discount_minor" >= 0 AND "amount_minor" + "discount_minor" = "list_amount_minor"
);

CREATE TABLE "coupons" (
    "id" UUID NOT NULL,
    "code" CITEXT NOT NULL,
    "description" TEXT,
    "percent_off" INTEGER,
    "amount_off_minor" BIGINT,
    "plan_keys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "max_redemptions" INTEGER,
    "redemptions" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "coupons_pkey" PRIMARY KEY ("id"),
    -- Either a percentage or an amount, never both.
    CONSTRAINT "coupons_one_discount" CHECK (("percent_off" IS NULL) <> ("amount_off_minor" IS NULL)),
    CONSTRAINT "coupons_percent_range" CHECK ("percent_off" IS NULL OR "percent_off" BETWEEN 1 AND 100),
    CONSTRAINT "coupons_amount_positive" CHECK ("amount_off_minor" IS NULL OR "amount_off_minor" > 0),
    CONSTRAINT "coupons_redemptions_valid" CHECK ("redemptions" >= 0 AND ("max_redemptions" IS NULL OR "max_redemptions" > 0))
);
CREATE UNIQUE INDEX "coupons_code_key" ON "coupons"("code");
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "platform_settings" (
    "key" VARCHAR(60) NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);
