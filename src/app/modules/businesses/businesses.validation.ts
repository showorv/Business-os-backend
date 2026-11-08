import { z } from "zod";
import { normalizeDigits } from "../../utils/normalize.js";
import { currencyField, textField, timezoneField } from "../../utils/validationFields.js";

const fiscalMonthField = z.coerce.number().int().min(1).max(12);

// Bump BUSINESS_SETTINGS_VERSION when a change here needs existing rows to be migrated.
// Later phases add their own fields, such as default accounts in Phase 4.
export const BUSINESS_SETTINGS_VERSION = 1;

const settingsShape = {
  locale: z.enum(["en", "bn-BD"]),
  currencyDisplay: z.enum(["symbol", "code"]),
  numberGrouping: z.enum(["lakh", "western"]),
  weekStart: z.enum(["saturday", "sunday", "monday"]),
  transactionPrefix: z.string().trim().min(1).max(10),
  // Expenses above this amount need a second approver (Phase 4). Minor units, as a string.
  approvalThresholdMinor: z
    .string()
    .overwrite(normalizeDigits)
    .regex(/^\d{1,18}$/)
    .nullable(),
  enabledModules: z.array(z.enum(["finance", "tasks", "documents", "integrations", "ai"])),
  // VAT (11.6). Only a registered business charges VAT on invoices and claims it back on bills.
  vatRegistered: z.boolean(),
  // The rate new invoice lines start with, in basis points: 1500 is 15%.
  defaultVatRateBp: z.number().int().min(0).max(10000),
};

export const defaultBusinessSettings = {
  version: BUSINESS_SETTINGS_VERSION,
  locale: "en",
  currencyDisplay: "symbol",
  numberGrouping: "lakh",
  weekStart: "saturday",
  transactionPrefix: "TXN",
  approvalThresholdMinor: null,
  enabledModules: ["finance", "tasks", "documents", "integrations", "ai"],
  vatRegistered: false,
  defaultVatRateBp: 1500,
};

const settingsPatch = z.object(settingsShape).partial();

const create = z.object({
  name: textField(120),
  type: z.enum(["RETAIL", "SERVICES", "AGENCY", "ECOMMERCE", "MANUFACTURING", "CUSTOM"]),
  legalName: textField(200).optional(),
  taxId: textField(50).optional(),
  baseCurrency: currencyField.default("BDT"),
  // Bangladesh's fiscal year starts in July.
  fiscalYearStartMonth: fiscalMonthField.default(7),
  timezone: timezoneField.default("Asia/Dhaka"),
  settings: settingsPatch.optional(),
});

// `type` is left out on purpose: it only chose the starting templates.
const update = z
  .object({
    name: textField(120),
    legalName: textField(200).nullable(),
    taxId: textField(50).nullable(),
    baseCurrency: currencyField,
    fiscalYearStartMonth: fiscalMonthField,
    timezone: timezoneField,
    settings: settingsPatch,
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: "NO_FIELDS_TO_UPDATE" });

const changeStatus = z.object({ status: z.enum(["ACTIVE", "INACTIVE", "ARCHIVED"]) });

const listQuery = z.object({
  includeArchived: z.stringbool().default(false),
});

export const businessesValidation = { create, update, changeStatus, listQuery };
