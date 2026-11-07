import type { z } from "zod";
import type { usersValidation } from "./users.validation.js";

export type IUpdateMeBody = z.infer<typeof usersValidation.updateMe>;

export interface IPublicUser {
  id: string;
  email: string;
  name: string;
  status: string;
  mfaEnabled: boolean;
  // Opens the platform admin panel (it also needs two-step verification turned on).
  isPlatformAdmin: boolean;
  locale: string;
  digitStyle: string;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export interface ICreateUserInput {
  email: string;
  name: string;
  passwordHash: string;
}
