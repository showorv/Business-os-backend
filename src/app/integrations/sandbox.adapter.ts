import { z } from "zod";
import { hmacSha256Hex, safeEqual } from "../utils/crypto.js";
import { addDays } from "../utils/dates.js";
import { AdapterError, type CanonicalLine, type ConnectionContext, type IntegrationAdapter, type RawPage } from "./adapter.js";

// A pretend bank for trying the whole sync pipeline without any merchant account. It is never available
// in production. Its `mode` setting makes it misbehave on purpose, to exercise the failure paths.
const PAGE_SIZE = 2;
const WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;

const sandboxRecords = (): SandboxRecord[] => {
  const dayAgo = (days: number) => addDays(new Date(), -days).toISOString().slice(0, 10);
  return [
    { id: "sbx-1", date: dayAgo(4), kind: "CREDIT", amount: "12500.00", narration: "Customer payment", ref: "RCPT-1", balance: "62500.00" },
    { id: "sbx-2", date: dayAgo(3), kind: "DEBIT", amount: "3000.00", narration: "Facebook ads", ref: "FB-22", balance: "59500.00" },
    { id: "sbx-3", date: dayAgo(2), kind: "DEBIT", amount: "1850.50", narration: "Electricity bill", ref: "DESCO-9", balance: "57649.50" },
    { id: "sbx-4", date: dayAgo(1), kind: "CREDIT", amount: "4000.00", narration: "Shop sale", ref: null, balance: "61649.50" },
    { id: "sbx-5", date: dayAgo(1), kind: "DEBIT", amount: "500.00", narration: "Bank charge", ref: null, balance: "61149.50" },
  ];
};

interface SandboxRecord {
  id: string;
  date: string;
  kind: "CREDIT" | "DEBIT";
  amount: string;
  narration: string;
  ref: string | null;
  balance: string;
}

const failIfAsked = ({ secrets }: ConnectionContext) => {
  if (secrets.mode === "revoked") throw new AdapterError("NEEDS_REAUTH", "SANDBOX_REVOKED");
  if (secrets.mode === "flaky") throw new AdapterError("RETRYABLE", "SANDBOX_TIMEOUT");
  if (secrets.mode === "broken") throw new AdapterError("PERMANENT", "SANDBOX_BAD_REQUEST");
};

const toMinor = (amount: string) => BigInt(amount.replace(".", ""));

export const sandboxAdapter: IntegrationAdapter = {
  key: "sandbox",
  name: "Sandbox bank (practice only)",
  capabilities: { fetchHistory: true, webhooks: true, balance: true, paymentsInOnly: false },
  secretsSchema: z.strictObject({
    apiKey: z.string().min(1).max(200),
    webhookSecret: z.string().min(16).max(200).optional(),
    mode: z.enum(["normal", "revoked", "flaky", "broken"]).optional(),
  }) as z.ZodType<Record<string, string>>,

  authenticate: async (connection) => {
    failIfAsked(connection);
    return { expiresAt: null };
  },

  fetchTransactions: async (connection, cursor): Promise<RawPage> => {
    failIfAsked(connection);
    const start = Number(cursor ?? 0);
    const records = sandboxRecords();
    const end = start + PAGE_SIZE;
    return { records: records.slice(start, end), nextCursor: String(Math.min(end, records.length)), hasMore: end < records.length };
  },

  fetchBalance: async () => toMinor(sandboxRecords().at(-1)!.balance),

  verifyWebhook: (headers, rawBody, secrets) => {
    const timestamp = headers["x-sandbox-timestamp"];
    const signature = headers["x-sandbox-signature"];
    if (!secrets.webhookSecret || !timestamp || !signature) return false;
    if (Math.abs(Date.now() - Number(timestamp)) > WEBHOOK_TOLERANCE_MS) return false;
    return safeEqual(signature, hmacSha256Hex(secrets.webhookSecret, `${timestamp}.${rawBody.toString("utf8")}`));
  },

  normalize: (raw): CanonicalLine => {
    const record = raw as SandboxRecord;
    return {
      txnDate: record.date,
      direction: record.kind === "CREDIT" ? "IN" : "OUT",
      amountMinor: toMinor(record.amount),
      feeMinor: 0n,
      balanceAfterMinor: toMinor(record.balance),
      description: record.narration,
      reference: record.ref,
      counterparty: null,
      providerTxnId: record.id,
    };
  },
};
