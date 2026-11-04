import { z } from "zod";
import { normalizeDigits } from "./normalize.js";

// NFC stops the same Bangla word being stored in two different byte forms.
export const textField = (max: number) => z.string().normalize("NFC").trim().min(1).max(max);

export const emailField = z.string().normalize("NFC").trim().toLowerCase().max(254).email();

// bcrypt silently ignores everything after 72 bytes, so longer passwords are refused.
export const newPasswordField = z
  .string()
  .normalize("NFC")
  .min(10)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 72, { message: "PASSWORD_TOO_LONG" });

export const existingPasswordField = z.string().normalize("NFC").min(1).max(1000);

const SUPPORTED_CURRENCIES = new Set(Intl.supportedValuesOf("currency"));

export const currencyField = z
  .string()
  .toUpperCase()
  .refine((value) => SUPPORTED_CURRENCIES.has(value), { message: "UNSUPPORTED_CURRENCY" });

export const totpCodeField = z
  .string()
  .overwrite(normalizeDigits)
  .trim()
  .regex(/^\d{6}$/);
