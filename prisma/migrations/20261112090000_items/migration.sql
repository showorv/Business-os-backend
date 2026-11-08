-- Step 11.7: saved items (what the business sells or buys) and which item an invoice line came from.
-- No stock is counted; prices and the VAT rate are starting values for a line.

CREATE TABLE "items" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "unit" TEXT,
    "description" TEXT,
    "sale_price_minor" BIGINT,
    "purchase_price_minor" BIGINT,
    "vat_rate_bp" INTEGER NOT NULL DEFAULT 0,
    "income_category_id" UUID,
    "expense_category_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "items_business_id_is_active_name_idx" ON "items"("business_id", "is_active", "name");
ALTER TABLE "items" ADD CONSTRAINT "items_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "items" ADD CONSTRAINT "items_income_category_id_fkey" FOREIGN KEY ("income_category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "items" ADD CONSTRAINT "items_expense_category_id_fkey" FOREIGN KEY ("expense_category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Checks the app also makes, kept in the database too.
ALTER TABLE "items" ADD CONSTRAINT "items_name_not_blank" CHECK (length(btrim("name")) > 0);
ALTER TABLE "items" ADD CONSTRAINT "items_prices_valid" CHECK (
    ("sale_price_minor" IS NULL OR "sale_price_minor" >= 0)
    AND ("purchase_price_minor" IS NULL OR "purchase_price_minor" >= 0)
    AND "vat_rate_bp" BETWEEN 0 AND 10000
);
-- One name per business, whatever the letter case.
CREATE UNIQUE INDEX "items_business_id_name_key" ON "items"("business_id", lower("name"));

ALTER TABLE "invoice_lines" ADD COLUMN "item_id" UUID,
ADD COLUMN "unit" TEXT;
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "invoice_lines_business_id_item_id_idx" ON "invoice_lines"("business_id", "item_id");

-- Items are never deleted, only archived.
GRANT SELECT, INSERT, UPDATE ON "items" TO business_os_app;

ALTER TABLE "items" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "items_isolation" ON "items" TO business_os_app
  USING (business_id = ANY (app_business_ids()))
  WITH CHECK (business_id = ANY (app_business_ids()));
