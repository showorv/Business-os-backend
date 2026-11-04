-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('ACTIVE', 'NEEDS_REAUTH', 'DISABLED');

-- CreateEnum
CREATE TYPE "SyncRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "StatementImportStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "StatementDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "StatementLineStatus" AS ENUM ('UNMATCHED', 'AWAITING_POSTING', 'MATCHED', 'IGNORED');

-- AlterEnum
ALTER TYPE "DocumentType" ADD VALUE 'STATEMENT';

-- CreateTable
CREATE TABLE "integration_connections" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "financial_account_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "encrypted_secrets" TEXT NOT NULL,
    "sync_cursor" TEXT,
    "sync_every_hours" INTEGER NOT NULL DEFAULT 6,
    "last_synced_at" TIMESTAMPTZ(3),
    "last_balance_minor" BIGINT,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "syncing_since" TIMESTAMPTZ(3),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "integration_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_runs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "status" "SyncRunStatus" NOT NULL DEFAULT 'RUNNING',
    "fetched" INTEGER NOT NULL DEFAULT 0,
    "new_lines" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "cursor_after" TEXT,
    "error_code" TEXT,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raw_payloads" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "raw_payloads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "statement_templates" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "mapping" JSONB NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "statement_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "statement_imports" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "financial_account_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "mapping" JSONB NOT NULL,
    "status" "StatementImportStatus" NOT NULL DEFAULT 'QUEUED',
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "new_lines" INTEGER NOT NULL DEFAULT 0,
    "duplicate_rows" INTEGER NOT NULL DEFAULT 0,
    "failed_rows" INTEGER NOT NULL DEFAULT 0,
    "balance_breaks" INTEGER NOT NULL DEFAULT 0,
    "row_errors" JSONB NOT NULL DEFAULT '[]',
    "error_code" TEXT,
    "requested_by" UUID NOT NULL,
    "finished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "statement_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "statement_lines" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "financial_account_id" UUID NOT NULL,
    "connection_id" UUID,
    "import_id" UUID,
    "txn_date" DATE NOT NULL,
    "direction" "StatementDirection" NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "fee_minor" BIGINT NOT NULL DEFAULT 0,
    "balance_after_minor" BIGINT,
    "description" TEXT,
    "reference" TEXT,
    "counterparty" TEXT,
    "provider_txn_id" TEXT,
    "dedupe_hash" TEXT NOT NULL,
    "status" "StatementLineStatus" NOT NULL DEFAULT 'UNMATCHED',
    "matched_by" TEXT,
    "last_match_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "statement_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "statement_line_links" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "statement_line_id" UUID NOT NULL,
    "transaction_id" UUID,
    "journal_line_id" UUID,

    CONSTRAINT "statement_line_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "statement_rules" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "contains_text" TEXT NOT NULL,
    "direction" "StatementDirection" NOT NULL,
    "category_id" UUID NOT NULL,
    "max_amount_minor" BIGINT,
    "auto_post" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "statement_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "integration_connections_business_id_id_idx" ON "integration_connections"("business_id", "id" DESC);

-- CreateIndex
CREATE INDEX "integration_connections_status_last_synced_at_idx" ON "integration_connections"("status", "last_synced_at");

-- CreateIndex
CREATE UNIQUE INDEX "integration_connections_financial_account_id_provider_key" ON "integration_connections"("financial_account_id", "provider");

-- CreateIndex
CREATE INDEX "sync_runs_connection_id_id_idx" ON "sync_runs"("connection_id", "id" DESC);

-- CreateIndex
CREATE INDEX "sync_runs_business_id_idx" ON "sync_runs"("business_id");

-- CreateIndex
CREATE INDEX "raw_payloads_connection_id_idx" ON "raw_payloads"("connection_id");

-- CreateIndex
CREATE INDEX "raw_payloads_created_at_idx" ON "raw_payloads"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "statement_templates_business_id_name_key" ON "statement_templates"("business_id", "name");

-- CreateIndex
CREATE INDEX "statement_imports_business_id_id_idx" ON "statement_imports"("business_id", "id" DESC);

-- CreateIndex
CREATE INDEX "statement_lines_business_id_status_id_idx" ON "statement_lines"("business_id", "status", "id" DESC);

-- CreateIndex
CREATE INDEX "statement_lines_financial_account_id_txn_date_idx" ON "statement_lines"("financial_account_id", "txn_date");

-- CreateIndex
CREATE UNIQUE INDEX "statement_lines_financial_account_id_dedupe_hash_key" ON "statement_lines"("financial_account_id", "dedupe_hash");

-- CreateIndex
CREATE UNIQUE INDEX "statement_line_links_journal_line_id_key" ON "statement_line_links"("journal_line_id");

-- CreateIndex
CREATE INDEX "statement_line_links_statement_line_id_idx" ON "statement_line_links"("statement_line_id");

-- CreateIndex
CREATE INDEX "statement_line_links_business_id_idx" ON "statement_line_links"("business_id");

-- CreateIndex
CREATE INDEX "statement_line_links_transaction_id_idx" ON "statement_line_links"("transaction_id");

-- CreateIndex
CREATE INDEX "statement_rules_business_id_priority_idx" ON "statement_rules"("business_id", "priority");

-- AddForeignKey
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_financial_account_id_fkey" FOREIGN KEY ("financial_account_id") REFERENCES "financial_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_payloads" ADD CONSTRAINT "raw_payloads_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "statement_templates" ADD CONSTRAINT "statement_templates_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "statement_imports" ADD CONSTRAINT "statement_imports_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "statement_imports" ADD CONSTRAINT "statement_imports_financial_account_id_fkey" FOREIGN KEY ("financial_account_id") REFERENCES "financial_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "statement_imports" ADD CONSTRAINT "statement_imports_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "statement_lines" ADD CONSTRAINT "statement_lines_financial_account_id_fkey" FOREIGN KEY ("financial_account_id") REFERENCES "financial_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "statement_lines" ADD CONSTRAINT "statement_lines_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "statement_lines" ADD CONSTRAINT "statement_lines_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "statement_imports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "statement_line_links" ADD CONSTRAINT "statement_line_links_statement_line_id_fkey" FOREIGN KEY ("statement_line_id") REFERENCES "statement_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "statement_line_links" ADD CONSTRAINT "statement_line_links_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "statement_line_links" ADD CONSTRAINT "statement_line_links_journal_line_id_fkey" FOREIGN KEY ("journal_line_id") REFERENCES "journal_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "statement_rules" ADD CONSTRAINT "statement_rules_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "statement_rules" ADD CONSTRAINT "statement_rules_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Rules the database enforces itself
-- ---------------------------------------------------------------------------
ALTER TABLE "statement_lines"
  ADD CONSTRAINT statement_lines_amount_positive CHECK ("amount_minor" > 0),
  ADD CONSTRAINT statement_lines_fee_valid CHECK ("fee_minor" >= 0);

-- The document's rule: a provider's transaction can only arrive once.
CREATE UNIQUE INDEX statement_lines_one_per_provider_txn ON "statement_lines" ("connection_id", "provider_txn_id")
  WHERE "provider_txn_id" IS NOT NULL;

ALTER TABLE "statement_rules"
  ADD CONSTRAINT statement_rules_text_not_empty CHECK (length(trim("contains_text")) > 0);

ALTER TABLE "integration_connections"
  ADD CONSTRAINT integration_connections_sync_hours_valid CHECK ("sync_every_hours" > 0);

-- ---------------------------------------------------------------------------
-- Restricted role
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON "integration_connections", "statement_imports", "statement_lines" TO business_os_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "statement_templates", "statement_rules", "statement_line_links" TO business_os_app;
GRANT SELECT ON "sync_runs" TO business_os_app;
-- raw_payloads has no grant: only the worker and the webhook endpoint touch it, on the normal connection.

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'integration_connections', 'sync_runs', 'raw_payloads', 'statement_templates',
    'statement_imports', 'statement_lines', 'statement_line_links', 'statement_rules'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I TO business_os_app USING (business_id = ANY (app_business_ids())) WITH CHECK (business_id = ANY (app_business_ids()))',
      table_name || '_isolation', table_name
    );
  END LOOP;
END
$$;
