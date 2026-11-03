import type { z } from "zod";
import type { IPublicUser } from "../users/users.interface.js";
import type { authValidation } from "./auth.validation.js";

export type IRegisterBody = z.infer<typeof authValidation.register>;
export type ILoginBody = z.infer<typeof authValidation.login>;
export type IMfaVerifyBody = z.infer<typeof authValidation.mfaVerify>;
export type IMfaSetupBody = z.infer<typeof authValidation.mfaSetup>;
export type IMfaCodeBody = z.infer<typeof authValidation.mfaCode>;
export type IMfaDisableBody = z.infer<typeof authValidation.mfaDisable>;
export type IChangePasswordBody = z.infer<typeof authValidation.changePassword>;
export type ISessionParams = z.infer<typeof authValidation.sessionParams>;

// What the auth middleware puts on req.auth.
export interface AuthContext {
  userId: string;
  workspaceId: string;
  sessionId: string;
  mfaEnabled: boolean;
  mfaAt?: number;
}

export interface IssuedTokens {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  user: IPublicUser;
}

export type LoginResult =
  | ({ mfaRequired: false } & IssuedTokens)
  | { mfaRequired: true; challengeToken: string };
