import { z } from "zod";
import { normalizeDigits } from "./normalize.js";

// All money is BIGINT minor units (paisa for BDT). It enters and leaves the API as a string of
// digits, because JSON numbers lose precision. 18 digits always fits in a PostgreSQL BIGINT.
const minorUnitsPattern = /^\d{1,18}$/;

// abort: stop here on bad input, because later checks call BigInt(), which throws on it.
export const minorAmountField = z.string().overwrite(normalizeDigits).trim().regex(minorUnitsPattern, { abort: true });

export const positiveMinorAmountField = minorAmountField.refine((value) => BigInt(value) > 0n, {
  message: "AMOUNT_MUST_BE_POSITIVE",
});

// For balances, which can go below zero, such as an overdrawn account on a statement.
export const signedMinorAmountField = z.string().overwrite(normalizeDigits).trim().regex(/^-?\d{1,18}$/, { abort: true });

export const bigintToString = (_key: string, value: unknown) => (typeof value === "bigint" ? value.toString() : value);
