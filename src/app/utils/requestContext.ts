import { isIP } from "node:net";
import type { Request } from "express";

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
  // Set when the request came through the AI assistant, so the audit log says so.
  actorVia?: "ai";
}

const cleanIp = (raw: string | undefined) => {
  if (!raw) return null;
  const ip = raw.split("%")[0]!.replace(/^::ffff:(?=\d+\.)/, "");
  return isIP(ip) ? ip : null;
};

export const getRequestContext = (req: Request): RequestContext => ({
  ip: cleanIp(req.ip),
  userAgent: req.get("user-agent")?.slice(0, 512) ?? null,
  requestId: req.requestId,
});
