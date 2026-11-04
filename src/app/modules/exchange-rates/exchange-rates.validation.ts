import { z } from "zod";
import { dateField } from "../../utils/dates.js";
import { normalizeDigits } from "../../utils/normalize.js";
import { currencyField } from "../../utils/validationFields.js";

// A string, so a rate is never rounded by passing through a float. Up to 6 decimals, as stored.
const rateField = z
  .string()
  .overwrite(normalizeDigits)
  .trim()
  .regex(/^\d{1,13}(\.\d{1,6})?$/, { abort: true })
  .refine((value) => Number(value) > 0, { message: "RATE_MUST_BE_POSITIVE" });

const save = z
  .object({ fromCurrency: currencyField, toCurrency: currencyField, rateDate: dateField, rate: rateField })
  .refine((body) => body.fromCurrency !== body.toCurrency, { message: "CURRENCIES_MUST_DIFFER" });

const listQuery = z.object({ fromCurrency: currencyField.optional(), toCurrency: currencyField.optional() });

export const exchangeRatesValidation = { save, listQuery };
