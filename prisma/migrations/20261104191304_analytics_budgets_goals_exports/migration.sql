-- CreateEnum
CREATE TYPE "BudgetStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "GoalMetric" AS ENUM ('REVENUE', 'NET_PROFIT', 'CASH_BALANCE');

-- CreateEnum
CREATE TYPE "GoalStatus" AS ENUM ('ACTIVE', 'ACHIEVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReportExportStatus" AS ENUM ('QUEUED', 'RUNNING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "ledger_monthly_rollups" (
    "workspace_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "ledger_account_id" UUID NOT NULL,
    "month" DATE NOT NULL,
    "debit_minor" BIGINT NOT NULL,
    "credit_minor" BIGINT NOT NULL,

    CONSTRAINT "ledger_monthly_rollups_pkey" PRIMARY KEY ("ledger_account_id","month")
);

-- CreateTable
CREATE TABLE "budgets" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "start_month" DATE NOT NULL,
    "end_month" DATE NOT NULL,
    "status" "BudgetStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "budgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_lines" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "budget_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "alert_percent" SMALLINT NOT NULL DEFAULT 80,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "budget_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_alerts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "budget_line_id" UUID NOT NULL,
    "percent" SMALLINT NOT NULL,
    "actual_minor" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "budget_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goals" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "metric" "GoalMetric" NOT NULL,
    "target_minor" BIGINT NOT NULL,
    "start_month" DATE NOT NULL,
    "end_month" DATE NOT NULL,
    "status" "GoalStatus" NOT NULL DEFAULT 'ACTIVE',
    "achieved_at" TIMESTAMPTZ(3),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "goals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_exports" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "report" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "locale" VARCHAR(10) NOT NULL,
    "digit_style" VARCHAR(10) NOT NULL,
    "status" "ReportExportStatus" NOT NULL DEFAULT 'QUEUED',
    "file_name" TEXT,
    "storage_key" TEXT,
    "error_code" TEXT,
    "requested_by" UUID NOT NULL,
    "finished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "report_exports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange_rates" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "from_currency" CHAR(3) NOT NULL,
    "to_currency" CHAR(3) NOT NULL,
    "rate_date" DATE NOT NULL,
    "rate" DECIMAL(20,6) NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intercompany_transfers" (
    "id" UUID NOT NULL,
    "from_business_id" UUID NOT NULL,
    "to_business_id" UUID NOT NULL,
    "from_entry_id" UUID NOT NULL,
    "to_entry_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "transfer_date" DATE NOT NULL,
    "memo" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intercompany_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" BIGSERIAL NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(3),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ledger_monthly_rollups_business_id_month_idx" ON "ledger_monthly_rollups"("business_id", "month");

-- CreateIndex
CREATE INDEX "budgets_business_id_status_idx" ON "budgets"("business_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "budget_lines_budget_id_category_id_key" ON "budget_lines"("budget_id", "category_id");

-- CreateIndex
CREATE UNIQUE INDEX "budget_alerts_budget_line_id_percent_key" ON "budget_alerts"("budget_line_id", "percent");

-- CreateIndex
CREATE INDEX "goals_business_id_status_idx" ON "goals"("business_id", "status");

-- CreateIndex
CREATE INDEX "report_exports_business_id_id_idx" ON "report_exports"("business_id", "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "exchange_rates_workspace_id_from_currency_to_currency_rate__key" ON "exchange_rates"("workspace_id", "from_currency", "to_currency", "rate_date");

-- CreateIndex
CREATE UNIQUE INDEX "intercompany_transfers_from_entry_id_key" ON "intercompany_transfers"("from_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "intercompany_transfers_to_entry_id_key" ON "intercompany_transfers"("to_entry_id");

-- CreateIndex
CREATE INDEX "intercompany_transfers_from_business_id_idx" ON "intercompany_transfers"("from_business_id");

-- CreateIndex
CREATE INDEX "intercompany_transfers_to_business_id_idx" ON "intercompany_transfers"("to_business_id");

-- AddForeignKey
ALTER TABLE "ledger_monthly_rollups" ADD CONSTRAINT "ledger_monthly_rollups_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_monthly_rollups" ADD CONSTRAINT "ledger_monthly_rollups_ledger_account_id_fkey" FOREIGN KEY ("ledger_account_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_budget_id_fkey" FOREIGN KEY ("budget_id") REFERENCES "budgets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_alerts" ADD CONSTRAINT "budget_alerts_budget_line_id_fkey" FOREIGN KEY ("budget_line_id") REFERENCES "budget_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goals" ADD CONSTRAINT "goals_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intercompany_transfers" ADD CONSTRAINT "intercompany_transfers_from_business_id_fkey" FOREIGN KEY ("from_business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intercompany_transfers" ADD CONSTRAINT "intercompany_transfers_to_business_id_fkey" FOREIGN KEY ("to_business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intercompany_transfers" ADD CONSTRAINT "intercompany_transfers_from_entry_id_fkey" FOREIGN KEY ("from_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intercompany_transfers" ADD CONSTRAINT "intercompany_transfers_to_entry_id_fkey" FOREIGN KEY ("to_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written below: Prisma cannot express triggers, check constraints or RLS.

ALTER TABLE "budget_lines"
  ADD CONSTRAINT "budget_lines_amount_positive" CHECK ("amount_minor" > 0),
  ADD CONSTRAINT "budget_lines_alert_percent_range" CHECK ("alert_percent" BETWEEN 1 AND 100);
ALTER TABLE "goals" ADD CONSTRAINT "goals_target_positive" CHECK ("target_minor" > 0);
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_rate_positive" CHECK ("rate" > 0);
ALTER TABLE "intercompany_transfers"
  ADD CONSTRAINT "intercompany_two_businesses" CHECK ("from_business_id" <> "to_business_id"),
  ADD CONSTRAINT "intercompany_amount_positive" CHECK ("amount_minor" > 0);

-- ---------------------------------------------------------------------------
-- Monthly rollups, kept in step by a trigger, so posting needs no extra query and none can be missed.
-- A statement-level trigger sees all of an entry's lines at once, and locks accounts in a fixed
-- order, so two entries touching the same accounts cannot deadlock.
-- ---------------------------------------------------------------------------
CREATE FUNCTION ledger_rollup_lines() RETURNS trigger AS $$
BEGIN
  INSERT INTO ledger_monthly_rollups AS rollup
    (workspace_id, business_id, ledger_account_id, month, debit_minor, credit_minor)
  SELECT n.workspace_id, n.business_id, n.ledger_account_id, date_trunc('month', e.entry_date)::date,
    SUM(n.debit_minor), SUM(n.credit_minor)
  FROM new_lines n
  JOIN journal_entries e ON e.id = n.journal_entry_id
  WHERE e.kind <> 'CLOSING'
  GROUP BY 1, 2, 3, 4
  ORDER BY 3, 4
  ON CONFLICT (ledger_account_id, month) DO UPDATE SET
    debit_minor = rollup.debit_minor + EXCLUDED.debit_minor,
    credit_minor = rollup.credit_minor + EXCLUDED.credit_minor;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER journal_lines_rollup
  AFTER INSERT ON "journal_lines"
  REFERENCING NEW TABLE AS new_lines
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_rollup_lines();

-- Journals posted before this migration.
INSERT INTO ledger_monthly_rollups (workspace_id, business_id, ledger_account_id, month, debit_minor, credit_minor)
SELECT l.workspace_id, l.business_id, l.ledger_account_id, date_trunc('month', e.entry_date)::date,
  SUM(l.debit_minor), SUM(l.credit_minor)
FROM journal_lines l
JOIN journal_entries e ON e.id = l.journal_entry_id
WHERE e.kind <> 'CLOSING'
GROUP BY 1, 2, 3, 4;

-- ---------------------------------------------------------------------------
-- Restricted role
-- ---------------------------------------------------------------------------
-- Only the trigger writes rollups.
GRANT SELECT ON "ledger_monthly_rollups" TO business_os_app;
GRANT SELECT, INSERT, UPDATE ON "budgets", "budget_lines", "goals", "report_exports" TO business_os_app;
GRANT SELECT, INSERT ON "budget_alerts", "exchange_rates", "intercompany_transfers", "outbox_events" TO business_os_app;
-- A rate can be corrected by saving it again for the same date.
GRANT UPDATE ON "exchange_rates" TO business_os_app;
GRANT USAGE ON SEQUENCE "outbox_events_id_seq" TO business_os_app;

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'ledger_monthly_rollups', 'budgets', 'budget_lines', 'budget_alerts', 'goals', 'report_exports', 'outbox_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I TO business_os_app USING (business_id = ANY (app_business_ids())) WITH CHECK (business_id = ANY (app_business_ids()))',
      table_name || '_isolation', table_name
    );
  END LOOP;
END
$$;

-- A transfer is visible to either side, but creating one needs both in scope.
ALTER TABLE "intercompany_transfers" ENABLE ROW LEVEL SECURITY;
CREATE POLICY intercompany_transfers_read ON "intercompany_transfers" FOR SELECT TO business_os_app
  USING ("from_business_id" = ANY (app_business_ids()) OR "to_business_id" = ANY (app_business_ids()));
CREATE POLICY intercompany_transfers_create ON "intercompany_transfers" FOR INSERT TO business_os_app
  WITH CHECK ("from_business_id" = ANY (app_business_ids()) AND "to_business_id" = ANY (app_business_ids()));

CREATE FUNCTION app_workspace_id() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.workspace_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

ALTER TABLE "exchange_rates" ENABLE ROW LEVEL SECURITY;
CREATE POLICY exchange_rates_isolation ON "exchange_rates" TO business_os_app
  USING ("workspace_id" = app_workspace_id())
  WITH CHECK ("workspace_id" = app_workspace_id());
