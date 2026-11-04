import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.config.js";

const encryptionKey = Buffer.from(env.MFA_ENCRYPTION_KEY, "base64");

export const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

export const safeEqual = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

// AES-256-GCM. The owner id is bound in as AAD, so a ciphertext copied to another user fails to decrypt.
export const encryptSecret = (plain: string, ownerId: string) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  cipher.setAAD(Buffer.from(ownerId));
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
};

export const decryptSecret = (stored: string, ownerId: string) => {
  const [, iv, tag, data] = stored.split(":") as [string, string, string, string];
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(iv, "base64"));
  decipher.setAAD(Buffer.from(ownerId));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
};

// Each workspace gets its own key, derived from the master key. So a leaked row from one workspace
// can't be read with another's key, and no extra key table needs protecting.
const workspaceKey = (workspaceId: string) =>
  Buffer.from(hkdfSync("sha256", encryptionKey, Buffer.from(workspaceId), "integration-secrets", 32));

// The connection id is bound in, so ciphertext copied to another connection fails to decrypt.
export const encryptForWorkspace = (plain: string, workspaceId: string, connectionId: string) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", workspaceKey(workspaceId), iv);
  cipher.setAAD(Buffer.from(connectionId));
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["w1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
};

export const decryptForWorkspace = (stored: string, workspaceId: string, connectionId: string) => {
  const [, iv, tag, data] = stored.split(":") as [string, string, string, string];
  const decipher = createDecipheriv("aes-256-gcm", workspaceKey(workspaceId), Buffer.from(iv, "base64"));
  decipher.setAAD(Buffer.from(connectionId));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
};

export const hmacSha256Hex = (key: string, value: string) => createHmac("sha256", key).update(value).digest("hex");
