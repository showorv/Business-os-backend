-- CreateEnum
CREATE TYPE "BusinessType" AS ENUM ('RETAIL', 'SERVICES', 'AGENCY', 'ECOMMERCE', 'MANUFACTURING', 'CUSTOM');

-- CreateEnum
CREATE TYPE "BusinessStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "MemberStatus" AS ENUM ('ACTIVE', 'REMOVED');

-- CreateTable
CREATE TABLE "businesses" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "legal_name" TEXT,
    "tax_id" TEXT,
    "type" "BusinessType" NOT NULL,
    "base_currency" CHAR(3) NOT NULL,
    "fiscal_year_start_month" SMALLINT NOT NULL,
    "timezone" TEXT NOT NULL,
    "status" "BusinessStatus" NOT NULL DEFAULT 'ACTIVE',
    "settings" JSONB NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "businesses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_members" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "status" "MemberStatus" NOT NULL DEFAULT 'ACTIVE',
    "extra_permissions" TEXT[],
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "business_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "role_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "workspace_id" UUID,
    "key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "key" TEXT NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" UUID NOT NULL,
    "permission_key" TEXT NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_key")
);

-- CreateIndex
CREATE INDEX "businesses_workspace_id_idx" ON "businesses"("workspace_id");

-- CreateIndex
CREATE INDEX "business_members_user_id_idx" ON "business_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "business_members_business_id_user_id_key" ON "business_members"("business_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations"("token_hash");

-- CreateIndex
CREATE INDEX "invitations_business_id_email_idx" ON "invitations"("business_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "roles_workspace_id_key_key" ON "roles"("workspace_id", "key");

-- AddForeignKey
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_members" ADD CONSTRAINT "business_members_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_members" ADD CONSTRAINT "business_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_members" ADD CONSTRAINT "business_members_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_key_fkey" FOREIGN KEY ("permission_key") REFERENCES "permissions"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written below: Prisma cannot express partial indexes, seed data, roles or RLS.

-- workspace_id is NULL for system roles, and a normal unique index treats NULLs as different.
CREATE UNIQUE INDEX "roles_system_key_unique" ON "roles"("key") WHERE "workspace_id" IS NULL;

-- ---------------------------------------------------------------------------
-- Permissions and system roles (architecture document, section 11.3)
-- ---------------------------------------------------------------------------
INSERT INTO "permissions" ("key") VALUES
  ('business.manage'), ('members.manage'),
  ('finance.read'), ('finance.write'),
  ('ledger.post'), ('ledger.reverse'), ('period.close'),
  ('transactions.approve'), ('integrations.manage'),
  ('tasks.read'), ('tasks.write'),
  ('documents.read'), ('documents.write'),
  ('ai.use'), ('audit.read');

INSERT INTO "roles" ("id", "key")
SELECT gen_random_uuid(), role_key
FROM unnest(ARRAY['OWNER', 'ADMIN', 'ACCOUNTANT', 'MANAGER', 'VIEWER']) AS role_key;

INSERT INTO "role_permissions" ("role_id", "permission_key")
SELECT r."id", grant_row.permission_key
FROM (VALUES
  ('OWNER', 'business.manage'), ('OWNER', 'members.manage'), ('OWNER', 'finance.read'), ('OWNER', 'finance.write'),
  ('OWNER', 'ledger.post'), ('OWNER', 'ledger.reverse'), ('OWNER', 'period.close'), ('OWNER', 'transactions.approve'),
  ('OWNER', 'integrations.manage'), ('OWNER', 'tasks.read'), ('OWNER', 'tasks.write'), ('OWNER', 'documents.read'),
  ('OWNER', 'documents.write'), ('OWNER', 'ai.use'), ('OWNER', 'audit.read'),

  ('ADMIN', 'business.manage'), ('ADMIN', 'members.manage'), ('ADMIN', 'finance.read'), ('ADMIN', 'finance.write'),
  ('ADMIN', 'ledger.post'), ('ADMIN', 'ledger.reverse'), ('ADMIN', 'period.close'), ('ADMIN', 'transactions.approve'),
  ('ADMIN', 'integrations.manage'), ('ADMIN', 'tasks.read'), ('ADMIN', 'tasks.write'), ('ADMIN', 'documents.read'),
  ('ADMIN', 'documents.write'), ('ADMIN', 'ai.use'), ('ADMIN', 'audit.read'),

  ('ACCOUNTANT', 'finance.read'), ('ACCOUNTANT', 'finance.write'), ('ACCOUNTANT', 'ledger.post'),
  ('ACCOUNTANT', 'ledger.reverse'), ('ACCOUNTANT', 'period.close'), ('ACCOUNTANT', 'tasks.read'),
  ('ACCOUNTANT', 'tasks.write'), ('ACCOUNTANT', 'documents.read'), ('ACCOUNTANT', 'documents.write'),
  ('ACCOUNTANT', 'ai.use'),

  ('MANAGER', 'tasks.read'), ('MANAGER', 'tasks.write'), ('MANAGER', 'documents.read'),
  ('MANAGER', 'documents.write'), ('MANAGER', 'ai.use'),

  ('VIEWER', 'tasks.read'), ('VIEWER', 'documents.read'), ('VIEWER', 'ai.use')
) AS grant_row(role_key, permission_key)
JOIN "roles" r ON r."key" = grant_row.role_key AND r."workspace_id" IS NULL;

-- ---------------------------------------------------------------------------
-- Restricted database role
--
-- The connecting role (superuser in Docker, neondb_owner on Neon) bypasses RLS. So every business
-- transaction switches to this role first (see src/lib/rls.ts). It cannot log in, and it has no
-- DELETE anywhere and no UPDATE on audit_logs.
-- ---------------------------------------------------------------------------
-- Without this, PostgreSQL 16+ gives the creator ADMIN on the new role but not the right to SET it.
SET LOCAL createrole_self_grant = 'set';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_os_app') THEN
    CREATE ROLE business_os_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

DO $$
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO business_os_app', current_schema());
END
$$;

GRANT SELECT ON "roles", "permissions", "role_permissions" TO business_os_app;
GRANT SELECT, INSERT, UPDATE ON "businesses", "business_members", "invitations" TO business_os_app;
GRANT SELECT, INSERT ON "audit_logs" TO business_os_app;
GRANT USAGE ON SEQUENCE "audit_logs_id_seq" TO business_os_app;

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------
-- '' is what a SET LOCAL value becomes once its transaction ends, so it must read as "no access".
CREATE FUNCTION app_business_ids() RETURNS uuid[] AS $$
  SELECT COALESCE(NULLIF(current_setting('app.business_ids', true), '')::uuid[], '{}'::uuid[]);
$$ LANGUAGE sql STABLE;

ALTER TABLE "businesses" ENABLE ROW LEVEL SECURITY;
CREATE POLICY businesses_isolation ON "businesses" TO business_os_app
  USING ("id" = ANY (app_business_ids()))
  WITH CHECK ("id" = ANY (app_business_ids()));

ALTER TABLE "business_members" ENABLE ROW LEVEL SECURITY;
CREATE POLICY business_members_isolation ON "business_members" TO business_os_app
  USING ("business_id" = ANY (app_business_ids()))
  WITH CHECK ("business_id" = ANY (app_business_ids()));

ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY invitations_isolation ON "invitations" TO business_os_app
  USING ("business_id" = ANY (app_business_ids()))
  WITH CHECK ("business_id" = ANY (app_business_ids()));

ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_logs_isolation ON "audit_logs" TO business_os_app
  USING ("business_id" = ANY (app_business_ids()))
  WITH CHECK ("business_id" = ANY (app_business_ids()));

-- The hash chain spans a whole workspace, but RLS only shows the restricted role its own business.
-- This runs as the migration owner, so it can read the chain head and returns only that hash.
CREATE FUNCTION audit_chain_head(chain_workspace_id uuid) RETURNS bytea AS $$
  SELECT "row_hash" FROM "audit_logs"
  WHERE "workspace_id" IS NOT DISTINCT FROM chain_workspace_id
  ORDER BY "id" DESC
  LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION audit_chain_head(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_chain_head(uuid) TO business_os_app;
