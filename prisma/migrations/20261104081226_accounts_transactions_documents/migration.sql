-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('INVOICE', 'RECEIPT', 'CONTRACT', 'POLICY', 'NOTE');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('PENDING_UPLOAD', 'READY', 'REJECTED');

-- CreateEnum
CREATE TYPE "FinancialAccountType" AS ENUM ('CASH', 'BANK', 'BKASH', 'NAGAD', 'MFS_OTHER', 'CUSTOM');

-- CreateEnum
CREATE TYPE "CategoryType" AS ENUM ('INCOME', 'EXPENSE');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('INCOME', 'EXPENSE', 'TRANSFER', 'REFUND', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'POSTED', 'REJECTED', 'VOID');

-- CreateEnum
CREATE TYPE "TransactionSource" AS ENUM ('MANUAL', 'IMPORT', 'SYNC', 'RECURRING', 'AI');

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "type" "DocumentType" NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
    "file_name" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "sha256" TEXT,
    "scan_status" TEXT NOT NULL DEFAULT 'NOT_SCANNED',
    "ingest_status" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "deleted_at" TIMESTAMPTZ(3),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_accounts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "name" CITEXT NOT NULL,
    "type" "FinancialAccountType" NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "opening_balance_minor" BIGINT NOT NULL,
    "opening_date" DATE NOT NULL,
    "current_balance_minor" BIGINT NOT NULL,
    "masked_number" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "financial_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "type" "CategoryType" NOT NULL,
    "name" CITEXT NOT NULL,
    "name_bn" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "type" "TransactionType" NOT NULL,
    "status" "TransactionStatus" NOT NULL DEFAULT 'DRAFT',
    "account_id" UUID NOT NULL,
    "to_account_id" UUID,
    "category_id" UUID,
    "amount_minor" BIGINT NOT NULL,
    "fee_minor" BIGINT NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL,
    "txn_date" DATE NOT NULL,
    "payment_method" TEXT,
    "reference_no" TEXT,
    "description" TEXT,
    "source" "TransactionSource" NOT NULL DEFAULT 'MANUAL',
    "provider_txn_id" TEXT,
    "possible_duplicate" BOOLEAN NOT NULL DEFAULT false,
    "duplicate_of_id" UUID,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction_attachments" (
    "transaction_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transaction_attachments_pkey" PRIMARY KEY ("transaction_id","document_id")
);

-- CreateTable
CREATE TABLE "business_sequences" (
    "business_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "value" BIGINT NOT NULL,

    CONSTRAINT "business_sequences_pkey" PRIMARY KEY ("business_id","name")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "user_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "status_code" INTEGER NOT NULL,
    "response_body" JSONB NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("user_id","key")
);

-- CreateIndex
CREATE UNIQUE INDEX "documents_storage_key_key" ON "documents"("storage_key");

-- CreateIndex
CREATE INDEX "documents_business_id_id_idx" ON "documents"("business_id", "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "financial_accounts_business_id_name_key" ON "financial_accounts"("business_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "categories_business_id_type_name_key" ON "categories"("business_id", "type", "name");

-- CreateIndex
CREATE INDEX "transactions_business_id_txn_date_id_idx" ON "transactions"("business_id", "txn_date" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "transactions_business_id_account_id_amount_minor_txn_date_idx" ON "transactions"("business_id", "account_id", "amount_minor", "txn_date");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_business_id_number_key" ON "transactions"("business_id", "number");

-- CreateIndex
CREATE INDEX "transaction_attachments_business_id_idx" ON "transaction_attachments"("business_id");

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_accounts" ADD CONSTRAINT "financial_accounts_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "financial_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_to_account_id_fkey" FOREIGN KEY ("to_account_id") REFERENCES "financial_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction_attachments" ADD CONSTRAINT "transaction_attachments_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction_attachments" ADD CONSTRAINT "transaction_attachments_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_sequences" ADD CONSTRAINT "business_sequences_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written below: Prisma cannot express check constraints, partial indexes or RLS.

ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_amount_positive" CHECK ("amount_minor" > 0),
  ADD CONSTRAINT "transactions_fee_not_negative" CHECK ("fee_minor" >= 0),
  ADD CONSTRAINT "transactions_valid_transfer"
    CHECK ("type" <> 'TRANSFER' OR ("to_account_id" IS NOT NULL AND "to_account_id" <> "account_id"));

ALTER TABLE "financial_accounts"
  ADD CONSTRAINT "financial_accounts_opening_not_negative" CHECK ("opening_balance_minor" >= 0);

-- No duplicate imports (Phase 7).
CREATE UNIQUE INDEX "transactions_provider_unique"
  ON "transactions"("business_id", "source", "provider_txn_id")
  WHERE "provider_txn_id" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Restricted role: no DELETE on these tables, with the one exception below.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON
  "financial_accounts", "categories", "transactions", "documents",
  "business_sequences", "idempotency_keys"
  TO business_os_app;

-- Removing an attachment is the one real delete: the link goes, the document and audit row stay.
GRANT SELECT, INSERT, DELETE ON "transaction_attachments" TO business_os_app;

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------
ALTER TABLE "financial_accounts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY financial_accounts_isolation ON "financial_accounts" TO business_os_app
  USING ("business_id" = ANY (app_business_ids()))
  WITH CHECK ("business_id" = ANY (app_business_ids()));

ALTER TABLE "categories" ENABLE ROW LEVEL SECURITY;
CREATE POLICY categories_isolation ON "categories" TO business_os_app
  USING ("business_id" = ANY (app_business_ids()))
  WITH CHECK ("business_id" = ANY (app_business_ids()));

ALTER TABLE "transactions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY transactions_isolation ON "transactions" TO business_os_app
  USING ("business_id" = ANY (app_business_ids()))
  WITH CHECK ("business_id" = ANY (app_business_ids()));

ALTER TABLE "transaction_attachments" ENABLE ROW LEVEL SECURITY;
CREATE POLICY transaction_attachments_isolation ON "transaction_attachments" TO business_os_app
  USING ("business_id" = ANY (app_business_ids()))
  WITH CHECK ("business_id" = ANY (app_business_ids()));

ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;
CREATE POLICY documents_isolation ON "documents" TO business_os_app
  USING ("business_id" = ANY (app_business_ids()))
  WITH CHECK ("business_id" = ANY (app_business_ids()));

ALTER TABLE "business_sequences" ENABLE ROW LEVEL SECURITY;
CREATE POLICY business_sequences_isolation ON "business_sequences" TO business_os_app
  USING ("business_id" = ANY (app_business_ids()))
  WITH CHECK ("business_id" = ANY (app_business_ids()));

-- Idempotency keys belong to a user, not a business.
CREATE FUNCTION app_user_id() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

ALTER TABLE "idempotency_keys" ENABLE ROW LEVEL SECURITY;
CREATE POLICY idempotency_keys_isolation ON "idempotency_keys" TO business_os_app
  USING ("user_id" = app_user_id())
  WITH CHECK ("user_id" = app_user_id());
