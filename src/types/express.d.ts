import type { AuthContext } from "../app/modules/auth/auth.interface.js";
import type { BusinessContext } from "../app/modules/members/members.interface.js";

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      auth?: AuthContext;
      business?: BusinessContext;
      validated: { body?: unknown; query?: unknown; params?: unknown };
    }
  }
}

export {};
