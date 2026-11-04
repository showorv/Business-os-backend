import { z } from "zod";
import { paginationQuery } from "../../utils/pagination.js";
import { textField } from "../../utils/validationFields.js";

const conversationParams = z.object({ conversationId: z.uuid() });
const proposalParams = z.object({ proposalId: z.uuid() });

const chat = z.object({
  message: textField(2000),
  conversationId: z.uuid().optional(),
  // One business, or leave it out for all you may ask about.
  businessId: z.uuid().optional(),
});

const listQuery = z.object({ ...paginationQuery });
const proposalsQuery = z.object({ ...paginationQuery, status: z.enum(["PENDING", "CONFIRMED", "REJECTED", "EXPIRED"]).optional() });

// Posting straight away is the person's choice on the card, and needs ledger.post.
const confirm = z.object({ postNow: z.boolean().default(false) });

export const aiValidation = { conversationParams, proposalParams, chat, listQuery, proposalsQuery, confirm };
