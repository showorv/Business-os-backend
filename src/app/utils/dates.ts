import { z } from "zod";
import { normalizeDigits } from "./normalize.js";

const isRealDate = (value: string) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
};

// A calendar date with no time, such as a transaction date. Accepts Bangla digits.
export const dateField = z
  .string()
  .overwrite(normalizeDigits)
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isRealDate, { message: "INVALID_DATE" });

// DATE columns are read and written as midnight UTC, so the calendar day never shifts.
export const toDbDate = (value: string) => new Date(`${value}T00:00:00.000Z`);
export const fromDbDate = (value: Date) => value.toISOString().slice(0, 10);

export const todayInTimezone = (timezone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

export const addDays = (date: Date, days: number) => new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
