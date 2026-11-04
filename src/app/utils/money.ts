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

// Digits after the decimal point in a currency: 2 for BDT, 0 for JPY, 3 for KWD.
export const minorDigitsOf = (currency: string) =>
  new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;

const divideRounded = (numerator: bigint, denominator: bigint) => {
  const negative = numerator < 0n !== denominator < 0n;
  const top = numerator < 0n ? -numerator : numerator;
  const bottom = denominator < 0n ? -denominator : denominator;
  const rounded = (top * 2n + bottom) / (bottom * 2n);
  return negative ? -rounded : rounded;
};

const RATE_SCALE = 1_000_000n;

// Whole-number maths at 6 decimals, the precision rates are stored in, so nothing passes through a float.
export const convertMinor = (
  amount: bigint,
  rate: string,
  fromCurrency: string,
  toCurrency: string,
  inverted = false,
) => {
  const rateMicro = BigInt(Number(rate).toFixed(6).replace(".", ""));
  const digitShift = 10n ** BigInt(minorDigitsOf(toCurrency));
  const digitBase = 10n ** BigInt(minorDigitsOf(fromCurrency));
  return inverted
    ? divideRounded(amount * RATE_SCALE * digitShift, rateMicro * digitBase)
    : divideRounded(amount * rateMicro * digitShift, RATE_SCALE * digitBase);
};

// "12.50" for 12.5%. Null when the base is zero, because a percentage of nothing has no meaning.
export const percentOf = (part: bigint, whole: bigint) => {
  if (whole === 0n) return null;
  const hundredths = divideRounded(part * 10_000n, whole);
  const sign = hundredths < 0n ? "-" : "";
  const absolute = hundredths < 0n ? -hundredths : hundredths;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
};

const BANGLA_ZERO = 0x09e6;
const toBanglaDigits = (text: string) => text.replace(/\d/g, (digit) => String.fromCharCode(BANGLA_ZERO + Number(digit)));

const groupDigits = (digits: string, grouping: "lakh" | "western") => {
  if (grouping === "western") return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  // Lakh and crore: the last three digits, then pairs. 1250000 becomes 12,50,000.
  if (digits.length <= 3) return digits;
  const head = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${head},${digits.slice(-3)}`;
};

const CURRENCY_SYMBOLS: Record<string, string> = { BDT: "৳", USD: "$", EUR: "€", GBP: "£", INR: "₹" };

export interface MoneyFormat {
  digitStyle: "latin" | "bangla";
  grouping: "lakh" | "western";
  withSymbol?: boolean;
}

// The one place money becomes text, for PDFs now and AI answers later. Built from the digits rather
// than Intl.NumberFormat, which would turn a large amount into an imprecise float first.
export const formatMoney = (amount: bigint, currency: string, format: MoneyFormat) => {
  const digits = minorDigitsOf(currency);
  const absolute = (amount < 0n ? -amount : amount).toString().padStart(digits + 1, "0");
  const whole = digits === 0 ? absolute : absolute.slice(0, -digits);
  const fraction = digits === 0 ? "" : `.${absolute.slice(-digits)}`;

  const number = `${groupDigits(whole, format.grouping)}${fraction}`;
  const symbol = format.withSymbol === false ? "" : (CURRENCY_SYMBOLS[currency] ?? `${currency} `);
  const text = `${amount < 0n ? "-" : ""}${symbol}${number}`;
  return format.digitStyle === "bangla" ? toBanglaDigits(text) : text;
};

// A plain decimal such as "30000.50", for CSV and Excel, where values stay machine-readable.
export const toDecimalString = (amount: bigint, currency: string) => {
  const digits = minorDigitsOf(currency);
  const absolute = (amount < 0n ? -amount : amount).toString().padStart(digits + 1, "0");
  const whole = digits === 0 ? absolute : absolute.slice(0, -digits);
  const fraction = digits === 0 ? "" : `.${absolute.slice(-digits)}`;
  return `${amount < 0n ? "-" : ""}${whole}${fraction}`;
};
