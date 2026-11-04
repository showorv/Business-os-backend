-- pgvector stores the embeddings. Neon and the local Docker image both include it.
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "AiMessageRole" AS ENUM ('USER', 'ASSISTANT');

-- CreateEnum
CREATE TYPE "AiProposalKind" AS ENUM ('TRANSACTION', 'TASK');

-- CreateEnum
CREATE TYPE "AiProposalStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED', 'EXPIRED');

-- CreateTable
CREATE TABLE "document_chunks" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "page" INTEGER NOT NULL,
    "heading" TEXT,
    "content" TEXT NOT NULL,
    "embedding" vector(384) NOT NULL,
    "search" tsvector GENERATED ALWAYS AS (to_tsvector('simple', "content")) STORED,
    "embedding_model" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_conversations" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ai_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "AiMessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "language" VARCHAR(10),
    "sources" JSONB NOT NULL DEFAULT '[]',
    "guard_status" TEXT,
    "model" TEXT,
    "prompt_tokens" INTEGER NOT NULL DEFAULT 0,
    "completion_tokens" INTEGER NOT NULL DEFAULT 0,
    "latency_ms" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_tool_calls" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "tool" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "row_count" INTEGER NOT NULL DEFAULT 0,
    "latency_ms" INTEGER NOT NULL,
    "error_code" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_tool_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_proposals" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "AiProposalKind" NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "AiProposalStatus" NOT NULL DEFAULT 'PENDING',
    "result_id" UUID,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "decided_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "document_chunks_business_id_idx" ON "document_chunks"("business_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_chunks_document_id_chunk_index_key" ON "document_chunks"("document_id", "chunk_index");

-- CreateIndex
CREATE INDEX "ai_conversations_user_id_id_idx" ON "ai_conversations"("user_id", "id" DESC);

-- CreateIndex
CREATE INDEX "ai_messages_conversation_id_id_idx" ON "ai_messages"("conversation_id", "id");

-- CreateIndex
CREATE INDEX "ai_messages_workspace_id_created_at_idx" ON "ai_messages"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_messages_user_id_created_at_idx" ON "ai_messages"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_tool_calls_message_id_idx" ON "ai_tool_calls"("message_id");

-- CreateIndex
CREATE INDEX "ai_proposals_user_id_status_idx" ON "ai_proposals"("user_id", "status");

-- CreateIndex
CREATE INDEX "ai_proposals_business_id_idx" ON "ai_proposals"("business_id");

-- AddForeignKey
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_tool_calls" ADD CONSTRAINT "ai_tool_calls_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "ai_messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_proposals" ADD CONSTRAINT "ai_proposals_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_proposals" ADD CONSTRAINT "ai_proposals_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- ---------------------------------------------------------------------------
-- Search indexes
-- ---------------------------------------------------------------------------
CREATE INDEX document_chunks_embedding_idx ON "document_chunks" USING hnsw ("embedding" vector_cosine_ops);
CREATE INDEX document_chunks_search_idx ON "document_chunks" USING gin ("search");

-- ---------------------------------------------------------------------------
-- Restricted role for the app's own AI records
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON "ai_conversations", "ai_proposals" TO business_os_app;
GRANT SELECT, INSERT ON "ai_messages", "ai_tool_calls" TO business_os_app;
-- The worker writes chunks. Deleting a document removes them, through the restricted role.
GRANT SELECT, DELETE ON "document_chunks" TO business_os_app;

ALTER TABLE "document_chunks" ENABLE ROW LEVEL SECURITY;
CREATE POLICY document_chunks_isolation ON "document_chunks" TO business_os_app
  USING (business_id = ANY (app_business_ids())) WITH CHECK (business_id = ANY (app_business_ids()));

DO $$
DECLARE
  table_name text;
BEGIN
  -- These belong to the person chatting.
  FOREACH table_name IN ARRAY ARRAY['ai_conversations', 'ai_messages', 'ai_tool_calls', 'ai_proposals'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I TO business_os_app USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id())',
      table_name || '_owner', table_name
    );
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- The AI's read-only role: it can read these views and nothing else
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'readonly_ai') THEN
    CREATE ROLE readonly_ai NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO readonly_ai', current_schema());
  EXECUTE format('GRANT readonly_ai TO %I WITH SET TRUE', current_user);
END
$$;

-- Each view has the session's business list built into it. They run with their owner's rights, which
-- is why readonly_ai needs no access to any table, and why that filter must stay in every one.
CREATE VIEW ai_businesses AS
  SELECT id AS business_id, name, base_currency, timezone, status
  FROM businesses WHERE id = ANY (app_business_ids());

CREATE VIEW ai_ledger_daily AS
  SELECT e.business_id, e.entry_date, e.kind::text AS kind, a.id AS account_id, a.code, a.name, a.name_bn,
    a.type::text AS type, a.cash_flow_class::text AS cash_flow_class,
    SUM(l.debit_minor) AS debit_minor, SUM(l.credit_minor) AS credit_minor,
    EXISTS (SELECT 1 FROM financial_accounts f WHERE f.ledger_account_id = a.id) AS is_cash
  FROM journal_lines l
  JOIN journal_entries e ON e.id = l.journal_entry_id
  JOIN ledger_accounts a ON a.id = l.ledger_account_id
  WHERE e.business_id = ANY (app_business_ids())
  GROUP BY e.business_id, e.entry_date, e.kind, a.id;

-- What moved in and out of cash, by the other side of each entry. Same rule as the cash flow report.
CREATE VIEW ai_cash_flow AS
  SELECT e.business_id, e.entry_date, a.code, a.name, a.name_bn, a.cash_flow_class::text AS cash_flow_class,
    SUM(l.credit_minor - l.debit_minor) AS net_minor
  FROM journal_lines l
  JOIN journal_entries e ON e.id = l.journal_entry_id
  JOIN ledger_accounts a ON a.id = l.ledger_account_id
  WHERE e.business_id = ANY (app_business_ids())
    AND e.kind::text NOT IN ('OPENING', 'CLOSING')
    AND NOT EXISTS (SELECT 1 FROM financial_accounts f WHERE f.ledger_account_id = a.id)
    AND EXISTS (
      SELECT 1 FROM journal_lines cash
      JOIN financial_accounts f ON f.ledger_account_id = cash.ledger_account_id
      WHERE cash.journal_entry_id = e.id
    )
  GROUP BY e.business_id, e.entry_date, a.id;

CREATE VIEW ai_financial_accounts AS
  SELECT id AS account_id, business_id, name, type::text AS type, currency, current_balance_minor, ledger_account_id
  FROM financial_accounts WHERE is_active AND business_id = ANY (app_business_ids());

CREATE VIEW ai_categories AS
  SELECT id AS category_id, business_id, name::text AS name, name_bn, type::text AS type
  FROM categories WHERE is_active AND business_id = ANY (app_business_ids());

CREATE VIEW ai_budget_lines AS
  SELECT b.business_id, b.id AS budget_id, b.name AS budget_name, b.start_month, b.end_month,
    c.name::text AS category, c.name_bn AS category_bn, c.type::text AS category_type, l.amount_minor, l.alert_percent,
    COALESCE(SUM(CASE WHEN c.type::text = 'EXPENSE' THEN r.debit_minor - r.credit_minor ELSE r.credit_minor - r.debit_minor END), 0) AS actual_minor
  FROM budget_lines l
  JOIN budgets b ON b.id = l.budget_id
  JOIN categories c ON c.id = l.category_id
  LEFT JOIN ledger_monthly_rollups r
    ON r.ledger_account_id = c.ledger_account_id AND r.month BETWEEN b.start_month AND b.end_month
  WHERE b.status::text = 'ACTIVE' AND b.business_id = ANY (app_business_ids())
  GROUP BY b.id, c.id, l.id;

CREATE VIEW ai_goals AS
  SELECT business_id, id AS goal_id, name, metric::text AS metric, target_minor, start_month, end_month, status::text AS status
  FROM goals WHERE business_id = ANY (app_business_ids());

CREATE VIEW ai_tasks AS
  SELECT business_id, id AS task_id, title, status::text AS status, priority::text AS priority, assignee_id, due_at
  FROM tasks WHERE business_id = ANY (app_business_ids());

CREATE VIEW ai_recurring_schedules AS
  SELECT business_id, id AS schedule_id, name, kind::text AS kind, type::text AS type, rrule, start_date, timezone, next_run_at, amount_minor
  FROM recurring_schedules WHERE status::text = 'ACTIVE' AND business_id = ANY (app_business_ids());

CREATE VIEW ai_reminders AS
  SELECT business_id, id AS reminder_id, title, next_occurrence_at, source_type::text AS source_type
  FROM reminders WHERE status::text = 'ACTIVE' AND source_type::text = 'MANUAL' AND business_id = ANY (app_business_ids());

-- Only passages of live documents can be searched.
CREATE VIEW ai_document_chunks AS
  SELECT c.id AS chunk_id, c.business_id, c.document_id, d.file_name, d.type::text AS document_type, c.page, c.heading,
    c.content, c.embedding, c.search, c.embedding_model
  FROM document_chunks c
  JOIN documents d ON d.id = c.document_id
  WHERE d.deleted_at IS NULL AND d.status::text = 'READY' AND c.business_id = ANY (app_business_ids());

GRANT SELECT ON ai_businesses, ai_ledger_daily, ai_cash_flow, ai_financial_accounts, ai_categories, ai_budget_lines,
  ai_goals, ai_tasks, ai_recurring_schedules, ai_reminders, ai_document_chunks TO readonly_ai;
