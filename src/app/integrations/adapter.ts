import type { z } from "zod";

// The one shape every provider fits. A new bank is one new file and one line in registry.ts, and the
// finance code never changes.
export interface AdapterCapabilities {
  fetchHistory: boolean;
  webhooks: boolean;
  balance: boolean;
  // A merchant API usually only shows money paid to the merchant, not everything on the account.
  paymentsInOnly: boolean;
}

export interface ConnectionContext {
  connectionId: string;
  secrets: Record<string, string>;
}

export interface RawPage {
  records: unknown[];
  nextCursor: string | null;
  hasMore: boolean;
}

// What every source turns into, whatever it started as.
export interface CanonicalLine {
  txnDate: string;
  direction: "IN" | "OUT";
  amountMinor: bigint;
  feeMinor: bigint;
  balanceAfterMinor: bigint | null;
  description: string | null;
  reference: string | null;
  counterparty: string | null;
  providerTxnId: string | null;
}

export interface IntegrationAdapter {
  key: string;
  name: string;
  capabilities: AdapterCapabilities;
  // Only ever app-level keys and tokens. A strict schema refuses anything else, including passwords.
  secretsSchema: z.ZodType<Record<string, string>>;
  authenticate(connection: ConnectionContext): Promise<{ expiresAt: Date | null }>;
  // Read-only: nothing here can move money.
  fetchTransactions(connection: ConnectionContext, cursor: string | null): Promise<RawPage>;
  fetchBalance?(connection: ConnectionContext): Promise<bigint | null>;
  verifyWebhook?(headers: Record<string, string | undefined>, rawBody: Buffer, secrets: Record<string, string>): boolean;
  normalize(raw: unknown): CanonicalLine;
}

// Tells the sync job what to do next, which is the only thing it needs to know about a failure.
export type AdapterFailure = "RETRYABLE" | "NEEDS_REAUTH" | "PERMANENT";

export class AdapterError extends Error {
  constructor(
    public readonly failure: AdapterFailure,
    public readonly code: string,
  ) {
    super(code);
    this.name = "AdapterError";
  }
}

// How a provider's HTTP status maps to that, for any adapter that calls an API.
export const failureFromStatus = (status: number): AdapterFailure => {
  if (status === 401 || status === 403) return "NEEDS_REAUTH";
  return status === 429 || status >= 500 ? "RETRYABLE" : "PERMANENT";
};

const SECRET_KEYS = /token|secret|password|passwd|pin\b|otp|authorization|api[-_]?key|signature|cookie/i;
const PERSONAL_KEYS = /msisdn|phone|mobile|account[-_]?(no|number)|card|nid/i;

// Run on anything from a provider before it is stored or logged.
export const redactPayload = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactPayload);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => {
      if (SECRET_KEYS.test(key)) return [key, "[REDACTED]"];
      if (PERSONAL_KEYS.test(key) && typeof inner !== "object") return [key, `***${String(inner).slice(-3)}`];
      return [key, redactPayload(inner)];
    }),
  );
};
