const BANGLA_ZERO = 0x09e6;

// ০-৯ to 0-9. Stored values always use Latin digits.
export const normalizeDigits = (value: string) =>
  value.replace(/[০-৯]/g, (digit) => String(digit.charCodeAt(0) - BANGLA_ZERO));
