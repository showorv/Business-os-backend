import { z } from "zod";
import { dateField } from "../../utils/dates.js";

const asOfQuery = z.object({ asOf: dateField });
const rangeQuery = z.object({ from: dateField, to: dateField });

export const reportsValidation = { asOfQuery, rangeQuery };
