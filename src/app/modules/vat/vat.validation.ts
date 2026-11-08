import { z } from "zod";
import { dateField } from "../../utils/dates.js";

// A VAT return covers a month, but any range up to a year can be summed.
const summaryQuery = z
  .object({ from: dateField, to: dateField })
  .refine((query) => query.from <= query.to, { message: "FROM_AFTER_TO", path: ["to"] })
  .refine((query) => (Date.parse(query.to) - Date.parse(query.from)) / 86_400_000 <= 366, { message: "RANGE_TOO_LONG", path: ["to"] });

export const vatValidation = { summaryQuery };
