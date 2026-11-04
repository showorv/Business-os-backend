// Mirrors the permissions table seeded by migration. To add one: add it here and in a new migration.
export const Permission = {
  BUSINESS_MANAGE: "business.manage",
  MEMBERS_MANAGE: "members.manage",
  FINANCE_READ: "finance.read",
  FINANCE_WRITE: "finance.write",
  LEDGER_POST: "ledger.post",
  LEDGER_REVERSE: "ledger.reverse",
  PERIOD_CLOSE: "period.close",
  TRANSACTIONS_APPROVE: "transactions.approve",
  INTEGRATIONS_MANAGE: "integrations.manage",
  TASKS_READ: "tasks.read",
  TASKS_WRITE: "tasks.write",
  DOCUMENTS_READ: "documents.read",
  DOCUMENTS_WRITE: "documents.write",
  AI_USE: "ai.use",
  AUDIT_READ: "audit.read",
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

export const RoleKey = {
  OWNER: "OWNER",
  ADMIN: "ADMIN",
  ACCOUNTANT: "ACCOUNTANT",
  MANAGER: "MANAGER",
  VIEWER: "VIEWER",
} as const;

export type RoleKey = (typeof RoleKey)[keyof typeof RoleKey];

// Marked "optional" in the document's role table: not part of the role, but grantable per member.
export const OPTIONAL_PERMISSIONS: Partial<Record<RoleKey, Permission[]>> = {
  MANAGER: [Permission.FINANCE_READ],
  VIEWER: [Permission.FINANCE_READ],
};
