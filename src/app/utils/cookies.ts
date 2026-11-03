import type { CookieOptions, Response } from "express";
import { env, isProduction } from "../config/env.config.js";
import { randomToken } from "./crypto.js";

export const REFRESH_COOKIE = "refresh_token";
export const CSRF_COOKIE = "csrf_token";
export const CSRF_HEADER = "x-csrf-token";

const base: CookieOptions = {
  secure: isProduction,
  sameSite: "strict",
  ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
};

// Only sent to the auth routes, so it never travels with ordinary API calls.
const refreshOptions: CookieOptions = { ...base, httpOnly: true, path: "/api/v1/auth" };
// Readable by the SPA on purpose: it echoes this value in the X-CSRF-Token header (double submit).
const csrfOptions: CookieOptions = { ...base, httpOnly: false, path: "/" };

export const setAuthCookies = (res: Response, refreshToken: string) => {
  const maxAge = env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;
  const csrfToken = randomToken();
  res.cookie(REFRESH_COOKIE, refreshToken, { ...refreshOptions, maxAge });
  res.cookie(CSRF_COOKIE, csrfToken, { ...csrfOptions, maxAge });
  return csrfToken;
};

export const clearAuthCookies = (res: Response) => {
  res.clearCookie(REFRESH_COOKIE, refreshOptions);
  res.clearCookie(CSRF_COOKIE, csrfOptions);
};
