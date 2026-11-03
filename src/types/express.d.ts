import type { AuthContext } from "../app/modules/auth/auth.interface.js";

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      auth?: AuthContext;
      validated: { body?: unknown; query?: unknown; params?: unknown };
    }
  }
}

export {};
