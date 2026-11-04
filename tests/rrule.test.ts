import { describe, expect, it } from "vitest";
import { fromWallClock, localDateOf, nextFiring, nextOccurrence, occurrencesBetween, reminderRuleField, scheduleRuleField, toWallClock } from "../src/app/utils/rrule.js";

const at = (iso: string) => new Date(iso);

describe("timezones", () => {
  it("turns a moment into local time and back", () => {
    const utc = at("2026-11-05T03:00:00.000Z");
    expect(toWallClock(utc, "Asia/Dhaka").toISOString()).toBe("2026-11-05T09:00:00.000Z");
    expect(fromWallClock(at("2026-11-05T09:00:00.000Z"), "Asia/Dhaka").toISOString()).toBe(utc.toISOString());
  });

  it("gives the local date, which can differ from the UTC date", () => {
    expect(localDateOf(at("2026-11-05T20:00:00.000Z"), "Asia/Dhaka")).toBe("2026-11-06");
  });
});

describe("the next occurrence", () => {
  const monthly = { rrule: "FREQ=MONTHLY;BYMONTHDAY=1", startsAt: at("2026-11-01T03:00:00.000Z"), timezone: "Asia/Dhaka" };

  it("finds the first one after a moment, at the same local time", () => {
    expect(nextOccurrence(monthly, at("2026-11-15T00:00:00.000Z"))?.toISOString()).toBe("2026-12-01T03:00:00.000Z");
  });

  it("never returns the moment itself", () => {
    expect(nextOccurrence(monthly, at("2026-12-01T03:00:00.000Z"))?.toISOString()).toBe("2027-01-01T03:00:00.000Z");
  });

  it("a one-time reminder has one occurrence", () => {
    const once = { rrule: null, startsAt: at("2026-12-01T03:00:00.000Z"), timezone: "Asia/Dhaka" };
    expect(nextOccurrence(once, at("2026-11-01T00:00:00.000Z"))).toEqual(once.startsAt);
    expect(nextOccurrence(once, at("2026-12-02T00:00:00.000Z"))).toBeNull();
  });

  it("ends when COUNT runs out", () => {
    const twice = { ...monthly, rrule: "FREQ=MONTHLY;COUNT=2" };
    expect(nextOccurrence(twice, at("2026-11-15T00:00:00.000Z"))?.toISOString()).toBe("2026-12-01T03:00:00.000Z");
    expect(nextOccurrence(twice, at("2026-12-15T00:00:00.000Z"))).toBeNull();
  });

  it("an impossible rule ends instead of searching for ever", () => {
    const started = Date.now();
    expect(nextOccurrence({ ...monthly, rrule: "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30" }, at("2026-11-15T00:00:00.000Z"))).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("stays at 09:00 local time across a daylight saving change", () => {
    const daily = { rrule: "FREQ=DAILY", startsAt: at("2026-10-30T13:00:00.000Z"), timezone: "America/New_York" };
    // Clocks in New York go back on 1 November 2026, from UTC-4 to UTC-5.
    expect(nextOccurrence(daily, at("2026-10-31T14:00:00.000Z"))?.toISOString()).toBe("2026-11-01T14:00:00.000Z");
    expect(nextOccurrence(daily, at("2026-11-01T14:00:00.000Z"))?.toISOString()).toBe("2026-11-02T14:00:00.000Z");
  });
});

describe("lead time", () => {
  const rule = { rrule: "FREQ=MONTHLY;BYMONTHDAY=10", startsAt: at("2026-11-10T03:00:00.000Z"), timezone: "Asia/Dhaka" };

  it("fires ahead of the occurrence", () => {
    const firing = nextFiring(rule, 3 * 24 * 60, at("2026-11-01T00:00:00.000Z"))!;
    expect(firing.occurrenceAt.toISOString()).toBe("2026-11-10T03:00:00.000Z");
    expect(firing.fireAt.toISOString()).toBe("2026-11-07T03:00:00.000Z");
  });

  it("moves to the next occurrence once this one's lead time has passed", () => {
    const firing = nextFiring(rule, 3 * 24 * 60, at("2026-11-08T00:00:00.000Z"))!;
    expect(firing.occurrenceAt.toISOString()).toBe("2026-12-10T03:00:00.000Z");
  });
});

describe("the calendar", () => {
  it("lists every occurrence in a range", () => {
    const weekly = { rrule: "FREQ=WEEKLY", startsAt: at("2026-11-02T03:00:00.000Z"), timezone: "Asia/Dhaka" };
    expect(occurrencesBetween(weekly, at("2026-11-01T00:00:00.000Z"), at("2026-11-16T00:00:00.000Z"))).toHaveLength(2);
  });
});

describe("which rules are allowed", () => {
  const reminderOk = (rule: string) => reminderRuleField.safeParse(rule).success;
  const scheduleOk = (rule: string) => scheduleRuleField.safeParse(rule).success;

  it("accepts ordinary rules, with or without the RRULE: prefix", () => {
    expect(reminderOk("FREQ=MONTHLY;BYMONTHDAY=1")).toBe(true);
    expect(reminderOk("rrule:freq=weekly;byday=mo,we")).toBe(true);
    expect(reminderRuleField.parse("rrule:freq=daily")).toBe("FREQ=DAILY");
  });

  it("refuses nonsense and rules with their own start or timezone", () => {
    expect(reminderOk("not a rule")).toBe(false);
    expect(reminderOk("BYDAY=MO")).toBe(false);
    expect(reminderOk("DTSTART:20260101T000000Z\nRRULE:FREQ=DAILY")).toBe(false);
    expect(reminderOk("FREQ=DAILY;TZID=Asia/Dhaka")).toBe(false);
  });

  it("refuses anything that could flood people", () => {
    expect(reminderOk("FREQ=MINUTELY")).toBe(false);
    expect(reminderOk("FREQ=SECONDLY")).toBe(false);
    expect(reminderOk("FREQ=HOURLY;BYMINUTE=0,1,2,3")).toBe(false);
    expect(reminderOk("FREQ=HOURLY")).toBe(true);
  });

  it("a schedule repeats daily at most", () => {
    expect(scheduleOk("FREQ=DAILY")).toBe(true);
    expect(scheduleOk("FREQ=HOURLY")).toBe(false);
  });
});
