-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL', 'PUSH');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'QUEUED', 'SENT', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReminderStatus" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReminderSource" AS ENUM ('MANUAL', 'TASK', 'RECURRING_SCHEDULE');

-- CreateEnum
CREATE TYPE "ScheduleKind" AS ENUM ('TRANSACTION', 'SALARY');

-- CreateEnum
CREATE TYPE "ScheduleStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ENDED');

-- CreateEnum
CREATE TYPE "ScheduleRunStatus" AS ENUM ('CREATED', 'FAILED');

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "workspace_id" UUID,
    "business_id" UUID,
    "user_id" UUID,
    "email" CITEXT,
    "locale" VARCHAR(10),
    "type" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "entity_type" TEXT,
    "entity_id" UUID,
    "dedupe_key" TEXT NOT NULL,
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" UUID NOT NULL,
    "notification_id" UUID NOT NULL,
    "user_id" UUID,
    "channel" "NotificationChannel" NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "send_after" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error_code" TEXT,
    "queued_at" TIMESTAMPTZ(3),
    "sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "user_id" UUID NOT NULL,
    "email_enabled" BOOLEAN NOT NULL DEFAULT true,
    "push_enabled" BOOLEAN NOT NULL DEFAULT true,
    "quiet_hours_start" VARCHAR(5),
    "quiet_hours_end" VARCHAR(5),
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Dhaka',
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "push_subscriptions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "assignee_id" UUID,
    "priority" "TaskPriority" NOT NULL DEFAULT 'MEDIUM',
    "status" "TaskStatus" NOT NULL DEFAULT 'TODO',
    "due_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_comments" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_attachments" (
    "task_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_attachments_pkey" PRIMARY KEY ("task_id","document_id")
);

-- CreateTable
CREATE TABLE "reminders" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "rrule" TEXT,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "timezone" TEXT NOT NULL,
    "lead_minutes" INTEGER NOT NULL DEFAULT 0,
    "next_occurrence_at" TIMESTAMPTZ(3),
    "next_fire_at" TIMESTAMPTZ(3),
    "last_fired_at" TIMESTAMPTZ(3),
    "channels" TEXT[],
    "recipient_user_id" UUID NOT NULL,
    "source_type" "ReminderSource" NOT NULL DEFAULT 'MANUAL',
    "source_id" UUID,
    "status" "ReminderStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recurring_schedules" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ScheduleKind" NOT NULL DEFAULT 'TRANSACTION',
    "rrule" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "timezone" TEXT NOT NULL,
    "next_run_at" TIMESTAMPTZ(3),
    "type" "TransactionType" NOT NULL,
    "account_id" UUID NOT NULL,
    "to_account_id" UUID,
    "category_id" UUID,
    "amount_minor" BIGINT NOT NULL,
    "fee_minor" BIGINT NOT NULL DEFAULT 0,
    "description" TEXT,
    "auto_post" BOOLEAN NOT NULL DEFAULT false,
    "remind_days_before" INTEGER,
    "status" "ScheduleStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "recurring_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recurring_runs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "schedule_id" UUID NOT NULL,
    "occurrence_date" DATE NOT NULL,
    "status" "ScheduleRunStatus" NOT NULL,
    "transaction_id" UUID,
    "error_code" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recurring_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notifications_dedupe_key_key" ON "notifications"("dedupe_key");

-- CreateIndex
CREATE INDEX "notifications_user_id_id_idx" ON "notifications"("user_id", "id" DESC);

-- CreateIndex
CREATE INDEX "notification_deliveries_status_send_after_idx" ON "notification_deliveries"("status", "send_after");

-- CreateIndex
CREATE UNIQUE INDEX "notification_deliveries_notification_id_channel_key" ON "notification_deliveries"("notification_id", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");

-- CreateIndex
CREATE INDEX "push_subscriptions_user_id_idx" ON "push_subscriptions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_tokens"("user_id");

-- CreateIndex
CREATE INDEX "tasks_business_id_id_idx" ON "tasks"("business_id", "id" DESC);

-- CreateIndex
CREATE INDEX "tasks_assignee_id_status_idx" ON "tasks"("assignee_id", "status");

-- CreateIndex
CREATE INDEX "tasks_status_due_at_idx" ON "tasks"("status", "due_at");

-- CreateIndex
CREATE INDEX "task_comments_task_id_id_idx" ON "task_comments"("task_id", "id");

-- CreateIndex
CREATE INDEX "task_comments_business_id_idx" ON "task_comments"("business_id");

-- CreateIndex
CREATE INDEX "task_attachments_business_id_idx" ON "task_attachments"("business_id");

-- CreateIndex
CREATE INDEX "reminders_business_id_id_idx" ON "reminders"("business_id", "id" DESC);

-- CreateIndex
CREATE INDEX "reminders_status_next_fire_at_idx" ON "reminders"("status", "next_fire_at");

-- CreateIndex
CREATE INDEX "reminders_source_type_source_id_idx" ON "reminders"("source_type", "source_id");

-- CreateIndex
CREATE INDEX "recurring_schedules_business_id_id_idx" ON "recurring_schedules"("business_id", "id" DESC);

-- CreateIndex
CREATE INDEX "recurring_schedules_status_next_run_at_idx" ON "recurring_schedules"("status", "next_run_at");

-- CreateIndex
CREATE INDEX "recurring_runs_business_id_idx" ON "recurring_runs"("business_id");

-- CreateIndex
CREATE UNIQUE INDEX "recurring_runs_schedule_id_occurrence_date_key" ON "recurring_runs"("schedule_id", "occurrence_date");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_attachments" ADD CONSTRAINT "task_attachments_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_attachments" ADD CONSTRAINT "task_attachments_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_schedules" ADD CONSTRAINT "recurring_schedules_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_runs" ADD CONSTRAINT "recurring_runs_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "recurring_schedules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_runs" ADD CONSTRAINT "recurring_runs_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Rules the database enforces itself
-- ---------------------------------------------------------------------------
ALTER TABLE "reminders"
  ADD CONSTRAINT reminders_lead_minutes_valid CHECK ("lead_minutes" >= 0),
  ADD CONSTRAINT reminders_channels_valid CHECK ("channels" <@ ARRAY['IN_APP', 'EMAIL', 'PUSH']::text[] AND cardinality("channels") > 0);

-- A task or schedule has at most one reminder, which it keeps up to date.
CREATE UNIQUE INDEX reminders_one_per_source ON "reminders" ("source_type", "source_id") WHERE "source_id" IS NOT NULL;

ALTER TABLE "recurring_schedules"
  ADD CONSTRAINT recurring_schedules_amount_positive CHECK ("amount_minor" > 0),
  ADD CONSTRAINT recurring_schedules_fee_valid CHECK ("fee_minor" >= 0),
  ADD CONSTRAINT recurring_schedules_remind_days_valid CHECK ("remind_days_before" IS NULL OR "remind_days_before" >= 0);

ALTER TABLE "notifications"
  ADD CONSTRAINT notifications_has_recipient CHECK ("user_id" IS NOT NULL OR "email" IS NOT NULL);

ALTER TABLE "notification_preferences"
  ADD CONSTRAINT notification_preferences_quiet_hours_valid CHECK (
    ("quiet_hours_start" IS NULL) = ("quiet_hours_end" IS NULL)
  );

-- ---------------------------------------------------------------------------
-- Restricted role
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON "tasks", "reminders", "recurring_schedules" TO business_os_app;
GRANT SELECT, INSERT ON "task_comments" TO business_os_app;
GRANT SELECT, INSERT, DELETE ON "task_attachments" TO business_os_app;
-- The worker writes runs, deliveries and new notifications, through its normal connection.
GRANT SELECT ON "recurring_runs", "notification_deliveries" TO business_os_app;
GRANT SELECT, UPDATE ON "notifications" TO business_os_app;
GRANT SELECT, INSERT, UPDATE ON "notification_preferences" TO business_os_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "push_subscriptions" TO business_os_app;

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'tasks', 'task_comments', 'task_attachments', 'reminders', 'recurring_schedules', 'recurring_runs'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I TO business_os_app USING (business_id = ANY (app_business_ids())) WITH CHECK (business_id = ANY (app_business_ids()))',
      table_name || '_isolation', table_name
    );
  END LOOP;

  -- These belong to a person, not a business.
  FOREACH table_name IN ARRAY ARRAY[
    'notifications', 'notification_deliveries', 'notification_preferences', 'push_subscriptions'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I TO business_os_app USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id())',
      table_name || '_owner', table_name
    );
  END LOOP;
END
$$;

-- The restricted role has no grant and no policy here: only the auth service may touch these.
ALTER TABLE "password_reset_tokens" ENABLE ROW LEVEL SECURITY;
