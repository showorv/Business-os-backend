-- Step 11.4: customers and suppliers, and which one a transaction was with.

CREATE TYPE "ContactKind" AS ENUM ('CUSTOMER', 'SUPPLIER', 'BOTH');

CREATE TABLE "contacts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "kind" "ContactKind" NOT NULL,
    "name" TEXT NOT NULL,
    "company" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "tax_id" TEXT,
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "contacts_business_id_is_active_name_idx" ON "contacts"("business_id", "is_active", "name");
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_name_not_blank" CHECK (length(btrim("name")) > 0);

ALTER TABLE "transactions" ADD COLUMN "contact_id" UUID;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "transactions_business_id_contact_id_txn_date_idx" ON "transactions"("business_id", "contact_id", "txn_date" DESC);

-- Contacts are never deleted, only archived.
GRANT SELECT, INSERT, UPDATE ON "contacts" TO business_os_app;

ALTER TABLE "contacts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "contacts_isolation" ON "contacts" TO business_os_app
  USING (business_id = ANY (app_business_ids()))
  WITH CHECK (business_id = ANY (app_business_ids()));
