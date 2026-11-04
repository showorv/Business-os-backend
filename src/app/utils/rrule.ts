import rrulePackage from "rrule";
import { z } from "zod";

const { RRule } = rrulePackage;

// Anything further ahead than this counts as "no more occurrences". It also stops an impossible rule
// such as 30 February from searching for thousands of years.
const SEARCH_YEARS = 10;

const offsetMsAt = (utc: Date, timezone: string) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(utc);
  const part = (type: string) => Number(parts.find((item) => item.type === type)!.value);
  const wallClock = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
  return wallClock - Math.floor(utc.getTime() / 1000) * 1000;
};

// A "wall clock" Date holds local time in its UTC fields: 09:00 in Dhaka is stored as 09:00Z.
// The rrule library does its calendar maths on these, so "every day at 09:00" stays at 09:00 local
// time when the clocks change.
export const toWallClock = (utc: Date, timezone: string) => new Date(utc.getTime() + offsetMsAt(utc, timezone));

export const fromWallClock = (wall: Date, timezone: string) => {
  const guess = new Date(wall.getTime() - offsetMsAt(wall, timezone));
  // The offset at the guess can differ from the offset at the wall time, around a clock change.
  return new Date(wall.getTime() - offsetMsAt(guess, timezone));
};

// The calendar date, YYYY-MM-DD, that a moment falls on in a timezone.
export const localDateOf = (utc: Date, timezone: string) => toWallClock(utc, timezone).toISOString().slice(0, 10);

// Local midnight, or another local time, on a calendar date.
export const localTimeToUtc = (date: string, time: string, timezone: string) =>
  fromWallClock(new Date(`${date}T${time}:00.000Z`), timezone);

const cleanRule = (value: string) => value.trim().toUpperCase().replace(/^RRULE:/, "");

const ruleIsSupported = (value: string, fastestAllowedFreq: number) => {
  // The start and timezone are separate fields, so a rule carrying its own would contradict them.
  if (/DTSTART|TZID|\n/.test(value)) return false;
  try {
    const options = RRule.parseString(value);
    if (options.freq === undefined || options.freq === null) return false;
    // In the library, a higher number repeats faster: YEARLY is 0, SECONDLY is 6.
    if (options.freq > fastestAllowedFreq) return false;
    if (options.bysecond !== undefined && options.bysecond !== null) return false;
    // Many minutes in one hour would turn an hourly rule into a flood.
    return !Array.isArray(options.byminute) || options.byminute.length <= 1;
  } catch {
    return false;
  }
};

// Reminders can repeat as often as hourly.
export const reminderRuleField = z
  .string()
  .max(500)
  .overwrite(cleanRule)
  .refine((value) => ruleIsSupported(value, RRule.HOURLY), { message: "INVALID_RRULE" });

// Each occurrence of a schedule is a transaction on one date, so daily is the most it can repeat.
export const scheduleRuleField = z
  .string()
  .max(500)
  .overwrite(cleanRule)
  .refine((value) => ruleIsSupported(value, RRule.DAILY), { message: "INVALID_RRULE" });

export interface Recurrence {
  // Empty means it happens once, at startsAt.
  rrule: string | null;
  startsAt: Date;
  timezone: string;
}

// The first occurrence strictly after a moment, or null when the rule has finished.
export const nextOccurrence = ({ rrule, startsAt, timezone }: Recurrence, after: Date) => {
  if (!rrule) return startsAt > after ? startsAt : null;

  const rule = new RRule({ ...RRule.parseString(rrule), dtstart: toWallClock(startsAt, timezone) });
  const from = toWallClock(after, timezone);
  const until = new Date(from);
  until.setUTCFullYear(until.getUTCFullYear() + SEARCH_YEARS);

  const [found] = rule.between(from, until, false, (_date, index) => index < 1);
  return found ? fromWallClock(found, timezone) : null;
};

// When a reminder should next fire: the first occurrence whose lead time is still ahead of `after`.
export const nextFiring = (recurrence: Recurrence, leadMinutes: number, after: Date) => {
  const leadMs = leadMinutes * 60 * 1000;
  const occurrenceAt = nextOccurrence(recurrence, new Date(after.getTime() + leadMs));
  return occurrenceAt ? { occurrenceAt, fireAt: new Date(occurrenceAt.getTime() - leadMs) } : null;
};

// Every occurrence in a range, for the calendar view.
export const occurrencesBetween = ({ rrule, startsAt, timezone }: Recurrence, from: Date, to: Date) => {
  if (!rrule) return startsAt >= from && startsAt <= to ? [startsAt] : [];

  const rule = new RRule({ ...RRule.parseString(rrule), dtstart: toWallClock(startsAt, timezone) });
  return rule.between(toWallClock(from, timezone), toWallClock(to, timezone), true).map((date) => fromWallClock(date, timezone));
};
