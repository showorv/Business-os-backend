// How each transaction type becomes journal lines (architecture document, section 4.2).
// Pure functions with no database access, so they can be tested with thousands of random inputs.
// A new transaction type adds one rule here and nothing else changes.

export interface JournalLineInput {
  ledgerAccountId: string;
  debitMinor: bigint;
  creditMinor: bigint;
  memo?: string;
}

export const debit = (ledgerAccountId: string, amount: bigint, memo?: string): JournalLineInput => ({
  ledgerAccountId,
  debitMinor: amount,
  creditMinor: 0n,
  ...(memo ? { memo } : {}),
});

export const credit = (ledgerAccountId: string, amount: bigint, memo?: string): JournalLineInput => ({
  ledgerAccountId,
  debitMinor: 0n,
  creditMinor: amount,
  ...(memo ? { memo } : {}),
});

export const swapSides = (line: JournalLineInput): JournalLineInput => ({
  ...line,
  debitMinor: line.creditMinor,
  creditMinor: line.debitMinor,
});

export const totals = (lines: JournalLineInput[]) => ({
  debit: lines.reduce((sum, line) => sum + line.debitMinor, 0n),
  credit: lines.reduce((sum, line) => sum + line.creditMinor, 0n),
});

export interface PostingInput {
  type: "INCOME" | "EXPENSE" | "TRANSFER" | "REFUND" | "ADJUSTMENT";
  amountMinor: bigint;
  feeMinor: bigint;
  // The ledger account behind the financial account the money moves through.
  accountLedgerId: string;
  toAccountLedgerId?: string | null;
  categoryLedgerId?: string | null;
  // Which side the category is on, needed for an adjustment.
  categoryType?: "INCOME" | "EXPENSE" | null;
  salesReturnsLedgerId: string;
  bankChargesLedgerId: string;
}

const required = (id: string | null | undefined, what: string) => {
  if (!id) throw new Error(`posting rule needs ${what}`);
  return id;
};

type PostingRule = (input: PostingInput) => JournalLineInput[];

const RULES: Record<PostingInput["type"], PostingRule> = {
  // Money comes in: Dr where it landed, Cr the revenue it earned.
  INCOME: (input) => [
    debit(input.accountLedgerId, input.amountMinor),
    credit(required(input.categoryLedgerId, "a category"), input.amountMinor),
  ],

  // Money goes out: Dr what it was spent on, Cr where it left from.
  EXPENSE: (input) => [
    debit(required(input.categoryLedgerId, "a category"), input.amountMinor),
    credit(input.accountLedgerId, input.amountMinor),
  ],

  // Asset to asset, so it can never touch income or expense. A fee is the only part that does.
  TRANSFER: (input) => [
    debit(required(input.toAccountLedgerId, "a destination account"), input.amountMinor),
    credit(input.accountLedgerId, input.amountMinor),
    ...(input.feeMinor > 0n
      ? [debit(input.bankChargesLedgerId, input.feeMinor, "Transfer fee"), credit(input.accountLedgerId, input.feeMinor, "Transfer fee")]
      : []),
  ],

  // Reduces revenue through the contra-revenue account, leaving the original sale visible.
  REFUND: (input) => [debit(input.salesReturnsLedgerId, input.amountMinor), credit(input.accountLedgerId, input.amountMinor)],

  // An income category adds money to the account; an expense category takes it out.
  ADJUSTMENT: (input) =>
    input.categoryType === "INCOME"
      ? RULES.INCOME(input)
      : RULES.EXPENSE(input),
};

export const buildTransactionLines = (input: PostingInput) => RULES[input.type](input);
