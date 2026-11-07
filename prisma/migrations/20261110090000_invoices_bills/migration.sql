-- Step 11.5: invoices to customers, bills from suppliers, and payments against them.

CREATE TYPE "InvoiceKind" AS ENUM ('SALE', 'BILL');

CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'VOID');

CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "kind" "InvoiceKind" NOT NULL,
    "number" TEXT,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "contact_id" UUID NOT NULL,
    "issue_date" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "total_minor" BIGINT NOT NULL,
    "paid_minor" BIGINT NOT NULL DEFAULT 0,
    "reference_no" TEXT,
    "notes" TEXT,
    "journal_entry_id" UUID,
    "issued_at" TIMESTAMPTZ(3),
    "issued_by" UUID,
    "voided_at" TIMESTAMPTZ(3),
    "voided_by" UUID,
    "void_reason" TEXT,
    "emailed_at" TIMESTAMPTZ(3),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "invoice_lines" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "line_no" SMALLINT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unit_price_minor" BIGINT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "category_id" UUID NOT NULL,

    CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "invoice_payments" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "paid_on" DATE NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "note" TEXT,
    "journal_entry_id" UUID NOT NULL,
    "voided_at" TIMESTAMPTZ(3),
    "voided_by" UUID,
    "reversal_journal_id" UUID,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_payments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "invoices_journal_entry_id_key" ON "invoices"("journal_entry_id");

CREATE INDEX "invoices_business_id_kind_status_due_date_idx" ON "invoices"("business_id", "kind", "status", "due_date");

CREATE INDEX "invoices_business_id_contact_id_idx" ON "invoices"("business_id", "contact_id");

CREATE UNIQUE INDEX "invoices_business_id_number_key" ON "invoices"("business_id", "number");

CREATE UNIQUE INDEX "invoice_lines_invoice_id_line_no_key" ON "invoice_lines"("invoice_id", "line_no");

CREATE UNIQUE INDEX "invoice_payments_journal_entry_id_key" ON "invoice_payments"("journal_entry_id");

CREATE UNIQUE INDEX "invoice_payments_reversal_journal_id_key" ON "invoice_payments"("reversal_journal_id");

CREATE INDEX "invoice_payments_invoice_id_paid_on_idx" ON "invoice_payments"("invoice_id", "paid_on");

ALTER TABLE "invoices" ADD CONSTRAINT "invoices_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "invoices" ADD CONSTRAINT "invoices_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "invoices" ADD CONSTRAINT "invoices_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "financial_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_reversal_journal_id_fkey" FOREIGN KEY ("reversal_journal_id") REFERENCES "journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Rules the code also checks, kept here so no path around the code can break them.
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_amounts_valid" CHECK ("total_minor" >= 0 AND "paid_minor" >= 0 AND "paid_minor" <= "total_minor");
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_due_after_issue" CHECK ("due_date" >= "issue_date");
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_number_when_issued" CHECK ("status" = 'DRAFT' OR "number" IS NOT NULL);
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_values_valid" CHECK ("quantity" > 0 AND "unit_price_minor" >= 0 AND "amount_minor" >= 0 AND length(btrim("description")) > 0);
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_amount_positive" CHECK ("amount_minor" > 0);

-- Drafts can be deleted (their lines go with them); issued ones are only ever voided.
GRANT SELECT, INSERT, UPDATE, DELETE ON "invoices" TO business_os_app;
GRANT SELECT, INSERT, DELETE ON "invoice_lines" TO business_os_app;
GRANT SELECT, INSERT, UPDATE ON "invoice_payments" TO business_os_app;

ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "invoices_isolation" ON "invoices" TO business_os_app
  USING (business_id = ANY (app_business_ids()))
  WITH CHECK (business_id = ANY (app_business_ids()));

ALTER TABLE "invoice_lines" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "invoice_lines_isolation" ON "invoice_lines" TO business_os_app
  USING (business_id = ANY (app_business_ids()))
  WITH CHECK (business_id = ANY (app_business_ids()));

ALTER TABLE "invoice_payments" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "invoice_payments_isolation" ON "invoice_payments" TO business_os_app
  USING (business_id = ANY (app_business_ids()))
  WITH CHECK (business_id = ANY (app_business_ids()));
