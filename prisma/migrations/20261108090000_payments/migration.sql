-- Step 11.2: paying for a plan. Platform tables, like plans: read and written only by the server's
-- owner connection, never through row-level security.

CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'CANCELLED');

CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "plan_key" VARCHAR(40) NOT NULL,
    "billing_cycle" "BillingCycle" NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "gateway" VARCHAR(20) NOT NULL,
    "gateway_ref" VARCHAR(120),
    "method" VARCHAR(20),
    "receipt_number" VARCHAR(30),
    "period_start" TIMESTAMPTZ(3),
    "period_end" TIMESTAMPTZ(3),
    "failure_reason" TEXT,
    "created_by" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "paid_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "payments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payments_amount_positive" CHECK ("amount_minor" > 0),
    -- A paid payment always has its receipt, its period and when it was paid.
    CONSTRAINT "payments_paid_complete" CHECK (
      "status" <> 'PAID' OR ("receipt_number" IS NOT NULL AND "period_start" IS NOT NULL AND "period_end" > "period_start" AND "paid_at" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "payments_receipt_number_key" ON "payments"("receipt_number");
CREATE INDEX "payments_workspace_id_created_at_idx" ON "payments"("workspace_id", "created_at");
-- A gateway's transaction id is only ever used once.
CREATE UNIQUE INDEX "payments_gateway_ref_key" ON "payments"("gateway", "gateway_ref") WHERE "gateway_ref" IS NOT NULL;

ALTER TABLE "payments" ADD CONSTRAINT "payments_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_plan_key_fkey" FOREIGN KEY ("plan_key") REFERENCES "plans"("key") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Receipt numbers run across the whole platform: BOS-2026-000001.
CREATE SEQUENCE "payment_receipt_seq";
