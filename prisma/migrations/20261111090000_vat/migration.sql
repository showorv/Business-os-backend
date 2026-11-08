-- Step 11.6: VAT on invoice and bill lines.

ALTER TABLE "invoice_lines" ADD COLUMN "vat_minor" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN "vat_rate_bp" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "invoices" ADD COLUMN "subtotal_minor" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN "vat_minor" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN "vat_recoverable" BOOLEAN NOT NULL DEFAULT false;

-- Invoices made before VAT had none: their subtotal is their total.
UPDATE "invoices" SET "subtotal_minor" = "total_minor";

CREATE INDEX "invoices_business_id_issue_date_idx" ON "invoices"("business_id", "issue_date");

ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_vat_valid" CHECK ("vat_rate_bp" BETWEEN 0 AND 10000 AND "vat_minor" >= 0);
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_total_adds_up" CHECK ("vat_minor" >= 0 AND "subtotal_minor" >= 0 AND "total_minor" = "subtotal_minor" + "vat_minor");
