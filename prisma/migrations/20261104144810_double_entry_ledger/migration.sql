-- CreateEnum
CREATE TYPE "LedgerAccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE');

-- CreateEnum
CREATE TYPE "NormalBalance" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "CashFlowClass" AS ENUM ('OPERATING', 'INVESTING', 'FINANCING');

-- CreateEnum
CREATE TYPE "FiscalPeriodStatus" AS ENUM ('OPEN', 'SOFT_CLOSED', 'CLOSED');

-- CreateEnum
CREATE TYPE "JournalKind" AS ENUM ('STANDARD', 'REVERSAL', 'ADJUSTING', 'CLOSING', 'OPENING');

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('OPEN', 'CLOSED');

-- AlterTable
ALTER TABLE "categories" ADD COLUMN     "ledger_account_id" UUID;

-- AlterTable
ALTER TABLE "financial_accounts" ADD COLUMN     "ledger_account_id" UUID;

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "approved_at" TIMESTAMPTZ(3),
ADD COLUMN     "approved_by" UUID,
ADD COLUMN     "journal_entry_id" UUID,
ADD COLUMN     "reversal_entry_id" UUID;

-- CreateTable
CREATE TABLE "ledger_accounts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_bn" TEXT,
    "type" "LedgerAccountType" NOT NULL,
    "normal_balance" "NormalBalance" NOT NULL,
    "cash_flow_class" "CashFlowClass" NOT NULL DEFAULT 'OPERATING',
    "parent_id" UUID,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fiscal_periods" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "fiscal_year" INTEGER NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "status" "FiscalPeriodStatus" NOT NULL DEFAULT 'OPEN',
    "closed_at" TIMESTAMPTZ(3),
    "closed_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "fiscal_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entries" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "fiscal_period_id" UUID NOT NULL,
    "entry_no" TEXT NOT NULL,
    "entry_date" DATE NOT NULL,
    "kind" "JournalKind" NOT NULL,
    "reverses_id" UUID,
    "source_type" TEXT,
    "source_id" UUID,
    "memo" TEXT,
    "posted_by" UUID NOT NULL,
    "posted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_lines" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "journal_entry_id" UUID NOT NULL,
    "ledger_account_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "debit_minor" BIGINT NOT NULL DEFAULT 0,
    "credit_minor" BIGINT NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL,
    "base_amount_minor" BIGINT NOT NULL,
    "fx_rate" DECIMAL(20,6) NOT NULL DEFAULT 1,
    "memo" TEXT,

    CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliations" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "financial_account_id" UUID NOT NULL,
    "statement_date" DATE NOT NULL,
    "statement_balance_minor" BIGINT NOT NULL,
    "status" "ReconciliationStatus" NOT NULL DEFAULT 'OPEN',
    "book_balance_minor" BIGINT,
    "difference_minor" BIGINT,
    "adjustment_entry_id" UUID,
    "closed_at" TIMESTAMPTZ(3),
    "closed_by" UUID,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reconciliations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_lines" (
    "reconciliation_id" UUID NOT NULL,
    "journal_line_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,

    CONSTRAINT "reconciliation_lines_pkey" PRIMARY KEY ("journal_line_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_business_id_code_key" ON "ledger_accounts"("business_id", "code");

-- CreateIndex
CREATE INDEX "fiscal_periods_business_id_fiscal_year_idx" ON "fiscal_periods"("business_id", "fiscal_year");

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_periods_business_id_start_date_key" ON "fiscal_periods"("business_id", "start_date");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_reverses_id_key" ON "journal_entries"("reverses_id");

-- CreateIndex
CREATE INDEX "journal_entries_business_id_entry_date_id_idx" ON "journal_entries"("business_id", "entry_date" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "journal_entries_business_id_source_type_source_id_idx" ON "journal_entries"("business_id", "source_type", "source_id");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_business_id_entry_no_key" ON "journal_entries"("business_id", "entry_no");

-- CreateIndex
CREATE INDEX "journal_lines_ledger_account_id_journal_entry_id_idx" ON "journal_lines"("ledger_account_id", "journal_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "journal_lines_journal_entry_id_line_no_key" ON "journal_lines"("journal_entry_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "reconciliations_adjustment_entry_id_key" ON "reconciliations"("adjustment_entry_id");

-- CreateIndex
CREATE INDEX "reconciliations_business_id_financial_account_id_idx" ON "reconciliations"("business_id", "financial_account_id");

-- CreateIndex
CREATE INDEX "reconciliation_lines_reconciliation_id_idx" ON "reconciliation_lines"("reconciliation_id");

-- CreateIndex
CREATE UNIQUE INDEX "financial_accounts_ledger_account_id_key" ON "financial_accounts"("ledger_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_journal_entry_id_key" ON "transactions"("journal_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_reversal_entry_id_key" ON "transactions"("reversal_entry_id");

-- AddForeignKey
ALTER TABLE "financial_accounts" ADD CONSTRAINT "financial_accounts_ledger_account_id_fkey" FOREIGN KEY ("ledger_account_id") REFERENCES "ledger_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_ledger_account_id_fkey" FOREIGN KEY ("ledger_account_id") REFERENCES "ledger_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_reversal_entry_id_fkey" FOREIGN KEY ("reversal_entry_id") REFERENCES "journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "ledger_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_fiscal_period_id_fkey" FOREIGN KEY ("fiscal_period_id") REFERENCES "fiscal_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reverses_id_fkey" FOREIGN KEY ("reverses_id") REFERENCES "journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_ledger_account_id_fkey" FOREIGN KEY ("ledger_account_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_financial_account_id_fkey" FOREIGN KEY ("financial_account_id") REFERENCES "financial_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_adjustment_entry_id_fkey" FOREIGN KEY ("adjustment_entry_id") REFERENCES "journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_lines" ADD CONSTRAINT "reconciliation_lines_reconciliation_id_fkey" FOREIGN KEY ("reconciliation_id") REFERENCES "reconciliations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_lines" ADD CONSTRAINT "reconciliation_lines_journal_line_id_fkey" FOREIGN KEY ("journal_line_id") REFERENCES "journal_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written below: Prisma cannot express check constraints, triggers, partial indexes or RLS.

ALTER TABLE "journal_lines"
  ADD CONSTRAINT "journal_lines_one_side"
    CHECK ("debit_minor" >= 0 AND "credit_minor" >= 0 AND ("debit_minor" = 0) <> ("credit_minor" = 0));

-- One open reconciliation per account at a time.
CREATE UNIQUE INDEX "reconciliations_one_open_per_account"
  ON "reconciliations"("financial_account_id") WHERE "status" = 'OPEN';

-- ---------------------------------------------------------------------------
-- The books cannot be edited
-- ---------------------------------------------------------------------------
CREATE FUNCTION ledger_block_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER journal_entries_no_update_delete
  BEFORE UPDATE OR DELETE ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION ledger_block_change();
CREATE TRIGGER journal_entries_no_truncate
  BEFORE TRUNCATE ON "journal_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_block_change();

CREATE TRIGGER journal_lines_no_update_delete
  BEFORE UPDATE OR DELETE ON "journal_lines"
  FOR EACH ROW EXECUTE FUNCTION ledger_block_change();
CREATE TRIGGER journal_lines_no_truncate
  BEFORE TRUNCATE ON "journal_lines"
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_block_change();

-- ---------------------------------------------------------------------------
-- Every entry must balance. Checked at COMMIT, when all of its lines exist.
-- ---------------------------------------------------------------------------
CREATE FUNCTION journal_assert_valid() RETURNS trigger AS $$
DECLARE
  entry_id uuid;
  entry_business uuid;
  total_debit numeric;
  total_credit numeric;
  line_count integer;
  foreign_lines integer;
BEGIN
  IF TG_TABLE_NAME = 'journal_entries' THEN
    entry_id := NEW.id;
  ELSE
    entry_id := NEW.journal_entry_id;
  END IF;
  SELECT business_id INTO entry_business FROM journal_entries WHERE id = entry_id;

  SELECT COALESCE(SUM(debit_minor), 0), COALESCE(SUM(credit_minor), 0), COUNT(*)
    INTO total_debit, total_credit, line_count
    FROM journal_lines WHERE journal_entry_id = entry_id;

  IF line_count < 2 THEN
    RAISE EXCEPTION 'journal entry % needs at least two lines', entry_id USING ERRCODE = 'check_violation';
  END IF;
  IF total_debit <> total_credit THEN
    RAISE EXCEPTION 'journal entry % is unbalanced: debit % credit %', entry_id, total_debit, total_credit
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COUNT(*) INTO foreign_lines
    FROM journal_lines l JOIN ledger_accounts a ON a.id = l.ledger_account_id
    WHERE l.journal_entry_id = entry_id AND (l.business_id <> entry_business OR a.business_id <> entry_business);
  IF foreign_lines > 0 THEN
    RAISE EXCEPTION 'journal entry % uses an account from another business', entry_id USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE CONSTRAINT TRIGGER journal_entries_valid
  AFTER INSERT ON "journal_entries" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION journal_assert_valid();
CREATE CONSTRAINT TRIGGER journal_lines_valid
  AFTER INSERT ON "journal_lines" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION journal_assert_valid();

-- Nothing can be posted into a closed period, or outside its period's dates.
CREATE FUNCTION journal_assert_period() RETURNS trigger AS $$
DECLARE
  period fiscal_periods%ROWTYPE;
BEGIN
  SELECT * INTO period FROM fiscal_periods WHERE id = NEW.fiscal_period_id;
  IF period.business_id <> NEW.business_id OR NEW.entry_date NOT BETWEEN period.start_date AND period.end_date THEN
    RAISE EXCEPTION 'entry date % is outside its fiscal period', NEW.entry_date USING ERRCODE = 'check_violation';
  END IF;
  IF period.status = 'CLOSED' THEN
    RAISE EXCEPTION 'fiscal period is closed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER journal_entries_period_open
  BEFORE INSERT ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION journal_assert_period();

-- ---------------------------------------------------------------------------
-- Restricted role: journals are INSERT and SELECT only.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT ON "journal_entries", "journal_lines" TO business_os_app;
GRANT SELECT, INSERT, UPDATE ON "ledger_accounts", "fiscal_periods", "reconciliations" TO business_os_app;
-- Un-matching a line during an open reconciliation deletes the link, never the journal line.
GRANT SELECT, INSERT, DELETE ON "reconciliation_lines" TO business_os_app;

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'ledger_accounts', 'fiscal_periods', 'journal_entries', 'journal_lines', 'reconciliations', 'reconciliation_lines'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I TO business_os_app USING (business_id = ANY (app_business_ids())) WITH CHECK (business_id = ANY (app_business_ids()))',
      table_name || '_isolation', table_name
    );
  END LOOP;
END
$$;
