import { normalizeDigits } from "../utils/normalize.js";

// The document's two checks around the model: what goes in, and what comes out.

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+|any\s+|your\s+|the\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)/i,
  /disregard\s+(all\s+|your\s+|the\s+)?(previous|prior|above|instructions?|rules?)/i,
  /(reveal|show|print|repeat|what\s+is)\s+(me\s+)?(your\s+|the\s+)?(system\s+prompt|instructions|hidden\s+prompt)/i,
  /you\s+are\s+now\s+(a|an|in)\b/i,
  /(run|execute|write)\s+(this\s+|an?\s+|the\s+)?(sql|query)\b/i,
  /(drop|delete\s+from|truncate|update)\s+(table\s+)?[a-z_]+\s*(;|set\b|where\b)/i,
  /(আগের|পূর্ববর্তী)\s+(সব\s+)?(নির্দেশ|নির্দেশনা|নিয়ম)\s+(উপেক্ষা|ভুলে)/,
  /সিস্টেম\s+প্রম্পট/,
];

export const looksLikeInjection = (question: string) => INJECTION_PATTERNS.some((pattern) => pattern.test(question));

// Digits as plain text, without separators, and without a meaningless tail: 1,25,000.00 becomes 125000.
const canonical = (number: string) => {
  const plain = number.replace(/,/g, "");
  const [whole = "", fraction = ""] = plain.split(".");
  const cleanFraction = fraction.replace(/0+$/, "");
  const cleanWhole = whole.replace(/^0+(?=\d)/, "");
  return cleanFraction ? `${cleanWhole}.${cleanFraction}` : cleanWhole;
};

const NUMBER = /\d[\d,]*(?:\.\d+)?/g;

export const numbersIn = (text: string) => (normalizeDigits(text).match(NUMBER) ?? []).map(canonical);

// A numbered list's "1." and "2." aren't figures.
const withoutListMarkers = (text: string) => text.replace(/^\s*\d{1,2}[.)]\s/gm, "");

// Every number in the answer must be one the tools returned, or one the person said. Anything else is
// a figure the model made up or worked out itself, which is exactly what must not reach a business owner.
export const findUnsupportedNumbers = (answer: string, sources: string[]) => {
  const allowed = new Set(sources.flatMap(numbersIn));
  return [...new Set(numbersIn(withoutListMarkers(answer)))].filter((number) => !allowed.has(number));
};
