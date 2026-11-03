// The API returns codes, never sentences: the frontend translates each code (English or Bangla).
export const ErrorCode = {
  VALIDATION_FAILED: "VALIDATION_FAILED",
  INVALID_JSON: "INVALID_JSON",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  RATE_LIMITED: "RATE_LIMITED",
  CSRF_FAILED: "CSRF_FAILED",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  TOKEN_EXPIRED: "TOKEN_EXPIRED",
  TOKEN_INVALID: "TOKEN_INVALID",
  REGISTRATION_DISABLED: "REGISTRATION_DISABLED",
  EMAIL_TAKEN: "EMAIL_TAKEN",
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  ACCOUNT_LOCKED: "ACCOUNT_LOCKED",
  REFRESH_INVALID: "REFRESH_INVALID",
  REFRESH_REUSED: "REFRESH_REUSED",
  MFA_REQUIRED: "MFA_REQUIRED",
  MFA_INVALID_CODE: "MFA_INVALID_CODE",
  MFA_CHALLENGE_INVALID: "MFA_CHALLENGE_INVALID",
  MFA_ALREADY_ENABLED: "MFA_ALREADY_ENABLED",
  MFA_NOT_ENABLED: "MFA_NOT_ENABLED",
  MFA_NOT_STARTED: "MFA_NOT_STARTED",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    public readonly params?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "AppError";
  }
}
