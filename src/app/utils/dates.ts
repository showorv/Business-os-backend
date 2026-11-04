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

// A whole month, written YYYY-MM. Dashboards and budgets work in months.
export const monthField = z
  .string()
  .overwrite(normalizeDigits)
  .trim()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/);

export const monthToDate = (month: string) => toDbDate(`${month}-01`);
export const dateToMonth = (date: Date) => date.toISOString().slice(0, 7);
export const lastDayOfMonth = (month: string) => {
  const [year, monthNumber] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
};

// Every month from one to the other, inclusive: ["2026-11", "2026-12", "2027-01"].
export const monthsBetween = (from: string, to: string) => {
  const months: string[] = [];
  const cursor = monthToDate(from);
  const end = monthToDate(to);
  while (cursor <= end) {
    months.push(dateToMonth(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
};

// A moment in time, with its local date and time in a timezone.
export const formatDateTime = (moment: Date, locale: "en" | "bn-BD", digitStyle: "latin" | "bangla", timezone: string) =>
  new Intl.DateTimeFormat(locale === "bn-BD" ? "bn-BD" : "en-GB", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: timezone,
    numberingSystem: digitStyle === "bangla" ? "beng" : "latn",
  }).format(moment);

export const addDays = (date: Date, days: number) => new Date(date.getTime() + days * 24 * 60 * 60 * 1000);

// A date for people to read: "2 November 2026" or "২ নভেম্বর ২০২৬". Only ever for display.
export const formatDate = (isoDate: string, locale: "en" | "bn-BD", digitStyle: "latin" | "bangla") =>
  new Intl.DateTimeFormat(locale === "bn-BD" ? "bn-BD" : "en-GB", {
    dateStyle: "long",
    timeZone: "UTC",
    numberingSystem: digitStyle === "bangla" ? "beng" : "latn",
  }).format(toDbDate(isoDate));
