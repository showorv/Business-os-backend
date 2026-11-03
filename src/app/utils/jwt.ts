import jwt from "jsonwebtoken";
import { env } from "../config/env.config.js";

const ISSUER = "business-os";
const ACCESS_AUDIENCE = "business-os-api";
const MFA_AUDIENCE = "business-os-mfa";
const MFA_CHALLENGE_TTL_SECONDS = 5 * 60;

export const accessTokenTtlSeconds = env.ACCESS_TOKEN_TTL_MINUTES * 60;

export interface AccessClaims {
  sub: string;
  wid: string;
  sid: string;
  tv: number;
  mfa_at?: number;
}

export interface MfaChallengeClaims {
  sub: string;
  tv: number;
}

export const signAccessToken = (claims: AccessClaims) =>
  jwt.sign(claims, env.JWT_ACCESS_SECRET, {
    algorithm: "HS256",
    expiresIn: accessTokenTtlSeconds,
    issuer: ISSUER,
    audience: ACCESS_AUDIENCE,
  });

export const verifyAccessToken = (token: string) =>
  jwt.verify(token, env.JWT_ACCESS_SECRET, {
    algorithms: ["HS256"],
    issuer: ISSUER,
    audience: ACCESS_AUDIENCE,
  }) as AccessClaims;

export const signMfaChallenge = (claims: MfaChallengeClaims) =>
  jwt.sign(claims, env.JWT_MFA_SECRET, {
    algorithm: "HS256",
    expiresIn: MFA_CHALLENGE_TTL_SECONDS,
    issuer: ISSUER,
    audience: MFA_AUDIENCE,
  });

export const verifyMfaChallenge = (token: string) =>
  jwt.verify(token, env.JWT_MFA_SECRET, {
    algorithms: ["HS256"],
    issuer: ISSUER,
    audience: MFA_AUDIENCE,
  }) as MfaChallengeClaims;
