import type { z } from "zod";
import type { invitationsValidation } from "./invitations.validation.js";

export type ICreateInvitationBody = z.infer<typeof invitationsValidation.create>;
export type IInvitationParams = z.infer<typeof invitationsValidation.invitationParams>;
export type IAcceptInvitationBody = z.infer<typeof invitationsValidation.accept>;
