import type { z } from "zod";
import type { aiValidation } from "./ai.validation.js";

export type IConversationParams = z.infer<typeof aiValidation.conversationParams>;
export type IProposalParams = z.infer<typeof aiValidation.proposalParams>;
export type IChatBody = z.infer<typeof aiValidation.chat>;
export type IListQuery = z.infer<typeof aiValidation.listQuery>;
export type IProposalsQuery = z.infer<typeof aiValidation.proposalsQuery>;
export type IConfirmBody = z.infer<typeof aiValidation.confirm>;
